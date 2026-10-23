// Rückfragen per Push: Auslösung, Idempotenz, Ruhezeit, Einstellungen, Token-Bereinigung und
// Wochenrückblick. Eigene Datenbank, weil der Job alle Nutzer durchgeht.
import type { Prompt } from '@timelog/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { devices, events, presenceSpans, pushPrompts } from '../src/db/schema.js';
import { runPromptJob } from '../src/push/prompts.js';
import { MemoryPushSender } from '../src/push/sender.js';
import { type TestEnv, createTestEnv, event, login, registerAndLogin } from './helpers.js';

let env: TestEnv;
let sender: MemoryPushSender;
beforeAll(async () => {
  env = await createTestEnv(undefined, undefined, { isolated: true });
});
afterAll(() => env.close());
beforeEach(async () => {
  sender = new MemoryPushSender();
  // Jeder Test beginnt ohne Rückfragen, Ereignisse und Push-Tokens früherer Tests
  await asOwner(env.database.db, async (tx) => {
    await tx.delete(pushPrompts);
    await tx.delete(events);
    await tx.delete(presenceSpans);
    await tx.update(devices).set({ pushToken: null });
  });
});

type Login = Awaited<ReturnType<typeof registerAndLogin>>;
const run = (iso: string) => runPromptJob({ db: env.database.db, sender }, Date.parse(iso));

function inject(t: Login, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) {
  return env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: t.auth,
    ...(payload ? { payload } : {}),
  });
}

/** Konto mit Laptop und Handy (Push-Token, Android). */
async function account(token = `fcm-${randomUUID()}`, os = 'android') {
  const desktop = await registerAndLogin(env);
  const phone = await login(env, desktop.email, 'mobile');
  const reg = await inject(phone, 'POST', '/devices', { pushToken: token, os, locale: 'de' });
  expect(reg.statusCode).toBe(200);
  return { desktop, phone, token };
}

/** Laptop-Tag: boot und shutdown (UTC), durchgehend aktiv. */
async function laptopDay(t: Login, from: string, to: string | undefined, spanEnd = to) {
  const evs = [
    event('boot', from, { createdAt: new Date(Date.parse(from) + 300_000).toISOString() }),
  ];
  if (to) evs.push(event('shutdown', to));
  expect((await inject(t, 'POST', '/events/batch', { events: evs })).statusCode).toBe(200);
  await inject(t, 'PUT', '/presence', {
    spans: [{ id: randomUUID(), start: from, end: spanEnd ?? from, open: false }],
  });
  return evs[0]?.id ?? '';
}

async function prompts(t: Login): Promise<Prompt[]> {
  const res = await inject(t, 'GET', '/prompts');
  expect(res.statusCode).toBe(200);
  return res.json<{ prompts: Prompt[] }>().prompts;
}

