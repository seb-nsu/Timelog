// Projekte, Tagesort und Kalender-Vorschläge. Die bestehenden Fixtures bleiben unverändert; die
// Property-Tests nutzen sie aber als Eingabe für die Projektaufteilung.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CalendarBlock,
  type PresenceSpan,
  type ProjectAssignment,
  type TimeEvent,
  type WorkDay,
  absenceSuggestions,
  allocateProjects,
  assignedPieces,
  computeDays,
  dayLocation,
  gapSuggestions,
  homeOfficeSummary,
  countOf,
  isCounted,
  largestRemainder,
  matchProject,
  networkRanges,
  projectTotals,
  resolveConfig,
  workRanges,
  zonedToUtc,
} from '../src/index.js';
import { loadScenarios, toInput } from './scenario.js';

const TZ = 'Europe/Berlin';
const D = '2026-10-14';
const t = (time: string, date = D): string => new Date(zonedToUtc(date, time, TZ)).toISOString();
const NOW = t('09:00', '2026-10-15');
const cfg = resolveConfig();

let n = 0;
function ev(type: TimeEvent['type'], time: string, extra: Partial<TimeEvent> = {}): TimeEvent {
  n += 1;
  const ts = t(time);
  return {
    id: `e${String(n)}`,
    deviceId: 'L',
    userId: 'u',
    type,
    source: type.startsWith('manual') || type.startsWith('session') ? 'user' : 'system',
    ts,
    tz: TZ,
    createdAt: ts,
    ...extra,
  };
}
const span = (from: string, to: string, deviceId = 'L'): PresenceSpan => ({
  deviceId,
  deviceKind: deviceId === 'L' ? 'desktop' : 'mobile',
  start: t(from),
  end: t(to),
  open: false,
});

/** boot 08:00, Aktiv 08:00–12:00 und 13:00–17:00, shutdown 17:00 → 8:05 Arbeit, 1 h Pause. */
function lunchDay(): WorkDay {
  const days = computeDays(
    [ev('boot', '08:00'), ev('shutdown', '17:00')],
    [span('08:00', '12:00'), span('13:00', '17:00')],
    [],
    cfg,
    NOW,
  );
  const day = days.find((d) => d.date === D);
  if (!day) throw new Error('kein Tag');
  return day;
}

/** boot 08:00, shutdown 17:00 ohne Pause → 9:05 Arbeit, 0:45 Auffüllung, 8:20 Netto. */
function topUpDay(): WorkDay {
  const day = computeDays([ev('boot', '08:00'), ev('shutdown', '17:00')], [], [], cfg, NOW).find(
    (d) => d.date === D,
  );
  if (!day) throw new Error('kein Tag');
  return day;
}

const assign = (
  from: string,
  to: string,
  projectId: string | null,
  source: ProjectAssignment['source'] = 'manual',
  createdAt = t('20:00'),
): ProjectAssignment => ({ from: t(from), to: t(to), projectId, source, createdAt });

