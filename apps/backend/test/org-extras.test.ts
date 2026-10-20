// Firmenversion: Schalter, Firmenprojekte, Netz-Ort, Homeoffice-Monatszahlen, Monatssperre und
// Row-Level-Security der neuen Tabellen (Mandantentrennung, Kalender nur für die Person selbst).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, withMember, withUser } from '../src/db/index.js';
import {
  auditLog,
  calendarConnections,
  calendarEntries,
  dayLocations,
  projectAssignments,
  projects,
} from '../src/db/schema.js';
import { type TestEnv, createTestEnv, event } from './helpers.js';
import { type OrgSetup, api, createOrg, setupOrg, workday } from './org-helpers.js';

let env: TestEnv;
let org: OrgSetup;
let foreign: Awaited<ReturnType<typeof createOrg>>;
let general: string;
let teamB: string;
let networkId: string;
beforeAll(async () => {
  env = await createTestEnv();
  org = await setupOrg(env);
  foreign = await createOrg(env, 'Fremd');
});
afterAll(() => env.close());

async function auditActions(orgId: string): Promise<string[]> {
  const rows = await asOwner(env.database.db, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, orgId)),
  );
  return rows.map((r) => r.action);
}

interface Share {
  projectId: string | null;
  netMinutes: number;
}

