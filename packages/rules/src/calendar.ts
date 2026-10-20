// Vorschläge aus Kalenderterminen. Termine ändern nie selbst Arbeitszeit: Sie erklären Lücken
// („War Arbeit (Termin)“) und schlagen Abwesenheiten vor; der Nutzer bestätigt jeden Vorschlag.
import { type Range, clipRanges, mergeRanges } from './ranges.js';
import { MINUTE_MS, addDays, localDate, startOfLocalDay } from './time.js';
import type { Absence, AbsenceKind, WorkDay } from './types.js';

export type CalendarKind = 'busy' | 'absence';

/** Gespeicherter Termin: nur Beginn, Ende, Art – keine Titel, Teilnehmer oder Orte. */
export interface CalendarBlock {
  from: string;
  to: string;
  kind: CalendarKind;
  allDay: boolean;
  /** bei ganztägigen Terminen: erster Tag und Tag nach dem letzten (JJJJ-MM-TT) */
  startDate?: string;
  endDate?: string;
}

export interface GapSuggestion {
  date: string;
  /** Sitzung, zu der die Lücke gehört (bei Lücken zwischen Sitzungen die spätere) */
  sessionId: string;
  from: string;
  to: string;
  kind: 'break' | 'gap';
}

export interface AbsenceSuggestion {
  date: string;
  kind: AbsenceKind;
}

export interface SuggestionConfig {
  /** Mindestlänge der Überschneidung von Lücke und Termin */
  minOverlapMin: number;
}

export const DEFAULT_SUGGESTION_CONFIG: SuggestionConfig = { minOverlapMin: 15 };

/**
 * Lücken eines Tages (automatisch erkannte Pausen und Lücken zwischen nicht verworfenen Sitzungen), die in einem beschäftigt-Termin liegen. Vorschlag = Überschneidung von Lücke und Termin.
 */
export function gapSuggestions(
  day: WorkDay,
  blocks: readonly CalendarBlock[],
  config: SuggestionConfig = DEFAULT_SUGGESTION_CONFIG,
): GapSuggestion[] {
  const busy = mergeRanges(
    blocks
      .filter((b) => b.kind === 'busy' && !b.allDay)
      .map((b): Range => [Date.parse(b.from), Date.parse(b.to)]),
  );
  if (busy.length === 0) return [];
  const gaps: { r: Range; sessionId: string; kind: GapSuggestion['kind'] }[] = [];
  // Verworfene Sitzungen nicht; unbestätigte schon (eine lange Besprechung trennt oft Sitzungen).
  const counted = day.sessions
    .filter((s) => s.confirmed !== false)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const s of counted) {
    for (const b of s.breaks) {
      if (b.source === 'manual') continue;
      gaps.push({ r: [Date.parse(b.from), Date.parse(b.to)], sessionId: s.id, kind: 'break' });
    }
  }
  for (let i = 1; i < counted.length; i++) {
    const prev = counted[i - 1];
    const cur = counted[i];
    if (!prev?.end || !cur) continue;
    gaps.push({ r: [Date.parse(prev.end), Date.parse(cur.start)], sessionId: cur.id, kind: 'gap' });
  }
  const out: GapSuggestion[] = [];
  const minMs = config.minOverlapMin * MINUTE_MS;
  for (const g of gaps) {
    for (const piece of clipRanges(busy, g.r[0], g.r[1])) {
      if (piece[1] - piece[0] < minMs) continue;
      out.push({
        date: day.date,
        sessionId: g.sessionId,
        from: new Date(piece[0]).toISOString(),
        to: new Date(piece[1]).toISOString(),
        kind: g.kind,
      });
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Kalendertage, die ein Abwesenheits-Termin ganz abdeckt (ganztägig oder ≥ 24 h). */
function absenceDates(b: CalendarBlock, tz: string): string[] {
  if (b.kind !== 'absence') return [];
  let first: string;
  let afterLast: string;
  if (b.allDay && b.startDate && b.endDate) {
    first = b.startDate;
    afterLast = b.endDate;
  } else {
    const from = Date.parse(b.from);
    const to = Date.parse(b.to);
    // erster Tag, dessen Beginn im Termin liegt, bis zum letzten vollständig enthaltenen Tag
    first = localDate(from, tz);
    if (startOfLocalDay(first, tz) < from) first = addDays(first, 1);
    afterLast = localDate(to, tz);
  }
  const out: string[] = [];
  for (let d = first; d < afterLast && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Abwesenheits-Vorschläge: jeder Tag, den ein Abwesenheits-Termin ganz abdeckt und für den noch
 * keine Abwesenheit eingetragen ist. Vorschlag ist „Urlaub“; der Nutzer kann die Art ändern.
 */
export function absenceSuggestions(
  blocks: readonly CalendarBlock[],
  absences: readonly Absence[],
  tz: string,
  from: string,
  to: string,
): AbsenceSuggestion[] {
  const taken = new Set(absences.map((a) => a.date));
  const dates = new Set<string>();
  for (const b of blocks) for (const d of absenceDates(b, tz)) dates.add(d);
  return [...dates]
    .filter((d) => d >= from && d <= to && !taken.has(d))
    .sort()
    .map((date) => ({ date, kind: 'vacation' as const }));
}