describe('Rückfrage „Feierabend erkannt“', () => {
  it('fragt nach der Karenz einmal je Sitzung und erledigt sich mit „Stimmt“', async () => {
    const { desktop, token } = await account();
    // Mi 14.10.2026: 08:00–17:00 Berlin
    const bootId = await laptopDay(desktop, '2026-10-14T06:00:00Z', '2026-10-14T15:00:00Z');
    env.clock.now = Date.parse('2026-10-14T15:10:00Z');

    // Ende 17:05 + 20 min Karenz: um 17:15 noch nichts
    expect((await run('2026-10-14T15:15:00Z')).prompts).toBe(0);
    const r = await run('2026-10-14T15:30:00Z');
    expect(r).toMatchObject({ prompts: 1, pushed: 1 });
    expect(sender.sent).toHaveLength(1);
    const msg = sender.sent[0];
    expect(msg?.token).toBe(token);
    expect(msg?.platform).toBe('android');
    expect(msg?.notification).toMatchObject({
      title: 'Feierabend um 17:05 erkannt',
      category: 'timelog.end_confirm',
      data: { kind: 'end_confirm', sessionId: bootId, date: '2026-10-14' },
      urgent: true,
    });
    // Keine personenbezogenen Inhalte in der Nachricht
    expect(JSON.stringify(msg?.notification)).not.toContain(desktop.email);

    // Idempotent: zweiter Lauf fragt nicht erneut
    expect((await run('2026-10-14T15:40:00Z')).prompts).toBe(0);
    expect(sender.sent).toHaveLength(1);

    // Desktop sieht die Rückfrage (mit Quelle des Endes)
    env.clock.now = Date.parse('2026-10-14T15:41:00Z');
    const open = await prompts(desktop);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'end_confirm',
      ref: bootId,
      payload: { endSource: 'shutdown', end: '2026-10-14T15:05:00.000Z', tz: 'Europe/Berlin' },
    });

    // „Stimmt“ = bestehende Sitzungsbestätigung → Rückfrage erledigt
    const ok = await inject(desktop, 'POST', `/sessions/${bootId}/confirm`, {});
    expect(ok.statusCode).toBe(200);
    expect(await prompts(desktop)).toEqual([]);
  });

  it('wartet die Ruhezeit ab und beachtet die Einstellung confirmEnd', async () => {
    const { desktop } = await account();
    // Shutdown 21:00 Berlin, Ruhezeit 20:00–07:00
    await laptopDay(desktop, '2026-10-14T17:00:00Z', '2026-10-14T19:00:00Z');
    expect((await run('2026-10-14T19:40:00Z')).prompts).toBe(0);
    expect((await run('2026-10-15T04:55:00Z')).prompts).toBe(0);
    const morning = await run('2026-10-15T05:05:00Z');
    expect(morning.prompts).toBe(1);
    // Anderer Tag: Datum im Text
    expect(sender.sent[0]?.notification.body).toMatch(/^Mi\., 14\.10\.: Stimmt das\?/);

    // Ausgeschaltet: keine Rückfrage
    const other = await account();
    const settings = await inject(other.desktop, 'GET', '/settings');
    const current = settings.json<{ settings: { notifications: Record<string, unknown> } }>();
    await inject(other.desktop, 'PUT', '/settings', {
      settings: {
        ...current.settings,
        notifications: { ...current.settings.notifications, confirmEnd: false },
      },
    });
    await laptopDay(other.desktop, '2026-10-15T06:00:00Z', '2026-10-15T14:00:00Z');
    const off = await run('2026-10-15T15:00:00Z');
    expect(off.prompts).toBe(0);
  });

  it('entfernt ungültige Tokens und sendet nur an Handys', async () => {
    const { desktop, phone, token } = await account('ungueltig-1');
    await inject(desktop, 'POST', '/devices', { pushToken: 'desktop-token' });
    sender.invalid.add(token);
    await laptopDay(desktop, '2026-10-14T06:00:00Z', '2026-10-14T15:00:00Z');
    const r = await run('2026-10-14T15:30:00Z');
    expect(r).toMatchObject({ prompts: 1, pushed: 0, removedTokens: 1 });
    expect(sender.sent).toEqual([]);
    const rows = await asOwner(env.database.db, (tx) =>
      tx.select().from(devices).where(eq(devices.id, phone.deviceId)),
    );
    expect(rows[0]?.pushToken).toBeNull();
    // Die Rückfrage bleibt für den Desktop sichtbar
    env.clock.now = Date.parse('2026-10-14T15:31:00Z');
    expect(await prompts(desktop)).toHaveLength(1);
  });
});

describe('Rückfrage „Arbeitsende fehlt“', () => {
  it('fragt bei no_end mit der letzten Aktivität; Ausblenden gilt auf allen Geräten', async () => {
    env.clock.now = Date.parse('2026-10-15T05:05:00Z');
    const { desktop, phone } = await account('ios-'.padEnd(64, 'a'), 'ios');
    // Kein shutdown: Ende = letzte Aktiv-Spanne 18:12, Warnung no_end nach 3 h
    const bootId = await laptopDay(
      desktop,
      '2026-10-14T06:00:00Z',
      undefined,
      '2026-10-14T16:12:00Z',
    );
    expect((await run('2026-10-14T18:00:00Z')).prompts).toBe(0);
    // 22:00 Berlin liegt in der Ruhezeit; am nächsten Morgen
    const r = await run('2026-10-15T05:10:00Z');
    expect(r.prompts).toBe(1);
    expect(sender.sent[0]).toMatchObject({
      platform: 'ios',
      notification: {
        title: 'Arbeitsende fehlt',
        category: 'timelog.end_missing',
        data: {
          kind: 'end_missing',
          sessionId: bootId,
          date: '2026-10-14',
          end: '2026-10-14T16:12:00.000Z',
        },
      },
    });
    env.clock.now = Date.parse('2026-10-15T05:11:00Z');
    expect((await prompts(phone))[0]?.kind).toBe('end_missing');
    const dismiss = await inject(phone, 'POST', '/prompts/dismiss', {
      kind: 'end_missing',
      ref: bootId,
    });
    expect(dismiss.statusCode).toBe(200);
    expect(await prompts(desktop)).toEqual([]);
  });

  it('erledigt sich, wenn das Ende korrigiert wird', async () => {
    const { desktop } = await account();
    await laptopDay(desktop, '2026-10-14T06:00:00Z', undefined, '2026-10-14T13:00:00Z');
    expect((await run('2026-10-14T16:30:00Z')).prompts).toBe(1);
    env.clock.now = Date.parse('2026-10-14T16:31:00Z');
    expect(await prompts(desktop)).toHaveLength(1);
    const fix = await inject(desktop, 'PATCH', '/days/2026-10-14', {
      field: 'end',
      time: '2026-10-14T14:00:00Z',
    });
    expect(fix.statusCode).toBe(200);
    expect(await prompts(desktop)).toEqual([]);
  });
});

