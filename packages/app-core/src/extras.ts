// Darstellungshilfen für Projekte, Arbeitsort und Kalender. Gerechnet wird im Regelwerk bzw. auf dem
// Server; hier wird nur sortiert, beschriftet und Eingaben werden vorbereitet.
import { addDays } from '@timelog/rules';

export interface ProjectLike {
  id: string;
  name: string;
  archived: boolean;
}

export interface ShareLike {
  projectId: string | null;
  netMinutes: number;
}

/** Name eines Projekts; `null` heißt „ohne Projekt“, Unbekanntes wird mit „?“ angezeigt. */
export function projectName(
  projects: readonly ProjectLike[],
  id: string | null,
  unassigned: string,
): string {
  if (id === null) return unassigned;
  return projects.find((p) => p.id === id)?.name ?? '?';
}

/** Größte Anteile zuerst, „ohne Projekt“ zuletzt; gleich große nach Name. */
export function sortShares<T extends ShareLike>(
  items: readonly T[],
  projects: readonly ProjectLike[],
): T[] {
  const name = (id: string | null) => projectName(projects, id, '');
  return [...items].sort((a, b) => {
    if ((a.projectId === null) !== (b.projectId === null)) return a.projectId === null ? 1 : -1;
    return b.netMinutes - a.netMinutes || name(a.projectId).localeCompare(name(b.projectId));
  });
}

/** Auswählbare Projekte: aktive, alphabetisch; das aktuell gewählte bleibt auch archiviert sichtbar. */
export function selectableProjects<T extends ProjectLike>(
  projects: readonly T[],
  current?: string | null,
): T[] {
  return projects
    .filter((p) => !p.archived || p.id === current)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stichwörter aus einer Komma-Liste: getrimmt, ohne Doppelte, 2–60 Zeichen, höchstens 20. */
export function parseKeywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const k = raw.trim();
    if (k.length < 2 || k.length > 60) continue;
    if (out.some((o) => o.toLowerCase() === k.toLowerCase())) continue;
    out.push(k);
    if (out.length === 20) break;
  }
  return out;
}

/** Zeitraum, für den Kalender-Vorschläge geholt werden (Abrufzeitraum des Servers: 35 Tage zurück). */
export function suggestionRange(today: string, days = 35): { from: string; to: string } {
  return { from: addDays(today, -days), to: today };
}

/** Betrag in Cent als Währung, z. B. 126000 → „1.260,00 €“. */
export function formatEuro(cents: number, locale = 'de-DE'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

/** Kurze Monatsnamen Januar–Dezember in der Sprache der Oberfläche. */
export function monthNames(locale = 'de-DE'): string[] {
  const f = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, m) => f.format(new Date(Date.UTC(2026, m, 15))));
}

/** Schlüssel eines Vorschlags, um ausgeblendete zu merken. */
export function suggestionKey(s: { date: string; from?: string; to?: string }): string {
  return s.from && s.to ? `${s.from}/${s.to}` : s.date;
}
