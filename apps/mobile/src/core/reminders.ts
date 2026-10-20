// Lokale Erinnerungen (Benachrichtigungen) aus dem berechneten Tag. Reine Funktion: plant nur
// Zeitpunkte; die Schwellen gelten für die tatsächliche Arbeitszeit des Regelwerks (workMinutes).
import type { TodaySummary } from '@timelog/app-core';
import { addDays, localDate, localTime, zonedToUtc } from '@timelog/rules';
import type { Settings } from '@timelog/shared';

export type ReminderKind = 'break6h' | 'break9h' | 'over10h' | 'forgotEnd' | 'confirmDay';

export interface Reminder {
  kind: ReminderKind;
  /** UTC */
  at: string;
}

const MIN = 60_000;
/** Vorlauf vor den ArbZG-Schwellen. */
const LEAD_MIN = 15;
const CONFIRM_AT = '16:00';

type Quiet = Settings['notifications']['quietHours'];

/** Liegt der Zeitpunkt in den Ruhezeiten (auch über Mitternacht, z. B. 20:00–07:00)? */
export function inQuietHours(ms: number, tz: string, quiet: Quiet): boolean {
  if (quiet.from === quiet.to) return false;
  const t = localTime(ms, tz);
  return quiet.from < quiet.to ? t >= quiet.from && t < quiet.to : t >= quiet.from || t < quiet.to;
}

/** Nächstes Ende der Ruhezeit ab `ms`. */
function quietEnd(ms: number, tz: string, quiet: Quiet): number {
  const today = localDate(ms, tz);
  const candidate = zonedToUtc(today, quiet.to, tz);
  return candidate > ms ? candidate : zonedToUtc(addDays(today, 1), quiet.to, tz);
}

export interface ReminderInput {
  today: TodaySummary;
  /** Anzahl der Einträge unter „Zu prüfen“ */
  reviewCount: number;
  notifications: Settings['notifications'];
  now: string;
  tz: string;
}

export function planReminders(input: ReminderInput): Reminder[] {
  const { today, notifications: n, tz } = input;
  const now = Date.parse(input.now);
  const out: Reminder[] = [];
  const work = today.day?.workMinutes ?? 0;
  const breaks = today.day?.breakMinutes ?? 0;
  const atWork = (minutes: number) => now + (minutes - work) * MIN;

  // ArbZG-Hinweise nur, solange die Arbeitszeit läuft; in Ruhezeiten entfallen sie.
  const legal = (kind: ReminderKind, ms: number) => {
    if (ms > now && !inQuietHours(ms, tz, n.quietHours))
      out.push({ kind, at: new Date(ms).toISOString() });
  };
  if (today.running) {
    if (n.breakViolation && breaks < 30 && work < 360) legal('break6h', atWork(360 - LEAD_MIN));
    if (n.breakViolation && breaks < 45 && work < 540) legal('break9h', atWork(540 - LEAD_MIN));
    if (n.over10h && work < 600) legal('over10h', atWork(600 - LEAD_MIN));
    if (n.forgotEnd) {
      // Läuft die Arbeitszeit noch, wenn die Ruhezeit beginnt, kurz vorher nachfragen.
      const date = localDate(now, tz);
      let start = zonedToUtc(date, n.quietHours.from, tz);
      if (start <= now) start = zonedToUtc(addDays(date, 1), n.quietHours.from, tz);
      const at = start - 5 * MIN;
      if (at > now) out.push({ kind: 'forgotEnd', at: new Date(at).toISOString() });
    }
  }

  // Offene Prüfungen: täglich um 16 Uhr, sonst nach der Ruhezeit.
  if (n.confirmDay && input.reviewCount > 0) {
    const date = localDate(now, tz);
    let at = zonedToUtc(date, CONFIRM_AT, tz);
    if (at <= now) at = zonedToUtc(addDays(date, 1), CONFIRM_AT, tz);
    if (inQuietHours(at, tz, n.quietHours)) at = quietEnd(at, tz, n.quietHours);
    out.push({ kind: 'confirmDay', at: new Date(at).toISOString() });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
