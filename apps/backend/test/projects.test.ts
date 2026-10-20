// Projekte, Projektzuordnung, Tagesort und Homeoffice-Nachweis (Privatkonto).
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { corrections, dayLocations, projectAssignments, projects } from '../src/db/schema.js';
import { PASSWORD, type TestEnv, createTestEnv, event, registerAndLogin } from './helpers.js';
import { api, userIdOf, workday } from './org-helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

type Who = Awaited<ReturnType<typeof registerAndLogin>> & { userId: string };
async function person(): Promise<Who> {
  const t = await registerAndLogin(env);
  return { ...t, userId: await userIdOf(env, t.email) };
}

interface Share {
  projectId: string | null;
  workMinutes: number;
  topUpMinutes: number;
  netMinutes: number;
  manual: boolean;
}
interface DayProjects {
  day: { items: Share[] };
  segments: { from: string; to: string; projectId: string | null; manual: boolean }[];
  locked: boolean;
}

/** Netz „Zuhause“ mit Standardprojekt; Arbeitstag 14.10. komplett in diesem Netz. */
async function homeNetworkDay(t: Who, projectId?: string): Promise<string> {
  const net = await api<{ id: string; location: string; defaultProjectId?: string }>(
    env,
    t,
    'POST',
    '/networks',
    {
      kind: 'fingerprint',
      label: 'Zuhause',
      fingerprint: 'fp-home-1234',
      location: 'home',
      ...(projectId ? { defaultProjectId: projectId } : {}),
    },
  );
  expect(net.status).toBe(200);
  expect(net.body.location).toBe('home');
  await workday(env, t);
  await api(env, t, 'POST', '/events/batch', {
    events: [
      event('net_connected', '2026-10-14T06:01:00Z', { networkId: net.body.id }),
      event('net_lost', '2026-10-14T15:04:00Z', { networkId: net.body.id }),
    ],
  });
  return net.body.id;
}

