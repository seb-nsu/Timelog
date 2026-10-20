// Kalender-Anbindung mit gefakten Anbieter-APIs (Google Calendar v3, Microsoft Graph v1.0).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { calendarConnections, calendarEntries, calendarOauthStates } from '../src/db/schema.js';
import { type TestEnv, createTestEnv, event, registerAndLogin } from './helpers.js';
import { encrypt } from '../src/security/crypto.js';
import { api, userIdOf } from './org-helpers.js';

interface Call {
  method: string;
  url: URL;
  body: URLSearchParams;
  headers: Record<string, string>;
}

const calls: Call[] = [];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Antwortet wie die Token- und Termin-Endpunkte der Anbieter (nur die genutzten Felder). */
const fakeFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
  const headers = Object.fromEntries(
    Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  calls.push({ method: init?.method ?? 'GET', url, body, headers });
  const token = url.pathname.endsWith('/token');
  if (token) {
    if (body.get('grant_type') === 'authorization_code') {
      if (body.get('code') !== 'good' || !body.get('code_verifier')) {
        return Promise.resolve(json(400, { error: 'invalid_grant' }));
      }
      return Promise.resolve(json(200, { access_token: 'at-1', refresh_token: 'rt-secret-1' }));
    }
    if (body.get('refresh_token') === 'rt-revoked') {
      return Promise.resolve(json(400, { error: 'invalid_grant' }));
    }
    return Promise.resolve(json(200, { access_token: 'at-2' }));
  }
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
    return Promise.resolve(json(200, {}));
  }
  if (url.hostname === 'www.googleapis.com') {
    if (url.searchParams.get('pageToken') === 'p2') {
      return Promise.resolve(
        json(200, {
          items: [
            {
              summary: 'Urlaub Mallorca',
              eventType: 'outOfOffice',
              start: { date: '2026-10-16' },
              end: { date: '2026-10-17' },
            },
          ],
        }),
      );
    }
    return Promise.resolve(
      json(200, {
        items: [
          {
            summary: 'Jour fixe',
            start: { dateTime: '2026-10-14T10:00:00Z' },
            end: { dateTime: '2026-10-14T11:00:00Z' },
          },
          {
            summary: 'Review ACME-Portal',
            start: { dateTime: '2026-10-14T14:00:00+02:00' },
            end: { dateTime: '2026-10-14T15:00:00+02:00' },
          },
          {
            summary: 'abgesagt',
            status: 'cancelled',
            start: { dateTime: '2026-10-14T07:00:00Z' },
            end: { dateTime: '2026-10-14T08:00:00Z' },
          },
          {
            summary: 'nur Info',
            transparency: 'transparent',
            start: { dateTime: '2026-10-14T07:00:00Z' },
            end: { dateTime: '2026-10-14T08:00:00Z' },
          },
        ],
        nextPageToken: 'p2',
      }),
    );
  }
  if (url.hostname === 'graph.microsoft.com') {
    return Promise.resolve(
      json(200, {
        value: [
          {
            subject: 'Kundentermin ACME',
            showAs: 'busy',
            start: { dateTime: '2026-10-14T14:00:00.0000000' },
            end: { dateTime: '2026-10-14T15:00:00.0000000' },
          },
          {
            subject: 'frei',
            showAs: 'free',
            start: { dateTime: '2026-10-14T09:00:00.0000000' },
            end: { dateTime: '2026-10-14T10:00:00.0000000' },
          },
          {
            subject: 'Krank',
            showAs: 'oof',
            isAllDay: true,
            start: { dateTime: '2026-10-19T00:00:00.0000000' },
            end: { dateTime: '2026-10-21T00:00:00.0000000' },
          },
        ],
      }),
    );
  }
  return Promise.resolve(json(404, {}));
};

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv(
    { auth: 1000, device: 1000 },
    {
      apiUrl: 'https://api.test',
      adminUrl: 'https://admin.test',
      calendar: {
        google: { clientId: 'g-id', clientSecret: 'g-secret' },
        microsoft: { clientId: 'm-id', clientSecret: 'm-secret', tenant: 'common' },
        fetch: fakeFetch,
      },
    },
  );
});
afterAll(() => env.close());

