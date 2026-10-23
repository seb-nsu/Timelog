// Formatierung für die Anzeige. Rechnet nichts fachlich, nur Darstellung.
import { localTime } from '@timelog/rules';

/** Minuten als Stunden:Minuten, z. B. 465 → "7:45", -20 → "−0:20". */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? '−' : '';
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h)}:${String(m).padStart(2, '0')}`;
}

/** Saldo mit Vorzeichen, z. B. "+1:05" oder "−0:20". */
export function formatBalance(minutes: number): string {
  return minutes > 0 ? `+${formatMinutes(minutes)}` : formatMinutes(minutes);
}

/** Uhrzeit in der Zeitzone des Ereignisses bzw. der Sitzung. */
export function formatClock(iso: string, tz: string): string {
  return localTime(Date.parse(iso), tz);
}

/** Datum ausgeschrieben, z. B. "Mi., 14.10.2026". */
export function formatDate(date: string, locale = 'de-DE'): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

/** Volle Minuten zwischen zwei Zeitpunkten (UTC-Differenz). */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}
