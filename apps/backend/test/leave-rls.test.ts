// Zweite Verteidigungslinie für Urlaub, Überstunden und Lohn: Row-Level-Security ohne Fastify-Hook.
import type { LeaveRequest } from '@timelog/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withMember, withUser } from '../src/db/index.js';
import {
  absences,
  leaveRequestEvents,
  leaveRequests,
  memberPayroll,
  overtimeBookings,
  payrollCredentials,
  payrollTransfers,
} from '../src/db/schema.js';
import { type TestEnv, createTestEnv } from './helpers.js';
import { type OrgSetup, api, createOrg, setupOrg } from './org-helpers.js';

let env: TestEnv;
let org: OrgSetup;
let foreign: Awaited<ReturnType<typeof createOrg>>;
let request: LeaveRequest;
beforeAll(async () => {
  env = await createTestEnv();
  org = await setupOrg(env);
  foreign = await createOrg(env, 'Fremd');
  request = (
    await api<LeaveRequest>(env, org.member, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-11-02',
      to: '2026-11-03',
    })
  ).body;
  await api(env, org.admin, 'PUT', `/org/payroll/members/${org.member.userId}`, {
    personnelNumber: '00042',
  });
  await api(env, org.admin, 'PUT', '/org/payroll/personio', {
    clientId: 'papi-client',
    clientSecret: 'papi-secret',
  });
});
afterAll(() => env.close());

const scope = (p: { userId: string }, orgId = org.orgId) => ({ userId: p.userId, orgId });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
  );

describe('RLS Urlaub und Lohn', () => {
  it('Anträge sind mandantengetrennt; Manager sieht nur sein Team', async () => {
    const foreignView = await withUser(env.database.db, scope(foreign, foreign.orgId), (tx) =>
      tx.select().from(leaveRequests),
    );
    expect(foreignView).toEqual([]);
    const otherView = await withUser(env.database.db, scope(org.other), (tx) =>
      tx.select().from(leaveRequests),
    );
    expect(otherView).toEqual([]);
    const managerView = await withUser(env.database.db, scope(org.manager), (tx) =>
      tx.select({ id: leaveRequests.id }).from(leaveRequests),
    );
    expect(managerView.map((r) => r.id)).toEqual([request.id]);
  });

  it('Firmenmitglied kann sich nichts selbst genehmigen', async () => {
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx.insert(leaveRequests).values({
            userId: org.member.userId,
            orgId: org.orgId,
            kind: 'vacation',
            fromDate: '2026-12-01',
            toDate: '2026-12-01',
            days: 1,
            minutes: 480,
            status: 'approved',
          }),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx
            .update(leaveRequests)
            .set({ status: 'approved' })
            .where(eq(leaveRequests.id, request.id)),
        ),
      ),
    ).toMatch(/row-level security/);
    // Überstunden-Buchungen im Firmenkonto: nur Admin
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx.insert(overtimeBookings).values({
            userId: org.member.userId,
            month: '2026-10',
            minutes: 600,
            kind: 'correction',
            comment: 'selbst',
            authorId: org.member.userId,
          }),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it('Manager schreibt Abwesenheiten nur zu Anträgen, nie über fremde Teams', async () => {
    expect(
      await failure(
        withMember(env.database.db, scope(org.manager), org.member.userId, (tx) =>
          tx.insert(absences).values({
            userId: org.member.userId,
            date: '2026-12-02',
            kind: 'vacation',
            minutes: 480,
          }),
        ),
      ),
    ).toMatch(/row-level security/);
    const decided = await withUser(env.database.db, scope(org.manager), (tx) =>
      tx
        .update(leaveRequests)
        .set({ status: 'approved' })
        .where(eq(leaveRequests.userId, org.other.userId))
        .returning(),
    );
    expect(decided).toEqual([]);
    // Eigene Anträge nie selbst entscheiden
    const own = await api<LeaveRequest>(env, org.manager, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-12-07',
      to: '2026-12-07',
    });
    // Als eigene Zeile greift nur die Stornier-Regel: Status muss „cancelled“ sein
    expect(
      await failure(
        withUser(env.database.db, scope(org.manager), (tx) =>
          tx
            .update(leaveRequests)
            .set({ status: 'approved' })
            .where(eq(leaveRequests.id, own.body.id)),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it('Antragshistorie ist unveränderlich', async () => {
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx
            .update(leaveRequestEvents)
            .set({ comment: 'geändert' })
            .where(eq(leaveRequestEvents.requestId, request.id)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failure(
        withUser(env.database.db, scope(org.admin), (tx) =>
          tx.delete(leaveRequestEvents).where(eq(leaveRequestEvents.requestId, request.id)),
        ),
      ),
    ).toMatch(/permission denied/);
  });

  it('Lohn-Zuordnung und Zugangsdaten: nur Admin der eigenen Organisation', async () => {
    const ownNumber = await withUser(env.database.db, scope(org.member), (tx) =>
      tx.select({ pn: memberPayroll.personnelNumber }).from(memberPayroll),
    );
    expect(ownNumber).toEqual([{ pn: '00042' }]);
    const managerView = await withUser(env.database.db, scope(org.manager), async (tx) => ({
      payroll: await tx.select().from(memberPayroll),
      creds: await tx.select().from(payrollCredentials),
      transfers: await tx.select().from(payrollTransfers),
    }));
    expect(managerView).toEqual({ payroll: [], creds: [], transfers: [] });
    const foreignView = await withUser(
      env.database.db,
      scope(foreign, foreign.orgId),
      async (tx) => ({
        payroll: await tx.select().from(memberPayroll),
        creds: await tx.select().from(payrollCredentials),
      }),
    );
    expect(foreignView).toEqual({ payroll: [], creds: [] });
    const adminView = await withUser(env.database.db, scope(org.admin), (tx) =>
      tx.select().from(payrollCredentials),
    );
    expect(adminView).toHaveLength(1);
    // Secret liegt nur verschlüsselt in der Datenbank
    expect(adminView[0]?.clientSecretEnc).not.toContain('papi-secret');
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx
            .insert(memberPayroll)
            .values({ userId: org.other.userId, orgId: org.orgId, personnelNumber: '1' }),
        ),
      ),
    ).toMatch(/row-level security/);
  });
});
