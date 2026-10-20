import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  formatBalance,
  formatClock,
  formatDate,
  formatMinutes,
  minutesBetween,
  pickLocale,
} from '../src/index.js';

describe('Formatierung', () => {
  it('Minuten als Stunden:Minuten', () => {
    expect(formatMinutes(0)).toBe('0:00');
    expect(formatMinutes(465)).toBe('7:45');
    expect(formatMinutes(-20)).toBe('−0:20');
    expect(formatBalance(65)).toBe('+1:05');
    expect(formatBalance(0)).toBe('0:00');
    expect(formatBalance(-125)).toBe('−2:05');
  });

  it('Uhrzeit in der Zeitzone, auch bei Zeitumstellung', () => {
    expect(formatClock('2026-10-14T06:00:00Z', 'Europe/Berlin')).toBe('08:00');
    expect(formatClock('2026-10-25T06:00:00Z', 'Europe/Berlin')).toBe('07:00');
    // 25-h-Tag: Dauer aus UTC-Differenz
    expect(minutesBetween('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z')).toBe(25 * 60);
  });

  it('Datum ausgeschrieben', () => {
    expect(formatDate('2026-10-14')).toBe('Mi., 14.10.2026');
  });
});

describe('Texte', () => {
  it('setzt Platzhalter ein und kennt alle Labels', () => {
    const t = createTranslator('de');
    expect(t.t('status.since', { time: '08:00' })).toBe('seit 08:00');
    expect(t.t('status.since')).toBe('seit {time}');
    expect(t.eventType('boot')).toBe('Hochgefahren');
    expect(t.source('lan')).toBe('LAN');
    expect(t.status('unchecked')).toBe('zu prüfen');
    expect(t.warning('break_violation')).toContain('§ 4 ArbZG');
    expect(createTranslator('en').t('action.start')).toBe('Start work');
  });

  it('wählt die Sprache', () => {
    expect(pickLocale('en-US')).toBe('en');
    expect(pickLocale('de-DE')).toBe('de');
    expect(pickLocale(undefined)).toBe('de');
    expect(pickLocale('fr')).toBe('de');
  });
});