describe('workRanges', () => {
  it('zieht Pausen ab und schneidet auf den Kalendertag zu', () => {
    const r = workRanges(lunchDay());
    expect(r.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()])).toEqual([
      [t('08:00'), t('12:00')],
      [t('13:00'), t('17:05')],
    ]);
  });

  it('teilt Sitzungen über Mitternacht', () => {
    const days = computeDays(
      [ev('boot', '22:00'), { ...ev('shutdown', '00:00'), ts: t('01:00', '2026-10-15') }],
      [],
      [],
      cfg,
      NOW,
    );
    const wed = days.find((d) => d.date === D);
    const thu = days.find((d) => d.date === '2026-10-15');
    expect(wed && workRanges(wed)).toEqual([
      [Date.parse(t('22:00')), Date.parse(t('00:00', '2026-10-15'))],
    ]);
    expect(thu && workRanges(thu)).toEqual([
      [Date.parse(t('00:00', '2026-10-15')), Date.parse(t('01:05', '2026-10-15'))],
    ]);
  });

  it('lässt unbestätigte und verworfene Sitzungen weg, offene laufen bis now', () => {
    const base: WorkDay = { ...lunchDay(), sessions: [] };
    const s = lunchDay().sessions[0];
    if (!s) throw new Error('keine Sitzung');
    expect(workRanges({ ...base, sessions: [{ ...s, needsConfirmation: true }] })).toEqual([]);
    expect(workRanges({ ...base, sessions: [{ ...s, confirmed: false }] })).toEqual([]);
    const open = { ...s, end: undefined, open: true, breaks: [] };
    expect(workRanges({ ...base, sessions: [open] }, t('10:00'))).toEqual([
      [Date.parse(t('08:00')), Date.parse(t('10:00'))],
    ]);
    // offenes Ende ohne now bzw. unbekanntes Ende: kein Zeitraum
    expect(workRanges({ ...base, sessions: [open] })).toEqual([]);
    expect(workRanges({ ...base, sessions: [{ ...open, open: false }] }, t('10:00'))).toEqual([]);
  });

  it('isCounted', () => {
    const s = lunchDay().sessions[0];
    if (!s) throw new Error('keine Sitzung');
    expect(isCounted(s)).toBe(true);
    expect(isCounted({ ...s, needsConfirmation: true })).toBe(false);
    expect(isCounted({ ...s, needsConfirmation: true, confirmed: true })).toBe(true);
    expect(isCounted({ ...s, confirmed: false })).toBe(false);
  });
});

describe('largestRemainder', () => {
  it('countOf liefert 0 für fehlende Schlüssel', () => {
    expect(countOf(new Map([['a', 2]]), 'a')).toBe(2);
    expect(countOf(new Map(), 'x')).toBe(0);
  });

  it('verteilt ganzzahlig und vollständig', () => {
    const r = largestRemainder(
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]),
      10,
    );
    expect([...r.values()].reduce((x, y) => x + y, 0)).toBe(10);
    expect(r.get('a')).toBe(4);
    expect(largestRemainder(new Map([['a', 0]]), 5).get('a')).toBe(0);
    expect(largestRemainder(new Map([['a', 3]]), 0).get('a')).toBe(0);
  });
});

