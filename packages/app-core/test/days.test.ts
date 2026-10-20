import { describe, expect, it } from 'vitest';
import {
  type LocalData,
  type Profile,
  computeLocalDays,
  detectedBreaks,
  eventsOfDay,
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
