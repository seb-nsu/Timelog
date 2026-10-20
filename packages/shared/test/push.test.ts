import { describe, expect, it } from 'vitest';
import { promptSchema, pushData, settingsSchema } from '../src/index.js';

describe('Push-Schemas', () => {
  it('Einstellungen: Rückfrage und Wochenrückblick mit Standardwerten', () => {
    const s = settingsSchema.parse({});
    expect(s.notifications.confirmEnd).toBe(true);
    expect(s.notifications.weekReview).toEqual({ enabled: true, weekday: 5, time: '15:00' });
    // Alte Einstellungen ohne die neuen Felder bleiben gültig
    const old = settingsSchema.parse({ notifications: { forgotEnd: false } });
    expect(old.notifications).toMatchObject({ forgotEnd: false, confirmEnd: true });
    expect(
      settingsSchema.safeParse({ notifications: { weekReview: { weekday: 7 } } }).success,
    ).toBe(false);
  });

  it('Push-Daten enthalten nur Kennungen und Zeiten', () => {
    expect(pushData.parse({ kind: 'end_confirm', sessionId: 'b1', date: '2026-10-14' })).toEqual({
      kind: 'end_confirm',
      sessionId: 'b1',
      date: '2026-10-14',
    });
    expect(
      pushData.safeParse({ kind: 'week_review', week: '2026-42', date: '2026-10-12' }).success,
    ).toBe(false);
    expect(pushData.safeParse({ kind: 'unknown' }).success).toBe(false);
  });

  it('Rückfragen nach Art', () => {
    expect(
      promptSchema.safeParse({
        kind: 'week_review',
        ref: '2026-W42',
        createdAt: '2026-10-16T13:00:00.000Z',
        payload: {
          week: '2026-W42',
          from: '2026-10-12',
          to: '2026-10-18',
          netMinutes: 2300,
          balanceMinutes: -100,
          openDays: 1,
          legalHints: 0,
        },
      }).success,
    ).toBe(true);
  });
});
