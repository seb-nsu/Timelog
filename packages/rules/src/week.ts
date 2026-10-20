// Wochenrückblick: fasst berechnete Arbeitstage einer Kalenderwoche (Mo–So) zusammen.
// Server (Push-Text) und Clients (Ansicht „Wochenrückblick“) nutzen dieselbe Funktion.
import { computeBalance, targetMinutes } from './compute.js';
import { addDays, weekday } from './time.js';
import { type RulesConfig, type Warning, type WorkDay } from './types.js';

/** Kalenderwoche nach ISO 8601: Montag bis Sonntag, Kennung `JJJJ-Www`. */
export interface IsoWeek {
  id: string;
  from: string;
  to: string;
}

/** Hinweise zum Arbeitszeitgesetz, die der Wochenrückblick nennt. */
export const LEGAL_HINT_WARNINGS = [
  'break_violation',
  'break_placement',
  'over_10h',
  'rest_under_11h',
  'sunday_or_holiday',
  'avg_over_8h',
] as const satisfies readonly Warning[];

export function isoWeekOf(date: string): IsoWeek {
  const from = addDays(date, -((weekday(date) + 6) % 7));
  // Das ISO-Jahr ist das Jahr des Donnerstags dieser Woche.
  const thursday = addDays(from, 3);
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${String(year)}-01-04`;
  const firstMonday = addDays(jan4, -((weekday(jan4) + 6) % 7));
  const week = Math.round((Date.parse(from) - Date.parse(firstMonday)) / (7 * 86_400_000)) + 1;
  return { id: `${String(year)}-W${String(week).padStart(2, '0')}`, from, to: addDays(from, 6) };
}

export interface WeekSummary {
  week: IsoWeek;
  /** Tatsächliche Arbeitszeit (vor Auffüllung) */
  workMinutes: number;
  netMinutes: number;
  /** Soll der ganzen Woche */
  targetMinutes: number;
  absenceMinutes: number;
  /** Saldo bis einschließlich `until`; wie in der Übersicht zählen nur Tage mit Erfassung oder Abwesenheit. */
  balanceMinutes: number;
  /** Tage mit Prüf-Warnungen (Status `unchecked`); sie bleiben bei „Woche bestätigen“ offen. */
  openDays: string[];
  /** Unproblematische Tage mit noch nicht bestätigten Sitzungen. */
  confirmableDays: string[];
  confirmedDays: string[];
  /** Hinweise zum Arbeitszeitgesetz je Tag. */
  legalHints: { date: string; warnings: Warning[] }[];
}

const isLegal = (w: Warning): boolean => (LEGAL_HINT_WARNINGS as readonly Warning[]).includes(w);

/**
 * Wochenrückblick für die Woche, in der `date` liegt. `days` sind Ergebnisse von `computeDays`
 * (Tage außerhalb der Woche werden ignoriert); Tage nach `until` zählen nicht zum Saldo.
 */
export function summarizeWeek(
  days: readonly WorkDay[],
  cfg: RulesConfig,
  date: string,
  until: string,
): WeekSummary {
  const week = isoWeekOf(date);
  const inWeek = days
    .filter((d) => d.date >= week.from && d.date <= week.to)
    .sort((a, b) => a.date.localeCompare(b.date));
  let target = 0;
  for (let d = week.from; d <= week.to; d = addDays(d, 1)) {
    const day = inWeek.find((x) => x.date === d);
    target += day ? day.targetMinutes : targetMinutes(d, cfg);
  }
  const sum = (f: (d: WorkDay) => number) => inWeek.reduce((s, d) => s + f(d), 0);
  // Das Regelwerk liefert nur Tage mit Erfassung oder Abwesenheit; leere Tage zählen nicht als Minus.
  const counted = inWeek.filter((d) => d.date <= until);
  const legalHints: WeekSummary['legalHints'] = [];
  for (const d of inWeek) {
    const all = new Set([...d.warnings, ...d.sessions.flatMap((s) => s.warnings)]);
    const warnings = [...all].filter(isLegal);
    if (warnings.length > 0) legalHints.push({ date: d.date, warnings });
  }
  return {
    week,
    workMinutes: sum((d) => d.workMinutes),
    netMinutes: sum((d) => d.netMinutes),
    targetMinutes: target,
    absenceMinutes: sum((d) => d.absenceMinutes),
    balanceMinutes: computeBalance(counted),
    openDays: inWeek.filter((d) => d.status === 'unchecked').map((d) => d.date),
    confirmableDays: inWeek
      .filter(
        (d) =>
          d.status === 'auto' &&
          d.date <= until &&
          d.sessions.some((s) => s.confirmed === undefined && !s.open),
      )
      .map((d) => d.date),
    confirmedDays: inWeek.filter((d) => d.status === 'confirmed').map((d) => d.date),
    legalHints,
  };
}