type Who = Awaited<ReturnType<typeof registerAndLogin>> & { userId: string };

async function person(e: TestEnv = env): Promise<Who> {
  const t = await registerAndLogin(e);
  return { ...t, userId: await userIdOf(e, t.email) };
}

/** Arbeitstag 08:00–17:00 Berlin mit Pause 12:00–13:00 (Laptop inaktiv). */
async function dayWithBreak(t: Who): Promise<void> {
  await api(env, t, 'POST', '/events/batch', {
    events: [
      event('boot', '2026-10-14T06:00:00Z', { createdAt: '2026-10-14T06:05:00Z' }),
      event('shutdown', '2026-10-14T15:00:00Z'),
    ],
  });
  await api(env, t, 'PUT', '/presence', {
    spans: [
      { id: randomUUID(), start: '2026-10-14T06:00:00Z', end: '2026-10-14T10:00:00Z', open: false },
      { id: randomUUID(), start: '2026-10-14T11:00:00Z', end: '2026-10-14T15:00:00Z', open: false },
    ],
  });
}

async function connect(t: Who, provider: 'google' | 'microsoft', redirect?: string) {
  const res = await api<{ url: string }>(
    env,
    t,
    'POST',
    `/calendar/${provider}/connect`,
    redirect ? { redirect } : {},
  );
  expect(res.status).toBe(200);
  const url = new URL(res.body.url);
  const state = url.searchParams.get('state') ?? '';
  return { url, state };
}

const callback = (provider: string, query: string) =>
  env.app.inject({ method: 'GET', url: `/api/v1/calendar/${provider}/callback?${query}` });

