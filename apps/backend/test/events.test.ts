import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestEnv, createTestEnv, event, registerAndLogin } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) =>
  env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

describe('/events/batch', () => {
  it('speichert idempotent über (user_id, id)', async () => {
    const t = await registerAndLogin(env);
    const evs = [event('boot', '2026-10-14T06:00:00Z'), event('shutdown', '2026-10-14T15:00:00Z')];
    const first = await call('POST', '/events/batch', t.auth, { events: evs });
    expect(first.json()).toEqual({ accepted: 2, duplicates: 0 });
    const again = await call('POST', '/events/batch', t.auth, { events: evs });
    expect(again.json()).toEqual({ accepted: 0, duplicates: 2 });
  });

  it('setzt user_id und device_id aus dem Token, nicht aus dem Request', async () => {
    const a = await registerAndLogin(env);
    const b = await registerAndLogin(env);
    const e = {
      ...event('boot', '2026-10-14T06:00:00Z'),
      userId: b.deviceId,
      deviceId: b.deviceId,
    };
    expect((await call('POST', '/events/batch', a.auth, { events: [e] })).statusCode).toBe(200);
    const listA = await call('GET', '/events', a.auth);
    const stored = listA.json<{ events: { id: string; deviceId: string }[] }>().events;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.deviceId).toBe(a.deviceId);
    expect((await call('GET', '/events', b.auth)).json()).toMatchObject({ events: [] });
  });

  it('fremde Event-IDs berühren keine Daten anderer Nutzer', async () => {
    const a = await registerAndLogin(env);
    const b = await registerAndLogin(env);
    const original = event('boot', '2026-10-14T06:00:00Z');
    await call('POST', '/events/batch', a.auth, { events: [original] });
    // B sendet dieselbe ID mit anderem Inhalt
    const forged = {
      ...original,
      type: 'shutdown',
      ts: '2026-10-14T07:00:00Z',
      createdAt: '2026-10-14T07:00:00Z',
    };
    expect((await call('POST', '/events/batch', b.auth, { events: [forged] })).json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    const aEvents = (await call('GET', '/events', a.auth)).json<{
      events: { id: string; type: string; ts: string }[];
    }>();
    expect(aEvents.events).toEqual([
      expect.objectContaining({ id: original.id, type: 'boot', ts: '2026-10-14T06:00:00.000Z' }),
    ]);
  });

  it('prüft Eingaben und Grenzen', async () => {
    const t = await registerAndLogin(env);
    const bad = await call('POST', '/events/batch', t.auth, {
      events: [{ ...event('boot', 'gestern') }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_request' });
    const tooMany = Array.from({ length: 501 }, () => event('boot', '2026-10-14T06:00:00Z'));
    expect((await call('POST', '/events/batch', t.auth, { events: tooMany })).statusCode).toBe(400);
    const huge = await env.app.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      headers: { ...t.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        events: [event('boot', '2026-10-14T06:00:00Z')],
        pad: 'x'.repeat(300 * 1024),
      }),
    });
    expect(huge.statusCode).toBe(413);
    expect((await call('POST', '/events/batch', {}, { events: [] })).statusCode).toBe(401);
    expect(
      (await call('POST', '/events/batch', { authorization: 'Bearer kaputt' }, { events: [] }))
        .statusCode,
    ).toBe(401);
  });

  it('liefert Ereignisse seitenweise per Cursor', async () => {
    const t = await registerAndLogin(env);
    const evs = Array.from({ length: 5 }, (_, i) =>
      event('net_connected', `2026-10-14T0${String(i)}:00:00Z`),
    );
    await call('POST', '/events/batch', t.auth, { events: evs });
    const p1 = (await call('GET', '/events?limit=3', t.auth)).json<{
      events: unknown[];
      nextCursor: number;
    }>();
    expect(p1.events).toHaveLength(3);
    const p2 = (await call('GET', `/events?since=${String(p1.nextCursor)}`, t.auth)).json<{
      events: unknown[];
      nextCursor: number;
    }>();
    expect(p2.events).toHaveLength(2);
    const p3 = (await call('GET', `/events?since=${String(p2.nextCursor)}`, t.auth)).json<{
      events: unknown[];
      nextCursor: number;
    }>();
    expect(p3).toEqual({ events: [], nextCursor: p2.nextCursor });
  });

  it('begrenzt auf 60 Anfragen je Minute und Gerät', async () => {
    const limited = await createTestEnv({ auth: 1000, device: 60 });
    try {
      const t = await registerAndLogin(limited);
      let last = 0;
      for (let i = 0; i < 61; i++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/api/v1/events/batch',
          headers: t.auth,
          payload: { events: [event('net_connected', '2026-10-14T06:00:00Z')] },
        });
        last = res.statusCode;
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('/presence', () => {
  it('legt Spannen an und verlängert die offene Spanne', async () => {
    const t = await registerAndLogin(env);
    const id = randomUUID();
    const put = (end: string, open: boolean) =>
      call('PUT', '/presence', t.auth, {
        spans: [{ id, start: '2026-10-14T06:00:00Z', end, open }],
      });
    expect((await put('2026-10-14T06:02:00Z', true)).statusCode).toBe(200);
    expect((await put('2026-10-14T08:00:00Z', true)).statusCode).toBe(200);
    // Ein älterer Stand verkürzt die Spanne nicht
    expect((await put('2026-10-14T07:00:00Z', false)).statusCode).toBe(200);
    const list = (await call('GET', '/presence', t.auth)).json<{
      spans: { id: string; end: string; open: boolean; deviceKind: string }[];
    }>();
    expect(list.spans).toEqual([
      expect.objectContaining({
        id,
        end: '2026-10-14T08:00:00.000Z',
        open: false,
        deviceKind: 'desktop',
      }),
    ]);
  });

  it('eine Spanne gehört genau einem Gerät', async () => {
    const t = await registerAndLogin(env);
    const phone = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: t.email,
        password: 'korrekt-pferd-batterie',
        device: { kind: 'mobile', os: 'a', name: 'b' },
      },
    });
    const phoneAuth = {
      authorization: `Bearer ${phone.json<{ accessToken: string }>().accessToken}`,
    };
    const span = {
      id: randomUUID(),
      start: '2026-10-14T06:00:00Z',
      end: '2026-10-14T07:00:00Z',
      open: false,
    };
    expect((await call('PUT', '/presence', t.auth, { spans: [span] })).statusCode).toBe(200);
    expect((await call('PUT', '/presence', phoneAuth, { spans: [span] })).statusCode).toBe(409);
  });
});

describe('Geräte', () => {
  it('aktualisiert das eigene Gerät und sperrt Geräte', async () => {
    const t = await registerAndLogin(env);
    const upd = await call('POST', '/devices', t.auth, { name: 'Arbeitslaptop', pushToken: 'abc' });
    expect(upd.json()).toMatchObject({ id: t.deviceId, name: 'Arbeitslaptop' });
    expect((await call('DELETE', `/devices/${randomUUID()}`, t.auth)).statusCode).toBe(404);
    expect((await call('DELETE', `/devices/${t.deviceId}`, t.auth)).statusCode).toBe(200);
    // Gesperrtes Gerät: Access- und Refresh-Token sind wertlos
    expect((await call('GET', '/devices', t.auth)).json()).toMatchObject({
      error: 'device_revoked',
    });
    const refresh = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: t.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('fremde Geräte lassen sich nicht sperren', async () => {
    const a = await registerAndLogin(env);
    const b = await registerAndLogin(env);
    expect((await call('DELETE', `/devices/${b.deviceId}`, a.auth)).statusCode).toBe(404);
    expect((await call('GET', '/devices', b.auth)).statusCode).toBe(200);
  });
});
