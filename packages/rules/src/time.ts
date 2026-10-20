// Zeitzonen-Hilfen ausschließlich mit der eingebauten Intl-API (keine Laufzeit-Abhängigkeiten).
// Alle Dauern werden aus UTC-Millisekunden berechnet; Zeitzonen dienen nur der Zuordnung zu Kalendertagen.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): LocalParts {
  const out: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type in out) out[p.type as keyof LocalParts] = Number(p.value);
  }
  return out;
}

function offsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Kalenderdatum YYYY-MM-DD des Zeitpunkts in der Zeitzone. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${String(p.year)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Uhrzeit HH:MM des Zeitpunkts in der Zeitzone. */
export function localTime(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Ungültiges Datum: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Lokale Zeit (Datum + HH:MM) in einer Zeitzone → UTC-Millisekunden.
 * Nicht existierende Zeiten (Lücke der Zeitumstellung) werfen einen Fehler.
 */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const [y, mo, d] = parseDate(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!tm) throw new RangeError(`Ungültige Uhrzeit: ${time}`);
  const h = Number(tm[1]);
  const mi = Number(tm[2]);
  const local = Date.UTC(y, mo - 1, d, h, mi);
  let guess = local - offsetMs(local, tz);
  guess = local - offsetMs(guess, tz);
  const p = localParts(guess, tz);
  if (p.year !== y || p.month !== mo || p.day !== d || p.hour !== h || p.minute !== mi) {
    throw new RangeError(`Lokale Zeit existiert nicht: ${date} ${time} ${tz}`);
  }
  return guess;
}

/** Beginn des Kalendertags (00:00 lokal) als UTC-Millisekunden. */
export function startOfLocalDay(date: string, tz: string): number {
  return zonedToUtc(date, '00:00', tz);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Wochentag des Datums, 0 = Sonntag. */
export function weekday(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
