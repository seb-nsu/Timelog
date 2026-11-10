import { describe, expect, it } from '@jest/globals';
import { ApiError } from '@timelog/shared';
import { backoffMs, classify } from '../src/core/sync';
import { harness, loggedIn } from './helpers';
import { LAPTOP_ID } from './fakeServer';

const SPAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Backoff', () => {
  it('verdoppelt ab 30 s bis höchstens 30 min', () => {
    expect([1, 2, 3, 4, 7, 100].map(backoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 1_800_000, 1_800_000,
    ]);
  });

  it('ordnet Fehler ein', () => {
    expect(classify(new TypeError('Network request failed'))).toBe('unavailable');
    expect(classify(new ApiError(503, 'x'))).toBe('unavailable');
    expect(classify(new ApiError(429, 'x'))).toBe('unavailable');
    expect(classify(new ApiError(401, 'x'))).toBe('unauthorized');
    expect(classify(new ApiError(400, 'x'))).toBe('rejected');
  });
});

describe('Warteschlange und Sync', () => {
  it('speichert offline, wartet nach Fehlern und überträgt später', async () => {
    const h = await loggedIn();
    h.server.offline = true;
    await h.core.manual('manual_start');
    expect(await h.core.store.pendingCount()).toBe(1);
    const failed = await h.core.sync();
    expect(failed).toMatchObject({
      state: 'offline',
      failures: 1,
      retryAt: '2026-10-15T07:00:30.000Z',
    });

    // Vor Ablauf des Backoffs wird nichts gesendet
    h.server.offline = false;
    const before = h.server.requests.length;
    h.clock.advance(0.25);
    await h.core.sync();
    expect(h.server.requests.length).toBe(before);

    h.clock.advance(1);
    expect(await h.core.sync()).toMatchObject({ state: 'ok' });
    expect(h.server.events.map((e) => e.type)).toEqual(['manual_start']);
    expect(await h.core.store.pendingCount()).toBe(0);
    expect(h.server.events[0]).toMatchObject({ source: 'user', tz: 'Europe/Berlin' });
  });

  it('zweiter Fehlschlag verdoppelt die Wartezeit; „Jetzt übertragen“ ignoriert sie', async () => {
    const h = await loggedIn();
    h.server.offline = true;
    await h.core.sync(true);
    h.clock.advance(1);
    expect(await h.core.sync()).toMatchObject({ failures: 2, retryAt: '2026-10-15T07:02:00.000Z' });
    h.server.offline = false;
    expect(await h.core.sync(true)).toMatchObject({ state: 'ok' });
  });

  it('erneuert ein abgelaufenes Access-Token mit rotierendem Refresh-Token', async () => {
    const h = await loggedIn();
    const first = h.secure.get('timelog.refreshToken');
    h.server.expireAccess();
    await h.core.manual('manual_start');
    expect(await h.core.sync(true)).toMatchObject({ state: 'ok' });
    expect(h.server.events).toHaveLength(1);
    expect(h.secure.get('timelog.refreshToken')).not.toBe(first);
    expect(h.server.requests).toContain('POST /auth/refresh');
  });

  it('verlangt neue Anmeldung, wenn das Refresh-Token ungültig ist', async () => {
    const h = await loggedIn();
    h.server.expireAccess();
    h.server.refreshTokens.clear();
    expect(await h.core.sync(true)).toEqual({ state: 'needsLogin' });
    expect(h.secure.has('timelog.refreshToken')).toBe(false);
    expect((await h.core.getState()).sync).toEqual({ state: 'needsLogin' });
  });

  it('ein abgelehntes Ereignis blockiert die übrigen nicht', async () => {
    const h = await loggedIn();
    h.server.offline = true;
    const a = await h.core.manual('manual_start');
    const b = await h.core.manual('manual_end');
    h.server.offline = false;
    h.server.rejectIds.add(a.id);
    await h.core.sync(true);
    expect(h.server.events.map((e) => e.id)).toEqual([b.id]);
    const state = await h.core.getState();
    expect(state.rejected).toBe(1);
    expect(state.pending).toBe(0);
  });

  it('nur lokal: keine Anfragen an einen Server', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    await h.core.manual('manual_start');
    expect(await h.core.sync(true)).toEqual({ state: 'idle' });
    expect((await h.core.getState()).sync).toEqual({ state: 'localOnly' });
    expect(h.server.requests).toEqual([]);
    expect((await h.core.days()).length).toBe(1);
  });
});

