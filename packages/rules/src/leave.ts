// Urlaubs- und Überstundenkonto: reine Funktionen ohne Seiteneffekte.
// Arbeitstage kommen aus der Sollzeit- und Feiertagslogik (targetMinutes): Urlaub an Wochenenden,
// Feiertagen oder Tagen ohne Sollzeit zählt nicht.
import { computeBalance, creditedAbsenceMinutes, targetMinutes } from './compute.js';
import { addDays } from './time.js';
import type { Absence, AbsenceKind, RulesConfig, WorkDay } from './types.js';

export { creditedAbsenceMinutes };

export type LeaveKind = 'vacation' | 'overtime';

export interface LeaveRange {
  from: string;
  to: string;
  /** Erster Tag nur halb (z. B. Nachmittag frei). */
  halfDayStart?: boolean;
  /** Letzter Tag nur halb. Bei from = to genügt eine der beiden Angaben. */
  halfDayEnd?: boolean;
}

export interface LeaveDay {
  date: string;
  /** 1 oder 0,5 Urlaubstage. */
  fraction: number;
  /** Sollzeit des Tages × Anteil (Gutschrift bei Urlaub, Abbau bei Überstunden). */
  minutes: number;
}

/** Höchstlänge eines Antrags in Kalendertagen. */
export const MAX_LEAVE_RANGE_DAYS = 366;

/**
 * Arbeitstage eines Antrags: nur Tage mit Sollzeit > 0 (keine Wochenenden, Feiertage nach
 * Bundesland, Teilzeit-freie Tage). Halbe Tage am Anfang bzw. Ende.
 */
export function leaveDays(range: LeaveRange, cfg: RulesConfig): LeaveDay[] {
  if (range.to < range.from) return [];
  const out: LeaveDay[] = [];
  let n = 0;
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    n += 1;
    if (n > MAX_LEAVE_RANGE_DAYS) break;
    const target = targetMinutes(date, cfg);
    if (target <= 0) continue;
    const half =
      (date === range.from && range.halfDayStart === true) ||
      (date === range.to && range.halfDayEnd === true);
    const fraction = half ? 0.5 : 1;
    out.push({ date, fraction, minutes: Math.round(target * fraction) });
  }
  return out;
}

/** Abwesenheiten, die ein genehmigter Antrag erzeugt. */
export function leaveAbsences(kind: LeaveKind, days: readonly LeaveDay[]): Absence[] {
  return days.map((d) => ({ date: d.date, kind, minutes: d.minutes }));
}

export const sumDays = (days: readonly { fraction: number }[]): number =>
  round2(days.reduce((s, d) => s + d.fraction, 0));

const round2 = (x: number): number => Math.round(x * 100) / 100;

// ── Anspruch ──────────────────────────────────────────────────────────────────

export interface EntitlementInput {
  year: number;
  /** Jahresanspruch in Tagen bei voller Beschäftigung und `standardWorkdaysPerWeek` Arbeitstagen. */
  annualDays: number;
  /** Arbeitstage je Woche der Person (Teilzeit); Standard = standardWorkdaysPerWeek. */
  workdaysPerWeek?: number;
  standardWorkdaysPerWeek?: number;
  /** Eintritt bzw. Austritt (JJJJ-MM-TT); anteilig 1/12 je vollem Beschäftigungsmonat im Jahr. */
  entryDate?: string;
  exitDate?: string;
}

/**
 * Beginn des nächsten Beschäftigungsmonats nach `months` Monaten ab `date` (§ 188 BGB): Fehlt der
 * entsprechende Tag im Zielmonat, endet die Frist am Monatsletzten, der nächste Monat beginnt danach.
 */