describe('Kalender: Google', () => {
  let t: Who;
  let projectId: string;
  beforeAll(async () => {
    t = await person();
    await dayWithBreak(t);
    await api(env, t, 'PUT', '/settings', { settings: { projects: true } });
    const p = await api<{ id: string }>(env, t, 'POST', '/projects', {
      name: 'ACME Portal',
      customer: 'ACME',
      keywords: ['acme'],
    });
    projectId = p.body.id;
  });

  it('Status ohne Verbindung; Anmelde-Adresse mit PKCE S256 und schmalem Scope', async () => {
    const status = await api<{
      allowed: boolean;
      providers: { provider: string; configured: boolean }[];
      connections: unknown[];
    }>(env, t, 'GET', '/calendar');
    expect(status.body.allowed).toBe(true);
    expect(status.body.providers.every((p) => p.configured)).toBe(true);
    expect(status.body.connections).toEqual([]);

    const { url } = await connect(t, 'google');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.events.readonly',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.test/api/v1/calendar/google/callback',
    );
  });

  it('lehnt fremde Rücksprung-Adressen und unbekannte state-Werte ab', async () => {
    const bad = await api(env, t, 'POST', '/calendar/google/connect', {
      redirect: 'https://evil.test/x',
    });
    expect(bad.status).toBe(400);
    const res = await callback('google', 'state=unbekannt-unbekannt-unbekannt&code=good');
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('lang="de"');
  });

  it('Rücksprung: Code-Tausch mit Verifier, Token verschlüsselt, Termine ohne Titel gespeichert', async () => {
    const { state } = await connect(t, 'google', 'https://admin.test/settings');
    const res = await callback('google', `state=${state}&code=good`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('https://admin.test/settings?calendar=connected');
    // state ist einmalig
    expect((await callback('google', `state=${state}&code=good`)).statusCode).toBe(400);

    const exchange = calls.find((c) => c.body.get('grant_type') === 'authorization_code');
    expect(exchange?.body.get('code_verifier')).toMatch(/^[\w-]{43,128}$/);
    expect(exchange?.body.get('client_secret')).toBe('g-secret');

    const [conn] = await asOwner(env.database.db, (tx) =>
      tx.select().from(calendarConnections).where(eq(calendarConnections.userId, t.userId)),
    );
    expect(conn?.refreshToken).not.toContain('rt-secret-1');
    expect(conn?.status).toBe('active');

    const list = calls.find((c) => c.url.hostname === 'www.googleapis.com');
    expect(list?.headers.authorization).toBe('Bearer at-2');
    expect(list?.url.searchParams.getAll('eventTypes')).toEqual([
      'default',
      'outOfOffice',
      'focusTime',
    ]);
    expect(list?.url.searchParams.get('fields')).not.toMatch(/attendees|location|description/);

    const rows = await asOwner(env.database.db, (tx) =>
      tx.select().from(calendarEntries).where(eq(calendarEntries.userId, t.userId)),
    );
    // abgesagte und „frei“ markierte Termine fehlen; zweite Seite (Abwesenheit) ist dabei
    expect(rows).toHaveLength(3);
    const dump = JSON.stringify(rows);
    for (const title of ['Jour fixe', 'Review', 'Mallorca', 'ACME-Portal']) {
      expect(dump).not.toContain(title);
    }
    expect(rows.filter((r) => r.projectId === projectId)).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'absence')).toMatchObject({
      allDay: true,
      startDate: '2026-10-16',
      endDate: '2026-10-17',
    });
  });

  it('Stichwort-Treffer ordnet Arbeitszeit dem Projekt zu; manuell gewinnt', async () => {
    const day = await api<{
      day: { items: { projectId: string | null; netMinutes: number }[] };
    }>(env, t, 'GET', '/days/2026-10-14/projects');
    expect(day.body.day.items.find((i) => i.projectId === projectId)?.netMinutes).toBe(60);

    const manual = await api<{
      day: { items: { projectId: string | null; netMinutes: number; manual: boolean }[] };
    }>(env, t, 'POST', '/days/2026-10-14/projects', {
      from: '2026-10-14T12:30:00Z',
      to: '2026-10-14T13:00:00Z',
      projectId: null,
    });
    expect(manual.status).toBe(200);
    expect(manual.body.day.items.find((i) => i.projectId === projectId)?.netMinutes).toBe(30);
  });

  it('Vorschläge: Pause im Termin („War Arbeit (Termin)“) und ganztägige Abwesenheit', async () => {
    const res = await api<{
      gaps: { date: string; from: string; to: string; kind: string }[];
      absences: { date: string; kind: string }[];
    }>(env, t, 'GET', '/calendar/suggestions?from=2026-10-12&to=2026-10-18');
    expect(res.status).toBe(200);
    expect(res.body.gaps).toEqual([
      expect.objectContaining({
        date: '2026-10-14',
        from: '2026-10-14T10:00:00.000Z',
        to: '2026-10-14T11:00:00.000Z',
        kind: 'break',
      }),
    ]);
    expect(res.body.absences).toEqual([{ date: '2026-10-16', kind: 'vacation' }]);
    // nichts wurde automatisch gebucht
    const days = await api<{ days: { date: string; netMinutes: number }[] }>(
      env,
      t,
      'GET',
      '/days?from=2026-10-14&to=2026-10-14',
    );
    expect(days.body.days[0]?.netMinutes).toBe(485);
  });

  it('„Jetzt abrufen“ ersetzt den Zeitraum ohne Doppelungen', async () => {
    const res = await api<{ entries: number }>(env, t, 'POST', '/calendar/google/sync');
    expect(res.body.entries).toBe(3);
    const rows = await asOwner(env.database.db, (tx) =>
      tx.select().from(calendarEntries).where(eq(calendarEntries.userId, t.userId)),
    );
    expect(rows).toHaveLength(3);
  });

  it('Trennen löscht Token, Termine und widerruft bei Google', async () => {
    const before = calls.length;
    expect((await api(env, t, 'DELETE', '/calendar/google')).status).toBe(200);
    expect(
      calls
        .slice(before)
        .some((c) => c.url.hostname === 'oauth2.googleapis.com' && c.url.pathname === '/revoke'),
    ).toBe(true);
    const left = await asOwner(env.database.db, async (tx) => ({
      conns: await tx
        .select()
        .from(calendarConnections)
        .where(eq(calendarConnections.userId, t.userId)),
      entries: await tx.select().from(calendarEntries).where(eq(calendarEntries.userId, t.userId)),
      states: await tx
        .select()
        .from(calendarOauthStates)
        .where(eq(calendarOauthStates.userId, t.userId)),
    }));
    expect(left).toEqual({ conns: [], entries: [], states: [] });
    expect((await api(env, t, 'DELETE', '/calendar/google')).status).toBe(404);
    expect((await api(env, t, 'POST', '/calendar/google/sync')).status).toBe(404);
  });
});