describe('Natives Modul', () => {
  it('übernimmt Netz-Ereignisse und Aktiv-Spannen und sendet Verlängerungen', async () => {
    const h = await loggedIn();
    h.native.queue.events.push({
      id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      type: 'net_connected',
      source: 'wifi',
      ts: '2026-10-15T06:00:00Z',
      tz: 'Europe/Berlin',
      createdAt: '2026-10-15T06:00:00Z',
      networkId: '44444444-4444-4444-8444-000000000000',
    });
    h.native.queue.spans.push({
      id: SPAN_ID,
      start: '2026-10-15T06:00:00Z',
      end: '2026-10-15T06:15:00Z',
      open: true,
    });
    await h.core.sync(true);
    expect(h.server.events[0]).toMatchObject({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      type: 'net_connected',
      source: 'wifi',
    });
    expect(h.server.spans).toEqual([
      expect.objectContaining({ id: SPAN_ID, end: '2026-10-15T06:15:00.000Z', open: true }),
    ]);
    expect(h.native.queue.events).toEqual([]);

    // WorkManager verlängert die Spanne
    h.native.queue.spans.push({
      id: SPAN_ID,
      start: '2026-10-15T06:00:00Z',
      end: '2026-10-15T06:30:00Z',
      open: true,
    });
    await h.core.sync(true);
    expect(h.server.spans[0]).toMatchObject({ end: '2026-10-15T06:30:00.000Z' });

    const days = await h.core.days('2026-10-15T07:00:00Z');
    expect(days[0]).toMatchObject({ date: '2026-10-15', status: 'open' });
  });

  it('meldet Arbeitsnetze mit HMAC an das Modul und schaltet die Erkennung ein', async () => {
    const h = await loggedIn();
    expect(h.native.configs.at(-1)).toMatchObject({ detection: false, networks: [] });
    const api = await h.core.api();
    await api.networks.add({
      kind: 'fingerprint',
      label: 'Büro',
      fingerprint: 'v4;gw=10.1.0.1;net=10.1.0.0/16',
    });
    await h.core.refreshNetworks();
    const config = h.native.configs.at(-1);
    expect(config?.detection).toBe(true);
    expect(config?.networks[0]).toMatchObject({ kind: 'fingerprint', scope: 'user' });
    expect(config?.networks[0]?.fingerprintHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(config)).not.toContain('10.1.0.1');

    // Automatik abgeschaltet → Erkennung aus
    const settings = await h.core.settings();
    await h.core.saveSettings({ ...settings, triggers: { ...settings.triggers, network: false } });
    expect(h.native.configs.at(-1)?.detection).toBe(false);
  });
});

describe('Daten anderer Geräte', () => {
  it('lädt Laptop-Ereignisse und berechnet den Tag gemeinsam', async () => {
    const h = await loggedIn({ now: '2026-10-15T07:00:00Z' });
    h.server.addLaptopEvent({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'boot',
      ts: '2026-10-14T06:00:00.000Z',
      createdAt: '2026-10-14T06:05:00.000Z',
    });
    h.server.addLaptopEvent({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      type: 'shutdown',
      ts: '2026-10-14T14:00:00.000Z',
    });
    h.server.spans.push({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      deviceId: LAPTOP_ID,
      deviceKind: 'desktop',
      start: '2026-10-14T06:00:00.000Z',
      end: '2026-10-14T14:00:00.000Z',
      open: false,
    });
    await h.core.sync(true);
    const day = (await h.core.days()).find((d) => d.date === '2026-10-14');
    expect(day).toMatchObject({ workMinutes: 485, netMinutes: 455, breakTopUpMin: 30 });
    expect(day?.warnings).toContain('break_violation');
    // erneuter Abruf ändert nichts (Cursor)
    await h.core.sync(true);
    expect((await h.core.events('2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z')).length).toBe(2);
  });
});