function monthStartAfter(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const d = Number(date.slice(8, 10));
  const year = y + Math.floor(m / 12);
  const month = m % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const iso = `${String(year)}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  return d > last ? addDays(iso, 1) : iso;
}

/** Volle Beschäftigungsmonate zwischen from und to (beide einschließlich). */
export function fullMonths(from: string, to: string): number {
  if (to < from) return 0;
  const endExclusive = addDays(to, 1);
  let k = 0;
  while (k < 12 && monthStartAfter(from, k + 1) <= endExclusive) k += 1;
  return k;
}

/**
 * Jahresanspruch: Teilzeit anteilig nach Arbeitstagen je Woche; bei Eintritt oder Austritt im Jahr
 * 1/12 je vollem Beschäftigungsmonat (§ 5 BUrlG vereinfacht), Bruchteile ab einem halben Tag werden
 * aufgerundet (§ 5 Abs. 2 BUrlG), kleinere bleiben erhalten. Keine Rechtsberatung.
 */
export function vacationEntitlement(input: EntitlementInput): number {
  const standard = input.standardWorkdaysPerWeek ?? 5;
  const perWeek = input.workdaysPerWeek ?? standard;
  const base = standard > 0 ? (input.annualDays * perWeek) / standard : 0;
  const yearStart = `${String(input.year)}-01-01`;
  const yearEnd = `${String(input.year)}-12-31`;
  const from = input.entryDate && input.entryDate > yearStart ? input.entryDate : yearStart;
  const to = input.exitDate && input.exitDate < yearEnd ? input.exitDate : yearEnd;
  if (from > yearEnd || to < yearStart || to < from) return 0;
  if (from === yearStart && to === yearEnd) return round2(base);
  const prorated = (base * fullMonths(from, to)) / 12;
  const whole = Math.floor(prorated);
  const rest = prorated - whole;
  return round2(rest >= 0.5 ? whole + 1 : prorated);
}

// ── Urlaubskonto ──────────────────────────────────────────────────────────────

export interface CarryOverRule {
  /** Verfall des Resturlaubs aus dem Vorjahr, Monat-Tag (Standard 03-31). */
  expiry: string;
  /**
   * Verfällt Resturlaub tatsächlich? Nach BAG (9 AZR 541/15) nur, wenn der Arbeitgeber rechtzeitig
   * auf den drohenden Verfall hingewiesen hat. Ohne Hinweis false setzen.
   */
  expires: boolean;
}

export const DEFAULT_CARRY_OVER: CarryOverRule = { expiry: '03-31', expires: true };

export interface VacationEntry {
  date: string;
  fraction: number;
  /** pending = beantragt, noch nicht entschieden. */
  status: 'approved' | 'pending';
}

export interface VacationYearInput {
  year: number;
  entitlement: number;
  /** Manuelle Korrekturen (z. B. Sonderurlaub, Ausgleich), Summe in Tagen. */
  correction?: number;
  /** Manuell gesetzter Übertrag aus dem Vorjahr; überschreibt die Automatik. */
  manualCarryOver?: number;
}

export interface VacationAccount {
  year: number;
  entitlement: number;
  correction: number;
  carryOver: number;
  carryOverManual: boolean;
  /** Übertrag, der vor dem Verfallsdatum genommen wurde. */
  carryOverUsed: number;
  /** Verfallener Übertrag (nur nach dem Verfallsdatum und wenn Verfall aktiv). */
  carryOverForfeited: number;
  carryOverExpiry: string;
  /** Genehmigt und bis heute (einschließlich) genommen. */
  taken: number;
  /** Genehmigt, aber nach heute. */
  planned: number;
  /** Beantragt, noch nicht entschieden. */
  pending: number;
  /** Anspruch + Korrektur + Übertrag − Verfall − genommen − geplant. */
  remaining: number;
  /** Rest nach Abzug offener Anträge. */
  remainingAfterPending: number;
}

/**
 * Urlaubskonten über mehrere Jahre: Rest eines Jahres wird ins Folgejahr übertragen; Übertrag wird
 * zuerst verbraucht und verfällt zum Stichtag, soweit bis dahin nicht genommen (wenn `expires`).
 * Manuelle Überträge überschreiben die Automatik. `today` bestimmt genommen/geplant und Verfall.
 */
export function vacationAccounts(
  years: readonly VacationYearInput[],
  entries: readonly VacationEntry[],
  rule: CarryOverRule,
  today: string,
): VacationAccount[] {
  const sorted = [...years].sort((a, b) => a.year - b.year);
  const out: VacationAccount[] = [];
  let previousRest: number | undefined;
  let previousYear: number | undefined;
  for (const y of sorted) {
    const prefix = String(y.year);
    const inYear = entries
      .filter((e) => e.date.startsWith(prefix))
      .sort((a, b) => a.date.localeCompare(b.date));
    const expiry = `${prefix}-${rule.expiry}`;
    const automatic = previousYear === y.year - 1 ? Math.max(0, previousRest ?? 0) : 0;
    const carryOver = round2(y.manualCarryOver ?? automatic);
    const approved = inYear.filter((e) => e.status === 'approved');
    // Übertrag zuerst verbrauchen, aber nur mit Urlaub bis zum Verfallsdatum.
    const beforeExpiry = sumDays(approved.filter((e) => e.date <= expiry));
    const carryOverUsed = round2(Math.min(carryOver, beforeExpiry));
    const expired = rule.expires && today > expiry;
    const carryOverForfeited = expired ? round2(carryOver - carryOverUsed) : 0;
    const taken = sumDays(approved.filter((e) => e.date <= today));
    const planned = sumDays(approved.filter((e) => e.date > today));
    const pending = sumDays(inYear.filter((e) => e.status === 'pending'));
    const correction = round2(y.correction ?? 0);
    const remaining = round2(
      y.entitlement + correction + carryOver - carryOverForfeited - taken - planned,
    );
    // Rest zum Jahresende: Verfall des Übertrags ist dann sicher eingetreten (falls aktiv).
    const forfeitAtYearEnd = rule.expires ? round2(carryOver - carryOverUsed) : 0;
    previousRest = round2(
      y.entitlement + correction + carryOver - forfeitAtYearEnd - taken - planned,
    );
    previousYear = y.year;
    out.push({
      year: y.year,
      entitlement: round2(y.entitlement),
      correction,
      carryOver,
      carryOverManual: y.manualCarryOver !== undefined,
      carryOverUsed,
      carryOverForfeited,
      carryOverExpiry: expiry,
      taken,
      planned,
      pending,
      remaining,
      remainingAfterPending: round2(remaining - pending),
    });
  }
  return out;
}

/**
 * Freie Urlaubs-Einträge (ohne Antrag, z. B. Privatversion): Anteil eines Tages aus Minuten und
 * Sollzeit, auf halbe Tage gerundet (mindestens 0,5); Tage ohne Sollzeit zählen nicht.
 */
export function absenceFraction(minutes: number, target: number): number {
  if (target <= 0 || minutes <= 0) return 0;
  return minutes * 2 < target * 1.5 ? 0.5 : 1;
}

// ── Überstundenkonto ──────────────────────────────────────────────────────────

export interface OvertimeBooking {
  month: string;
  /** Negativ = Auszahlung bzw. Kappung, positiv = Gutschrift. */
  minutes: number;
}

export interface OvertimeMonth {
  month: string;
  /** Saldo des Monats aus den Arbeitstagen (Netto + Abwesenheit − Soll). */
  workMinutes: number;
  /** Manuelle Buchungen des Monats (Auszahlung, Kappung, Korrektur). */
  bookedMinutes: number;
  /** Überstundenabbau im Monat (nur Info; bereits im Arbeitstag-Saldo enthalten). */
  reducedMinutes: number;
  /** Kontostand am Monatsende. */
  balanceMinutes: number;
  /** Kontostand über dem Höchstsaldo. */
  overMax: boolean;
}

/** Monat (JJJJ-MM) eines Datums. */
const monthOf = (date: string): string => date.slice(0, 7);

/**
 * Saldo-Verlauf je Monat: Arbeitstage (überstundenfreie Tage mit 0 Gutschrift senken den Saldo),
 * plus manuelle Buchungen. `startBalance` = Kontostand vor dem ersten Monat.
 */
export function overtimeHistory(
  months: readonly string[],
  days: readonly WorkDay[],
  absences: readonly Pick<Absence, 'date' | 'kind' | 'minutes'>[],
  bookings: readonly OvertimeBooking[],
  maxBalanceMinutes?: number,
  startBalance = 0,
): OvertimeMonth[] {
  let balance = startBalance;
  return [...months].sort().map((month) => {
    const workMinutes = computeBalance(days.filter((d) => monthOf(d.date) === month));
    const bookedMinutes = bookings
      .filter((b) => b.month === month)
      .reduce((s, b) => s + b.minutes, 0);
    const reducedMinutes = absences
      .filter((a) => a.kind === 'overtime' && monthOf(a.date) === month)
      .reduce((s, a) => s + a.minutes, 0);
    balance += workMinutes + bookedMinutes;
    return {
      month,
      workMinutes,
      bookedMinutes,
      reducedMinutes,
      balanceMinutes: balance,
      overMax: maxBalanceMinutes !== undefined && balance > maxBalanceMinutes,
    };
  });
}

// ── Lohn-Export ───────────────────────────────────────────────────────────────

export interface PayrollAbsenceDay {
  date: string;
  kind: AbsenceKind;
  minutes: number;
  /** Anteil des Tages (1 oder 0,5) bezogen auf die Sollzeit. */
  fraction: number;
}

export interface PayrollMonth {
  /** Netto-Arbeitszeit des Monats (nach ausgewiesener Pausenauffüllung). */
  netMinutes: number;
  /** Tatsächliche Arbeitszeit des Monats (vor Auffüllung). */
  workMinutes: number;
  absences: PayrollAbsenceDay[];
  /** Tage nach Art (Summe der Anteile). */
  daysByKind: Record<AbsenceKind, number>;
}

/** Lohnrelevante Summen eines (freigegebenen) Monats aus Snapshot-Tagen und Abwesenheiten. */
export function payrollMonth(
  days: readonly WorkDay[],
  absences: readonly Pick<Absence, 'date' | 'kind' | 'minutes'>[],
  cfg: RulesConfig,
): PayrollMonth {
  const targetByDate = new Map(days.map((d) => [d.date, d.targetMinutes]));
  const list: PayrollAbsenceDay[] = [...absences]
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
    .map((a) => {
      const target = targetByDate.get(a.date) ?? targetMinutes(a.date, cfg);
      // Überstundenabbau trägt die abgebauten Minuten; der Anteil bezieht sich auf die Sollzeit.
      return {
        date: a.date,
        kind: a.kind,
        minutes: a.minutes,
        fraction: absenceFraction(a.minutes, target),
      };
    })
    .filter((a) => a.fraction > 0);
  const daysByKind: Record<AbsenceKind, number> = {
    vacation: 0,
    sick: 0,
    holiday: 0,
    other: 0,
    overtime: 0,
  };
  for (const a of list) daysByKind[a.kind] = round2(daysByKind[a.kind] + a.fraction);
  return {
    netMinutes: days.reduce((s, d) => s + d.netMinutes, 0),
    workMinutes: days.reduce((s, d) => s + d.workMinutes, 0),
    absences: list,
    daysByKind,
  };
}

/** Arbeitsabschnitte eines Tages (für Personio): gezählte Sitzungen minus Pausen, auf den Tag zugeschnitten. */
export interface WorkPeriod {
  start: string;
  end: string;
}

export function dayWorkPeriods(day: WorkDay, dayStartMs: number, dayEndMs: number): WorkPeriod[] {
  const out: WorkPeriod[] = [];
  for (const s of day.sessions) {
    if (!s.end || s.confirmed === false) continue;
    if (s.needsConfirmation && s.confirmed !== true) continue;
    let cursor = Math.max(Date.parse(s.start), dayStartMs);
    const end = Math.min(Date.parse(s.end), dayEndMs);
    const breaks = [...s.breaks].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
    for (const b of breaks) {
      const from = Math.max(Date.parse(b.from), cursor);
      const to = Math.min(Date.parse(b.to), end);
      if (to <= from) continue;
      if (from > cursor) out.push({ start: iso(cursor), end: iso(from) });
      cursor = to;
    }
    if (end > cursor) out.push({ start: iso(cursor), end: iso(end) });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

const iso = (ms: number): string => new Date(ms).toISOString();
