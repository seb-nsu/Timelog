import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Absence,
  type Session,
  type WorkDay,
  DEFAULT_CARRY_OVER,
  absenceFraction,
  addDays,
  computeBalance,
  computeDays,
  creditedAbsenceMinutes,
  dayWorkPeriods,
  fullMonths,
  leaveAbsences,
  leaveDays,
  overtimeHistory,
  payrollMonth,
  resolveConfig,
  sumDays,
  vacationAccounts,
  vacationEntitlement,
  zonedToUtc,
} from '../src/index.js';

const cfg = resolveConfig();
const TZ = 'Europe/Berlin';
const now = '2026-12-31T12:00:00Z';

function emptyDay(date: string, over: Partial<WorkDay> = {}): WorkDay {
  return {
    date,
    sessions: [],
    breakMinutes: 0,
    workMinutes: 0,
    breakTopUpMin: 0,
    netMinutes: 0,
    pendingMinutes: 0,
    absenceMinutes: 0,
    targetMinutes: 480,
    status: 'auto',
    corrected: false,
    warnings: [],
    ...over,
  };
}

describe('Abwesenheitsart overtime', () => {
  it('schreibt 0 Minuten gut, das Soll bleibt: Saldo sinkt um die Sollzeit', () => {
    const absences: Absence[] = [{ date: '2026-10-14', kind: 'overtime', minutes: 480 }];
    const days = computeDays([], [], absences, cfg, now);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ absenceMinutes: 0, targetMinutes: 480 });
    expect(computeBalance(days)).toBe(-480);
  });

  it('Urlaub schreibt die Minuten gut (Saldo 0)', () => {
    const days = computeDays(
      [],
      [],
      [{ date: '2026-10-14', kind: 'vacation', minutes: 480 }],
      cfg,
      now,
    );
    expect(computeBalance(days)).toBe(0);
  });

  it('creditedAbsenceMinutes', () => {
    expect(creditedAbsenceMinutes({ kind: 'overtime', minutes: 240 })).toBe(0);
    expect(creditedAbsenceMinutes({ kind: 'sick', minutes: 240 })).toBe(240);
  });
});

