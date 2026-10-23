// Dateiformate für den Lohn-Export. Reine Formatierung: die Summen kommen aus @timelog/rules
// (payrollMonth) und ausschließlich aus freigegebenen Monaten (Snapshot).
//
// Quellen (Stand der Prüfung siehe docs/URLAUB_LOHN.md):
// - DATEV LODAS: Schnittstellenhandbuch LODAS (ASCII-Import), Musterdatei mit [Allgemein],
//   [Satzbeschreibung], [Bewegungsdaten]; Tabellen u_lod_bwd_buchung_standard und
//   u_lod_bwd_buchung_kalendarium; ANSI-Zeichensatz, Satzende CR/LF.
// - DATEV Lohn und Gehalt: ASCII-Import über ein einmal in der Formatverwaltung angelegtes
//   Importformat (Personalnummer, Lohnart, Wert).
// - Lexware lohn+gehalt: „Lohndaten importieren“ (Import-ASCII): Jahr, Monat, Personalnummer,
//   Lohnartnummer, Wert; Semikolon, Dezimalkomma, ANSI.
import type { AbsenceKind, PayrollAbsenceDay } from '@timelog/rules';
import { weekday } from '@timelog/rules';
import type { PayrollConfig } from '@timelog/shared';

export interface PayrollRow {
  personnelNumber: string;
  netMinutes: number;
  absences: PayrollAbsenceDay[];
  daysByKind: Record<AbsenceKind, number>;
}

export interface PayrollFile {
  content: Buffer;
  filename: string;
  contentType: string;
}

/** Arten, die als Lohnart exportiert werden können (Feiertage zahlt das Lohnprogramm selbst). */
export const EXPORT_KINDS = ['vacation', 'sick', 'overtime'] as const;
type ExportKind = (typeof EXPORT_KINDS)[number];

const CRLF = '\r\n';

/** Zahl mit Dezimalkomma, höchstens zwei Nachkommastellen, ohne führende Nullen. */
export function decimal(value: number, digits = 2): string {
  return value.toFixed(digits).replace('.', ',');
}

export const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

// Windows-1252 für die Zeichen 0x80–0x9F; alles andere bis 0xFF ist Latin-1.
const CP1252: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Text als Windows-1252 („ANSI“); nicht darstellbare Zeichen werden zu „?“. */
export function toWindows1252(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else out.push(CP1252[cp] ?? 0x3f);
  }
  return Buffer.from(out);
}

/** ISO-Kalenderwoche eines Datums. */
export function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Donnerstag derselben Woche
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