describe('Kalender: Microsoft 365', () => {
  it('Verbinden, Abwesenheit (oof) und widerrufene Freigabe als Fehlerstatus', async () => {
    const t = await person();
    const { url, state } = await connect(t, 'microsoft');
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')).toBe('offline_access Calendars.ReadBasic');
    const res = await callback('microsoft', `state=${state}&code=good`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Kalender verbunden');

    const view = calls.filter((c) => c.url.hostname === 'graph.microsoft.com').at(-1);
    expect(view?.headers.prefer).toBe('outlook.timezone="Europe/Berlin"');
    expect(view?.url.searchParams.get('$select')).toBe(
      'subject,start,end,isAllDay,showAs,isCancelled',
    );

    const rows = await asOwner(env.database.db, (tx) =>
      tx.select().from(calendarEntries).where(eq(calendarEntries.userId, t.userId)),
    );
    expect(rows).toHaveLength(2);
    // 14:00 Ortszeit (Sommerzeit) = 12:00 UTC
    expect(rows.find((r) => r.kind === 'busy')?.startAt.toISOString()).toBe(
      '2026-10-14T12:00:00.000Z',
    );
    const sug = await api<{ absences: { date: string }[] }>(
      env,
      t,
      'GET',
      '/calendar/suggestions?from=2026-10-12&to=2026-10-25',
    );
    expect(sug.body.absences.map((a) => a.date)).toEqual(['2026-10-19', '2026-10-20']);

    // Freigabe beim Anbieter widerrufen → Status „error“, ohne personenbezogene Angaben
    await asOwner(env.database.db, (tx) =>
      tx
        .update(calendarConnections)
        .set({ refreshToken: encrypt('rt-revoked', Buffer.alloc(32, 7)) })
        .where(eq(calendarConnections.userId, t.userId)),
    );
    const sync = await api<{ error: string }>(env, t, 'POST', '/calendar/microsoft/sync');
    expect(sync.status).toBe(502);
    expect(sync.body.error).toBe('calendar_invalid_grant');
    const status = await api<{ connections: { status: string; lastError?: string }[] }>(
      env,
      t,
      'GET',
      '/calendar',
    );
    expect(status.body.connections[0]).toMatchObject({
      status: 'error',
      lastError: 'invalid_grant',
    });
  });

  it('abgelehnte Anmeldung verbindet nichts', async () => {
    const t = await person();
    const { state } = await connect(t, 'microsoft');
    const res = await callback('microsoft', `state=${state}&error=access_denied`);
    expect(res.statusCode).toBe(400);
    const status = await api<{ connections: unknown[] }>(env, t, 'GET', '/calendar');
    expect(status.body.connections).toEqual([]);
  });
});

describe('Kalender ohne Konfiguration', () => {
  it('Anbieter ohne Client-ID ist nicht verfügbar', async () => {
    const bare = await createTestEnv();
    try {
      const t = await person(bare);
      const status = await api<{ providers: { configured: boolean }[] }>(
        bare,
        t,
        'GET',
        '/calendar',
      );
      expect(status.body.providers.every((p) => !p.configured)).toBe(true);
      expect((await api(bare, t, 'POST', '/calendar/google/connect', {})).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