describe('Wochenrückblick', () => {
  it('kommt freitags 15:00 Ortszeit einmal je Woche mit Stunden, Saldo und offenen Tagen', async () => {
    env.clock.now = Date.parse('2026-10-16T13:00:00Z');
    const { desktop, phone } = await account();
    await inject(phone, 'POST', '/devices', { locale: 'en' });
    // Mo 12.10.: 08:00–16:30 mit Pause; Di 13.10.: 08:00–17:00 ohne Pause (offen)
    await laptopDay(desktop, '2026-10-12T06:00:00Z', '2026-10-12T10:00:00Z');
    await laptopDay(desktop, '2026-10-12T10:45:00Z', '2026-10-12T14:30:00Z');
    await laptopDay(desktop, '2026-10-13T06:00:00Z', '2026-10-13T15:00:00Z');

    // Rückfragen zum Feierabend der Tage sind älter als 24 h: nur der Wochenrückblick
    expect((await run('2026-10-16T12:55:00Z')).prompts).toBe(0);
    const r = await run('2026-10-16T13:05:00Z');
    expect(r.prompts).toBe(1);
    const week = sender.sent.find((s) => s.notification.category === 'timelog.week_review');
    expect(week?.notification).toMatchObject({
      title: 'Your week 42',
      data: { kind: 'week_review', week: '2026-W42', date: '2026-10-12' },
      urgent: false,
    });
    expect(week?.notification.body).toContain('1 day to review');
    expect(week?.notification.body).toContain('Working Hours Act');
    expect((await run('2026-10-16T13:10:00Z')).prompts).toBe(0);

    env.clock.now = Date.parse('2026-10-16T13:11:00Z');
    const list = await prompts(desktop);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'week_review',
      ref: '2026-W42',
      payload: { openDays: 1, legalHints: 1, from: '2026-10-12' },
    });
  });

  it('richtet sich nach Wochentag und Uhrzeit aus den Einstellungen', async () => {
    const { desktop } = await account();
    const current = (await inject(desktop, 'GET', '/settings')).json<{
      settings: { notifications: Record<string, unknown> };
    }>();
    await inject(desktop, 'PUT', '/settings', {
      settings: {
        ...current.settings,
        notifications: {
          ...current.settings.notifications,
          weekReview: { enabled: true, weekday: 4, time: '12:30' },
        },
      },
    });
    await laptopDay(desktop, '2026-10-12T06:00:00Z', '2026-10-12T10:00:00Z');
    expect((await run('2026-10-15T10:20:00Z')).prompts).toBe(0);
    expect((await run('2026-10-15T10:35:00Z')).prompts).toBe(1);
    // Freitag kommt nichts mehr
    expect((await run('2026-10-16T13:05:00Z')).prompts).toBe(0);
  });

  it('trennt Nutzer: fremde Rückfragen sind unsichtbar', async () => {
    const a = await account();
    const b = await account();
    await laptopDay(a.desktop, '2026-10-14T06:00:00Z', '2026-10-14T15:00:00Z');
    await run('2026-10-14T15:30:00Z');
    env.clock.now = Date.parse('2026-10-14T15:31:00Z');
    expect(await prompts(a.desktop)).toHaveLength(1);
    expect(await prompts(b.desktop)).toEqual([]);
    expect(sender.sent.every((s) => s.token === a.token)).toBe(true);
  });
});