/** TT/MM/JJJJ (Datumsformat der LODAS-Musterdatei). */
const lodasDate = (date: string): string =>
  `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

export class PayrollConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`payroll config incomplete: ${missing.join(', ')}`);
  }
}

/** Fehlende Pflichtangaben je Format (Lohnart für Stunden und, bei LODAS, Berater/Mandant). */
export function missingConfig(format: string, cfg: PayrollConfig): string[] {
  const missing: string[] = [];
  if (format === 'datev_lodas') {
    if (!cfg.datev.beraterNr) missing.push('datev.beraterNr');
    if (!cfg.datev.mandantenNr) missing.push('datev.mandantenNr');
  }
  if (format === 'lexware') {
    if (!cfg.lexware.wageTypes.hours) missing.push('lexware.wageTypes.hours');
  } else if (!cfg.datev.wageTypes.hours) missing.push('datev.wageTypes.hours');
  return missing;
}

/**
 * DATEV LODAS, ASCII-Import (Bewegungsdaten). Stunden als Standardbuchung (Bearbeitungsschlüssel 01
 * = Stundenbuchung), Urlaub/Krankheit/Überstundenabbau als Kalendariumsbuchung je Tag mit
 * Ausfallschlüssel und Stunden pro Tag. Arten ohne Lohnart bzw. Ausfallschlüssel entfallen.
 */
export function datevLodas(month: string, rows: readonly PayrollRow[], cfg: PayrollConfig): string {
  const missing = missingConfig('datev_lodas', cfg);
  if (missing.length > 0) throw new PayrollConfigError(missing);
  const period = lodasDate(`${month}-01`);
  const hours = cfg.datev.wageTypes.hours ?? '';
  const lines = [
    '[Allgemein]',
    'Ziel=LODAS',
    'Version_SST=1.0',
    `BeraterNr=${cfg.datev.beraterNr ?? ''}`,
    `MandantenNr=${cfg.datev.mandantenNr ?? ''}`,
    'Datumsformat=TT/MM/JJJJ',
    'Feldtrennzeichen=;',
    'Zahlenkomma=,',
    'Kommentarzeichen=*',
    `* TimeLog: Bewegungsdaten ${month} aus freigegebenen Monaten`,
    '',
    '[Satzbeschreibung]',
    '1;u_lod_bwd_buchung_standard;abrechnung_zeitraum#bwd;bs_wert_butab#bwd;bs_nr#bwd;la_eigene#bwd;pnr#bwd;',
    '2;u_lod_bwd_buchung_kalendarium;abrechnung_zeitraum#bwd;kalendertag#bwd;kalenderwoche#bwd;wochentag#kal;pnr#bwd;stunden_pro_tag#bwd;la_eigene#bwd;as_kal#bwd;',
    '',
    '[Bewegungsdaten]',
  ];
  for (const r of [...rows].sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber))) {
    if (r.netMinutes > 0) {
      lines.push(`1;${period};${decimal(hoursOf(r.netMinutes))};01;${hours};${r.personnelNumber};`);
    }
    for (const a of r.absences) {
      const kind = a.kind as ExportKind;
      if (!(EXPORT_KINDS as readonly string[]).includes(a.kind)) continue;
      const wage = cfg.datev.wageTypes[kind];
      const code = cfg.datev.absenceCodes[kind];
      if (!wage || !code) continue;
      lines.push(
        [
          '2',
          period,
          a.date.slice(8, 10),
          String(isoWeek(a.date)).padStart(2, '0'),
          WEEKDAYS_DE[weekday(a.date)],
          r.personnelNumber,
          decimal(hoursOf(a.minutes)),
          wage,
          code,
        ].join(';') + ';',
      );
    }
  }
  return lines.join(CRLF) + CRLF;
}

/**
 * DATEV Lohn und Gehalt: Semikolon-Datei für ein einmal in der Formatverwaltung angelegtes
 * Importformat. Je Person und Lohnart eine Zeile: Stunden bzw. Tage.
 */
export function datevLug(month: string, rows: readonly PayrollRow[], cfg: PayrollConfig): string {
  const missing = missingConfig('datev_lug', cfg);
  if (missing.length > 0) throw new PayrollConfigError(missing);
  const period = `${month.slice(5, 7)}/${month.slice(0, 4)}`;
  const lines = ['Personalnummer;Abrechnungsmonat;Lohnart;Stunden;Tage'];
  for (const r of [...rows].sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber))) {
    if (r.netMinutes > 0) {
      lines.push(
        `${r.personnelNumber};${period};${cfg.datev.wageTypes.hours ?? ''};${decimal(hoursOf(r.netMinutes))};`,
      );
    }
    for (const kind of EXPORT_KINDS) {
      const wage = cfg.datev.wageTypes[kind];
      const days = r.daysByKind[kind];
      if (!wage || days <= 0) continue;
      const minutes = r.absences.filter((a) => a.kind === kind).reduce((s, a) => s + a.minutes, 0);
      lines.push(
        `${r.personnelNumber};${period};${wage};${decimal(hoursOf(minutes))};${decimal(days, 1)}`,
      );
    }
  }
  return lines.join(CRLF) + CRLF;
}

/**
 * Lexware lohn+gehalt, „Lohndaten importieren“: Pflichtfelder Jahr, Monat, Personalnummer,
 * Lohnartnummer, Wert. Stunden in Stunden, Abwesenheiten in Tagen.
 */
export function lexware(month: string, rows: readonly PayrollRow[], cfg: PayrollConfig): string {
  const missing = missingConfig('lexware', cfg);
  if (missing.length > 0) throw new PayrollConfigError(missing);
  const year = month.slice(0, 4);
  const mon = String(Number(month.slice(5, 7)));
  const lines = ['Jahr;Monat;Personalnummer;Lohnartnummer;Wert'];
  for (const r of [...rows].sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber))) {
    if (r.netMinutes > 0) {
      lines.push(
        `${year};${mon};${r.personnelNumber};${cfg.lexware.wageTypes.hours ?? ''};${decimal(hoursOf(r.netMinutes))}`,
      );
    }
    for (const kind of EXPORT_KINDS) {
      const wage = cfg.lexware.wageTypes[kind];
      const days = r.daysByKind[kind];
      if (!wage || days <= 0) continue;
      lines.push(`${year};${mon};${r.personnelNumber};${wage};${decimal(days, 1)}`);
    }
  }
  return lines.join(CRLF) + CRLF;
}

export function renderPayroll(
  format: 'datev_lodas' | 'datev_lug' | 'lexware',
  month: string,
  rows: readonly PayrollRow[],
  cfg: PayrollConfig,
): PayrollFile {
  const text =
    format === 'datev_lodas'
      ? datevLodas(month, rows, cfg)
      : format === 'datev_lug'
        ? datevLug(month, rows, cfg)
        : lexware(month, rows, cfg);
  const ext = format === 'datev_lodas' ? 'txt' : 'csv';
  return {
    content: toWindows1252(text),
    filename: `lohn_${format}_${month}.${ext}`,
    contentType: `${ext === 'txt' ? 'text/plain' : 'text/csv'}; charset=windows-1252`,
  };
}