describe('Projekte (Privatkonto)', () => {
  let t: Who;
  let alpha: string;
  let beta: string;
  beforeAll(async () => {
    t = await person();
  });

  it('standardmäßig aus; Zuordnung und Auswertung dann gesperrt', async () => {
    const list = await api<{ enabled: boolean; canManage: boolean }>(env, t, 'GET', '/projects');
    expect(list.body).toMatchObject({ enabled: false, canManage: true });
    expect((await api(env, t, 'GET', '/days/2026-10-14/projects')).status).toBe(403);
    expect(
      (await api(env, t, 'GET', '/projects/report?from=2026-10-01&to=2026-10-31')).status,
    ).toBe(403);
  });

  it('Anlegen, Ändern, Archivieren; Eingaben werden geprüft', async () => {
    await api(env, t, 'PUT', '/settings', { settings: { projects: true } });
    const a = await api<{ id: string; color: string; archived: boolean }>(
      env,
      t,
      'POST',
      '/projects',
      { name: 'Alpha', customer: 'Kunde A', keywords: ['alpha'] },
    );
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ color: '#1d4ed8', archived: false });
    alpha = a.body.id;
    const b = await api<{ id: string }>(env, t, 'POST', '/projects', {
      name: 'Beta',
      color: '#047857',
    });
    beta = b.body.id;
    expect((await api(env, t, 'POST', '/projects', { name: '' })).status).toBe(400);
    expect((await api(env, t, 'POST', '/projects', { name: 'X', color: 'red' })).status).toBe(400);
    const upd = await api<{ name: string }>(env, t, 'PATCH', `/projects/${beta}`, {
      name: 'Beta 2',
    });
    expect(upd.body.name).toBe('Beta 2');
  });

  it('Netz-Standardprojekt bucht automatisch; Tagesort Homeoffice', async () => {
    await homeNetworkDay(t, alpha);
    const day = await api<DayProjects>(env, t, 'GET', '/days/2026-10-14/projects');
    expect(day.status).toBe(200);
    // 06:01–15:04 im Netz, die erste und letzte Minute ohne Projekt
    const auto = new Map(day.body.day.items.map((i) => [i.projectId, i]));
    expect(auto.get(alpha)).toMatchObject({ workMinutes: 543, manual: false });
    expect(auto.get(null)?.workMinutes).toBe(2);
    expect(day.body.day.items.reduce((s, i) => s + i.netMinutes, 0)).toBe(500);
    expect(day.body.segments.find((s) => s.projectId === alpha)?.manual).toBe(false);
    const loc = await api<{
      days: { date: string; location: string; source: string }[];
      summary: { homeDays: number; amountCents: number };
      allowance: { perDayCents: number; legalBasis: string };
    }>(env, t, 'GET', '/locations?year=2026');
    expect(loc.body.days).toEqual([
      expect.objectContaining({ date: '2026-10-14', location: 'home', source: 'auto' }),
    ]);
    expect(loc.body.summary).toMatchObject({ homeDays: 1, amountCents: 600 });
    expect(loc.body.allowance.legalBasis).toContain('Nr. 6c EStG');
  });

  it('manuell überschreibt die Automatik, ist unveränderlich und protokolliert', async () => {
    const res = await api<DayProjects>(env, t, 'POST', '/days/2026-10-14/projects', {
      from: '2026-10-14T12:00:00Z',
      to: '2026-10-14T15:05:00Z',
      projectId: beta,
      reason: 'Nachmittag Beta',
    });
    expect(res.status).toBe(200);
    const items = new Map(res.body.day.items.map((i) => [i.projectId, i]));
    expect(items.get(beta)).toMatchObject({ manual: true });
    expect(items.get(beta)?.workMinutes).toBe(185);
    // Summe = Netto, nie negativ
    expect(res.body.day.items.reduce((s, i) => s + i.netMinutes, 0)).toBe(500);
    expect(res.body.day.items.every((i) => i.netMinutes >= 0)).toBe(true);

    const rows = await asOwner(env.database.db, async (tx) => ({
      assignments: await tx
        .select()
        .from(projectAssignments)
        .where(eq(projectAssignments.userId, t.userId)),
      corrections: await tx.select().from(corrections).where(eq(corrections.userId, t.userId)),
    }));
    expect(rows.assignments).toHaveLength(1);
    expect(rows.corrections).toEqual([
      expect.objectContaining({
        field: 'project',
        eventId: rows.assignments[0]?.id,
        reason: 'Nachmittag Beta',
      }),
    ]);
    // Datenbank verhindert Änderungen (auch für den Eigentümer der Tabelle)
    await expect(
      asOwner(env.database.db, (tx) =>
        tx
          .update(projectAssignments)
          .set({ projectId: alpha })
          .where(eq(projectAssignments.userId, t.userId)),
      ),
    ).rejects.toThrow();

    // unbekannte oder archivierte Projekte, Zeiträume außerhalb des Tages
    await api(env, t, 'PATCH', `/projects/${beta}`, { archived: true });
    expect(
      (
        await api(env, t, 'POST', '/days/2026-10-14/projects', {
          from: '2026-10-14T07:00:00Z',
          to: '2026-10-14T08:00:00Z',
          projectId: beta,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(env, t, 'POST', '/days/2026-10-14/projects', {
          from: '2026-10-20T07:00:00Z',
          to: '2026-10-20T08:00:00Z',
          projectId: alpha,
        })
      ).status,
    ).toBe(400);
    await api(env, t, 'PATCH', `/projects/${beta}`, { archived: false });
  });

  it('Auswertung je Projekt und Kunde; CSV/PDF-Export mit Projektspalte', async () => {
    const r = await api<{
      totals: { projectId: string | null; netMinutes: number }[];
      customers: { customer: string | null; netMinutes: number }[];
    }>(env, t, 'GET', '/projects/report?from=2026-10-01&to=2026-10-31');
    expect(r.status).toBe(200);
    expect(r.body.totals.reduce((s, x) => s + x.netMinutes, 0)).toBe(500);
    expect(r.body.customers.find((c) => c.customer === 'Kunde A')?.netMinutes).toBeGreaterThan(0);

    const csv = await env.app.inject({
      method: 'GET',
      url: '/api/v1/projects/export?from=2026-10-01&to=2026-10-31&format=csv',
      headers: t.auth,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.startsWith('﻿')).toBe(true);
    expect(csv.body).toContain('Alpha');
    const pdf = await env.app.inject({
      method: 'GET',
      url: '/api/v1/projects/export?from=2026-10-01&to=2026-10-31&format=pdf',
      headers: t.auth,
    });
    expect(pdf.body.startsWith('%PDF')).toBe(true);

    const work = await env.app.inject({
      method: 'GET',
      url: '/api/v1/export?from=2026-10-14&to=2026-10-14&format=csv',
      headers: t.auth,
    });
    const lines = work.body.slice(1).trim().split('\r\n');
    expect(lines[0]?.split(';').at(-1)).toBe('Projekte');
    expect(lines[1]).toContain('Alpha');
    expect(lines[1]).toContain('Beta 2');
  });

  it('Tagesort manuell korrigieren (gesperrt, nur Insert) und Nachweis exportieren', async () => {
    const set = await api<{ location: string; source: string }>(
      env,
      t,
      'PUT',
      '/days/2026-10-14/location',
      { location: 'office' },
    );
    expect(set.body).toMatchObject({ location: 'office', source: 'manual' });
    env.clock.now += 60_000;
    const extra = await api<{ location: string }>(env, t, 'PUT', '/days/2026-10-17/location', {
      location: 'home',
    });
    expect(extra.body.location).toBe('home');
    const year = await api<{ summary: { homeDays: number; officeDays: number } }>(
      env,
      t,
      'GET',
      '/locations?year=2026',
    );
    expect(year.body.summary).toMatchObject({ homeDays: 1, officeDays: 1 });
    // zurück zur Automatik (jüngste Angabe gewinnt)
    env.clock.now += 60_000;
    const reset = await api<{ location: string; source: string }>(
      env,
      t,
      'PUT',
      '/days/2026-10-14/location',
      { location: null },
    );
    expect(reset.body).toMatchObject({ location: 'home', source: 'auto' });
    const rows = await asOwner(env.database.db, (tx) =>
      tx.select().from(dayLocations).where(eq(dayLocations.userId, t.userId)),
    );
    expect(rows).toHaveLength(3);

    const csv = await env.app.inject({
      method: 'GET',
      url: '/api/v1/locations/export?year=2026&format=csv',
      headers: t.auth,
    });
    expect(csv.body).toContain('Homeoffice-Tage;2');
    expect(csv.body).toContain('12,00 EUR');
    const pdf = await env.app.inject({
      method: 'GET',
      url: '/api/v1/locations/export?year=2026&format=pdf',
      headers: t.auth,
    });
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('Netz ändern: Ort und Standardprojekt; fremde Projekte abgelehnt', async () => {
    const other = await person();
    await api(env, other, 'PUT', '/settings', { settings: { projects: true } });
    const foreign = await api<{ id: string }>(env, other, 'POST', '/projects', { name: 'Fremd' });
    const nets = await api<{ networks: { id: string }[] }>(env, t, 'GET', '/networks');
    const id = nets.body.networks[0]?.id ?? '';
    const ok = await api<{ location: string; defaultProjectId?: string }>(
      env,
      t,
      'PATCH',
      `/networks/${id}`,
      { location: 'office', defaultProjectId: null },
    );
    expect(ok.body.location).toBe('office');
    expect(ok.body.defaultProjectId).toBeUndefined();
    expect(
      (await api(env, t, 'PATCH', `/networks/${id}`, { defaultProjectId: foreign.body.id })).status,
    ).toBe(400);
    // fremde Projekte sind unsichtbar und nicht änderbar
    const seen = await api<{ projects: { id: string }[] }>(env, t, 'GET', '/projects');
    expect(seen.body.projects.map((p) => p.id)).not.toContain(foreign.body.id);
    expect((await api(env, t, 'PATCH', `/projects/${foreign.body.id}`, { name: 'x' })).status).toBe(
      404,
    );
  });

  it('Datenauskunft enthält Projekte und Orte; Kontolöschung entfernt alles', async () => {
    const data = await api<{
      projects: unknown[];
      projectAssignments: unknown[];
      dayLocations: unknown[];
      calendarConnections: unknown[];
    }>(env, t, 'GET', '/me/export');
    expect(data.body.projects).toHaveLength(2);
    expect(data.body.projectAssignments).toHaveLength(1);
    expect(data.body.dayLocations).toHaveLength(3);
    expect(data.body.calendarConnections).toEqual([]);

    expect((await api(env, t, 'DELETE', '/me', { password: PASSWORD })).status).toBe(200);
    const left = await asOwner(env.database.db, async (tx) => [
      ...(await tx.select().from(projects).where(eq(projects.userId, t.userId))),
      ...(await tx
        .select()
        .from(projectAssignments)
        .where(eq(projectAssignments.userId, t.userId))),
      ...(await tx.select().from(dayLocations).where(eq(dayLocations.userId, t.userId))),
    ]);
    expect(left).toEqual([]);
  });
});
