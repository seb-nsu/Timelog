import { describe, expect, it } from 'vitest';
import {
  type LocalData,
  type Profile,
  computeDeviceDays,
  computeLocalDays,
  detectedBreaks,
  eventsOfDay,
  periodDays,
  reviewItems,
  todaySummary,
} from '../src/index.js';

const tz = 'Europe/Berlin';
const profile: Profile = { state: 'BE', timezone: tz };

const ev = (id: string, type: LocalData['events'][number]['type'], ts: string, createdAt = ts) => ({
  id,
  type,
  source: 'system' as const,
  ts,
  tz,
  createdAt,
});

describe('Lokale Berechnung über das Regelwerk', () => {
  it('Arbeitstag mit Standby-Pause (Mi 14.10.2026)', () => {
    const data: LocalData = {
      events: [
        ev('b1', 'boot', '2026-10-14T06:00:00Z', '2026-10-14T06:05:00Z'),
        ev('s1', 'shutdown', '2026-10-14T15:00:00Z'),
      ],
      spans: [
        { id: 'p1', start: '2026-10-14T06:00:00Z', end: '2026-10-14T10:00:00Z', open: false },
        { id: 'p2', start: '2026-10-14T10:45:00Z', end: '2026-10-14T15:00:00Z', open: false },
      ],
    };
    const days = computeLocalDays(data, profile, '2026-10-15T07:00:00Z');
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      date: '2026-10-14',
      breakMinutes: 45,
      netMinutes: 500,
      status: 'auto',
    });

    const breaks = detectedBreaks(days[0]);
    expect(breaks).toEqual([
      expect.objectContaining({
        from: '2026-10-14T10:00:00.000Z',
        to: '2026-10-14T10:45:00.000Z',
        source: 'standby',
        sessionId: 'b1',
      }),
    ]);
    expect(detectedBreaks(undefined)).toEqual([]);
    expect(eventsOfDay(data.events, '2026-10-14').map((e) => e.id)).toEqual(['b1', 's1']);
    expect(eventsOfDay(data.events, '2026-10-15')).toEqual([]);
  });

  it('laufende Sitzung im Tagesüberblick', () => {
    const data: LocalData = {
      events: [ev('b1', 'boot', '2026-10-15T06:00:00Z', '2026-10-15T06:05:00Z')],
      spans: [{ id: 'p1', start: '2026-10-15T06:00:00Z', end: '2026-10-15T07:00:00Z', open: true }],
    };
    const now = '2026-10-15T07:00:00Z';
    const summary = todaySummary(computeLocalDays(data, profile, now), now, tz);
    expect(summary).toMatchObject({
      date: '2026-10-15',
      running: true,
      since: '2026-10-15T06:00:00.000Z',
      netMinutes: 60,
    });
    const empty = todaySummary([], now, tz);
    expect(empty).toMatchObject({
      running: false,
      netMinutes: 0,
      breakMinutes: 0,
      balanceMinutes: 0,
    });
  });

  it('Sollzeiten aus dem Profil: Arbeit am Samstag muss bestätigt werden', () => {
    const data: LocalData = {
      events: [
        ev('b1', 'boot', '2026-10-17T08:00:00Z', '2026-10-17T08:05:00Z'),
        ev('s1', 'shutdown', '2026-10-17T10:00:00Z'),
      ],
      spans: [
        { id: 'p1', start: '2026-10-17T08:00:00Z', end: '2026-10-17T10:00:00Z', open: false },
      ],
    };
    const days = computeLocalDays(data, profile, '2026-10-19T07:00:00Z');
    const items = reviewItems(days);
    expect(items).toEqual([
      expect.objectContaining({
        date: '2026-10-17',
        sessionId: 'b1',
        needsDecision: true,
        warnings: ['non_workday'],
      }),
    ]);

    // Mit Sollzeit am Samstag zählt die Sitzung automatisch
    const withSaturday = computeLocalDays(
      data,
      {
        ...profile,
        targetSchedule: [
          { validFrom: '2026-01-01', minutesByWeekday: [0, 480, 480, 480, 480, 480, 240] },
        ],
      },
      '2026-10-19T07:00:00Z',
    );
    expect(reviewItems(withSaturday)).toEqual([]);

    // Nach Bestätigung nicht mehr in der Liste
    const confirmed = computeLocalDays(
      {
        ...data,
        events: [
          ...data.events,
          {
            ...ev('c1', 'session_confirm', '2026-10-18T09:00:00Z'),
            source: 'user',
            refEventId: 'b1',
          },
        ],
      },
      profile,
      '2026-10-19T07:00:00Z',
    );
    expect(reviewItems(confirmed)).toEqual([]);
  });
});

describe('Daten mehrerer Geräte', () => {
  it('Handy-Netz und Laptop ergeben eine Sitzung (Fall 4)', () => {
    type T = LocalData['events'][number]['type'];
    const at = (id: string, deviceId: string, type: T, ts: string) => ({
      ...ev(id, type, ts, type === 'boot' ? new Date(Date.parse(ts) + 300_000).toISOString() : ts),
      deviceId,
      source: deviceId === 'H' ? ('wifi' as const) : ('system' as const),
    });
    const days = computeDeviceDays(
      {
        events: [
          at('n1', 'H', 'net_connected', '2026-10-14T05:50:00Z'),
          at('b1', 'L', 'boot', '2026-10-14T06:10:00Z'),
          at('s1', 'L', 'shutdown', '2026-10-14T14:30:00Z'),
          at('n2', 'H', 'net_lost', '2026-10-14T14:32:00Z'),
        ],
        spans: [
          {
            id: 'p1',
            deviceId: 'L',
            deviceKind: 'desktop',
            start: '2026-10-14T06:10:00Z',
            end: '2026-10-14T14:30:00Z',
            open: false,
          },
        ],
      },
      profile,
      '2026-10-15T07:00:00Z',
    );
    expect(days[0]).toMatchObject({
      date: '2026-10-14',
      start: '2026-10-14T05:50:00.000Z',
      end: '2026-10-14T14:35:00.000Z',
      workMinutes: 525,
      netMinutes: 495,
    });
  });
});

describe('Woche/Monat', () => {
  it('Tage ohne Erfassung zählen mit Sollzeit, Zukunft nicht', () => {
    const data: LocalData = {
      events: [
        ev('b1', 'boot', '2026-10-14T06:00:00Z', '2026-10-14T06:05:00Z'),
        ev('s1', 'shutdown', '2026-10-14T15:00:00Z'),
      ],
      spans: [
        { id: 'p1', start: '2026-10-14T06:00:00Z', end: '2026-10-14T10:00:00Z', open: false },
        { id: 'p2', start: '2026-10-14T10:45:00Z', end: '2026-10-14T15:00:00Z', open: false },
      ],
    };
    const withVacation: Profile = {
      ...profile,
      absences: [{ date: '2026-10-13', kind: 'vacation', minutes: 480 }],
    };
    const days = computeLocalDays(data, withVacation, '2026-10-15T07:00:00Z');
    const week = periodDays(days, withVacation, '2026-10-12', '2026-10-18', '2026-10-14');
    expect(week.days.map((d) => d.date)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    expect(week.days.map((d) => d.targetMinutes)).toEqual([480, 480, 480, 480, 480, 0, 0]);
    expect(week.netMinutes).toBe(500);
    expect(week.absenceMinutes).toBe(480);
    // Mo −480, Di Urlaub ±0, Mi +20; Do/Fr liegen nach `until`
    expect(week.balanceMinutes).toBe(-460);
  });
});
