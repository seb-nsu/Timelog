// Tagesort (Büro, Homeoffice, unterwegs/unbekannt) und Jahresübersicht für den Homeoffice-Nachweis.
//
// Regeln (angelehnt an die Tagespauschale, § 4 Abs. 5 Satz 1 Nr. 6c EStG):
// - Grundlage ist die gezählte Arbeitszeit des Tages, geschnitten mit den Zeiten in hinterlegten Netzen.
// - „Büro“, sobald mindestens `minOfficeMin` Arbeitszeit in einem Büro-Netz liegt (kurze Ausreißer
//   werden ignoriert); an solchen Tagen gilt die Pauschale in der Regel nicht.
// - „Homeoffice“, wenn mehr als die Hälfte der Arbeitszeit in einem Homeoffice-Netz liegt
//   („überwiegend in der häuslichen Wohnung“).
// - sonst „unterwegs/unbekannt“ (`other`).
// - Eine manuelle Angabe je Tag überschreibt die Automatik und ist gesperrt.
import { type Range, clipRanges, mergeRanges, totalLength } from './ranges.js';
import type { NetworkRange } from './segments.js';
import { workRanges } from './segments.js';
import { MINUTE_MS } from './time.js';
import type { WorkDay } from './types.js';

export type WorkLocation = 'office' | 'home' | 'other';
export const WORK_LOCATIONS = [
  'office',
  'home',
  'other',
] as const satisfies readonly WorkLocation[];

export interface LocationConfig {
  /** Ab so viel Arbeitszeit im Büro-Netz gilt der Tag als Bürotag. */
  minOfficeMin: number;
}

export const DEFAULT_LOCATION_CONFIG: LocationConfig = { minOfficeMin: 15 };

export interface DayLocation {
  date: string;
  /** fehlt an Tagen ohne gezählte Arbeitszeit und ohne manuelle Angabe */
  location?: WorkLocation;
  source: 'auto' | 'manual';
  officeMinutes: number;
  homeMinutes: number;
}

/**
 * Ermittelt den Ort eines Arbeitstags.
 * `networkLocations` ordnet jeder Netz-ID ihren Ort zu; unbekannte Netze zählen als `other`.
 */
export function dayLocation(
  day: WorkDay,
  nets: readonly NetworkRange[],
  networkLocations: Readonly<Record<string, WorkLocation>>,
  override?: WorkLocation,
  config: LocationConfig = DEFAULT_LOCATION_CONFIG,
  now?: string,
): DayLocation {
  const work = workRanges(day, now);
  const inPlace = (place: WorkLocation): number => {
    const ranges: Range[] = [];
    for (const n of nets) {
      if ((networkLocations[n.networkId] ?? 'other') !== place) continue;
      for (const w of work)
        ranges.push(...clipRanges([[Date.parse(n.from), Date.parse(n.to)]], w[0], w[1]));
    }
    return Math.floor(totalLength(mergeRanges(ranges)) / MINUTE_MS);
  };
  const officeMinutes = inPlace('office');
  const homeMinutes = inPlace('home');
  const base = { date: day.date, officeMinutes, homeMinutes };
  if (override) return { ...base, location: override, source: 'manual' };
  const total = Math.floor(totalLength(work) / MINUTE_MS);
  if (total <= 0) return { ...base, source: 'auto' };
  let location: WorkLocation = 'other';
  if (officeMinutes >= config.minOfficeMin) location = 'office';
  else if (homeMinutes * 2 > total) location = 'home';
  return { ...base, location, source: 'auto' };
}

export interface HomeOfficeAllowance {
  /** Betrag je Homeoffice-Tag in Cent (Konfigurationswert, z. B. 600). */
  perDayCents: number;
  /** Höchstbetrag je Jahr in Cent (Konfigurationswert, z. B. 126000). */
  maxPerYearCents: number;
}

export interface HomeOfficeSummary {
  homeDays: number;
  officeDays: number;
  otherDays: number;
  /** Homeoffice-Tage je Monat, Index 0 = Januar */
  homeDaysByMonth: number[];
  /** Tage, bis der Höchstbetrag erreicht ist */
  maxDays: number;
  /** Tage × Tagesbetrag, gedeckelt (nur Hinweis, keine Steuerberatung) */
  amountCents: number;
}

/** Jahresübersicht aus den Tagesorten eines Jahres. */
export function homeOfficeSummary(
  locations: readonly DayLocation[],
  allowance: HomeOfficeAllowance,
): HomeOfficeSummary {
  const byMonth = Array.from({ length: 12 }, () => 0);
  let home = 0;
  let office = 0;
  let other = 0;
  for (const l of locations) {
    if (l.location === 'home') {
      home += 1;
      const m = Number(l.date.slice(5, 7)) - 1;
      byMonth[m] = (byMonth[m] as number) + 1;
    } else if (l.location === 'office') office += 1;
    else if (l.location === 'other') other += 1;
  }
  const maxDays =
    allowance.perDayCents > 0 ? Math.floor(allowance.maxPerYearCents / allowance.perDayCents) : 0;
  return {
    homeDays: home,
    officeDays: office,
    otherDays: other,
    homeDaysByMonth: byMonth,
    maxDays,
    amountCents: Math.min(home * allowance.perDayCents, allowance.maxPerYearCents),
  };
}
