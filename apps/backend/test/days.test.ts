import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestEnv, createTestEnv, event, registerAndLogin } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('/days und /status', () => {
  it('berechnet Arbeitstage mit dem Regelwerk (Fall 1)', async () => {
    const t = await registerAndLogin(env);
    // Mi 14.10.2026, Europe/Berlin: boot 08:00, shutdown 17:00
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
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/days?from=2026-10-12&to=2026-10-16',
      headers: t.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ days: Record<string, unknown>[]; balanceMinutes: number }>();
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toMatchObject({
      date: '2026-10-14',
      start: '2026-10-14T06:00:00.000Z',
      end: '2026-10-14T15:05:00.000Z',
      workMinutes: 545,
      breakTopUpMin: 45,
      netMinutes: 500,
      status: 'unchecked',
      warnings: ['break_violation', 'break_placement'],
    });
    expect(body.balanceMinutes).toBe(20);
  });

  it('zeigt eine laufende Sitzung im Status', async () => {
    const t = await registerAndLogin(env);
    // now = Do 15.10. 09:00 Berlin; boot 08:00, Spanne offen bis jetzt
    await env.app.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      headers: t.auth,
      payload: {
        events: [event('boot', '2026-10-15T06:00:00Z', { createdAt: '2026-10-15T06:05:00Z' })],
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
            start: '2026-10-15T06:00:00Z',
            end: '2026-10-15T07:00:00Z',
            open: true,
          },
        ],
      },
    });
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/status', headers: t.auth });
    expect(res.json()).toMatchObject({
      date: '2026-10-15',
      running: true,
      since: '2026-10-15T06:00:00.000Z',
      today: { status: 'open', workMinutes: 60 },
      toReview: [],
    });
  });

  it('prüft den Zeitraum', async () => {
    const t = await registerAndLogin(env);
    const get = (q: string) =>
      env.app.inject({ method: 'GET', url: `/api/v1/days?${q}`, headers: t.auth });
    expect((await get('from=2026-10-16&to=2026-10-12')).statusCode).toBe(400);
    expect((await get('from=2026-01-01&to=2026-12-31')).statusCode).toBe(400);
    expect((await get('from=2026-10-01')).statusCode).toBe(400);
    expect((await get('from=2026-10-01&to=2026-10-31')).json()).toEqual({
      days: [],
      balanceMinutes: 0,
    });
  });
});
