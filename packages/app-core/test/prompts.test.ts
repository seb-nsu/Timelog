import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDERS,
  type LocalData,
  type Profile,
  type PromptLike,
  computeLocalDays,
  createTranslator,
  notifyOnDesktop,
  promptMessage,
  remindersFromAccount,
  remindersToAccount,
  weekSummary,
  weekdayName,
} from '../src/index.js';

const tz = 'Europe/Berlin';
const profile: Profile = { state: 'BE', timezone: tz };
const de = createTranslator('de');
const en = createTranslator('en');

const endConfirm = (date: string, endSource?: string): PromptLike => ({
  kind: 'end_confirm',
  ref: 's1',
  payload: { sessionId: 's1', date, end: '2026-10-14T15:12:00Z', tz, endSource },
});

describe('Rückfragen', () => {
  it('„Feierabend um … erkannt“ in de/en, Datum nur wenn nicht heute', () => {
    expect(promptMessage(endConfirm('2026-10-14'), de, '2026-10-14')).toEqual({
      title: 'Feierabend um 17:12 erkannt',
      body: 'Stimmt das?',
    });
    expect(promptMessage(endConfirm('2026-10-14'), en, '2026-10-15')).toEqual({
      title: 'End of work detected at 17:12',
      body: 'Wed, 14/10/2026: Is that right?',
    });
  });

  it('„Arbeitsende fehlt“ mit und ohne letzte Aktivität', () => {
    const p: PromptLike = {
      kind: 'end_missing',
      ref: 's2',
      payload: { sessionId: 's2', date: '2026-10-14', end: '2026-10-14T16:00:00Z', tz },
    };
    expect(promptMessage(p, de, '2026-10-15').body).toBe(
      'Mi., 14.10.2026: zuletzt aktiv um 18:00. War das das Ende?',
    );
    const noTime: PromptLike = {
      kind: 'end_missing',
      ref: 's2',
      payload: { sessionId: 's2', date: '2026-10-14', tz },
    };
    expect(promptMessage(noTime, en, '2026-10-15')).toEqual({
      title: 'End of work missing',
      body: 'Wed, 14/10/2026: please add the end in the day log.',
    });
  });

  it('Wochenrückblick mit Summen ohne Namen', () => {
    const p: PromptLike = {
      kind: 'week_review',
      ref: '2026-W42',
      payload: {
        week: '2026-W42',
        from: '2026-10-12',
        to: '2026-10-18',
        netMinutes: 2345,
        balanceMinutes: -20,
        openDays: 1,
        legalHints: 0,
      },
    };
    expect(promptMessage(p, de, '2026-10-16')).toEqual({
      title: 'Dein Wochenrückblick KW 42',
      body: '39:05 h netto · Saldo −0:20 h · offene Tage: 1 · Hinweise zum ArbZG: 0',
    });
    expect(promptMessage(p, en, '2026-10-16').title).toBe('Your week 42');
  });

  it('Desktop meldet ein Ende durch Herunterfahren nicht erneut', () => {
    expect(notifyOnDesktop(endConfirm('2026-10-14', 'shutdown'))).toBe(false);
    expect(notifyOnDesktop(endConfirm('2026-10-14', 'net_lost'))).toBe(true);
    expect(notifyOnDesktop(endConfirm('2026-10-14'))).toBe(true);
  });

  it('Wochentage für die Einstellung', () => {
    expect(weekdayName(5, de)).toBe('Freitag');
    expect(weekdayName(0, en)).toBe('Sunday');
  });
});

describe('Wochenrückblick', () => {
  it('nutzt das Regelwerk mit dem Profil', () => {
    const start = '2026-10-14T06:00:00Z';
    const now = '2026-10-14T09:00:00Z';
    const data: LocalData = {
      events: [{ id: 'b', type: 'boot', source: 'system', ts: start, tz, createdAt: start }],
      spans: [{ id: 'p', start, end: now, open: true }],
    };
    const days = computeLocalDays(data, profile, now);
    const week = weekSummary(days, profile, '2026-10-14', '2026-10-14');
    expect(week.week).toEqual({ id: '2026-W42', from: '2026-10-12', to: '2026-10-18' });
    expect(week.workMinutes).toBe(180);
    expect(week.targetMinutes).toBeGreaterThan(0);
  });
});

describe('Einstellungen', () => {
  it('Standard: Rückfrage an, Wochenrückblick Freitag 15:00', () => {
    expect(DEFAULT_REMINDERS.confirmEnd).toBe(true);
    expect(DEFAULT_REMINDERS.weekReview).toEqual({ enabled: true, weekday: 5, time: '15:00' });
  });

  it('Konto-Abbildung hin und zurück', () => {
    const account = {
      forgotEnd: true,
      over10h: false,
      breakViolation: true,
      confirmEnd: false,
      weekReview: { enabled: true, weekday: 1, time: '08:30' },
      quietHours: { from: '21:00', to: '07:00' },
    };
    const r = remindersFromAccount(account);
    expect(r.confirmEnd).toBe(false);
    expect(r.weekReview).toEqual({ enabled: true, weekday: 1, time: '08:30' });
    expect(remindersToAccount(r)).toEqual(account);
    const legacy = remindersFromAccount({
      forgotEnd: true,
      over10h: true,
      breakViolation: true,
      quietHours: { from: '21:00', to: '07:00' },
    });
    expect(legacy.confirmEnd).toBeUndefined();
    expect(remindersToAccount(legacy)).not.toHaveProperty('weekReview');
  });
});
