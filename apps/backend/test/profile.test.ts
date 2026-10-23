// Einstellungen, Arbeitsnetze (nur HMAC), Sollzeiten, Abwesenheiten, Feiertage.
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { users, workNetworks } from '../src/db/schema.js';
import { type TestEnv, createTestEnv, registerAndLogin } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('Einstellungen', () => {
  it('liefert Standardwerte und speichert Änderungen', async () => {
    const t = await registerAndLogin(env);
    const get = await env.app.inject({ method: 'GET', url: '/api/v1/settings', headers: t.auth });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      email: t.email,
      settings: { triggers: { boot: true, geofence: false } },
    });

    const put = await env.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: t.auth,
      payload: { state: 'BY', settings: { triggers: { geofence: true }, personnelNumber: '4711' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      state: 'BY',
      settings: { triggers: { geofence: true, boot: true }, personnelNumber: '4711' },
    });
  });
});

describe('Arbeitsnetze', () => {
  it('speichert BSSID und Kennung nur als HMAC und liefert den Schlüssel', async () => {
    const t = await registerAndLogin(env);
    const put = await env.app.inject({
      method: 'PUT',
      url: '/api/v1/networks',
      headers: t.auth,
      payload: {
        networks: [
          { kind: 'ssid', label: 'Büro', ssid: 'Firma-WLAN', bssid: 'AA-BB-CC-DD-EE-FF' },
          { kind: 'fingerprint', label: 'LAN', fingerprint: 'gateway-mac-11:22:33:44:55:66' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await env.app.inject({ method: 'GET', url: '/api/v1/networks', headers: t.auth });
    const body = get.json<{
      networks: { kind: string; ssid?: string; bssidHmac?: string; fingerprintHmac?: string }[];
      keys: { user: string };
    }>();
    expect(body.networks).toHaveLength(2);
    const key = Buffer.from(body.keys.user, 'base64');
    const hmac = (v: string) => createHmac('sha256', key).update(v).digest('hex');
    const ssid = body.networks.find((n) => n.kind === 'ssid');
    // Normalisiert: Kleinbuchstaben, Doppelpunkte – der Client kann denselben Wert bilden
    expect(ssid?.bssidHmac).toBe(hmac('aa:bb:cc:dd:ee:ff'));
    expect(ssid?.ssid).toBe('Firma-WLAN');

    const [u] = await asOwner(env.database.db, (tx) =>
      tx.select().from(users).where(eq(users.email, t.email)),
    );
    const raw = await asOwner(env.database.db, (tx) =>
      tx
        .select()
        .from(workNetworks)
        .where(eq(workNetworks.userId, u?.id ?? '')),
    );
    const stored = JSON.stringify(raw).toLowerCase();
    expect(stored).not.toContain('aa:bb:cc');
    expect(stored).not.toContain('aa-bb-cc');
    expect(stored).not.toContain('gateway-mac');

    // Ersetzen statt Anhängen
    await env.app.inject({
      method: 'PUT',
      url: '/api/v1/networks',
      headers: t.auth,
      payload: { networks: [] },
    });
    const empty = await env.app.inject({ method: 'GET', url: '/api/v1/networks', headers: t.auth });
    expect(empty.json<{ networks: unknown[] }>().networks).toHaveLength(0);
  });

  it('Schlüssel ist je Nutzer verschieden', async () => {
    const a = await registerAndLogin(env);
    const b = await registerAndLogin(env);
    const key = async (t: typeof a) =>
      (await env.app.inject({ method: 'GET', url: '/api/v1/networks', headers: t.auth })).json<{
        keys: { user: string };
      }>().keys.user;
    expect(await key(a)).not.toBe(await key(b));
  });
});

describe('Sollzeiten und Abwesenheiten', () => {
  it('Teilzeit ab einem Datum ändert das Soll und damit den Saldo', async () => {
    const t = await registerAndLogin(env);
    const put = await env.app.inject({
      method: 'PUT',
      url: '/api/v1/target-hours',
      headers: t.auth,
      payload: { validFrom: '2026-10-01', minutesByWeekday: [0, 240, 240, 240, 240, 240, 0] },
    });
    expect(put.statusCode).toBe(200);
    const get = await env.app.inject({
      method: 'GET',
      url: '/api/v1/target-hours',
      headers: t.auth,
    });
    expect(get.json()).toEqual({
      schedule: [{ validFrom: '2026-10-01', minutesByWeekday: [0, 240, 240, 240, 240, 240, 0] }],
    });
    await env.app.inject({
      method: 'PUT',
      url: '/api/v1/absences',
      headers: t.auth,
      payload: {
        from: '2026-10-12',
        to: '2026-10-12',
        absences: [{ date: '2026-10-12', kind: 'vacation', minutes: 240 }],
      },
    });
    const days = await env.app.inject({
      method: 'GET',
      url: '/api/v1/days?from=2026-10-12&to=2026-10-12',
      headers: t.auth,
    });
    const body = days.json<{ days: { targetMinutes: number }[]; balanceMinutes: number }>();
    expect(body.days[0]?.targetMinutes).toBe(240);
    expect(body.balanceMinutes).toBe(0);
  });

  it('Abwesenheiten ersetzen den Zeitraum und zählen als Ist', async () => {
    const t = await registerAndLogin(env);
    const put = await env.app.inject({
      method: 'PUT',
      url: '/api/v1/absences',
      headers: t.auth,
      payload: {
        from: '2026-10-12',
        to: '2026-10-16',
        absences: [
          { date: '2026-10-12', kind: 'vacation', minutes: 480 },
          { date: '2026-10-13', kind: 'sick', minutes: 480, note: 'AU' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const outside = await env.app.inject({
      method: 'PUT',
      url: '/api/v1/absences',
      headers: t.auth,
      payload: {
        from: '2026-10-12',
        to: '2026-10-16',
        absences: [{ date: '2026-11-01', kind: 'other', minutes: 60 }],
      },
    });
    expect(outside.statusCode).toBe(400);

    const get = await env.app.inject({
      method: 'GET',
      url: '/api/v1/absences?from=2026-10-01&to=2026-10-31',
      headers: t.auth,
    });
    expect(get.json<{ absences: unknown[] }>().absences).toEqual([
      { date: '2026-10-12', kind: 'vacation', minutes: 480 },
      { date: '2026-10-13', kind: 'sick', minutes: 480, note: 'AU' },
    ]);
    const days = await env.app.inject({
      method: 'GET',
      url: '/api/v1/days?from=2026-10-12&to=2026-10-13',
      headers: t.auth,
    });
    expect(days.json<{ balanceMinutes: number }>().balanceMinutes).toBe(0);
  });

  it('Feiertage im Bundesland', async () => {
    const t = await registerAndLogin(env);
    await env.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: t.auth,
      payload: { state: 'BY' },
    });
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/holidays?year=2026',
      headers: t.auth,
    });
    const body = res.json<{ state: string; holidays: { date: string }[] }>();
    expect(body.state).toBe('BY');
    expect(body.holidays.map((h) => h.date)).toEqual(
      expect.arrayContaining(['2026-01-06', '2026-10-03']),
    );
  });
});

describe('Arbeitsnetz hinzufügen und entfernen', () => {
  it('POST fügt hinzu, DELETE entfernt nur eigene Netze', async () => {
    const a = await registerAndLogin(env);
    const b = await registerAndLogin(env);
    const add = await env.app.inject({
      method: 'POST',
      url: '/api/v1/networks',
      headers: a.auth,
      payload: {
        kind: 'fingerprint',
        label: 'Dock',
        fingerprint: 'gw:aa:bb:cc:dd:ee:ff|dns:firma.local',
      },
    });
    expect(add.statusCode).toBe(200);
    const net = add.json<{ id: string; fingerprintHmac: string; scope: string }>();
    expect(net.scope).toBe('user');
    expect(net.fingerprintHmac).toMatch(/^[0-9a-f]{64}$/);

    const second = await env.app.inject({
      method: 'POST',
      url: '/api/v1/networks',
      headers: a.auth,
      payload: { kind: 'ssid', label: 'Büro', ssid: 'Firma' },
    });
    expect(second.statusCode).toBe(200);

    const foreign = await env.app.inject({
      method: 'DELETE',
      url: `/api/v1/networks/${net.id}`,
      headers: b.auth,
    });
    expect(foreign.statusCode).toBe(404);
    const del = await env.app.inject({
      method: 'DELETE',
      url: `/api/v1/networks/${net.id}`,
      headers: a.auth,
    });
    expect(del.statusCode).toBe(200);
    const list = await env.app.inject({ method: 'GET', url: '/api/v1/networks', headers: a.auth });
    expect(list.json<{ networks: { label: string }[] }>().networks.map((n) => n.label)).toEqual([
      'Büro',
    ]);
  });
});