describe('leaveDays', () => {
  it('zählt nur Arbeitstage: Wochenende und Feiertag (03.10., Berlin) zählen nicht', () => {
    // Do 01.10. – Di 06.10.2026: Sa 03.10. ist ohnehin Wochenende
    const days = leaveDays({ from: '2026-10-01', to: '2026-10-06' }, cfg);
    expect(days.map((d) => d.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(sumDays(days)).toBe(4);
  });

  it('Feiertag unter der Woche zählt nicht (Weihnachten 2026: Fr 25.12.)', () => {
    const days = leaveDays({ from: '2026-12-21', to: '2026-12-31' }, cfg);
    expect(days.map((d) => d.date)).not.toContain('2026-12-25');
    expect(sumDays(days)).toBe(8);
  });

  it('Frauentag nur in Berlin (So 08.03.2026 → Mo 08.03.2027 prüfen)', () => {
    expect(leaveDays({ from: '2027-03-08', to: '2027-03-08' }, cfg)).toHaveLength(0);
    const by = resolveConfig({ state: 'BY' });
    expect(leaveDays({ from: '2027-03-08', to: '2027-03-08' }, by)).toHaveLength(1);
  });

  it('halbe Tage am Anfang und Ende; Minuten aus der Sollzeit', () => {
    const days = leaveDays(
      { from: '2026-10-12', to: '2026-10-14', halfDayStart: true, halfDayEnd: true },
      cfg,
    );
    expect(days.map((d) => [d.fraction, d.minutes])).toEqual([
      [0.5, 240],
      [1, 480],
      [0.5, 240],
    ]);
    expect(sumDays(days)).toBe(2);
    expect(leaveDays({ from: '2026-10-12', to: '2026-10-12', halfDayEnd: true }, cfg)).toEqual([
      { date: '2026-10-12', fraction: 0.5, minutes: 240 },
    ]);
  });

  it('Teilzeit: freie Wochentage zählen nicht', () => {
    const part = resolveConfig({
      targetSchedule: [{ validFrom: '2026-01-01', minutesByWeekday: [0, 360, 360, 360, 0, 0, 0] }],
    });
    const days = leaveDays({ from: '2026-10-12', to: '2026-10-18' }, part);
    expect(days.map((d) => d.minutes)).toEqual([360, 360, 360]);
  });

  it('leerer bzw. umgekehrter Zeitraum, Höchstlänge', () => {
    expect(leaveDays({ from: '2026-10-14', to: '2026-10-13' }, cfg)).toEqual([]);
    const long = leaveDays({ from: '2026-01-01', to: '2028-12-31' }, cfg);
    expect(long.length).toBeLessThanOrEqual(366);
    expect(long[long.length - 1]?.date).toBe('2026-12-31'); // 01.01.2027 = Neujahr
  });

  it('erzeugt Abwesenheiten je Arbeitstag', () => {
    const days = leaveDays({ from: '2026-10-14', to: '2026-10-15' }, cfg);
    expect(leaveAbsences('overtime', days)).toEqual([
      { date: '2026-10-14', kind: 'overtime', minutes: 480 },
      { date: '2026-10-15', kind: 'overtime', minutes: 480 },
    ]);
  });
});

describe('vacationEntitlement', () => {
  it('voller Anspruch, Teilzeit anteilig', () => {
    expect(vacationEntitlement({ year: 2026, annualDays: 30 })).toBe(30);
    expect(vacationEntitlement({ year: 2026, annualDays: 30, workdaysPerWeek: 3 })).toBe(18);
    expect(vacationEntitlement({ year: 2026, annualDays: 30, workdaysPerWeek: 0 })).toBe(0);
    expect(vacationEntitlement({ year: 2026, annualDays: 30, standardWorkdaysPerWeek: 0 })).toBe(0);
  });

  it('Eintritt im Jahr: 1/12 je vollem Beschäftigungsmonat, ab ½ Tag aufrunden', () => {
    // 15.04. → 8 volle Monate (15.04.–14.12.) → 30 × 8 / 12 = 20
    expect(vacationEntitlement({ year: 2026, annualDays: 30, entryDate: '2026-04-15' })).toBe(20);
    // 01.10. → 3 Monate → 7,5 → 8
    expect(vacationEntitlement({ year: 2026, annualDays: 30, entryDate: '2026-10-01' })).toBe(8);
    // 25 Tage, 01.12. → 1 Monat → 2,083… bleibt (unter ½)
    expect(vacationEntitlement({ year: 2026, annualDays: 25, entryDate: '2026-12-01' })).toBe(2.08);
    // Austritt 30.06. → 6 Monate
    expect(vacationEntitlement({ year: 2026, annualDays: 30, exitDate: '2026-06-30' })).toBe(15);
  });

  it('außerhalb des Jahres: 0', () => {
    expect(vacationEntitlement({ year: 2026, annualDays: 30, entryDate: '2027-01-01' })).toBe(0);
    expect(vacationEntitlement({ year: 2026, annualDays: 30, exitDate: '2025-12-31' })).toBe(0);
    expect(
      vacationEntitlement({
        year: 2026,
        annualDays: 30,
        entryDate: '2026-08-01',
        exitDate: '2026-07-01',
      }),
    ).toBe(0);
  });

  it('fullMonths', () => {
    expect(fullMonths('2026-01-31', '2026-02-27')).toBe(0);
    expect(fullMonths('2026-01-31', '2026-02-28')).toBe(1);
    expect(fullMonths('2026-01-01', '2026-12-31')).toBe(12);
    expect(fullMonths('2026-05-01', '2026-04-30')).toBe(0);
  });
});

describe('vacationAccounts', () => {
  const years = [
    { year: 2025, entitlement: 30 },
    { year: 2026, entitlement: 30 },
  ];

  it('Rest wird übertragen und vor dem 31.03. zuerst verbraucht', () => {
    const entries = [
      ...Array.from({ length: 25 }, (_, i) => ({
        date: addDays('2025-06-02', i),
        fraction: 1,
        status: 'approved' as const,
      })),
      { date: '2026-02-02', fraction: 1, status: 'approved' as const },
      { date: '2026-02-03', fraction: 0.5, status: 'approved' as const },
    ];
    const [y25, y26] = vacationAccounts(years, entries, DEFAULT_CARRY_OVER, '2026-05-01');
    expect(y25).toMatchObject({ taken: 25, remaining: 5 });
    expect(y26).toMatchObject({
      carryOver: 5,
      carryOverUsed: 1.5,
      carryOverForfeited: 3.5,
      taken: 1.5,
      remaining: 30,
      carryOverExpiry: '2026-03-31',
    });
  });

  it('ohne Hinweis des Arbeitgebers (BAG) verfällt nichts', () => {
    const entries = [{ date: '2025-06-02', fraction: 20, status: 'approved' as const }];
    const [, y26] = vacationAccounts(
      years,
      entries,
      { expiry: '03-31', expires: false },
      '2026-05-01',
    );
    expect(y26).toMatchObject({ carryOver: 10, carryOverForfeited: 0, remaining: 40 });
  });

  it('vor dem Stichtag noch kein Verfall; genommen, geplant, beantragt', () => {
    const entries = [
      { date: '2026-01-05', fraction: 1, status: 'approved' as const },
      { date: '2026-07-01', fraction: 1, status: 'approved' as const },
      { date: '2026-08-03', fraction: 2, status: 'pending' as const },
    ];
    const [, y26] = vacationAccounts(years, entries, DEFAULT_CARRY_OVER, '2026-03-01');
    expect(y26).toMatchObject({
      carryOver: 30,
      carryOverForfeited: 0,
      taken: 1,
      planned: 1,
      pending: 2,
      remaining: 58,
      remainingAfterPending: 56,
    });
  });

  it('manueller Übertrag überschreibt die Automatik, Korrektur zählt dazu', () => {
    const [, y26] = vacationAccounts(
      [
        { year: 2025, entitlement: 30 },
        { year: 2026, entitlement: 30, manualCarryOver: 2, correction: 1 },
      ],
      [],
      DEFAULT_CARRY_OVER,
      '2026-01-10',
    );
    expect(y26).toMatchObject({ carryOver: 2, carryOverManual: true, remaining: 33 });
  });

  it('Lücke zwischen Jahren: kein automatischer Übertrag; negativer Rest wird nicht übertragen', () => {
    const accounts = vacationAccounts(
      [
        { year: 2023, entitlement: 10 },
        { year: 2024, entitlement: 30 },
        { year: 2026, entitlement: 30 },
      ],
      [{ date: '2024-03-01', fraction: 35, status: 'approved' }],
      DEFAULT_CARRY_OVER,
      '2026-06-01',
    );
    expect(accounts.map((a) => a.carryOver)).toEqual([0, 10, 0]);
  });
});

describe('absenceFraction', () => {
  it('halbe bzw. ganze Tage', () => {
    expect(absenceFraction(480, 480)).toBe(1);
    expect(absenceFraction(240, 480)).toBe(0.5);
    expect(absenceFraction(100, 480)).toBe(0.5);
    expect(absenceFraction(400, 480)).toBe(1);
    expect(absenceFraction(480, 0)).toBe(0);
    expect(absenceFraction(0, 480)).toBe(0);
  });
});

describe('overtimeHistory', () => {
  it('Saldo-Verlauf je Monat mit Abbau, Auszahlung und Höchstsaldo', () => {
    const days = [
      emptyDay('2026-09-01', { netMinutes: 600 }),
      emptyDay('2026-09-02', { netMinutes: 600 }),
      emptyDay('2026-10-01', { netMinutes: 0 }),
    ];
    const absences = [{ date: '2026-10-01', kind: 'overtime' as const, minutes: 480 }];
    const history = overtimeHistory(
      ['2026-10', '2026-09'],
      days,
      absences,
      [{ month: '2026-10', minutes: -60 }],
      200,
      30,
    );
    expect(history).toEqual([
      {
        month: '2026-09',
        workMinutes: 240,
        bookedMinutes: 0,
        reducedMinutes: 0,
        balanceMinutes: 270,
        overMax: true,
      },
      {
        month: '2026-10',
        workMinutes: -480,
        bookedMinutes: -60,
        reducedMinutes: 480,
        balanceMinutes: -270,
        overMax: false,
      },
    ]);
    expect(overtimeHistory(['2026-09'], days, [], [])[0]?.overMax).toBe(false);
  });
});

describe('payrollMonth', () => {
  it('Netto, Tage je Art; Tage ohne Sollzeit zählen nicht', () => {
    const days = [
      emptyDay('2026-10-14', { netMinutes: 450, workMinutes: 480 }),
      emptyDay('2026-10-15', { absenceMinutes: 480 }),
      emptyDay('2026-10-17', { targetMinutes: 0 }),
    ];
    const result = payrollMonth(
      days,
      [
        { date: '2026-10-15', kind: 'vacation', minutes: 480 },
        { date: '2026-10-16', kind: 'sick', minutes: 240 },
        { date: '2026-10-17', kind: 'sick', minutes: 480 },
        { date: '2026-10-16', kind: 'overtime', minutes: 240 },
      ],
      cfg,
    );
    expect(result.netMinutes).toBe(450);
    expect(result.workMinutes).toBe(480);
    expect(result.daysByKind).toEqual({
      vacation: 1,
      sick: 0.5,
      holiday: 0,
      other: 0,
      overtime: 0.5,
    });
    expect(result.absences.map((a) => `${a.date}:${a.kind}`)).toEqual([
      '2026-10-15:vacation',
      '2026-10-16:overtime',
      '2026-10-16:sick',
    ]);
  });
});

describe('dayWorkPeriods', () => {
  const t = (time: string, date = '2026-10-14') =>
    new Date(zonedToUtc(date, time, TZ)).toISOString();
  const session = (over: Partial<Session>): Session => ({
    id: 's',
    start: t('08:00'),
    end: t('17:00'),
    tz: TZ,
    startSource: 'boot',
    endSource: 'shutdown',
    breaks: [],
    workMinutes: 0,
    breakTopUpMin: 0,
    needsConfirmation: false,
    open: false,
    corrected: false,
    warnings: [],
    ...over,
  });
  const dayStart = zonedToUtc('2026-10-14', '00:00', TZ);
  const dayEnd = zonedToUtc('2026-10-15', '00:00', TZ);

  it('teilt an Pausen, schneidet auf den Tag zu, ignoriert offene, verworfene und unbestätigte', () => {
    const day = emptyDay('2026-10-14', {
      sessions: [
        session({
          breaks: [
            { from: t('12:00'), to: t('12:30'), source: 'standby', countsLegally: true },
            { from: t('07:00'), to: t('07:30'), source: 'manual', countsLegally: true },
          ],
        }),
        session({ id: 'n', start: t('22:00'), end: t('01:00', '2026-10-15') }),
        session({ id: 'o', end: undefined }),
        session({ id: 'r', confirmed: false }),
        session({ id: 'p', needsConfirmation: true }),
        session({
          id: 'c',
          start: t('19:00'),
          end: t('20:00'),
          needsConfirmation: true,
          confirmed: true,
        }),
        session({
          id: 'b',
          start: t('20:30'),
          end: t('21:00'),
          breaks: [{ from: t('20:30'), to: t('21:00'), source: 'manual', countsLegally: true }],
        }),
      ],
    });
    expect(dayWorkPeriods(day, dayStart, dayEnd)).toEqual([
      { start: t('08:00'), end: t('12:00') },
      { start: t('12:30'), end: t('17:00') },
      { start: t('19:00'), end: t('20:00') },
      { start: t('22:00'), end: t('00:00', '2026-10-15') },
    ]);
  });
});

describe('Eigenschaften', () => {
  const dateArb = fc.integer({ min: 0, max: 730 }).map((n) => addDays('2026-01-01', n));

  it('Urlaubstage: nur Tage mit Sollzeit, Anteil 0,5 oder 1, Summe ≤ Kalendertage', () => {
    fc.assert(
      fc.property(
        dateArb,
        fc.integer({ min: 0, max: 40 }),
        fc.boolean(),
        fc.boolean(),
        (from, len, hs, he) => {
          const to = addDays(from, len);
          const days = leaveDays({ from, to, halfDayStart: hs, halfDayEnd: he }, cfg);
          for (const d of days) {
            expect(d.date >= from && d.date <= to).toBe(true);
            expect([0.5, 1]).toContain(d.fraction);
            expect(d.minutes).toBeGreaterThan(0);
          }
          expect(sumDays(days)).toBeLessThanOrEqual(len + 1);
          // Urlaub schreibt genau die Sollzeit gut, Überstundenabbau senkt den Saldo um sie
          const vac = computeDays([], [], leaveAbsences('vacation', days), cfg, now);
          const ot = computeDays([], [], leaveAbsences('overtime', days), cfg, now);
          const target = days.reduce((s, d) => s + d.minutes, 0);
          const fullTarget = vac.reduce((s, d) => s + d.targetMinutes, 0);
          expect(computeBalance(vac)).toBe(target - fullTarget);
          expect(computeBalance(ot) + fullTarget).toBe(0);
        },
      ),
    );
  });

  it('Urlaubskonto: Rest = Anspruch + Übertrag − Verfall − genommen − geplant; Verfall ≤ Übertrag', () => {
    const entryArb = fc.record({
      date: dateArb,
      fraction: fc.constantFrom(0.5, 1),
      status: fc.constantFrom('approved' as const, 'pending' as const),
    });
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 40 }),
        fc.boolean(),
        dateArb,
        (entries, entitlement, expires, today) => {
          const accounts = vacationAccounts(
            [
              { year: 2026, entitlement },
              { year: 2027, entitlement },
            ],
            entries,
            { expiry: '03-31', expires },
            today,
          );
          for (const a of accounts) {
            expect(a.carryOverForfeited).toBeGreaterThanOrEqual(0);
            expect(a.carryOverForfeited).toBeLessThanOrEqual(a.carryOver);
            expect(a.carryOver).toBeGreaterThanOrEqual(0);
            expect(a.remaining).toBeCloseTo(
              a.entitlement +
                a.correction +
                a.carryOver -
                a.carryOverForfeited -
                a.taken -
                a.planned,
              5,
            );
          }
          // Reihenfolge der Einträge ist egal
          expect(
            vacationAccounts(
              [
                { year: 2026, entitlement },
                { year: 2027, entitlement },
              ],
              [...entries].reverse(),
              { expiry: '03-31', expires },
              today,
            ),
          ).toEqual(accounts);
        },
      ),
    );
  });

  it('Überstundenverlauf: Endstand = Start + Σ Monatssalden + Σ Buchungen', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            month: fc.constantFrom('2026-01', '2026-02'),
            minutes: fc.integer({ min: -600, max: 600 }),
          }),
          { maxLength: 6 },
        ),
        fc.array(fc.integer({ min: 0, max: 700 }), { maxLength: 10 }),
        (bookings, nets) => {
          const days = nets.map((net, i) =>
            emptyDay(addDays('2026-01-05', i * 5), { netMinutes: net }),
          );
          const h = overtimeHistory(['2026-01', '2026-02'], days, [], bookings);
          const expected = computeBalance(days) + bookings.reduce((s, b) => s + b.minutes, 0);
          expect(h.at(-1)?.balanceMinutes).toBe(expected);
        },
      ),
    );
  });
});
