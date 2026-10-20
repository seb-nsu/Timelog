import { describe, expect, it } from 'vitest';
import {
  type Absence,
  GERMAN_STATES,
  type PresenceSpan,
  type TimeEvent,
  addDays,
  computeDays,
  easterSunday,
  holidaysOf,
  isHoliday,
  localDate,
  resolveConfig,
  targetMinutes,
  weekday,
  zonedToUtc,
} from '../src/index.js';
import { clipRanges, gapsWithin, mergeRanges, subtractRanges, totalLength } from '../src/ranges.js';

const TZ = 'Europe/Berlin';
const t = (date: string, time: string): string =>
  new Date(zonedToUtc(date, time, TZ)).toISOString();
const D = '2026-10-14';

let n = 0;
function ev(
  type: TimeEvent['type'],
  time: string,
  extra: Partial<TimeEvent> & { date?: string } = {},
): TimeEvent {
  const { date = D, ...rest } = extra;
  n += 1;
  const ts = t(date, time);
  return {
    id: `x${String(n)}`,
    deviceId: 'L',
    userId: 'u',
    type,
    source: type.startsWith('manual') || type.startsWith('session') ? 'user' : 'system',
    ts,
    tz: TZ,
    createdAt: ts,
    ...rest,
  };
}
const span = (from: string, to: string, deviceId = 'L', date = D): PresenceSpan => ({
  deviceId,
  deviceKind: deviceId === 'H' ? 'mobile' : 'desktop',
  start: t(date, from),
  end: t(date, to),
  open: false,
});
const cfg = resolveConfig();
const nextMorning = t('2026-10-15', '09:00');
const days = (
  events: TimeEvent[],
  spans: PresenceSpan[] = [],
  now = nextMorning,
  absences: Absence[] = [],
) => computeDays(events, spans, absences, cfg, now);

describe('Feiertage', () => {
  it('berechnet Ostersonntag', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(easterSunday(2000)).toBe('2000-04-23');
  });

  it('kennt Feiertage aller Bundesländer', () => {
    for (const s of GERMAN_STATES) {
      const list = holidaysOf(2026, s);
      expect(list.length).toBeGreaterThanOrEqual(9);
      expect(isHoliday('2026-10-03', s)).toBe(true);
      expect(holidaysOf(2026, s)).toBe(list); // Cache
    }
    expect(isHoliday('2026-03-08', 'BE')).toBe(true);
    expect(isHoliday('2026-03-08', 'BY')).toBe(false);
    expect(isHoliday('2018-03-08', 'BE')).toBe(false);
    expect(isHoliday('2022-03-08', 'MV')).toBe(false);
    expect(isHoliday('2023-03-08', 'MV')).toBe(true);
    expect(isHoliday('2025-05-08', 'BE')).toBe(true);
    expect(isHoliday('2026-11-18', 'SN')).toBe(true); // Buß- und Bettag
    expect(isHoliday('2017-10-31', 'BY')).toBe(true); // 500 Jahre Reformation
    expect(isHoliday('2017-10-31', 'HH')).toBe(true);
    expect(isHoliday('2016-10-31', 'HH')).toBe(false);
    expect(isHoliday('2026-06-04', 'NW')).toBe(true); // Fronleichnam
    expect(isHoliday('2026-09-20', 'TH')).toBe(true);
    expect(isHoliday('2018-09-20', 'TH')).toBe(false);
  });
});

describe('Zeit und Zeiträume', () => {
  it('lehnt nicht existierende und ungültige Zeiten ab', () => {
    expect(() => zonedToUtc('2026-03-29', '02:30', TZ)).toThrow(RangeError);
    expect(() => zonedToUtc('2026-3-29', '02:30', TZ)).toThrow(RangeError);
    expect(() => zonedToUtc('2026-03-29', '2:30', TZ)).toThrow(RangeError);
  });

  it('rechnet Datum und Wochentag', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekday('2026-10-18')).toBe(0);
    expect(localDate(Date.parse('2026-10-14T22:30:00Z'), TZ)).toBe('2026-10-15');
  });

  it('verknüpft Zeiträume', () => {
    expect(
      mergeRanges([
        [5, 6],
        [1, 3],
        [2, 4],
        [7, 7],
      ]),
    ).toEqual([
      [1, 4],
      [5, 6],
    ]);
    expect(
      clipRanges(
        [
          [0, 10],
          [20, 30],
        ],
        5,
        25,
      ),
    ).toEqual([
      [5, 10],
      [20, 25],
    ]);
    expect(
      subtractRanges(
        [[0, 10]],
        [
          [2, 3],
          [5, 12],
          [20, 30],
        ],
      ),
    ).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(gapsWithin([[2, 3]], 0, 5)).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(
      totalLength([
        [0, 2],
        [3, 5],
      ]),
    ).toBe(4);
  });
});

