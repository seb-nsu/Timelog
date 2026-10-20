// Export (CSV/PDF), Datenauskunft, Kontolöschung und Lösch-Job.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { devices, events, organizations, users } from '../src/db/schema.js';
import { purgeExpired } from '../src/jobs/purge.js';
import {
  PASSWORD,
  type TestEnv,
  createTestEnv,
  event,
  login,
  registerAndLogin,
} from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

type Login = Awaited<ReturnType<typeof registerAndLogin>>;

async function workday(t: Login) {
  await env.app.inject({
    method: 'POST',
    url: '/api/v1/events/batch',
    headers: t.auth,
    payload: {
      events: [
        event('boot', '2026-10-14T06:00:00Z', { createdAt: '2026-10-14T06:05:00Z' }),
        event('shutdown', '2026-10-14T15:00:00Z'),
      ],
    },
  });
  await env.app.inject({
    method: 'PUT',
    url: '/api/v1/presence',
    headers: t.auth,
    payload: {
      spans: [
        {
          id: randomUUID(),
          start: '2026-10-14T06:00:00Z',
          end: '2026-10-14T15:00:00Z',
          open: false,
        },
      ],
    },
  });
}

async function findUser(id: string) {
  const [u] = await asOwner(env.database.db, (tx) =>
    tx.select().from(users).where(eq(users.id, id)),
  );
  return u;
}

async function userIdOf(email: string): Promise<string> {
  const [u] = await asOwner(env.database.db, (tx) =>
    tx.select().from(users).where(eq(users.email, email)),
  );
  if (!u) throw new Error('user');
  return u.id;
}

describe('Export', () => {
  it('CSV mit BOM, Semikolon und Pause inklusive Auffüllung', async () => {
    const t = await registerAndLogin(env);
    await env.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: t.auth,
      payload: { settings: { personnelNumber: '4711' } },
    });
    await workday(t);
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/export?from=2026-10-01&to=2026-10-31&format=csv',
      headers: t.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('arbeitszeit_2026-10-01_2026-10-31.csv');
    expect(res.body.startsWith('﻿')).toBe(true);
    const lines = res.body.slice(1).trim().split('\r\n');
    expect(lines[0]?.split(';')[0]).toBe('Personalnummer');
    expect(lines[1]).toBe(
      '4711;2026-10-14;08:00;17:05;45;45;500;0;ungeprüft;nein;break_violation break_placement',
    );
  });

  it('PDF ist ein gültiges Dokument', async () => {
    const t = await registerAndLogin(env);
    await workday(t);
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/export?from=2026-10-01&to=2026-10-31&format=pdf',
      headers: t.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const raw = res.rawPayload.toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(raw).toContain('(2026-10-14)');
    // xref-Offset zeigt auf die xref-Tabelle
    const offset = Number(/startxref\n(\d+)/.exec(raw)?.[1]);
    expect(raw.slice(offset, offset + 4)).toBe('xref');
  });

  it('lehnt zu lange Zeiträume ab', async () => {
    const t = await registerAndLogin(env);
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/export?from=2025-01-01&to=2026-10-31',
      headers: t.auth,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Datenauskunft', () => {
  it('enthält eigene Daten ohne Passwort-Hash oder TOTP-Geheimnis', async () => {
    const t = await registerAndLogin(env);
    await workday(t);
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/me/export', headers: t.auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ user: { email: string }; events: unknown[]; devices: unknown[] }>();
    expect(body.user.email).toBe(t.email);
    expect(body.events).toHaveLength(2);
    expect(body.devices).toHaveLength(1);
    expect(res.body).not.toContain('argon2');
    expect(res.body).not.toContain('passwordHash');
  });
});

describe('Kontolöschung', () => {
  it('Privatkonto: alles sofort gelöscht, falsches Passwort abgelehnt', async () => {
    const t = await registerAndLogin(env);
    await workday(t);
    const id = await userIdOf(t.email);
    const wrong = await env.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: t.auth,
      payload: { password: 'falsch' },
    });
    expect(wrong.statusCode).toBe(403);

    const res = await env.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: t.auth,
      payload: { password: PASSWORD },
    });
    expect(res.json()).toEqual({ mode: 'deleted' });
    expect(await findUser(id)).toBeUndefined();
    const left = await asOwner(env.database.db, (tx) =>
      tx.select().from(events).where(eq(events.userId, id)),
    );
    expect(left).toHaveLength(0);
    const after = await env.app.inject({ method: 'GET', url: '/api/v1/status', headers: t.auth });
    expect(after.statusCode).toBe(401);
  });

  it('Firmenkonto: anonymisiert, Löschung nach Ablauf der Frist durch den Job', async () => {
    const t = await registerAndLogin(env);
    const id = await userIdOf(t.email);
    const orgId = await asOwner(env.database.db, async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: 'Firma', plan: 'company', retentionYears: 2 })
        .returning();
      if (!org) throw new Error('org');
      await tx.update(users).set({ orgId: org.id }).where(eq(users.id, id));
      return org.id;
    });
    const c = await login(env, t.email);
    await workday(c);

    const res = await env.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: c.auth,
      payload: { password: PASSWORD },
    });
    expect(res.json()).toEqual({ mode: 'anonymized' });
    const anon = await findUser(id);
    expect(anon).toMatchObject({ name: 'Gelöschtes Konto', totpSecret: null, orgId });
    expect(anon?.email).not.toBe(t.email);
    expect(anon?.deletedAt).toBeInstanceOf(Date);
    const devs = await asOwner(env.database.db, (tx) =>
      tx.select().from(devices).where(eq(devices.userId, id)),
    );
    expect(devs.every((d) => d.revokedAt !== null)).toBe(true);
    // Arbeitszeitdaten bleiben während der Aufbewahrungsfrist erhalten
    const kept = await asOwner(env.database.db, (tx) =>
      tx.select().from(events).where(eq(events.userId, id)),
    );
    expect(kept).toHaveLength(2);
    const relogin = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: t.email,
        password: PASSWORD,
        device: { kind: 'desktop', os: 'x', name: 'x' },
      },
    });
    expect(relogin.statusCode).toBe(401);

    // Innerhalb der Frist: nichts löschen
    await purgeExpired(env.database.db, Date.parse('2027-10-20T03:00:00Z'));
    expect(await findUser(id)).toBeDefined();
    // Nach Ablauf der Frist: Konto und Daten weg
    await purgeExpired(env.database.db, Date.parse('2028-10-21T03:00:00Z'));
    expect(await findUser(id)).toBeUndefined();
  });
});
