// Zweite Verteidigungslinie: Row-Level-Security prüft Rollen und Mandanten auch ohne Fastify-Hook.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, withMember, withUser } from '../src/db/index.js';
import {
  approvals,
  auditLog,
  events,
  organizations,
  teams,
  users,
  workNetworks,
} from '../src/db/schema.js';
import { type TestEnv, createTestEnv } from './helpers.js';
import { type OrgSetup, api, createOrg, setupOrg, workday } from './org-helpers.js';

let env: TestEnv;
let org: OrgSetup;
let foreign: Awaited<ReturnType<typeof createOrg>>;
beforeAll(async () => {
  env = await createTestEnv();
  org = await setupOrg(env);
  foreign = await createOrg(env, 'Fremd');
  await workday(env, org.member);
  await workday(env, org.other);
});
afterAll(() => env.close());

const scope = (p: { userId: string }, orgId = org.orgId) => ({ userId: p.userId, orgId });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
  );

describe('RLS Firmenversion', () => {
  it('Manager sieht in users nur sich und sein Team, im Audit-Log nichts', async () => {
    const seen = await withUser(env.database.db, scope(org.manager), async (tx) => ({
      users: (await tx.select({ id: users.id }).from(users)).map((u) => u.id).sort(),
      audit: await tx.select().from(auditLog),
      events: await tx.select({ userId: events.userId }).from(events),
    }));
    expect(seen.users).toEqual([org.manager.userId, org.member.userId].sort());
    expect(seen.audit).toEqual([]);
    expect(seen.events).toEqual([]); // keine fremden Rohereignisse
  });

  it('Admin sieht alle Mitglieder der eigenen Organisation, keine fremden', async () => {
    const ids = await withUser(env.database.db, scope(org.admin), async (tx) =>
      (await tx.select({ id: users.id }).from(users)).map((u) => u.id),
    );
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain(foreign.userId);
  });

  it('Zugriff im Auftrag: Datenbank lehnt fremde Teams und fremde Organisationen ab', async () => {
    expect(
      await failure(
        withMember(env.database.db, scope(org.manager), org.other.userId, () => Promise.resolve()),
      ),
    ).toMatch(/delegate not allowed/);
    expect(
      await failure(
        withMember(env.database.db, scope(foreign, foreign.orgId), org.member.userId, () =>
          Promise.resolve(),
        ),
      ),
    ).toMatch(/delegate not allowed/);
    // Gefälschte org_id im Kontext hilft nicht: der Akteur ist dort kein Mitglied
    expect(
      await failure(
        withMember(env.database.db, scope(foreign, org.orgId), org.member.userId, () =>
          Promise.resolve(),
        ),
      ),
    ).toMatch(/delegate not allowed/);
    const own = await withMember(env.database.db, scope(org.manager), org.member.userId, (tx) =>
      tx.select({ userId: events.userId }).from(events),
    );
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.userId === org.member.userId)).toBe(true);
  });

  it('Manager darf im Auftrag nichts schreiben, Admin schon', async () => {
    const row = (deviceId: string) => ({
      userId: org.member.userId,
      id: randomUUID(),
      deviceId,
      type: 'manual_start',
      source: 'user',
      ts: new Date('2026-10-14T05:00:00Z'),
      tz: 'Europe/Berlin',
      createdAt: new Date(),
    });
    expect(
      await failure(
        withMember(env.database.db, scope(org.manager), org.member.userId, (tx) =>
          tx.insert(events).values(row(org.manager.deviceId)),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await failure(
        withMember(env.database.db, scope(org.admin), org.member.userId, (tx) =>
          tx.insert(events).values(row(org.admin.deviceId)),
        ),
      ),
    ).toBe('ok');
  });

  it('Nutzer kann sich nicht selbst befördern oder den eigenen Monat freigeben', async () => {
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx.update(users).set({ role: 'admin' }).where(eq(users.id, org.member.userId)),
        ),
      ),
    ).toMatch(/managed by an admin/);
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx
            .insert(approvals)
            .values({ userId: org.member.userId, month: '2026-09', status: 'approved' }),
        ),
      ),
    ).toMatch(/row-level security/);
    await api(env, org.member, 'POST', '/approvals/2026-08');
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx
            .update(approvals)
            .set({ status: 'approved' })
            .where(and(eq(approvals.userId, org.member.userId), eq(approvals.month, '2026-08'))),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it('Manager kann Freigaben fremder Teams nicht ändern', async () => {
    await api(env, org.other, 'POST', '/approvals/2026-08');
    const updated = await withUser(env.database.db, scope(org.manager), (tx) =>
      tx
        .update(approvals)
        .set({ status: 'approved' })
        .where(eq(approvals.userId, org.other.userId))
        .returning(),
    );
    expect(updated).toEqual([]);
  });

  it('Teams, Organisationen, Firmen-Netze und Audit-Log sind mandantengetrennt', async () => {
    const view = await withUser(env.database.db, scope(foreign, foreign.orgId), async (tx) => ({
      teams: await tx.select().from(teams),
      orgs: (await tx.select({ id: organizations.id }).from(organizations)).map((o) => o.id),
    }));
    expect(view.teams).toEqual([]);
    expect(view.orgs).toEqual([foreign.orgId]);
    expect(
      await failure(
        withUser(env.database.db, scope(foreign, foreign.orgId), (tx) =>
          tx.insert(teams).values({ orgId: org.orgId, name: 'Einbruch' }),
        ),
      ),
    ).toMatch(/row-level security/);
    // Normale Mitglieder dürfen keine Firmen-Netze anlegen und die Organisation nicht ändern
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx.insert(workNetworks).values({ orgId: org.orgId, label: 'x', kind: 'fingerprint' }),
        ),
      ),
    ).toMatch(/row-level security/);
    const changed = await withUser(env.database.db, scope(org.member), (tx) =>
      tx.update(organizations).set({ retentionYears: 6 }).returning(),
    );
    expect(changed).toEqual([]);
    // Audit-Log: nur als man selbst schreiben, nie ändern
    expect(
      await failure(
        withUser(env.database.db, scope(org.member), (tx) =>
          tx.insert(auditLog).values({ orgId: org.orgId, actorId: org.admin.userId, action: 'x' }),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await failure(
        withUser(env.database.db, scope(org.admin), (tx) =>
          tx.update(auditLog).set({ action: 'y' }).where(eq(auditLog.orgId, org.orgId)),
        ),
      ),
    ).toMatch(/permission denied/);
    const count = await asOwner(env.database.db, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.orgId, foreign.orgId)),
    );
    expect(count.map((r) => r.action)).toEqual(['org.create']);
  });
});
