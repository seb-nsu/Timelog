import { describe, expect, it } from 'vitest';
import {
  type PresenceSpan,
  type TimeEvent,
  computeDays,
  isoWeekOf,
  resolveConfig,
  summarizeWeek,
  zonedToUtc,
} from '../src/index.js';

const TZ = 'Europe/Berlin';
const at = (date: string, time: string): string =>
  new Date(zonedToUtc(date, time, TZ)).toISOString();

let n = 0;
function ev(type: TimeEvent['type'], ts: string, extra: Partial<TimeEvent> = {}): TimeEvent {
  n += 1;
  return {
    id: `e${String(n)}`,
    deviceId: 'L',
    userId: 'u',
    type,
    source: type.startsWith('session') ? 'user' : 'system',
    ts,
    tz: TZ,
    createdAt: type === 'boot' ? new Date(Date.parse(ts) + 5 * 60_000).toISOString() : ts,
    ...extra,
  };
}

/** Laptop-Tag: boot → shutdown, durchgehend aktiv. */
function laptopDay(date: string, from: string, to: string) {
  const boot = ev('boot', at(date, from));
  const span: PresenceSpan = {
    deviceId: 'L',
    deviceKind: 'desktop',
    start: at(date, from),
    end: at(date, to),
    open: false,
  };
  return { events: [boot, ev('shutdown', at(date, to))], span, boot };
}

describe('isoWeekOf', () => {
  it('liefert Montag bis Sonntag und die ISO-Kalenderwoche', () => {
    expect(isoWeekOf('2026-10-16')).toEqual({
      id: '2026-W42',
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(isoWeekOf('2026-10-18').from).toBe('2026-10-12');
    expect(isoWeekOf('2026-10-19').id).toBe('2026-W43');
  });

  it('Jahreswechsel: Woche gehört zum Jahr ihres Donnerstags', () => {
    // Do 01.01.2026 → KW 1 von 2026 beginnt am Mo 29.12.2025
    expect(isoWeekOf('2025-12-29')).toMatchObject({ id: '2026-W01', from: '2025-12-29' });
    // So 03.01.2027 gehört noch zu KW 53 von 2026
    expect(isoWeekOf('2027-01-03')).toMatchObject({ id: '2026-W53', from: '2026-12-28' });
    expect(isoWeekOf('2027-01-04').id).toBe('2027-W01');
  });
});

describe('summarizeWeek', () => {
  const cfg = resolveConfig({ state: 'BE' });

  it('summiert die Woche, zählt offene und bestätigbare Tage und nennt ArbZG-Hinweise', () => {
    // Mo 12.10.: 08:00–16:00 mit 45 min Pause (auto)
    const mo = laptopDay('2026-10-12', '08:00', '16:00');
    mo.span.end = at('2026-10-12', '12:00');
    const moAfter: PresenceSpan = {
      ...mo.span,
      start: at('2026-10-12', '12:45'),
      end: at('2026-10-12', '16:00'),
    };
    // Di 13.10.: 08:00–17:00 ohne Pause (unchecked, Pause fehlt)
    const di = laptopDay('2026-10-13', '08:00', '17:00');
    // Mi 14.10.: 09:00–13:00, bereits bestätigt
    const mi = laptopDay('2026-10-14', '09:00', '13:00');
    const confirm = ev('session_confirm', at('2026-10-14', '14:00'), { refEventId: mi.boot.id });
    // Fr 16.10.: läuft noch (offen)
    const fr = ev('boot', at('2026-10-16', '08:00'));
    const frSpan: PresenceSpan = {
      deviceId: 'L',
      deviceKind: 'desktop',
      start: at('2026-10-16', '08:00'),
      end: at('2026-10-16', '10:55'),
      open: true,
    };
    const now = at('2026-10-16', '11:00');
    const days = computeDays(
      [...mo.events, ...di.events, ...mi.events, confirm, fr],
      [mo.span, moAfter, di.span, mi.span, frSpan],
      [{ date: '2026-10-15', kind: 'vacation', minutes: 480 }],
      cfg,
      now,
    );
    const s = summarizeWeek(days, cfg, '2026-10-16', '2026-10-16');
    expect(s.week.id).toBe('2026-W42');
    expect(s.targetMinutes).toBe(5 * 480);
    expect(s.absenceMinutes).toBe(480);
    expect(s.openDays).toEqual(['2026-10-13']);
    expect(s.confirmableDays).toEqual(['2026-10-12']);
    expect(s.confirmedDays).toEqual(['2026-10-14']);
    expect(s.legalHints).toEqual([
      { date: '2026-10-13', warnings: ['break_violation', 'break_placement'] },
    ]);
    const byDate = new Map(days.map((d) => [d.date, d]));
    const net = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16'].reduce(
      (sum, d) => sum + (byDate.get(d)?.netMinutes ?? 0),
      0,
    );
    expect(s.netMinutes).toBe(net);
    expect(s.workMinutes).toBeGreaterThanOrEqual(s.netMinutes);
    // Saldo zählt nur erfasste Tage bis heute: Mo, Di, Mi, Do (Urlaub), Fr
    const recorded = days.filter((d) => d.date >= '2026-10-12' && d.date <= '2026-10-16');
    expect(s.balanceMinutes).toBe(
      recorded.reduce((sum, d) => sum + d.netMinutes + d.absenceMinutes - d.targetMinutes, 0),
    );
  });

  it('ignoriert Tage außerhalb der Woche und nach `until`', () => {
    const before = laptopDay('2026-10-09', '08:00', '12:00');
    const later = laptopDay('2026-10-15', '08:00', '12:00');
    const days = computeDays(
      [...before.events, ...later.events],
      [before.span, later.span],
      [],
      cfg,
      at('2026-10-16', '09:00'),
    );
    const s = summarizeWeek(days, cfg, '2026-10-14', '2026-10-14');
    expect(s.netMinutes).toBe(245);
    expect(s.balanceMinutes).toBe(0);
    expect(s.confirmableDays).toEqual([]);
    expect(s.openDays).toEqual([]);
    expect(s.legalHints).toEqual([]);
  });

  it('leere Woche: nur Soll, Saldo 0', () => {
    const s = summarizeWeek([], cfg, '2026-10-14', '2026-10-18');
    expect(s).toMatchObject({ netMinutes: 0, targetMinutes: 2400, balanceMinutes: 0 });
  });
});