describe('allocateProjects', () => {
  it('ohne Zuordnung ist alles „nicht zugeordnet“', () => {
    const day = lunchDay();
    expect(allocateProjects(day, []).items).toEqual([
      { projectId: null, workMinutes: 485, topUpMinutes: 0, netMinutes: 485, manual: false },
    ]);
  });

  it('Netz-Standardprojekt, Kalender und manuelle Zuordnung mit Vorrang', () => {
    const day = lunchDay();
    const result = allocateProjects(day, [
      assign('07:00', '18:00', 'net', 'network'),
      assign('09:00', '10:00', 'cal', 'calendar'),
      assign('09:30', '11:00', 'man', 'manual'),
    ]);
    expect(result.items).toEqual([
      { projectId: 'net', workMinutes: 365, topUpMinutes: 0, netMinutes: 365, manual: false },
      { projectId: 'man', workMinutes: 90, topUpMinutes: 0, netMinutes: 90, manual: true },
      { projectId: 'cal', workMinutes: 30, topUpMinutes: 0, netMinutes: 30, manual: false },
    ]);
  });

  it('manuell „kein Projekt“ nimmt Zeit heraus; die jüngste manuelle Angabe gewinnt', () => {
    const day = lunchDay();
    const items = allocateProjects(day, [
      assign('08:00', '17:05', 'a', 'manual', t('18:00')),
      assign('08:00', '12:00', null, 'manual', t('19:00')),
      assign('08:00', '09:00', 'b', 'manual', t('18:30')),
    ]).items;
    expect(items).toEqual([
      { projectId: 'a', workMinutes: 245, topUpMinutes: 0, netMinutes: 245, manual: true },
      { projectId: null, workMinutes: 240, topUpMinutes: 0, netMinutes: 240, manual: true },
    ]);
  });

  it('Auffüllung wird anteilig abgezogen, Summe = Netto', () => {
    const day = topUpDay();
    expect(day.breakTopUpMin).toBe(45);
    const items = allocateProjects(day, [
      assign('08:00', '11:00', 'a'),
      assign('11:00', '17:05', 'b'),
    ]).items;
    expect(items).toEqual([
      { projectId: 'b', workMinutes: 365, topUpMinutes: 30, netMinutes: 335, manual: true },
      { projectId: 'a', workMinutes: 180, topUpMinutes: 15, netMinutes: 165, manual: true },
    ]);
    expect(items.reduce((s, i) => s + i.netMinutes, 0)).toBe(day.netMinutes);
  });

  it('leere und ungültige Zuordnungen werden ignoriert, Tag ohne Arbeit bleibt leer', () => {
    const day = lunchDay();
    const items = allocateProjects(day, [assign('10:00', '09:00', 'x')]).items;
    expect(items).toHaveLength(1);
    expect(
      allocateProjects({ ...day, sessions: [], workMinutes: 0, netMinutes: 0 }, []).items,
    ).toEqual([]);
  });

  it('Arbeitszeit ohne erkennbaren Zeitraum fällt auf „nicht zugeordnet“', () => {
    const day = { ...lunchDay(), sessions: [] };
    expect(allocateProjects(day, [assign('08:00', '17:00', 'a')]).items).toEqual([
      { projectId: null, workMinutes: 485, topUpMinutes: 0, netMinutes: 485, manual: false },
    ]);
  });

  it('gleicher Zeitpunkt der Erfassung: Ergebnis hängt nicht von der Reihenfolge ab', () => {
    const day = lunchDay();
    const a = assign('08:00', '17:05', 'a', 'manual', t('18:00'));
    const b = assign('08:00', '17:05', 'b', 'manual', t('18:00'));
    expect(allocateProjects(day, [a, b])).toEqual(allocateProjects(day, [b, a]));
  });

  it('winzige Anteile runden auf 0 und erscheinen nicht; Gleichstand nach ID', () => {
    const day = lunchDay();
    const tiny: ProjectAssignment = {
      from: t('08:00'),
      to: new Date(Date.parse(t('08:00')) + 10_000).toISOString(),
      projectId: 'tiny',
      source: 'manual',
      createdAt: t('20:00'),
    };
    const items = allocateProjects(day, [tiny]).items;
    expect(items.map((i) => i.projectId)).toEqual([null]);
    const even = allocateProjects({ ...day, workMinutes: 480, netMinutes: 480 }, [
      assign('08:00', '12:00', 'y'),
      assign('13:00', '17:00', 'x'),
      assign('17:00', '17:05', 'z'),
    ]).items;
    expect(even.map((i) => [i.projectId, i.netMinutes])).toEqual([
      ['x', 238],
      ['y', 237],
      ['z', 5],
    ]);
  });

  it('assignedPieces teilt an allen Grenzen', () => {
    const pieces = assignedPieces(
      [[Date.parse(t('08:00')), Date.parse(t('10:00'))]],
      [assign('09:00', '09:30', 'a')],
    );
    expect(pieces.map((p) => p.projectId)).toEqual([null, 'a', null]);
  });

  it('projectTotals summiert je Projekt', () => {
    const day = topUpDay();
    const p = allocateProjects(day, [assign('08:00', '11:00', 'a')]);
    const totals = projectTotals([p, p]);
    expect(totals).toEqual([
      { projectId: 'a', workMinutes: 360, topUpMinutes: 30, netMinutes: 330 },
      { projectId: null, workMinutes: 730, topUpMinutes: 60, netMinutes: 670 },
    ]);
  });
});

