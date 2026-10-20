// Aufteilung der Netto-Arbeitszeit eines Tages auf Projekte.
//
// Entscheidungen:
// - Grundlage sind die tatsächlich gezählten Arbeitszeiträume (ohne Pausen, ohne unbestätigte Sitzungen).
// - Zuordnungen haben einen Vorrang: manuell > Kalendertermin > Arbeitsnetz; bei gleicher Quelle gilt
//   die jüngste (createdAt). Manuelle Zuordnungen überschreiben damit die Automatik.
// - Zeit ohne Zuordnung bleibt „nicht zugeordnet“ (projectId null); eine manuelle Zuordnung zu `null`
//   nimmt Zeit bewusst aus einem Projekt heraus.
// - Die Pausen-Auffüllung ist ein rechtlicher Abzug ohne eigenen Zeitraum. Sie wird anteilig nach
//   Arbeitszeit auf alle Posten verteilt und je Posten ausgewiesen; so stimmt die Summe der Projektzeiten
//   immer mit dem Netto überein und kein Posten wird negativ.
import type { Range } from './ranges.js';
import { countOf, largestRemainder, workRanges } from './segments.js';
import type { WorkDay } from './types.js';

export type AssignmentSource = 'manual' | 'calendar' | 'network';

export interface ProjectAssignment {
  from: string;
  to: string;
  /** null = ausdrücklich keinem Projekt zugeordnet */
  projectId: string | null;
  source: AssignmentSource;
  createdAt: string;
}

export interface ProjectShare {
  /** null = nicht zugeordnet */
  projectId: string | null;
  /** tatsächliche Arbeitszeit in diesem Projekt */
  workMinutes: number;
  /** anteiliger Abzug der Pausen-Auffüllung */
  topUpMinutes: number;
  /** workMinutes − topUpMinutes, nie negativ */
  netMinutes: number;
  /** stammt die Zuordnung (überwiegend) aus manueller Eingabe? */
  manual: boolean;
}

export interface DayProjects {
  date: string;
  items: ProjectShare[];
}

const PRIORITY: Record<AssignmentSource, number> = { manual: 3, calendar: 2, network: 1 };
const NONE = '';

interface Prepared {
  r: Range;
  key: string;
  prio: number;
  c: number;
  order: string;
}

function prepare(assignments: readonly ProjectAssignment[]): Prepared[] {
  return assignments
    .map((a) => ({
      r: [Date.parse(a.from), Date.parse(a.to)] as Range,
      key: a.projectId ?? NONE,
      prio: PRIORITY[a.source],
      c: Date.parse(a.createdAt),
      order: `${a.from}|${a.to}|${a.projectId ?? ''}|${a.source}`,
    }))
    .filter((a) => a.r[1] > a.r[0]);
}

/** Gewinner unter den Zuordnungen, die den Zeitpunkt abdecken (Reihenfolge der Eingabe egal). */
function winner(list: readonly Prepared[], at: number): Prepared | undefined {
  let best: Prepared | undefined;
  for (const a of list) {
    if (a.r[0] > at || a.r[1] <= at) continue;
    if (
      !best ||
      a.prio > best.prio ||
      (a.prio === best.prio && (a.c > best.c || (a.c === best.c && a.order > best.order)))
    ) {
      best = a;
    }
  }
  return best;
}

/** Zuordnung je Zeitstück: Arbeitszeiträume, an allen Grenzen der Zuordnungen geteilt. */
export function assignedPieces(
  work: readonly Range[],
  assignments: readonly ProjectAssignment[],
): { r: Range; projectId: string | null; manual: boolean }[] {
  const list = prepare(assignments);
  const out: { r: Range; projectId: string | null; manual: boolean }[] = [];
  for (const w of work) {
    const cuts = new Set<number>([w[0], w[1]]);
    for (const a of list) {
      for (const t of a.r) if (t > w[0] && t < w[1]) cuts.add(t);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] as number;
      const b = points[i + 1] as number;
      const win = winner(list, a);
      out.push({
        r: [a, b],
        projectId: win && win.key !== NONE ? win.key : null,
        manual: win?.prio === PRIORITY.manual,
      });
    }
  }
  return out;
}

