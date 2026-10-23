// Erinnerungen „Ende vergessen?“, „über 10 h“ und „Pause fehlt“. Sie lesen nur die Warnungen
// des Regelwerks; ob eine Pause fehlt oder 10 h überschritten sind, entscheidet @timelog/rules.
import { type WorkDay, localDate } from '@timelog/rules';

export type ReminderKind = 'end_forgotten' | 'over_10h' | 'break_missing';

export const REMINDER_KINDS: readonly ReminderKind[] = [
  'end_forgotten',
  'over_10h',
  'break_missing',
];

/** Wochenrückblick: Wochentag (0 = Sonntag) und Uhrzeit (Ortszeit). */
export interface WeekReviewSetting {
  enabled: boolean;
  weekday: number;
  time: string;
}

export interface ReminderSettings {
  enabled: Record<ReminderKind, boolean>;
  /** Rückfrage nach automatisch erkanntem Arbeitsende (Push bzw. Desktop). */
  confirmEnd?: boolean;
  weekReview?: WeekReviewSetting;
  /** Ruhezeit (Ortszeit, `HH:MM`): keine Benachrichtigungen. Über Mitternacht erlaubt. */
  quietFrom: string;
  quietTo: string;
}

export const DEFAULT_REMINDERS: ReminderSettings = {
  enabled: { end_forgotten: true, over_10h: true, break_missing: true },
  confirmEnd: true,
  weekReview: { enabled: true, weekday: 5, time: '15:00' },
  quietFrom: '20:00',
  quietTo: '07:00',
};

export interface Reminder {
  /** Einmal je Tag und Art: `YYYY-MM-DD:kind`. */
  key: string;
  kind: ReminderKind;
  date: string;
}

const DAY_MS = 86_400_000;

function minutesOfDay(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Liegt `now` (in `tz`) in der Ruhezeit? */
export function inQuietHours(now: string, tz: string, settings: ReminderSettings): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const current = part('hour') * 60 + part('minute');
  const from = minutesOfDay(settings.quietFrom);
  const to = minutesOfDay(settings.quietTo);
  if (from === to) return false;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

/**
 * Fällige Erinnerungen, die noch nicht gesendet wurden. In der Ruhezeit keine; was dann noch
 * gilt, kommt danach.
 */
export function dueReminders(
  days: readonly WorkDay[],
  now: string,
  tz: string,
  settings: ReminderSettings,
  sent: ReadonlySet<string>,
): Reminder[] {
  if (inQuietHours(now, tz, settings)) return [];
  const nowMs = Date.parse(now);
  const today = localDate(nowMs, tz);
  const yesterday = localDate(nowMs - DAY_MS, tz);
  const found: Reminder[] = [];
  const add = (kind: ReminderKind, date: string) => {
    const key = `${date}:${kind}`;
    if (settings.enabled[kind] && !sent.has(key) && !found.some((r) => r.key === key)) {
      found.push({ key, kind, date });
    }
  };
  for (const day of days) {
    const warnings = new Set([...day.warnings, ...day.sessions.flatMap((s) => s.warnings)]);
    if (
      (day.date === today || day.date === yesterday) &&
      (warnings.has('no_end') || warnings.has('gap_end'))
    ) {
      add('end_forgotten', day.date);
    }
    if (day.date !== today) continue;
    if (warnings.has('over_10h')) add('over_10h', day.date);
    if (day.status === 'open' && warnings.has('break_violation')) add('break_missing', day.date);
  }
  return found;
}

/** Benachrichtigungs-Einstellungen des Kontos (`settings.notifications`). */
export interface AccountNotifications {
  forgotEnd: boolean;
  over10h: boolean;
  breakViolation: boolean;
  confirmEnd?: boolean;
  weekReview?: WeekReviewSetting;
  quietHours: { from: string; to: string };
}

export function remindersFromAccount(n: AccountNotifications): ReminderSettings {
  return {
    enabled: { end_forgotten: n.forgotEnd, over_10h: n.over10h, break_missing: n.breakViolation },
    ...(n.confirmEnd !== undefined ? { confirmEnd: n.confirmEnd } : {}),
    ...(n.weekReview ? { weekReview: { ...n.weekReview } } : {}),
    quietFrom: n.quietHours.from,
    quietTo: n.quietHours.to,
  };
}

export function remindersToAccount(r: ReminderSettings): AccountNotifications {
  return {
    forgotEnd: r.enabled.end_forgotten,
    over10h: r.enabled.over_10h,
    breakViolation: r.enabled.break_missing,
    ...(r.confirmEnd !== undefined ? { confirmEnd: r.confirmEnd } : {}),
    ...(r.weekReview ? { weekReview: { ...r.weekReview } } : {}),
    quietHours: { from: r.quietFrom, to: r.quietTo },
  };
}
