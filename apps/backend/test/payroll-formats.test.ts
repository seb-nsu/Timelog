// Golden-File-Tests der Lohn-Exportformate. Erwartete Dateien liegen in test/golden/ (Windows-1252,
// CR/LF). Neu schreiben nur bewusst: UPDATE_GOLDEN=1 pnpm --filter @timelog/backend test.
import { type PayrollConfig, payrollConfigSchema } from '@timelog/shared';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PayrollConfigError,
  type PayrollRow,
  datevLodas,
  decimal,
  isoWeek,
  renderPayroll,
  toWindows1252,
} from '../src/payroll/formats.js';

const golden = (name: string) => join(import.meta.dirname, 'golden', name);

const cfg: PayrollConfig = payrollConfigSchema.parse({
  datev: {
    beraterNr: '1234567',
    mandantenNr: '12345',
    wageTypes: { hours: '100', vacation: '300', sick: '400', overtime: '310' },
    absenceCodes: { vacation: 'U', sick: 'K', overtime: 'F' },
  },
  lexware: { wageTypes: { hours: '1000', vacation: '1300', sick: '1400' } },
});

const rows: PayrollRow[] = [
  {
    personnelNumber: '00042',
    netMinutes: 9_870, // 164,5 h
    absences: [
      { date: '2026-10-05', kind: 'vacation', minutes: 480, fraction: 1 },
      { date: '2026-10-06', kind: 'vacation', minutes: 240, fraction: 0.5 },
      { date: '2026-10-20', kind: 'sick', minutes: 480, fraction: 1 },
      { date: '2026-10-21', kind: 'overtime', minutes: 480, fraction: 1 },
      { date: '2026-10-03', kind: 'holiday', minutes: 480, fraction: 1 },
    ],
    daysByKind: { vacation: 1.5, sick: 1, overtime: 1, holiday: 1, other: 0 },
  },
  {
    personnelNumber: '00007',
    netMinutes: 4_825, // 80,42 h
    absences: [],
    daysByKind: { vacation: 0, sick: 0, overtime: 0, holiday: 0, other: 0 },
  },
];

describe('Lohn-Exportformate', () => {
  for (const format of ['datev_lodas', 'datev_lug', 'lexware'] as const) {
    it(`${format} entspricht der Golden-Datei`, () => {
      const file = renderPayroll(format, '2026-10', rows, cfg);
      const path = golden(file.filename);
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
        if (process.env.CI) throw new Error(`Golden-Datei fehlt: ${file.filename}`);
        writeFileSync(path, file.content);
      }
      expect(file.content.equals(readFileSync(path))).toBe(true);
      // CR/LF, keine nackten LF
      expect(file.content.toString('latin1')).not.toMatch(/[^\r]\n/);
    });
  }

  it('LODAS: Kopf, Satzbeschreibung, Feiertage nicht exportiert', () => {
    const text = datevLodas('2026-10', rows, cfg);
    expect(text.startsWith('[Allgemein]\r\nZiel=LODAS\r\n')).toBe(true);
    expect(text).toContain('BeraterNr=1234567');
    expect(text).toContain('[Bewegungsdaten]');
    expect(text).toContain('1;01/10/2026;164,50;01;100;00042;');
    expect(text).toContain('2;01/10/2026;06;41;Di;00042;4,00;300;U;');
    expect(text).not.toContain('03;40;Sa');
  });

  it('fehlende Pflichtangaben werden benannt', () => {
    const empty = payrollConfigSchema.parse({});
    expect(() => renderPayroll('datev_lodas', '2026-10', rows, empty)).toThrow(PayrollConfigError);
    try {
      renderPayroll('lexware', '2026-10', rows, empty);
    } catch (e) {
      expect((e as PayrollConfigError).missing).toEqual(['lexware.wageTypes.hours']);
    }
  });

  it('Hilfsfunktionen: Dezimalkomma, ISO-Woche, ANSI', () => {
    expect(decimal(164.5)).toBe('164,50');
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
    expect(isoWeek('2026-10-21')).toBe(43);
    expect([...toWindows1252('Müller €…ł')]).toEqual([
      0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x20, 0x80, 0x85, 0x3f,
    ]);
  });
});
