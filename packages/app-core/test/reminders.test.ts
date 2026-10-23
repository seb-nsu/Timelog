import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDERS,
  type LocalData,
  type Profile,
  computeLocalDays,
  dueReminders,
  inQuietHours,
} from '../src/index.js';

const tz = 'Europe/Berlin';
const profile: Profile = { state: 'BE', timezone: tz };
const boot = (ts: string) => ({
  id: `b-${ts}`,
  type: 'boot' as const,
  source: 'system' as const,
  ts,
  tz,
  createdAt: ts,
});

/** Laufende Sitzung ab `start` ohne Pause, aktiv bis `now`. */
function running(start: string, now: string): LocalData {
  return { events: [boot(start)], spans: [{ id: 'p', start, end: now, open: true }] };
}

describe('Erinnerungen', () => {
  it('Ruhezeit über Mitternacht', () => {
    expect(inQuietHours('2026-10-14T19:30:00Z', tz, DEFAULT_REMINDERS)).toBe(true); // 21:30
    expect(inQuietHours('2026-10-15T04:30:00Z', tz, DEFAULT_REMINDERS)).toBe(true); // 06:30
    expect(inQuietHours('2026-10-15T05:00:00Z', tz, DEFAULT_REMINDERS)).toBe(false); // 07:00
    expect(
      inQuietHours('2026-10-15T10:00:00Z', tz, {
        ...DEFAULT_REMINDERS,
        quietFrom: '12:00',
        quietTo: '13:00',
      }),
    ).toBe(true);
    expect(
      inQuietHours('2026-10-15T10:00:00Z', tz, {
        ...DEFAULT_REMINDERS,
        quietFrom: '00:00',
        quietTo: '00:00',
      }),
    ).toBe(false);
  });

  it('„Pause fehlt“ nach über 6 h ohne Pause, einmal je Tag', () => {
    const now = '2026-10-14T12:30:00Z'; // 14:30, seit 07:00
    const days = computeLocalDays(running('2026-10-14T05:00:00Z', now), profile, now);
    const due = dueReminders(days, now, tz, DEFAULT_REMINDERS, new Set());
    expect(due.map((r) => r.key)).toContain('2026-10-14:break_missing');
    expect(
      dueReminders(days, now, tz, DEFAULT_REMINDERS, new Set(['2026-10-14:break_missing'])),
    ).toEqual(due.filter((r) => r.kind !== 'break_missing'));
    const off = {
      ...DEFAULT_REMINDERS,
      enabled: { ...DEFAULT_REMINDERS.enabled, break_missing: false },
    };
    expect(
      dueReminders(days, now, tz, off, new Set()).some((r) => r.kind === 'break_missing'),
    ).toBe(false);
  });

  it('„über 10 h“ und Ruhezeit', () => {
    const now = '2026-10-14T16:30:00Z'; // 18:30, seit 06:00
    const days = computeLocalDays(running('2026-10-14T04:00:00Z', now), profile, now);
    expect(dueReminders(days, now, tz, DEFAULT_REMINDERS, new Set()).map((r) => r.kind)).toContain(
      'over_10h',
    );
    const late = '2026-10-14T19:00:00Z';
    const lateDays = computeLocalDays(running('2026-10-14T04:00:00Z', late), profile, late);
    expect(dueReminders(lateDays, late, tz, DEFAULT_REMINDERS, new Set())).toEqual([]);
  });

  it('„Ende vergessen?“ am Morgen nach manuellem Start ohne Ende', () => {
    const start = '2026-10-14T07:00:00Z';
    const data: LocalData = {
      events: [{ id: 'm1', type: 'manual_start', source: 'user', ts: start, tz, createdAt: start }],
      spans: [],
    };
    const now = '2026-10-15T06:00:00Z'; // 08:00 am Folgetag
    const days = computeLocalDays(data, profile, now);
    expect(dueReminders(days, now, tz, DEFAULT_REMINDERS, new Set()).map((r) => r.key)).toContain(
      '2026-10-14:end_forgotten',
    );
  });

  it('kurze Sitzung: keine Erinnerung', () => {
    const now = '2026-10-14T08:00:00Z';
    const days = computeLocalDays(running('2026-10-14T06:00:00Z', now), profile, now);
    expect(dueReminders(days, now, tz, DEFAULT_REMINDERS, new Set())).toEqual([]);
  });
});