describe('Schalter und Firmenprojekte', () => {
  it('Projekte sind aus; nur Admins schalten sie ein', async () => {
    const f = await api<{ projects: boolean; calendar: boolean; homeOfficeReport: boolean }>(
      env,
      org.admin,
      'GET',
      '/org/features',
    );
    expect(f.body).toEqual({ projects: false, calendar: true, homeOfficeReport: false });
    expect((await api(env, org.member, 'GET', '/org/features')).status).toBe(403);
    expect((await api(env, org.manager, 'PUT', '/org/features', { projects: true })).status).toBe(
      403,
    );
    expect((await api(env, org.member, 'GET', '/days/2026-10-14/projects')).status).toBe(403);
    // Ein privater Schalter in den Einstellungen hilft Firmenmitgliedern nicht
    await api(env, org.member, 'PUT', '/settings', { settings: { projects: true } });
    expect((await api(env, org.member, 'GET', '/days/2026-10-14/projects')).status).toBe(403);

    const on = await api<{ projects: boolean }>(env, org.admin, 'PUT', '/org/features', {
      projects: true,
    });
    expect(on.body.projects).toBe(true);
    expect(await auditActions(org.orgId)).toContain('features.update');
  });

  it('Admin legt Firmen- und Teamprojekte an; Mitglieder nicht', async () => {
    expect((await api(env, org.member, 'POST', '/projects', { name: 'Privat' })).status).toBe(403);
    const g = await api<{ id: string; scope: string }>(env, org.admin, 'POST', '/org/projects', {
      name: 'Allgemein',
      customer: 'Intern',
    });
    expect(g.body.scope).toBe('org');
    general = g.body.id;
    const b = await api<{ id: string; teamId: string }>(env, org.admin, 'POST', '/org/projects', {
      name: 'Nur Team B',
      teamId: org.teamB,
    });
    expect(b.body.teamId).toBe(org.teamB);
    teamB = b.body.id;
    const foreignTeam = await api<{ id: string }>(env, foreign, 'POST', '/org/teams', {
      name: 'X',
    });
    expect(
      (
        await api(env, org.admin, 'POST', '/org/projects', {
          name: 'Falsch',
          teamId: foreignTeam.body.id,
        })
      ).status,
    ).toBe(400);
    expect((await api(env, org.manager, 'POST', '/org/projects', { name: 'M' })).status).toBe(403);

    const seen = await api<{ enabled: boolean; canManage: boolean; projects: { id: string }[] }>(
      env,
      org.member,
      'GET',
      '/projects',
    );
    expect(seen.body.enabled).toBe(true);
    expect(seen.body.canManage).toBe(false);
    expect(seen.body.projects.map((p) => p.id)).toEqual([general]);
    const other = await api<{ projects: { id: string }[] }>(env, org.other, 'GET', '/projects');
    expect(other.body.projects.map((p) => p.id).sort()).toEqual([general, teamB].sort());
    expect(await auditActions(org.orgId)).toContain('project.create');
  });

  it('Firmen-Netz mit Ort Homeoffice und Standardprojekt', async () => {
    const add = await api<{ id: string }>(env, org.admin, 'POST', '/org/networks', {
      kind: 'fingerprint',
      label: 'Telearbeit',
      fingerprint: 'gw:11-22-33-44-55-66',
    });
    networkId = add.body.id;
    const upd = await api<{ location: string; defaultProjectId?: string }>(
      env,
      org.admin,
      'PATCH',
      `/org/networks/${networkId}`,
      { location: 'home', defaultProjectId: general },
    );
    expect(upd.body).toMatchObject({ location: 'home', defaultProjectId: general });
    const fp = await api<{ id: string }>(env, foreign, 'POST', '/org/projects', { name: 'F' });
    expect(
      (
        await api(env, org.admin, 'PATCH', `/org/networks/${networkId}`, {
          defaultProjectId: fp.body.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(env, foreign, 'PATCH', `/org/networks/${networkId}`, { location: 'office' }))
        .status,
    ).toBe(404);

    for (const p of [org.member, org.other]) {
      await workday(env, p);
      await api(env, p, 'POST', '/events/batch', {
        events: [
          event('net_connected', '2026-10-14T06:01:00Z', { networkId }),
          event('net_lost', '2026-10-14T15:04:00Z', { networkId }),
        ],
      });
    }
    const day = await api<{ day: { items: Share[] } }>(
      env,
      org.member,
      'GET',
      '/days/2026-10-14/projects',
    );
    expect(day.body.day.items.find((i) => i.projectId === general)?.netMinutes).toBeGreaterThan(
      480,
    );
    // Mitglied darf ein Teamprojekt eines anderen Teams nicht buchen
    expect(
      (
        await api(env, org.member, 'POST', '/days/2026-10-14/projects', {
          from: '2026-10-14T07:00:00Z',
          to: '2026-10-14T08:00:00Z',
          projectId: teamB,
        })
      ).status,
    ).toBe(400);
  });

  it('Projektauswertung für Admins nur als Summe, nie je Person', async () => {
    const r = await api<{ totals: Share[]; days: unknown[] }>(
      env,
      org.admin,
      'GET',
      '/org/projects/report?from=2026-10-01&to=2026-10-31',
    );
    expect(r.status).toBe(200);
    expect(r.body.totals.reduce((s, t) => s + t.netMinutes, 0)).toBe(1000);
    expect(r.raw).not.toContain(org.member.userId);
    const team = await api<{ totals: Share[] }>(
      env,
      org.admin,
      'GET',
      `/org/projects/report?from=2026-10-01&to=2026-10-31&teamId=${org.teamA}`,
    );
    expect(team.body.totals.reduce((s, t) => s + t.netMinutes, 0)).toBe(500);
    expect(
      (await api(env, org.manager, 'GET', '/org/projects/report?from=2026-10-01&to=2026-10-31'))
        .status,
    ).toBe(403);
  });

  it('Homeoffice-Monatszahlen nur mit Schalter, nur Anzahl, protokolliert', async () => {
    expect((await api(env, org.admin, 'GET', '/org/home-office?year=2026')).status).toBe(403);
    await api(env, org.admin, 'PUT', '/org/features', { homeOfficeReport: true });
    const res = await api<{ members: { userId: string; homeDaysByMonth: number[] }[] }>(
      env,
      org.admin,
      'GET',
      '/org/home-office?year=2026',
    );
    expect(res.status).toBe(200);
    const m = res.body.members.find((x) => x.userId === org.member.userId);
    expect(m?.homeDaysByMonth).toHaveLength(12);
    expect(m?.homeDaysByMonth[9]).toBe(1);
    expect(res.raw).not.toContain('2026-10-14');
    expect(await auditActions(org.orgId)).toContain('home_office.view');
    expect((await api(env, org.manager, 'GET', '/org/home-office?year=2026')).status).toBe(403);
  });
});

describe('Freigegebene Monate', () => {
  it('sperren Zuordnung und Tagesort; Snapshot (v2) wird nie neu berechnet', async () => {
    const m = org.member;
    await api(env, m, 'POST', '/approvals/2026-10');
    const ok = await api(
      env,
      org.manager,
      'POST',
      `/org/approvals/${m.userId}/2026-10/approve`,
      {},
    );
    expect(ok.status).toBe(200);
    expect(
      (
        await api(env, m, 'POST', '/days/2026-10-14/projects', {
          from: '2026-10-14T07:00:00Z',
          to: '2026-10-14T08:00:00Z',
          projectId: null,
        })
      ).status,
    ).toBe(409);
    expect(
      (await api(env, m, 'PUT', '/days/2026-10-14/location', { location: 'office' })).status,
    ).toBe(409);

    // Spätere Änderungen an Netz und Projekt ändern den freigegebenen Monat nicht
    await api(env, org.admin, 'PATCH', `/org/networks/${networkId}`, {
      location: 'office',
      defaultProjectId: null,
    });
    const day = await api<{ day: { items: Share[] }; locked: boolean }>(
      env,
      m,
      'GET',
      '/days/2026-10-14/projects',
    );
    expect(day.body.locked).toBe(true);
    expect(day.body.day.items.find((i) => i.projectId === general)?.netMinutes).toBeGreaterThan(
      480,
    );
    const loc = await api<{ days: { date: string; location: string }[] }>(
      env,
      m,
      'GET',
      '/locations?year=2026',
    );
    expect(loc.body.days.find((d) => d.date === '2026-10-14')?.location).toBe('home');
    // Nicht freigegebenes Mitglied: neu berechnet
    const other = await api<{ days: { date: string; location: string }[] }>(
      env,
      org.other,
      'GET',
      '/locations?year=2026',
    );
    expect(other.body.days.find((d) => d.date === '2026-10-14')?.location).toBe('office');
  });
});

describe('RLS der neuen Tabellen', () => {
  const scope = (p: { userId: string }, orgId = org.orgId) => ({ userId: p.userId, orgId });

  it('Kalenderdaten sieht nur die Person selbst – auch kein Admin im Auftrag', async () => {
    const connId = randomUUID();
    await asOwner(env.database.db, async (tx) => {
      await tx.insert(calendarConnections).values({
        id: connId,
        userId: org.member.userId,
        provider: 'google',
        refreshToken: 'x',
      });
      await tx.insert(calendarEntries).values({
        userId: org.member.userId,
        connectionId: connId,
        startAt: new Date('2026-10-14T08:00:00Z'),
        endAt: new Date('2026-10-14T09:00:00Z'),
        allDay: false,
        kind: 'busy',
      });
    });
    const own = await withUser(env.database.db, scope(org.member), (tx) =>
      tx.select().from(calendarEntries),
    );
    expect(own).toHaveLength(1);
    const asAdmin = await withMember(
      env.database.db,
      scope(org.admin),
      org.member.userId,
      async (tx) => ({
        entries: await tx.select().from(calendarEntries),
        conns: await tx.select().from(calendarConnections),
      }),
    );
    expect(asAdmin).toEqual({ entries: [], conns: [] });
    const adminSelf = await withUser(env.database.db, scope(org.admin), (tx) =>
      tx.select().from(calendarEntries),
    );
    expect(adminSelf).toEqual([]);
    await expect(
      withMember(env.database.db, scope(org.admin), org.member.userId, (tx) =>
        tx.insert(calendarEntries).values({
          userId: org.member.userId,
          connectionId: connId,
          startAt: new Date('2026-10-15T08:00:00Z'),
          endAt: new Date('2026-10-15T09:00:00Z'),
          allDay: false,
          kind: 'busy',
        }),
      ),
    ).rejects.toThrow();
  });

  it('Zuordnungen und Tagesorte: nur eigene; im Auftrag nur Admins', async () => {
    const managerView = await withUser(env.database.db, scope(org.manager), async (tx) => ({
      a: await tx.select().from(projectAssignments),
      l: await tx.select().from(dayLocations),
    }));
    expect(managerView.a.every((r) => r.userId === org.manager.userId)).toBe(true);
    expect(managerView.l.every((r) => r.userId === org.manager.userId)).toBe(true);
    // Manager darf im Auftrag lesen (Team), aber nicht einfügen
    await expect(
      withMember(env.database.db, scope(org.manager), org.member.userId, (tx) =>
        tx.insert(dayLocations).values({
          userId: org.member.userId,
          date: '2026-11-02',
          location: 'home',
          authorId: org.manager.userId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withUser(env.database.db, scope(org.member), (tx) =>
        tx.insert(dayLocations).values({
          userId: org.other.userId,
          date: '2026-11-02',
          location: 'home',
          authorId: org.member.userId,
        }),
      ),
    ).rejects.toThrow();
    // App-Rolle darf nicht ändern oder löschen
    await expect(
      withUser(env.database.db, scope(org.member), (tx) =>
        tx.delete(projectAssignments).where(eq(projectAssignments.userId, org.member.userId)),
      ),
    ).rejects.toThrow();
  });

  it('Projekte: Mandantentrennung; Firmenprojekte ändert nur der Admin', async () => {
    const seen = await withUser(env.database.db, scope(foreign, foreign.orgId), (tx) =>
      tx.select({ id: projects.id }).from(projects),
    );
    expect(seen.map((p) => p.id)).not.toContain(general);
    const changed = await withUser(env.database.db, scope(org.member), (tx) =>
      tx
        .update(projects)
        .set({ name: 'gekapert' })
        .where(eq(projects.id, general))
        .returning({ id: projects.id }),
    );
    expect(changed).toEqual([]);
    await expect(
      withUser(env.database.db, scope(org.member), (tx) =>
        tx.insert(projects).values({ orgId: org.orgId, name: 'heimlich' }),
      ),
    ).rejects.toThrow();
    await expect(
      withUser(env.database.db, scope(org.admin), (tx) =>
        tx.insert(projects).values({ orgId: foreign.orgId, name: 'fremd' }),
      ),
    ).rejects.toThrow();
  });
});