describe('Sollzeit', () => {
  it('nimmt den jüngsten gültigen Plan und setzt Feiertage auf 0', () => {
    const c = resolveConfig({
      targetSchedule: [
        { validFrom: '2026-01-01', minutesByWeekday: [0, 480, 480, 480, 480, 480, 0] },
        { validFrom: '2026-10-01', minutesByWeekday: [0, 240, 240, 240, 240, 240, 0] },
        { validFrom: '2027-01-01', minutesByWeekday: [0, 1, 1, 1, 1, 1, 0] },
      ],
    });
    expect(targetMinutes('2026-09-30', c)).toBe(480);
    expect(targetMinutes('2026-10-14', c)).toBe(240);
    expect(targetMinutes('2026-10-03', c)).toBe(0);
    expect(targetMinutes('2025-12-31', c)).toBe(0);
  });
});

describe('Regelwerk – Sonderfälle', () => {
  it('Neustart per restart-Ereignis und Update-Fenster', () => {
    const r = days(
      [
        ev('boot', '08:00'),
        ev('restart', '12:00'),
        ev('boot', '12:05'),
        ev('shutdown', '13:00', { flags: ['update_restart'] }),
        ev('boot', '13:40'),
        ev('shutdown', '15:00'),
      ],
      [span('08:00', '15:00')],
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.sessions).toHaveLength(1);
    expect(r[0]?.workMinutes).toBe(425);
  });

  it('restart ohne folgenden boot beendet wie ein shutdown', () => {
    const r = days([ev('boot', '08:00'), ev('restart', '10:00')], [span('08:00', '10:00')]);
    expect(r[0]?.workMinutes).toBe(125);
  });

  it('Absturz ohne Neustart: Ende bei letzter Aktivität, neues Intervall beim nächsten boot', () => {
    const r = days(
      [ev('boot', '08:00'), ev('boot', '13:00'), ev('shutdown', '15:00')],
      [span('08:00', '10:00'), span('13:00', '15:00')],
    );
    const s = r[0]?.sessions ?? [];
    expect(s).toHaveLength(2); // Lücke 3 h > maxBreakMin trennt Sitzungen
    expect(s[0]?.end).toBe(t(D, '10:00'));
    expect(r[0]?.warnings).toContain('no_end');
  });

  it('verwirft Waisen und Duplikate', () => {
    const boot = ev('boot', '08:00');
    const r = days(
      [
        boot,
        boot,
        ev('shutdown', '09:00'),
        ev('shutdown', '09:30'),
        ev('net_lost', '10:00', { deviceId: 'H' }),
      ],
      [span('08:00', '09:00'), span('20:00', '21:00', 'L9')],
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.workMinutes).toBe(65);
  });

  it('Laptop ohne Aktiv-Spannen gilt als durchgehend aktiv', () => {
    const r = days([ev('boot', '08:00'), ev('shutdown', '10:00')]);
    expect(r[0]?.workMinutes).toBe(125);
  });

  it('Laptop schläft bis zum Herunterfahren am nächsten Morgen', () => {
    const r = days(
      [ev('boot', '08:00'), ev('shutdown', '07:00', { date: '2026-10-15' })],
      [span('08:00', '12:00')],
    );
    expect(r[0]?.end).toBe(t(D, '12:00'));
    expect(r[0]?.warnings).toContain('gap_end');
  });

  it('manuelle Pause, abgelehnte Sitzung und Bestätigung per Mitglied', () => {
    const boot = ev('boot', '08:00');
    const r = days(
      [
        boot,
        ev('manual_break', '12:00', { endTs: t(D, '12:30') }),
        ev('manual_break', '12:20', { endTs: t(D, '12:40') }),
        ev('shutdown', '15:00'),
        ev('boot', '20:00'),
        ev('shutdown', '21:00'),
        ev('session_reject', '21:30', { refEventId: 'x-none' }),
      ],
      [span('08:00', '15:00'), span('20:00', '21:00')],
    );
    expect(r[0]?.breakMinutes).toBe(40);
    expect(r[0]?.sessions[0]?.breaks[0]?.source).toBe('manual');
    expect(r[0]?.pendingMinutes).toBe(65);
  });

  it('abgelehnte Sitzung zählt nicht, Tag nur mit abgelehnter Sitzung bleibt sichtbar', () => {
    const boot = ev('boot', '10:00', { date: '2026-10-18' });
    const r = days(
      [
        boot,
        ev('shutdown', '11:00', { date: '2026-10-18' }),
        ev('session_reject', '12:00', { date: '2026-10-18', refEventId: boot.id }),
      ],
      [],
      t('2026-10-19', '09:00'),
    );
    expect(r[0]?.workMinutes).toBe(0);
    expect(r[0]?.pendingMinutes).toBe(0);
    expect(r[0]?.status).toBe('auto');
    expect(r[0]?.warnings).toEqual([]);
  });

  it('jüngste Entscheidung gewinnt', () => {
    const boot = ev('boot', '10:00', { date: '2026-10-18' });
    const mk = (type: 'session_confirm' | 'session_reject', time: string) =>
      ev(type, time, { date: '2026-10-18', refEventId: boot.id });
    const r = days(
      [
        boot,
        ev('shutdown', '11:00', { date: '2026-10-18' }),
        mk('session_reject', '12:00'),
        mk('session_confirm', '12:00'),
        mk('session_confirm', '11:30'),
      ],
      [],
      t('2026-10-19', '09:00'),
    );
    expect(r[0]?.sessions[0]?.confirmed).toBeDefined();
  });

  it('offene manuelle Sitzung läuft bis jetzt', () => {
    const r = days([ev('manual_start', '09:00')], [], t(D, '10:00'));
    expect(r[0]?.status).toBe('open');
    expect(r[0]?.workMinutes).toBe(60);
  });

  it('markiert künftige Ereignisse', () => {
    const r = days([ev('boot', '20:00'), ev('shutdown', '21:00')], [], t(D, '10:00'));
    expect(r[0]?.warnings).toContain('future_event');
  });

  it('manual_end ohne Sitzung wird ignoriert, manual_end nach Sitzung verlängert', () => {
    const r = days(
      [
        ev('manual_end', '06:00'),
        ev('boot', '08:00'),
        ev('shutdown', '10:00'),
        ev('manual_end', '11:00', { createdAt: t(D, '18:00') }),
      ],
      [span('08:00', '10:00')],
    );
    expect(r[0]?.end).toBe(t(D, '11:00'));
    expect(r[0]?.corrected).toBe(true);
  });

  it('mehrere manual_start: jüngstes createdAt gewinnt', () => {
    const r = days([
      ev('manual_start', '08:30', { createdAt: t(D, '18:00') }),
      ev('manual_start', '09:00'),
      ev('manual_end', '13:00'),
    ]);
    expect(r[0]?.start).toBe(t(D, '08:30'));
    expect(r[0]?.workMinutes).toBe(270);
  });

  it('manuelles Start-Ereignis vor späterer Sitzung bleibt ohne Ende', () => {
    const r = days(
      [ev('manual_start', '05:00'), ev('boot', '09:00'), ev('shutdown', '10:00')],
      [span('09:00', '10:00')],
    );
    expect(r[0]?.sessions[0]?.warnings).toContain('no_end');
  });

  it('Netz offen ohne net_lost und Handy-Netz doppelt verbunden', () => {
    const r = days(
      [
        ev('net_connected', '08:00', { deviceId: 'H' }),
        ev('net_connected', '08:30', { deviceId: 'H' }),
      ],
      [span('08:00', '09:50', 'H')],
      t(D, '10:00'),
    );
    expect(r[0]?.status).toBe('open');
    expect(r[0]?.end).toBeUndefined();
  });

  it('Netz-Lücke vor Laptop-Aktivität gilt als Pause', () => {
    const r = days(
      [
        ev('net_connected', '07:00', { deviceId: 'H' }),
        ev('net_lost', '07:30', { deviceId: 'H' }),
        ev('boot', '08:00'),
        ev('shutdown', '10:00'),
      ],
      [span('07:00', '07:30', 'H'), span('08:00', '10:00')],
    );
    expect(r[0]?.breakMinutes).toBe(30);
  });

  it('Durchschnitt über 24 Wochen über 8 h', () => {
    const events: TimeEvent[] = [];
    for (let i = 0; i < 168; i++) {
      const date = addDays('2026-04-01', i);
      events.push(ev('boot', '06:00', { date }), ev('shutdown', '16:00', { date }));
    }
    const r = days(events, [], t('2026-09-20', '09:00'));
    expect(r.at(-1)?.warnings).toContain('avg_over_8h');
  });
});