describe('Property-Tests Projektaufteilung', () => {
  const scenarios = loadScenarios().map(({ scenario }) => toInput(scenario));
  const allDays = scenarios.flatMap((i) =>
    computeDays(i.events, i.spans, i.absences, i.config, i.now).map((d) => ({ d, now: i.now })),
  );
  const startMs = Date.parse('2026-03-27T00:00:00Z');
  const assignmentArb = fc.record({
    from: fc.integer({ min: 0, max: 260 * 24 * 60 }),
    len: fc.integer({ min: 1, max: 24 * 60 }),
    project: fc.constantFrom('p1', 'p2', 'p3', null),
    source: fc.constantFrom('manual' as const, 'calendar' as const, 'network' as const),
    created: fc.integer({ min: 0, max: 1000 }),
  });
  const toAssign = (a: {
    from: number;
    len: number;
    project: string | null;
    source: ProjectAssignment['source'];
    created: number;
  }): ProjectAssignment => ({
    from: new Date(startMs + a.from * 60_000).toISOString(),
    to: new Date(startMs + (a.from + a.len) * 60_000).toISOString(),
    projectId: a.project,
    source: a.source,
    createdAt: new Date(startMs + a.created * 60_000).toISOString(),
  });

  it('Summen stimmen, nichts negativ, Reihenfolge egal (über alle Fixture-Tage)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allDays),
        fc.array(assignmentArb, { maxLength: 12 }),
        ({ d, now }, raw) => {
          const list = raw.map(toAssign);
          const r = allocateProjects(d, list, now);
          const sum = (f: (x: (typeof r.items)[number]) => number) =>
            r.items.reduce((s, i) => s + f(i), 0);
          expect(sum((i) => i.workMinutes)).toBe(d.workMinutes);
          expect(sum((i) => i.netMinutes)).toBe(d.netMinutes);
          for (const i of r.items) {
            expect(i.netMinutes).toBeGreaterThanOrEqual(0);
            expect(i.topUpMinutes).toBeGreaterThanOrEqual(0);
            expect(i.netMinutes).toBeLessThanOrEqual(i.workMinutes);
          }
          expect(allocateProjects(d, [...list].reverse(), now)).toEqual(r);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('eine manuelle Zuordnung über den ganzen Tag schlägt jede Automatik', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allDays.filter(({ d }) => d.workMinutes > 0)),
        fc.array(assignmentArb, { maxLength: 8 }),
        ({ d, now }, raw) => {
          const auto = raw.map((a) => toAssign({ ...a, source: 'network' }));
          const whole: ProjectAssignment = {
            from: '2000-01-01T00:00:00.000Z',
            to: '2100-01-01T00:00:00.000Z',
            projectId: 'manual',
            source: 'manual',
            createdAt: '2000-01-01T00:00:00.000Z',
          };
          const r = allocateProjects(d, [...auto, whole], now);
          expect(r.items.map((i) => i.projectId)).toEqual(['manual']);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('matchProject', () => {
  const projects = [
    { id: 'b', keywords: ['Kunde A', ''] },
    { id: 'a', keywords: ['kunde a'] },
    { id: 'c', keywords: ['Kunde A Wartung'] },
  ];
  it('längstes Stichwort gewinnt, ohne Groß-/Kleinschreibung', () => {
    expect(matchProject('Jour fixe KUNDE A wartung', projects)).toBe('c');
    expect(matchProject('Call kunde a', projects)).toBe('a');
    expect(matchProject('Mittag', projects)).toBeNull();
    expect(matchProject('   ', projects)).toBeNull();
  });
});

describe('networkRanges', () => {
  it('paart Verbinden und Trennen je Gerät und Netz', () => {
    const events = [
      ev('net_connected', '08:00', { deviceId: 'H', networkId: 'office' }),
      ev('net_connected', '08:30', { deviceId: 'H', networkId: 'office' }),
      ev('net_lost', '12:00', { deviceId: 'H', networkId: 'office' }),
      ev('net_lost', '12:30', { deviceId: 'H' }),
      ev('net_connected', '13:00', { deviceId: 'H', networkId: 'office' }),
      ev('net_connected', '15:00', { deviceId: 'H', networkId: 'home' }),
      ev('net_lost', '16:00', { deviceId: 'H' }),
      ev('net_connected', '16:30', { deviceId: 'H' }),
      ev('net_connected', '17:00', { deviceId: 'L', networkId: 'home' }),
      ev('boot', '08:00'),
    ];
    const dup = events[0];
    if (!dup) throw new Error('kein Ereignis');
    const r = networkRanges([...events, dup], [span('17:00', '19:00'), span('06:00', '07:00')]);
    expect(r).toEqual([
      { networkId: 'home', from: t('15:00'), to: t('16:00') },
      { networkId: 'home', from: t('17:00'), to: t('19:00') },
      { networkId: 'office', from: t('08:00'), to: t('12:00') },
      { networkId: 'office', from: t('13:00'), to: t('15:00') },
    ]);
  });

  it('gleiche Zeitstempel werden stabil sortiert', () => {
    const a = ev('net_connected', '08:00', { networkId: 'x', id: 'b' });
    const b = ev('net_lost', '08:00', { networkId: 'x', id: 'a' });
    const c = ev('net_lost', '09:00', { networkId: 'x' });
    expect(networkRanges([a, b, c])).toEqual(networkRanges([c, b, a]));
  });

  it('ohne Trennen und ohne Aktivität: kein Zeitraum', () => {
    expect(networkRanges([ev('net_connected', '08:00', { networkId: 'x' })])).toEqual([]);
  });
});

describe('dayLocation und homeOfficeSummary', () => {
  const day = lunchDay();
  const nets = (id: string, from: string, to: string) => ({
    networkId: id,
    from: t(from),
    to: t(to),
  });
  const locs = { o: 'office' as const, h: 'home' as const, x: 'other' as const };

  it('Büro ab 15 Minuten im Büro-Netz', () => {
    expect(
      dayLocation(day, [nets('o', '08:00', '08:15'), nets('h', '09:00', '17:05')], locs),
    ).toEqual({
      date: D,
      location: 'office',
      source: 'auto',
      officeMinutes: 15,
      homeMinutes: 425,
    });
  });

  it('Homeoffice bei überwiegender Zeit im Homeoffice-Netz, sonst unterwegs', () => {
    expect(dayLocation(day, [nets('h', '08:00', '12:30')], locs).location).toBe('other');
    expect(dayLocation(day, [nets('h', '08:00', '14:00')], locs).location).toBe('home');
    expect(
      dayLocation(day, [nets('o', '08:00', '08:10'), nets('h', '08:10', '17:00')], locs).location,
    ).toBe('home');
    expect(dayLocation(day, [nets('unbekannt', '08:00', '17:00')], locs).location).toBe('other');
  });

  it('manuelle Angabe gewinnt; Tag ohne Arbeit hat keinen Ort', () => {
    expect(dayLocation(day, [nets('o', '08:00', '17:00')], locs, 'home')).toMatchObject({
      location: 'home',
      source: 'manual',
    });
    const empty = { ...day, sessions: [] };
    expect(dayLocation(empty, [], locs).location).toBeUndefined();
  });

  it('Jahresübersicht mit Deckelung', () => {
    const list = [
      {
        date: '2026-01-05',
        location: 'home' as const,
        source: 'auto' as const,
        officeMinutes: 0,
        homeMinutes: 400,
      },
      {
        date: '2026-01-06',
        location: 'office' as const,
        source: 'auto' as const,
        officeMinutes: 400,
        homeMinutes: 0,
      },
      {
        date: '2026-02-02',
        location: 'home' as const,
        source: 'manual' as const,
        officeMinutes: 0,
        homeMinutes: 0,
      },
      {
        date: '2026-02-03',
        location: 'other' as const,
        source: 'auto' as const,
        officeMinutes: 0,
        homeMinutes: 0,
      },
      { date: '2026-02-04', source: 'auto' as const, officeMinutes: 0, homeMinutes: 0 },
    ];
    const s = homeOfficeSummary(list, { perDayCents: 600, maxPerYearCents: 1000 });
    expect(s).toEqual({
      homeDays: 2,
      officeDays: 1,
      otherDays: 1,
      homeDaysByMonth: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxDays: 1,
      amountCents: 1000,
    });
    expect(homeOfficeSummary([], { perDayCents: 0, maxPerYearCents: 0 }).maxDays).toBe(0);
  });
});

describe('Kalender-Vorschläge', () => {
  const busy = (from: string, to: string, kind: CalendarBlock['kind'] = 'busy'): CalendarBlock => ({
    from: t(from),
    to: t(to),
    kind,
    allDay: false,
  });

  it('Termin in einer erkannten Pause → Vorschlag „War Arbeit“ für die Überschneidung', () => {
    const day = lunchDay();
    const sid = day.sessions[0]?.id ?? '';
    expect(gapSuggestions(day, [busy('12:15', '13:30'), busy('14:00', '15:00')])).toEqual([
      { date: D, sessionId: sid, from: t('12:15'), to: t('13:00'), kind: 'break' },
    ]);
    // zu kurze Überschneidung, ganztägige und Abwesenheits-Termine zählen nicht
    expect(gapSuggestions(day, [busy('12:50', '13:30')])).toEqual([]);
    expect(gapSuggestions(day, [busy('12:00', '13:00', 'absence')])).toEqual([]);
    expect(gapSuggestions(day, [{ ...busy('12:00', '13:00'), allDay: true }])).toEqual([]);
  });

  it('Lücke zwischen zwei Sitzungen, manuelle Pausen und verworfene Sitzungen nicht', () => {
    const days = computeDays(
      [
        ev('boot', '07:00'),
        ev('shutdown', '10:00'),
        ev('boot', '13:00'),
        ev('shutdown', '17:00'),
        ev('manual_break', '15:00', { endTs: t('15:30') }),
      ],
      [],
      [],
      cfg,
      NOW,
    );
    const day = days.find((d) => d.date === D);
    if (!day) throw new Error('kein Tag');
    const second = day.sessions[1];
    expect(gapSuggestions(day, [busy('11:00', '12:00'), busy('15:00', '15:30')])).toEqual([
      { date: D, sessionId: second?.id, from: t('11:00'), to: t('12:00'), kind: 'gap' },
    ]);
    const rejected = {
      ...day,
      sessions: day.sessions.map((s, i) => (i === 1 ? { ...s, confirmed: false } : s)),
    };
    expect(gapSuggestions(rejected, [busy('11:00', '12:00')])).toEqual([]);
    const openFirst = {
      ...day,
      sessions: day.sessions.map((s, i) => (i === 0 ? { ...s, end: undefined } : s)),
    };
    expect(gapSuggestions(openFirst, [busy('11:00', '12:00')])).toEqual([]);
  });

  it('ganztägige Abwesenheit → Abwesenheits-Vorschlag je Tag, eingetragene Tage nicht', () => {
    const blocks: CalendarBlock[] = [
      {
        from: t('00:00', '2026-10-19'),
        to: t('00:00', '2026-10-22'),
        kind: 'absence',
        allDay: true,
        startDate: '2026-10-19',
        endDate: '2026-10-22',
      },
      // nicht ganztägig, aber 26.10. 00:00 bis 28.10. 12:00 → 26. und 27.
      {
        from: t('00:00', '2026-10-26'),
        to: t('12:00', '2026-10-28'),
        kind: 'absence',
        allDay: false,
      },
      // beginnt mittags: nur der folgende volle Tag
      {
        from: t('12:00', '2026-11-02'),
        to: t('00:00', '2026-11-04'),
        kind: 'absence',
        allDay: false,
      },
      { from: t('00:00', '2026-11-10'), to: t('00:00', '2026-11-12'), kind: 'busy', allDay: true },
    ];
    expect(
      absenceSuggestions(
        blocks,
        [{ date: '2026-10-20', kind: 'sick', minutes: 480 }],
        TZ,
        '2026-10-01',
        '2026-11-30',
      ),
    ).toEqual([
      { date: '2026-10-19', kind: 'vacation' },
      { date: '2026-10-21', kind: 'vacation' },
      { date: '2026-10-26', kind: 'vacation' },
      { date: '2026-10-27', kind: 'vacation' },
      { date: '2026-11-03', kind: 'vacation' },
    ]);
    expect(absenceSuggestions(blocks, [], TZ, '2026-10-20', '2026-10-20')).toEqual([
      { date: '2026-10-20', kind: 'vacation' },
    ]);
  });
});