describe('Korrekturen', () => {
  it('online über PATCH mit Begründung, offline als Ereignis', async () => {
    const h = await loggedIn();
    expect(
      await h.core.correct('2026-10-14', { field: 'start', time: '2026-10-14T05:30:00Z' }, 'Zug'),
    ).toBe('server');
    expect(h.server.corrections[0]).toMatchObject({ field: 'start', reason: 'Zug' });
    const local = await h.core.events('2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z');
    expect(local[0]).toMatchObject({ type: 'manual_start', source: 'user' });
    expect(await h.core.store.pendingCount()).toBe(0);

    h.server.offline = true;
    expect(
      await h.core.correct('2026-10-14', {
        field: 'break',
        from: '2026-10-14T10:00:00Z',
        to: '2026-10-14T10:30:00Z',
      }),
    ).toBe('queued');
    expect(await h.core.store.pendingEvents(10)).toEqual([
      expect.objectContaining({
        type: 'manual_break',
        ts: '2026-10-14T10:00:00.000Z',
        endTs: '2026-10-14T10:30:00.000Z',
      }),
    ]);
  });

  it('Firmenkonto ohne Begründung wird abgelehnt', async () => {
    const h = await loggedIn();
    h.server.orgAccount = true;
    await expect(
      h.core.correct('2026-10-14', { field: 'end', time: '2026-10-14T15:00:00Z' }),
    ).rejects.toMatchObject({ code: 'reason_required' });
  });
});

describe('Konto', () => {
  it('Abmelden entfernt Tokens und fremde Daten, eigene ungesendete bleiben', async () => {
    const h = await loggedIn();
    h.server.addLaptopEvent({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'boot',
      ts: '2026-10-15T06:00:00.000Z',
    });
    await h.core.sync(true);
    h.server.offline = true;
    await h.core.manual('manual_start');
    await h.core.logout();
    expect(h.secure.size).toBe(0);
    expect((await h.core.getState()).account).toBe('none');
    const events = await h.core.events('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z');
    expect(events.map((e) => e.type)).toEqual(['manual_start']);
    expect(h.native.configs.at(-1)?.detection).toBe(false);
  });

  it('meldet das Push-Token am Gerät an, auch wenn es vor der Anmeldung kam', async () => {
    const h = await harness();
    await h.core.registerPushToken('fcm-token-1');
    expect(h.server.pushTokens).toEqual([]);
    await h.core.login({
      baseUrl: 'https://zeit.example',
      email: 'a@example.com',
      password: 'geheim-geheim',
    });
    expect(h.server.pushTokens).toEqual(['fcm-token-1']);
  });

  it('Konto löschen entfernt alle lokalen Daten', async () => {
    const h = await loggedIn();
    await h.core.manual('manual_start');
    await expect(h.core.deleteAccount('falsch')).rejects.toBeInstanceOf(ApiError);
    expect(await h.core.deleteAccount('geheim-geheim')).toBe('deleted');
    expect(await h.core.events('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z')).toEqual([]);
    expect((await h.core.getState()).setupDone).toBe(false);
  });

  it('Profil ohne Konto lokal speichern', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    await h.core.saveProfile({
      state: 'BY',
      timezone: 'Europe/Berlin',
      targetSchedule: [
        { validFrom: '2026-01-01', minutesByWeekday: [0, 420, 420, 420, 420, 420, 0] },
      ],
    });
    expect((await h.core.profile()).state).toBe('BY');
    expect(h.server.requests).toEqual([]);
  });
});
