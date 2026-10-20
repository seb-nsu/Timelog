import { describe, expect, it } from '@jest/globals';
import type { TodaySummary } from '@timelog/app-core';
import type { WorkDay } from '@timelog/rules';
import { DEFAULT_SETTINGS } from '../src/core/core';
import { inQuietHours, planReminders } from '../src/core/reminders';
import { widgetState } from '../src/core/widget';
import { MOBILE_MESSAGES, createMobileTranslator } from '../src/i18n';

const tz = 'Europe/Berlin';

function day(work: number, breaks: number): WorkDay {
  return {
    date: '2026-10-15',
    sessions: [],
    breakMinutes: breaks,
    workMinutes: work,
    breakTopUpMin: 0,
    netMinutes: work,
    pendingMinutes: 0,
    absenceMinutes: 0,
    targetMinutes: 480,
    status: 'open',
    corrected: false,
    warnings: [],
  };
}

function today(work: number, breaks: number, running = true): TodaySummary {
  return {
    date: '2026-10-15',
    day: day(work, breaks),
    running,
    since: running ? '2026-10-15T06:00:00Z' : undefined,
    netMinutes: work,
    breakMinutes: breaks,
    balanceMinutes: 0,
  };
}

const notifications = DEFAULT_SETTINGS.notifications;

describe('Ruhezeiten', () => {
  it('über Mitternacht (20:00–07:00, Ortszeit)', () => {
    const q = { from: '20:00', to: '07:00' };
    expect(inQuietHours(Date.parse('2026-10-15T18:30:00Z'), tz, q)).toBe(true); // 20:30
    expect(inQuietHours(Date.parse('2026-10-15T04:00:00Z'), tz, q)).toBe(true); // 06:00
    expect(inQuietHours(Date.parse('2026-10-15T05:00:00Z'), tz, q)).toBe(false); // 07:00
    expect(inQuietHours(Date.parse('2026-10-15T10:00:00Z'), tz, q)).toBe(false);
  });

  it('gleiche Zeiten = keine Ruhezeit', () => {
    expect(inQuietHours(0, tz, { from: '00:00', to: '00:00' })).toBe(false);
  });
});

describe('Erinnerungen', () => {
  it('Pause, 10 h und vergessenes Ende bei laufender Arbeitszeit', () => {
    // 10:00 Ortszeit, 4 h gearbeitet ohne Pause
    const plan = planReminders({
      today: today(240, 0),
      reviewCount: 0,
      notifications,
      now: '2026-10-15T08:00:00Z',
      tz,
    });
    expect(plan).toEqual([
      { kind: 'break6h', at: '2026-10-15T09:45:00.000Z' },
      { kind: 'break9h', at: '2026-10-15T12:45:00.000Z' },
      { kind: 'over10h', at: '2026-10-15T13:45:00.000Z' },
      { kind: 'forgotEnd', at: '2026-10-15T17:55:00.000Z' },
    ]);
  });

  it('Schwellen aus tatsächlicher Arbeitszeit; genug Pause → keine Pausen-Erinnerung', () => {
    const plan = planReminders({
      today: today(400, 45),
      reviewCount: 0,
      notifications,
      now: '2026-10-15T13:00:00Z',
      tz,
    });
    expect(plan.map((r) => r.kind)).toEqual(['over10h', 'forgotEnd']);
  });

  it('in Ruhezeiten keine ArbZG-Hinweise; Prüfen wird auf das Ende verschoben', () => {
    const quiet = { ...notifications, quietHours: { from: '12:00', to: '17:00' } };
    const plan = planReminders({
      today: today(240, 0),
      reviewCount: 2,
      notifications: quiet,
      now: '2026-10-15T08:00:00Z',
      tz,
    });
    expect(plan).toEqual([
      { kind: 'break6h', at: '2026-10-15T09:45:00.000Z' }, // 11:45, vor der Ruhezeit
      { kind: 'forgotEnd', at: '2026-10-15T09:55:00.000Z' },
      { kind: 'confirmDay', at: '2026-10-15T15:00:00.000Z' },
    ]);
  });

  it('nichts, wenn abgeschaltet oder nicht laufend', () => {
    expect(
      planReminders({
        today: today(240, 0, false),
        reviewCount: 0,
        notifications,
        now: '2026-10-15T08:00:00Z',
        tz,
      }),
    ).toEqual([]);
    const off = {
      ...notifications,
      forgotEnd: false,
      over10h: false,
      breakViolation: false,
      confirmDay: false,
    };
    expect(
      planReminders({
        today: today(240, 0),
        reviewCount: 3,
        notifications: off,
        now: '2026-10-15T08:00:00Z',
        tz,
      }),
    ).toEqual([]);
  });
});

describe('Widget', () => {
  it('Texte in der App-Sprache', () => {
    const t = createMobileTranslator('de');
    expect(widgetState(today(125, 0), t, tz)).toEqual({
      running: true,
      since: '2026-10-15T06:00:00Z',
      netMinutes: 125,
      title: 'Arbeitszeit läuft',
      subtitle: 'seit 08:00 · Netto 2:05 h',
      startLabel: 'Arbeit beginnen',
      stopLabel: 'Arbeit beenden',
      tz,
    });
    expect(widgetState(today(0, 0, false), createMobileTranslator('en'), tz).title).toBe(
      'Not recording',
    );
  });
});

describe('Texte', () => {
  it('Englisch hat dieselben Platzhalter wie Deutsch', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, text] of Object.entries(MOBILE_MESSAGES.de)) {
      expect([key, vars(MOBILE_MESSAGES.en[key as keyof typeof MOBILE_MESSAGES.de])]).toEqual([
        key,
        vars(text),
      ]);
    }
  });

  it('Erinnerungstexte für jede Art', () => {
    const t = createMobileTranslator('de');
    for (const kind of ['break6h', 'break9h', 'over10h', 'forgotEnd', 'confirmDay'] as const) {
      expect(t.reminder(kind).title.length).toBeGreaterThan(0);
    }
    expect(t.absence('vacation')).toBe('Urlaub');
    expect(t.weekday(1)).toBe('Montag');
  });
});
