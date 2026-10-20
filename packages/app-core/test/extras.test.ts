import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  formatEuro,
  monthNames,
  parseKeywords,
  projectName,
  selectableProjects,
  sortShares,
  suggestionKey,
  suggestionRange,
} from '../src/index.js';

const projects = [
  { id: 'b', name: 'Beta', archived: false },
  { id: 'a', name: 'Alpha', archived: false },
  { id: 'z', name: 'Zeta', archived: true },
];

describe('Projekte, Orte und Kalender (Darstellung)', () => {
  it('Projektnamen und Sortierung der Anteile', () => {
    expect(projectName(projects, 'a', '–')).toBe('Alpha');
    expect(projectName(projects, null, 'ohne Projekt')).toBe('ohne Projekt');
    expect(projectName(projects, 'x', '–')).toBe('?');
    const sorted = sortShares(
      [
        { projectId: null, netMinutes: 300 },
        { projectId: 'b', netMinutes: 60 },
        { projectId: 'a', netMinutes: 60 },
        { projectId: 'z', netMinutes: 120 },
      ],
      projects,
    );
    expect(sorted.map((s) => s.projectId)).toEqual(['z', 'a', 'b', null]);
  });

  it('auswählbar: aktive alphabetisch, gewähltes archiviertes bleibt', () => {
    expect(selectableProjects(projects).map((p) => p.id)).toEqual(['a', 'b']);
    expect(selectableProjects(projects, 'z').map((p) => p.id)).toEqual(['a', 'b', 'z']);
  });

  it('Stichwörter: getrimmt, ohne Doppelte, Länge geprüft, höchstens 20', () => {
    expect(parseKeywords(' ACME, acme ,x, Portal ,,')).toEqual(['ACME', 'Portal']);
    expect(parseKeywords('y'.repeat(61))).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `k${String(i)}`).join(',');
    expect(parseKeywords(many)).toHaveLength(20);
  });

  it('Vorschlagszeitraum, Beträge und Monatsnamen', () => {
    expect(suggestionRange('2026-10-15')).toEqual({ from: '2026-09-10', to: '2026-10-15' });
    expect(formatEuro(126_000).replace(/\s/g, ' ')).toBe('1.260,00 €');
    expect(formatEuro(600, 'en-GB')).toBe('€6.00');
    expect(monthNames()).toHaveLength(12);
    expect(monthNames('en-GB')[0]).toBe('Jan');
    expect(suggestionKey({ date: '2026-10-14' })).toBe('2026-10-14');
    expect(suggestionKey({ date: 'd', from: 'a', to: 'b' })).toBe('a/b');
  });

  it('Texte sind in beiden Sprachen vorhanden', () => {
    const de = createTranslator('de');
    const en = createTranslator('en');
    expect(de.t('suggest.wasMeeting')).toBe('War Arbeit (Termin)');
    expect(en.t('suggest.wasMeeting')).toBe('Was work (meeting)');
    expect(de.t('homeOffice.homeDays', { count: 3 })).toBe('Homeoffice-Tage: 3');
    expect(en.t('calendar.connect', { provider: 'Google' })).toBe('Connect Google');
  });
});
