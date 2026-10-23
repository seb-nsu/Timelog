// Mandantentrennung doppelt: Fastify-Hook (Token) und PostgreSQL Row-Level-Security.
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/db/index.js';
import { devices, events, organizations, users } from '../src/db/schema.js';
import { type TestEnv, createTestEnv, event, registerAndLogin } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

async function userInNewOrg(name: string) {
  const t = await registerAndLogin(env);
  const [org] = await env.database.db
    .insert(organizations)
    .values({ name, plan: 'company' })
    .returning();
  if (!org) throw new Error('org');
  const [user] = await env.database.db
    .update(users)
    .set({ orgId: org.id })
    .where(eq(users.email, t.email))
    .returning({ id: users.id });
  if (!user) throw new Error('user');
  await env.app.inject({
    method: 'POST',
    url: '/api/v1/events/batch',
    headers: t.auth,
    payload: { events: [event('boot', '2026-10-14T06:00:00Z')] },
  });
  return { ...t, userId: user.id, orgId: org.id };
}

describe('Mandantentrennung', () => {
  it('RLS: eine Transaktion sieht nur Zeilen des eigenen Nutzers bzw. der eigenen Organisation', async () => {
    const a = await userInNewOrg('Firma A');
    const b = await userInNewOrg('Firma B');
    const scopeA = { userId: a.userId, orgId: a.orgId };

    const seen = await withUser(env.database.db, scopeA, async (tx) => ({
      events: await tx.select({ userId: events.userId }).from(events),
      users: await tx.select({ id: users.id }).from(users),
      orgs: await tx.select({ id: organizations.id }).from(organizations),
      devices: await tx.select({ userId: devices.userId }).from(devices),
    }));
    expect(seen.events.length).toBeGreaterThan(0);
    expect(seen.events.every((r) => r.userId === a.userId)).toBe(true);
    expect(seen.users).toEqual([{ id: a.userId }]);
    expect(seen.orgs).toEqual([{ id: a.orgId }]);
    expect(seen.devices.every((r) => r.userId === a.userId)).toBe(true);

    // Schreiben unter fremder user_id wird von der Policy abgelehnt
    await expect(
      withUser(env.database.db, scopeA, (tx) =>
        tx.insert(events).values({
          userId: b.userId,
          id: crypto.randomUUID(),
          deviceId: b.deviceId,
          type: 'boot',
          source: 'system',
          ts: new Date(),
          tz: 'Europe/Berlin',
          createdAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('RLS: ohne gesetzten Nutzer sieht die API-Rolle nichts', async () => {
    await userInNewOrg('Firma C');
    const rows = await env.database.db.transaction(async (tx) => {
      await tx.execute(sql`set local role timelog_app`);
      return tx.select().from(events);
    });
    expect(rows).toEqual([]);
  });

  it('Ereignisse sind unveränderlich', async () => {
    const a = await userInNewOrg('Firma D');
    await expect(
      withUser(env.database.db, { userId: a.userId, orgId: a.orgId }, (tx) =>
        tx.update(events).set({ type: 'shutdown' }).where(eq(events.userId, a.userId)),
      ),
    ).rejects.toThrow();
    // Auch der Tabellen-Eigentümer kann nicht ändern (Trigger)
    const err: unknown = await env.database.db
      .update(events)
      .set({ type: 'shutdown' })
      .where(eq(events.userId, a.userId))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(String((err as { cause?: unknown } | undefined)?.cause)).toMatch(/append-only/);
  });

  it('API: Nutzer verschiedener Organisationen sehen nur eigene Daten', async () => {
    const a = await userInNewOrg('Firma E');
    const b = await userInNewOrg('Firma F');
    const listA = await env.app.inject({ method: 'GET', url: '/api/v1/events', headers: a.auth });
    const listB = await env.app.inject({ method: 'GET', url: '/api/v1/events', headers: b.auth });
    const idsA = listA.json<{ events: { id: string }[] }>().events.map((e) => e.id);
    const idsB = listB.json<{ events: { id: string }[] }>().events.map((e) => e.id);
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
    expect(idsA).not.toEqual(idsB);
    const devA = await env.app.inject({ method: 'GET', url: '/api/v1/devices', headers: a.auth });
    expect(devA.json<{ devices: { id: string }[] }>().devices.map((d) => d.id)).toEqual([
      a.deviceId,
    ]);
  });
});