/**
 * Teilt Arbeitszeit, Auffüllung und Netto eines Tages auf Projekte auf.
 * Garantiert: Σ workMinutes = day.workMinutes, Σ netMinutes = day.netMinutes, jeder Posten ≥ 0.
 */
export function allocateProjects(
  day: WorkDay,
  assignments: readonly ProjectAssignment[],
  now?: string,
): DayProjects {
  const work = workRanges(day, now);
  const ms = new Map<string, number>();
  const manualMs = new Map<string, number>();
  for (const p of assignedPieces(work, assignments)) {
    const key = p.projectId ?? NONE;
    const len = p.r[1] - p.r[0];
    ms.set(key, countOf(ms, key) + len);
    if (p.manual) manualMs.set(key, countOf(manualMs, key) + len);
  }

  const totalWork = Math.max(0, day.workMinutes);
  if (ms.size === 0 && totalWork > 0) ms.set(NONE, 1);
  const workBy = largestRemainder(ms, totalWork);
  const totalTopUp = Math.min(totalWork, Math.max(0, totalWork - day.netMinutes));
  const topUpBy = largestRemainder(workBy, totalTopUp);

  const rows: Row[] = [];
  for (const [key, w] of workBy) {
    if (w <= 0) continue;
    const t = Math.min(w, countOf(topUpBy, key));
    rows.push({
      key,
      work: w,
      topUp: t,
      net: w - t,
      manual: countOf(manualMs, key) * 2 >= countOf(ms, key),
    });
  }
  return {
    date: day.date,
    items: rows.sort(byShare).map((r) => ({
      projectId: r.key === NONE ? null : r.key,
      workMinutes: r.work,
      topUpMinutes: r.topUp,
      netMinutes: r.net,
      manual: r.manual,
    })),
  };
}

interface Row {
  key: string;
  work: number;
  topUp: number;
  net: number;
  manual: boolean;
}

/** Projekte nach Netto absteigend, „nicht zugeordnet“ zuletzt. */
const byShare = (a: Pick<Row, 'key' | 'net'>, b: Pick<Row, 'key' | 'net'>): number =>
  Number(a.key === NONE) - Number(b.key === NONE) || b.net - a.net || a.key.localeCompare(b.key);

/** Summe je Projekt über mehrere Tage (z. B. Monats- oder Kundenauswertung). */
export function projectTotals(
  days: readonly DayProjects[],
): { projectId: string | null; workMinutes: number; topUpMinutes: number; netMinutes: number }[] {
  const acc = new Map<string, Row>();
  for (const d of days) {
    for (const i of d.items) {
      const key = i.projectId ?? NONE;
      const a = acc.get(key) ?? { key, work: 0, topUp: 0, net: 0, manual: false };
      a.work += i.workMinutes;
      a.topUp += i.topUpMinutes;
      a.net += i.netMinutes;
      acc.set(key, a);
    }
  }
  return [...acc.values()].sort(byShare).map((r) => ({
    projectId: r.key === NONE ? null : r.key,
    workMinutes: r.work,
    topUpMinutes: r.topUp,
    netMinutes: r.net,
  }));
}

/** Ein Projekt mit Stichwörtern für den Abgleich mit Kalendertiteln. */
export interface KeywordProject {
  id: string;
  keywords: readonly string[];
}

const norm = (s: string): string => s.normalize('NFKC').toLocaleLowerCase('de-DE').trim();

/**
 * Erkennt ein Projekt am Termintitel: Stichwort als Teilzeichenkette, ohne Groß-/Kleinschreibung.
 * Das längste passende Stichwort gewinnt, bei Gleichstand die kleinere Projekt-ID.
 */
export function matchProject(title: string, projects: readonly KeywordProject[]): string | null {
  const t = norm(title);
  if (!t) return null;
  let best: { id: string; len: number } | undefined;
  for (const p of projects) {
    for (const k of p.keywords) {
      const kw = norm(k);
      if (!kw || !t.includes(kw)) continue;
      if (!best || kw.length > best.len || (kw.length === best.len && p.id < best.id)) {
        best = { id: p.id, len: kw.length };
      }
    }
  }
  return best?.id ?? null;
}
