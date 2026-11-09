import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, eventInput, workDaySchema } from '../src/index.js';

const base = {
  id: '0b7a1c4e-2f43-4d4f-9d7e-6f1a2b3c4d5e',
  source: 'system',
  ts: '2026-10-14T06:00:00Z',
  tz: 'Europe/Berlin',
  createdAt: '2026-10-14T06:05:00Z',
} as const;

describe('Schemas', () => {
  it('akzeptiert gültige Ereignisse', () => {
    expect(eventInput.safeParse({ ...base, type: 'boot' }).success).toBe(true);
    expect(
      eventInput.safeParse({
        ...base,
        type: 'manual_work',
        source: 'user',
        endTs: '2026-10-14T07:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('lehnt ungültige Ereignisse ab', () => {
    expect(eventInput.safeParse({ ...base, type: 'boot', tz: 'Mars/Base' }).success).toBe(false);
    expect(eventInput.safeParse({ ...base, type: 'manual_work' }).success).toBe(false);
    expect(
      eventInput.safeParse({ ...base, type: 'boot', endTs: '2026-10-14T07:00:00Z' }).success,
    ).toBe(false);
    expect(
      eventInput.safeParse({ ...base, type: 'manual_break', endTs: '2026-10-14T05:00:00Z' })
        .success,
    ).toBe(false);
    expect(eventInput.safeParse({ ...base, type: 'session_confirm' }).success).toBe(false);
    expect(eventInput.safeParse({ ...base, type: 'boot', id: 'e1' }).success).toBe(false);
  });

  it('beschreibt Arbeitstage', () => {
    const day = {
      date: '2026-10-14',
      sessions: [],
      breakMinutes: 0,
      workMinutes: 0,
      breakTopUpMin: 0,
      netMinutes: 0,
      pendingMinutes: 0,
      absenceMinutes: 0,
      targetMinutes: 480,
      status: 'auto',
      corrected: false,
      warnings: ['over_10h'],
    };
    expect(workDaySchema.parse(day)).toEqual(day);
  });
});

describe('API-Client', () => {
  it('sendet Token und prüft Antworten', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => 'tok',
      fetch: ((url: URL, init: RequestInit) => {
        calls.push({ url: url.toString(), init });
        return Promise.resolve(
          new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), { status: 200 }),
        );
      }) as typeof fetch,
    });
    await expect(client.events.batch([{ ...base, type: 'boot' }])).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(calls[0]?.url).toBe('https://api.example/api/v1/events/batch');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('sendet die Sprache als Accept-Language, wenn angegeben', async () => {
    const seen: (string | null)[] = [];
    const make = (locale?: 'de' | 'en') =>
      createApiClient({
        baseUrl: 'https://api.example',
        ...(locale ? { locale } : {}),
        fetch: ((_url: URL, init: RequestInit) => {
          seen.push(new Headers(init.headers).get('accept-language'));
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        }) as typeof fetch,
      });
    await make('en').auth.requestPasswordReset('a@example.test');
    await make().auth.requestPasswordReset('a@example.test');
    expect(seen).toEqual(['en', null]);
  });

  it('wirft ApiError mit Fehlercode', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_credentials' }), { status: 401 }),
        ),
    });
    await expect(client.status()).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    await expect(client.status()).rejects.toBeInstanceOf(ApiError);
  });

  it('lädt den Export als Blob und meldet Fehler ohne JSON-Körper', async () => {
    const urls: string[] = [];
    const client = createApiClient({
      baseUrl: 'https://api.example',
      fetch: ((url: URL) => {
        urls.push(url.toString());
        return Promise.resolve(
          url.pathname.endsWith('/export')
            ? new Response('%PDF-1.4', {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
              })
            : new Response('Bad Gateway', { status: 502 }),
        );
      }) as typeof fetch,
    });
    const blob = await client.export({ from: '2026-10-01', to: '2026-10-31', format: 'pdf' });
    expect(await blob.text()).toBe('%PDF-1.4');
    expect(urls[0]).toBe(
      'https://api.example/api/v1/export?from=2026-10-01&to=2026-10-31&format=pdf',
    );
    await expect(client.holidays(2026)).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });
});
