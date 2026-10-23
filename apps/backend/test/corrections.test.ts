// Korrekturen als Ereignisse, Bestätigen/Verwerfen und gesperrte Monate.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { approvals, corrections, events, organizations, users } from '../src/db/schema.js';
import { type TestEnv, createTestEnv, event, login, registerAndLogin } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

type Login = Awaited<ReturnType<typeof registerAndLogin>>;

async function workday(t: Login) {
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
}

async function userId(email: string): Promise<string> {
  const [u] = await asOwner(env.database.db, (tx) =>
    tx.select().from(users).where(eq(users.email, email)),
  );
  if (!u) throw new Error('user');
  return u.id;
}

describe('Korrekturen', () => {
  it('Start korrigieren erzeugt manual_start und corrections-Zeile; Wert ist gesperrt', async () => {
    const t = await registerAndLogin(env);
    await workday(t);
    const res = await env.app.inject({
      method: 'PATCH',
      url: '/api/v1/days/2026-10-14',
      headers: t.auth,
      payload: { field: 'start', time: '2026-10-14T05:30:00Z', reason: 'früher angefangen' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ eventId: string; day: Record<string, unknown> }>();
    expect(body.day).toMatchObject({
      date: '2026-10-14',
      start: '2026-10-14T05:30:00.000Z',
      corrected: true,
    });

    const id = await userId(t.email);
    const rows = await asOwner(env.database.db, async (tx) => ({
      corrections: await tx.select().from(corrections).where(eq(corrections.userId, id)),
      events: await tx.select().from(events).where(eq(events.userId, id)),
    }));
    expect(rows.corrections).toHaveLength(1);
    expect(rows.corrections[0]).toMatchObject({
      eventId: body.eventId,
      field: 'start',
      oldValue: '2026-10-14T06:00:00.000Z',
      newValue: '2026-10-14T05:30:00.000Z',
      reason: 'früher angefangen',
    });
    const manual = rows.events.find((e) => e.id === body.eventId);
    expect(manual).toMatchObject({ type: 'manual_start', source: 'user' });

    // Ein späteres automatisches Ereignis überschreibt den manuellen Wert nicht
    await env.app.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      headers: t.auth,
      payload: { events: [event('boot', '2026-10-14T05:45:00Z')] },
    });
    const days = await env.app.inject({
      method: 'GET',
      url: '/api/v1/days?from=2026-10-14&to=2026-10-14',
      headers: t.auth,
    });
    expect(days.json<{ days: { start: string }[] }>().days[0]?.start).toBe(
      '2026-10-14T05:30:00.000Z',
    );
  });

  it('Pause nachtragen und Bereich prüfen', async () => {
    const t = await registerAndLogin(env);
    await workday(t);
    const ok = await env.app.inject({
      method: 'PATCH',
      url: '/api/v1/days/2026-10-14',
      headers: t.auth,
      payload: { field: 'break', from: '2026-10-14T10:00:00Z', to: '2026-10-14T10:45:00Z' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ day: { breakMinutes: number; breakTopUpMin: number } }>().day).toMatchObject({
      breakMinutes: 45,
      breakTopUpMin: 0,
    });

    const reversed = await env.app.inject({
      method: 'PATCH',
      url: '/api/v1/days/2026-10-14',
      headers: t.auth,
      payload: { field: 'break', from: '2026-10-14T11:00:00Z', to: '2026-10-14T10:00:00Z' },
    });
    expect(reversed.statusCode).toBe(400);
    const far = await env.app.inject({
      method: 'PATCH',
      url: '/api/v1/days/2026-10-14',
      headers: t.auth,
      payload: { field: 'end', time: '2026-10-20T15:00:00Z' },
    });
    expect(far.statusCode).toBe(400);
  });

  it('Firmenkonto: Begründung ist Pflicht; freigegebener Monat ist gesperrt', async () => {
    const t = await registerAndLogin(env);
    const id = await userId(t.email);
    await asOwner(env.database.db, async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: 'Firma', plan: 'company' })
        .returning();
      if (!org) throw new Error('org');
      await tx.update(users).set({ orgId: org.id }).where(eq(users.id, id));
      await tx.insert(approvals).values({ userId: id, month: '2026-09', status: 'approved' });
    });
    const c = await login(env, t.email);
    await workday(c);
    const noReason = await env.app.inject({
      method: 'PATCH',
      url: '/api/v1/days/2026-10-14',
      headers: c.auth,
      payload: { field: 'start', time: '2026-10-14T05:30:00Z' },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json<{ error: string }>().error).toBe('reason_required');

    const locked = await env.app.inject({
      method: 'PATCH',
      url: '/api/v1/days/2026-09-14',
      headers: c.auth,
      payload: { field: 'start', time: '2026-09-14T05:30:00Z', reason: 'nachgetragen' },
    });
    expect(locked.statusCode).toBe(409);
  });

  it('Tag bestätigen und Sitzung verwerfen', async () => {
    const t = await registerAndLogin(env);
    await workday(t);
    const confirm = await env.app.inject({
      method: 'POST',
      url: '/api/v1/days/2026-10-14/confirm',
      headers: t.auth,
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json<{ confirmed: number }>().confirmed).toBe(1);
    const again = await env.app.inject({
      method: 'POST',
      url: '/api/v1/days/2026-10-14/confirm',
      headers: t.auth,
    });
    expect(again.json<{ confirmed: number }>().confirmed).toBe(0);

    const day = await env.app.inject({
      method: 'GET',
      url: '/api/v1/days?from=2026-10-14&to=2026-10-14',
      headers: t.auth,
    });
    const d = day.json<{
      days: { status: string; sessions: { id: string; confirmed?: boolean }[] }[];
    }>().days[0];
    // Pausenwarnung hält den Tag auf „ungeprüft“, die Sitzung selbst ist bestätigt
    expect(d?.status).toBe('unchecked');
    expect(d?.sessions[0]?.confirmed).toBe(true);
    const sessionId = d?.sessions[0]?.id ?? '';

    env.clock.now += 60_000;
    const reject = await env.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/reject`,
      headers: t.auth,
    });
    expect(reject.statusCode).toBe(200);
    const after = await env.app.inject({
      method: 'GET',
      url: '/api/v1/days?from=2026-10-14&to=2026-10-14',
      headers: t.auth,
    });
    const days = after.json<{ days: { netMinutes: number }[] }>().days;
    expect(days[0]?.netMinutes ?? 0).toBe(0);
  });
});
