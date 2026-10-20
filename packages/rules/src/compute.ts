import { isHoliday } from './holidays.js';
import {
  type Range,
  clipRanges,
  gapsWithin,
  mergeRanges,
  subtractRanges,
  totalLength,
} from './ranges.js';
import { HOUR_MS, MINUTE_MS, addDays, localDate, startOfLocalDay, toIso, weekday } from './time.js';
import {
  type Absence,
  type Break,
  type BreakSource,
  type DayStatus,
  type PresenceSpan,
  REVIEW_WARNINGS,
  type RulesConfig,
  type Session,
  type TimeEvent,
  WARNINGS,
  type Warning,
  type WorkDay,
} from './types.js';

type StartSource = Session['startSource'];
type EndSource = NonNullable<Session['endSource']>;

/** Ereignis mit vorberechneten Zeitstempeln. */
interface Ev {
  e: TimeEvent;
  t: number;
  c: number;
  end: number | undefined;
}

/** Anwesenheits-Intervall aus einer Quelle (Laptop, Netz, manuell). */
interface Interval {
  start: number;
  end: number;
  startSource: StartSource;
  startEventId: string;
  tz: string;
  endSource: EndSource;
  open: boolean;
  noEnd: boolean;
  gapEnd: boolean;
  /** Ende unbekannt (offenes manual_start ohne andere Aktivität). */
  endUnknown: boolean;
  /** Desktop-Aktivität (nur Laptop-Intervalle). */
  desktop: Range[];
  members: string[];
}

interface Group {
  intervals: Interval[];
  start: number;
  end: number;
  manualStarts: Ev[];
  manualEnds: Ev[];
}

interface BuiltSession {
  session: Session;
  startMs: number;
  /** Ende für Berechnungen; bei offenen Sitzungen die letzte Aktivität bzw. `now`. */
  endMs: number;
  breaks: { r: Range; source: BreakSource }[];
  members: Set<string>;
  auto: boolean;
  counted: boolean;
  rejected: boolean;
}

const isReview = (w: Warning): boolean => (REVIEW_WARNINGS as readonly string[]).includes(w);
const sortWarnings = (ws: Iterable<Warning>): Warning[] =>
  [...new Set(ws)].sort((a, b) => WARNINGS.indexOf(a) - WARNINGS.indexOf(b));
const toMin = (ms: number): number => Math.floor(ms / MINUTE_MS);

/** Neuestes Ereignis nach createdAt, bei Gleichstand nach ts und id. */
function latest(evs: readonly Ev[]): Ev | undefined {
  let best: Ev | undefined;
  for (const x of evs) {
    if (
      !best ||
      x.c > best.c ||
      (x.c === best.c && (x.t > best.t || (x.t === best.t && x.e.id > best.e.id)))
    ) {
      best = x;
    }
  }
  return best;
}

function groupBy<T>(items: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Schritt 1: bereinigen, sortieren, Duplikate entfernen. */
function clean(events: readonly TimeEvent[]): Ev[] {
  const sorted = [...events].sort(
    (a, b) =>
      a.id.localeCompare(b.id) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.ts.localeCompare(b.ts),
  );
  const seen = new Set<string>();
  const out: Ev[] = [];
  for (const e of sorted) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      e,
      t: Date.parse(e.ts),
      c: Date.parse(e.createdAt),
      end: e.endTs === undefined ? undefined : Date.parse(e.endTs),
    });
  }
  return out.sort((a, b) => a.t - b.t || a.e.id.localeCompare(b.e.id));
}

/** Aktiv-Spannen je Gerät, vereinigt. */
function spansByDevice(spans: readonly PresenceSpan[]): Map<string, Range[]> {
  const m = new Map<string, Range[]>();
  for (const [device, list] of groupBy(spans, (s) => s.deviceId)) {
    m.set(device, mergeRanges(list.map((s): Range => [Date.parse(s.start), Date.parse(s.end)])));
  }
  return m;
}

function lastActivity(spans: readonly Range[], from: number, before: number): number {
  let last = from;
  for (const s of spans) {
    if (s[1] > from && s[0] < before) last = Math.max(last, Math.min(s[1], before));
  }
  return last;
}

interface Ctx {
  cfg: RulesConfig;
  now: number;
  warnDay: (date: string, w: Warning) => void;
}

/** Schritte 2–5: Neustarts verschmelzen, Waisen verwerfen, Laptop-Intervalle mit Aktivität. */
function laptopIntervals(evs: readonly Ev[], spans: Map<string, Range[]>, ctx: Ctx): Interval[] {
  const { cfg, now } = ctx;
  const out: Interval[] = [];
  const power = evs.filter(
    (x) => x.e.type === 'boot' || x.e.type === 'shutdown' || x.e.type === 'restart',
  );

  for (const [device, list] of groupBy(power, (x) => x.e.deviceId)) {
    const devSpans = spans.get(device) ?? [];

    // Neustarts und Waisen
    const kept: Ev[] = [];
    let openBoot: Ev | undefined;
    let lastEnd: Ev | undefined;
    for (const x of list) {
      if (x.e.type === 'boot') {
        if (openBoot && lastEnd) {
          const windowMin = lastEnd.e.flags?.includes('update_restart')
            ? cfg.updateRestartWindowMin
            : cfg.restartWindowMin;
          if (x.t - lastEnd.t <= windowMin * MINUTE_MS) {
            kept.splice(kept.indexOf(lastEnd), 1);
            lastEnd = undefined;
            continue;
          }
        } else if (openBoot) {
          const act = lastActivity(devSpans, openBoot.t, x.t);
          if (x.t - act <= cfg.restartWindowMin * MINUTE_MS) {
            ctx.warnDay(localDate(x.t, x.e.tz), 'crash_restart');
            continue;
          }
        }
        openBoot = x;
        lastEnd = undefined;
        kept.push(x);
      } else if (openBoot && !lastEnd) {
        lastEnd = x;
        kept.push(x);
      }
      // shutdown/restart ohne vorheriges boot: Waise, verworfen
    }

    // Laptop-Intervalle
    for (let i = 0; i < kept.length; i++) {
      const boot = kept[i];
      if (!boot || boot.e.type !== 'boot') continue;
      const next = kept[i + 1];
      const endEv = next && next.e.type !== 'boot' ? next : undefined;
      const boundary = next ? next.t : Infinity;
      const activity = clipRanges(devSpans, boot.t, boundary);

      let end: number;
      let endSource: EndSource;
      let open = false;
      let noEnd = false;
      if (endEv) {
        end = endEv.t + cfg.shutdownBonusMin * MINUTE_MS;
        endSource = 'shutdown';
      } else {
        end = activity.at(-1)?.[1] ?? boot.t;
        endSource = 'last_presence';
        if (!next && now - end < cfg.maxStandbyMin * MINUTE_MS) open = true;
        else noEnd = true;
      }

      const desktop: Range[] = activity.length > 0 ? activity : [[boot.t, endEv ? endEv.t : end]];
      const members = endEv ? [endEv.e.id] : [];
      let segStart = boot.t;
      let segSource: StartSource = 'boot';
      let segId = boot.e.id;
      let segDesk: Range[] = [];
      let prev: Range | undefined;
      for (const piece of desktop) {
        if (prev && piece[0] - prev[1] >= cfg.maxStandbyMin * MINUTE_MS) {
          out.push({
            start: segStart,
            end: prev[1],
            startSource: segSource,
            startEventId: segId,
            tz: boot.e.tz,
            endSource: 'last_presence',
            open: false,
            noEnd: false,
            gapEnd: true,
            endUnknown: false,
            desktop: segDesk,
            members: [segId],
          });
          segStart = piece[0];
          segSource = 'resume';
          segId = `${boot.e.id}@${toIso(piece[0])}`;
          segDesk = [];
        }
        segDesk.push(piece);
        prev = piece;
      }
      const lastDesk = segDesk.at(-1);
      const sleptUntilShutdown =
        endEv !== undefined &&
        activity.length > 0 &&
        lastDesk !== undefined &&
        endEv.t - lastDesk[1] >= cfg.maxStandbyMin * MINUTE_MS;
      out.push({
        start: segStart,
        end: sleptUntilShutdown ? lastDesk[1] : end,
        startSource: segSource,
        startEventId: segId,
        tz: boot.e.tz,
        endSource: sleptUntilShutdown ? 'last_presence' : endSource,
        open,
        noEnd,
        gapEnd: sleptUntilShutdown,
        endUnknown: false,
        desktop: segDesk,
        members: [segId, ...members],
      });
    }
  }
  return out;
}

/** Schritt 6: Netz-Intervalle je Gerät. */
function netIntervals(evs: readonly Ev[], spans: Map<string, Range[]>, ctx: Ctx): Interval[] {
  const out: Interval[] = [];
  const net = evs.filter((x) => x.e.type === 'net_connected' || x.e.type === 'net_lost');
  for (const [device, list] of groupBy(net, (x) => x.e.deviceId)) {
    let open: Ev | undefined;
    let members: string[] = [];
    const push = (start: Ev, end: number, endSource: EndSource, o: boolean, noEnd: boolean) => {
      out.push({
        start: start.t,
        end,
        startSource: 'net_connected',
        startEventId: start.e.id,
        tz: start.e.tz,
        endSource,
        open: o,
        noEnd,
        gapEnd: false,
        endUnknown: false,
        desktop: [],
        members,
      });
    };
    for (const x of list) {
      if (x.e.type === 'net_connected') {
        if (open) members.push(x.e.id);
        else {
          open = x;
          members = [x.e.id];
        }
      } else if (open) {
        members.push(x.e.id);
        push(open, x.t, 'net_lost', false, false);
        open = undefined;
      }
      // net_lost ohne offenes Intervall: Waise, verworfen
    }
    if (open) {
      const act = lastActivity(spans.get(device) ?? [], open.t, Infinity);
      const isOpen = ctx.now - act < ctx.cfg.maxStandbyMin * MINUTE_MS;
      push(open, act, 'last_presence', isOpen, !isOpen);
    }
  }
  return out;
}

function intervalOrder(a: Interval, b: Interval): number {
  return a.start - b.start || a.end - b.end || a.startEventId.localeCompare(b.startEventId);
}

/** Schritt 8: Vereinigung aller Intervalle; Lücken > maxBreakMin trennen Sitzungen. */
function groupIntervals(intervals: readonly Interval[], maxBreakMs: number): Group[] {
  const groups: Group[] = [];
  for (const iv of [...intervals].sort(intervalOrder)) {
    const g = groups.at(-1);
    if (g && iv.start - g.end <= maxBreakMs) {
      g.intervals.push(iv);
      g.end = Math.max(g.end, iv.end);
    } else {
      groups.push({
        intervals: [iv],
        start: iv.start,
        end: iv.end,
        manualStarts: [],
        manualEnds: [],
      });
    }
  }
  return groups;
}

function nearestGroup(
  groups: readonly Group[],
  t: number,
  fits: (g: Group) => boolean,
  distance: (g: Group) => number,
): Group | undefined {
  let best: Group | undefined;
  let bestDist = Infinity;
  for (const g of groups) {
    if (!fits(g)) continue;
    const d = t >= g.start && t <= g.end ? 0 : distance(g);
    if (d < bestDist) {
      best = g;
      bestDist = d;
    }
  }
  return best;
}

function mergeBreaks(
  pieces: { r: Range; source: BreakSource }[],
): { r: Range; source: BreakSource }[] {
  const out: { r: [number, number]; source: BreakSource }[] = [];
  for (const p of [...pieces].sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1])) {
    if (p.r[1] <= p.r[0]) continue;
    const last = out.at(-1);
    if (last && p.r[0] <= last.r[1]) {
      last.r[1] = Math.max(last.r[1], p.r[1]);
      if (p.source === 'manual') last.source = 'manual';
    } else out.push({ r: [p.r[0], p.r[1]], source: p.source });
  }
  return out;
}

interface ManualRanges {
  breaks: { ev: Ev; r: Range }[];
  work: { ev: Ev; r: Range }[];
}

/** Schritte 9–11 für eine Sitzung. */
function buildSession(g: Group, manual: ManualRanges, ctx: Ctx): BuiltSession {
  const { cfg } = ctx;
  const first = [...g.intervals].sort(intervalOrder)[0];
  if (!first) throw new Error('leere Sitzung');
  const lastIv = [...g.intervals].sort((a, b) => b.end - a.end || intervalOrder(a, b))[0] ?? first;

  const ms = latest(g.manualStarts);
  const start = ms ? ms.t : g.start;
  const meCandidate = latest(g.manualEnds);
  const me = meCandidate && meCandidate.t > start ? meCandidate : undefined;
  let end = me ? me.t : Math.max(g.end, start);

  const open = !me && g.intervals.some((i) => i.open);
  const endUnknown = !me && !open && lastIv.endUnknown;
  const noEnd = !me && !open && lastIv.noEnd;
  const gapEnd = !me && lastIv.gapEnd;
  let endSource: EndSource = me ? 'manual_end' : lastIv.endSource;

  const warnings: Warning[] = [];
  if (end - start > cfg.maxSessionH * HOUR_MS) {
    end = start + cfg.maxSessionH * HOUR_MS;
    endSource = 'capped';
    warnings.push('session_capped');
  }
  if (noEnd) warnings.push('no_end');
  if (gapEnd) warnings.push('gap_end');

  // Anwesenheit; manuelle Grenzen erweitern bzw. schneiden zu
  const presence = mergeRanges(
    clipRanges(
      [...g.intervals.map((i): Range => [i.start, i.end]), [start, g.start], [g.end, end]],
      start,
      end,
    ),
  );
  const desktop = mergeRanges(
    clipRanges(
      g.intervals.flatMap((i) => i.desktop),
      start,
      end,
    ),
  );
  const gaps = gapsWithin(presence, start, end);

  const auto: { r: Range; source: BreakSource }[] = [];
  const firstDesk = desktop[0];
  const lastDesk = desktop.at(-1);
  if (firstDesk && lastDesk) {
    for (let i = 1; i < desktop.length; i++) {
      const a = desktop[i - 1];
      const b = desktop[i];
      if (a && b && b[0] - a[1] >= cfg.standbyBreakMin * MINUTE_MS) {
        auto.push({ r: [a[1], b[0]], source: 'standby' });
      }
    }
    for (const piece of subtractRanges(gaps, [[firstDesk[0], lastDesk[1]]])) {
      if (piece[1] - piece[0] > cfg.netGraceMin * MINUTE_MS)
        auto.push({ r: piece, source: 'net_gap' });
    }
  } else {
    for (const piece of gaps) {
      if (piece[1] - piece[0] > cfg.netGraceMin * MINUTE_MS)
        auto.push({ r: piece, source: 'net_gap' });
    }
  }

  const touching = (r: Range): boolean => r[1] > start && r[0] < end;
  const manualBreaks = manual.breaks.filter((x) => touching(x.r));
  const manualWork = manual.work.filter((x) => touching(x.r));
  const workRanges = manualWork.map((x) => x.r);
  const breaks = mergeBreaks([
    ...auto.flatMap((b) => subtractRanges([b.r], workRanges).map((r) => ({ r, source: b.source }))),
    ...subtractRanges(
      manualBreaks.map((x) => x.r),
      workRanges,
    ).map((r) => ({ r, source: 'manual' as const })),
  ])
    .map((b) => ({ r: clipRanges([b.r], start, end)[0], source: b.source }))
    .filter((b): b is { r: Range; source: BreakSource } => b.r !== undefined);

  const breakRanges = breaks.map((b) => b.r);
  const workMs = end - start - totalLength(breakRanges);
  const workMinutes = toMin(workMs);
  const legalMs = cfg.legalBreakPieceMin * MINUTE_MS;
  const legal = breakRanges.filter((r) => r[1] - r[0] >= legalMs);
  let requiredMin = 0;
  for (const rule of cfg.breakRules) {
    if (workMs > rule.overMin * MINUTE_MS) requiredMin = Math.max(requiredMin, rule.breakMin);
  }
  const breakTopUpMin = Math.max(0, requiredMin - toMin(totalLength(legal)));
  if (breakTopUpMin > 0) warnings.push('break_violation');

  let acc = 0;
  let cursor = start;
  let placement = false;
  for (const r of breakRanges) {
    acc += r[0] - cursor;
    cursor = r[1];
    if (r[1] - r[0] >= legalMs) {
      if (acc > cfg.maxContinuousH * HOUR_MS) placement = true;
      acc = 0;
    }
  }
  acc += end - cursor;
  if (acc > cfg.maxContinuousH * HOUR_MS) placement = true;
  if (placement) warnings.push('break_placement');

  const manualEvs = [
    ...g.manualStarts,
    ...g.manualEnds,
    ...manualBreaks.map((x) => x.ev),
    ...manualWork.map((x) => x.ev),
  ];
  const corrected = manualEvs.some((x) => x.c - x.t > cfg.correctionThresholdMin * MINUTE_MS);

  const members = new Set<string>(g.intervals.flatMap((i) => i.members));
  for (const x of manualEvs) members.add(x.e.id);

  const session: Session = {
    id: first.startEventId,
    start: toIso(start),
    tz: ms?.e.tz ?? first.tz,
    startSource: ms ? 'manual_start' : first.startSource,
    breaks: breaks.map((b): Break => ({
      from: toIso(b.r[0]),
      to: toIso(b.r[1]),
      source: b.source,
      countsLegally: b.r[1] - b.r[0] >= legalMs,
    })),
    workMinutes,
    breakTopUpMin,
    needsConfirmation: false,
    open,
    corrected,
    warnings,
  };
  if (!open && !endUnknown) {
    session.end = toIso(end);
    session.endSource = endSource;
  }
  return {
    session,
    startMs: start,
    endMs: end,
    breaks,
    members,
    auto: true,
    counted: true,
    rejected: false,
  };
}

interface DayAcc {
  sessions: BuiltSession[];
  starts: number[];
  ends: (number | undefined)[];
  breakMs: number;
  work: number;
  topUp: number;
  pending: number;
  warnings: Set<Warning>;
}

export function targetMinutes(date: string, cfg: RulesConfig): number {
  if (isHoliday(date, cfg.state)) return 0;
  let entry: RulesConfig['targetSchedule'][number] | undefined;
  for (const s of cfg.targetSchedule) {
    if (s.validFrom <= date && (!entry || s.validFrom > entry.validFrom)) entry = s;
  }
  return entry?.minutesByWeekday[weekday(date)] ?? 0;
}

/**
 * Regelwerk: berechnet Arbeitstage aus Ereignissen, Aktiv-Spannen und Abwesenheiten.
 * Reine Funktion ohne Seiteneffekte; das Ergebnis hängt nicht von der Reihenfolge der Eingaben ab.
 */
export function computeDays(
  events: readonly TimeEvent[],
  spans: readonly PresenceSpan[],
  absences: readonly Absence[],
  config: RulesConfig,
  now: string,
): WorkDay[] {
  const cfg = config;
  const nowMs = Date.parse(now);
  const dayWarnings = new Map<string, Set<Warning>>();
  const ctx: Ctx = {
    cfg,
    now: nowMs,
    warnDay: (date, w) => {
      const set = dayWarnings.get(date) ?? new Set<Warning>();
      set.add(w);
      dayWarnings.set(date, set);
    },
  };

  // 1. Bereinigen
  const evs = clean(events);
  for (const x of evs) {
    if (x.t > nowMs + cfg.futureToleranceMin * MINUTE_MS)
      ctx.warnDay(localDate(x.t, x.e.tz), 'future_event');
    if (x.e.source !== 'user' && x.c - x.t > cfg.backdateH * HOUR_MS) {
      ctx.warnDay(localDate(x.t, x.e.tz), 'late_event');
    }
  }
  const spanMap = spansByDevice(spans);

  // 2–6. Automatische Intervalle
  const intervals: Interval[] = [
    ...laptopIntervals(evs, spanMap, ctx),
    ...netIntervals(evs, spanMap, ctx),
  ];

  // 7. Manuelle Intervalle
  const manual: ManualRanges = { breaks: [], work: [] };
  for (const x of evs) {
    if (x.end === undefined || x.end <= x.t) continue;
    if (x.e.type === 'manual_break') manual.breaks.push({ ev: x, r: [x.t, x.end] });
    if (x.e.type === 'manual_work') {
      manual.work.push({ ev: x, r: [x.t, x.end] });
      intervals.push({
        start: x.t,
        end: x.end,
        startSource: 'manual_work',
        startEventId: x.e.id,
        tz: x.e.tz,
        endSource: 'manual_work',
        open: false,
        noEnd: false,
        gapEnd: false,
        endUnknown: false,
        desktop: [],
        members: [],
      });
    }
  }
  const pairs: [Ev, Ev][] = [];
  const looseStarts: Ev[] = [];
  const looseEnds: Ev[] = [];
  let pendingStart: Ev | undefined;
  for (const x of evs) {
    if (x.e.type === 'manual_start') {
      if (pendingStart) looseStarts.push(pendingStart);
      pendingStart = x;
    } else if (x.e.type === 'manual_end') {
      if (pendingStart) pairs.push([pendingStart, x]);
      else looseEnds.push(x);
      pendingStart = undefined;
    }
  }
  if (pendingStart) looseStarts.push(pendingStart);
  for (const [s, e] of pairs) {
    intervals.push({
      start: s.t,
      end: e.t,
      startSource: 'manual_start',
      startEventId: s.e.id,
      tz: s.e.tz,
      endSource: 'manual_end',
      open: false,
      noEnd: false,
      gapEnd: false,
      endUnknown: false,
      desktop: [],
      members: [],
    });
  }

  // 8. Sitzungen bilden, manuelle Grenzen zuordnen
  const maxBreakMs = cfg.maxBreakMin * MINUTE_MS;
  const groups = groupIntervals(intervals, maxBreakMs);
  for (const [s, e] of pairs) {
    const g = groups.find((x) => s.t >= x.start && s.t <= x.end);
    g?.manualStarts.push(s);
    g?.manualEnds.push(e);
  }
  const standalone: Ev[] = [];
  for (const x of looseStarts) {
    const g = nearestGroup(
      groups,
      x.t,
      (gr) => x.t >= gr.start - maxBreakMs && x.t <= gr.end,
      (gr) => gr.start - x.t,
    );
    if (g) g.manualStarts.push(x);
    else standalone.push(x);
  }
  for (const x of looseEnds) {
    const g = nearestGroup(
      groups,
      x.t,
      (gr) => x.t >= gr.start && x.t <= gr.end + maxBreakMs,
      (gr) => x.t - gr.end,
    );
    g?.manualEnds.push(x);
  }
  for (const x of standalone) {
    const later = groups.some((g) => g.start > x.t);
    const isOpen = !later && nowMs >= x.t && nowMs - x.t < cfg.maxSessionH * HOUR_MS;
    const end = isOpen ? nowMs : x.t;
    groups.push({
      intervals: [
        {
          start: x.t,
          end,
          startSource: 'manual_start',
          startEventId: x.e.id,
          tz: x.e.tz,
          endSource: 'last_presence',
          open: isOpen,
          noEnd: !isOpen,
          gapEnd: false,
          endUnknown: !isOpen,
          desktop: [],
          members: [],
        },
      ],
      start: x.t,
      end,
      manualStarts: [x],
      manualEnds: [],
    });
  }

  // 9–11. Sitzungen berechnen
  const built = groups
    .map((g) => buildSession(g, manual, ctx))
    .sort((a, b) => a.startMs - b.startMs || a.session.id.localeCompare(b.session.id));

  // 12. Bestätigung
  const decisions = evs.filter(
    (x) => x.e.type === 'session_confirm' || x.e.type === 'session_reject',
  );
  const firstOfDay = new Set<string>();
  for (const b of built) {
    const decision = latest(
      decisions.filter((d) => d.e.refEventId !== undefined && b.members.has(d.e.refEventId)),
    );
    if (decision) b.session.confirmed = decision.e.type === 'session_confirm';
    b.rejected = b.session.confirmed === false;
    const date = localDate(b.startMs, b.session.tz);
    const target = targetMinutes(date, cfg);
    b.auto = false;
    if (!b.rejected && !firstOfDay.has(date)) {
      firstOfDay.add(date);
      b.auto = target > 0;
    }
    b.session.needsConfirmation = !b.auto;
    b.counted = !b.rejected && (b.auto || b.session.confirmed === true);
    if (!b.auto && !b.rejected && b.session.confirmed !== true) {
      b.session.warnings.push(target > 0 ? 'second_session' : 'non_workday');
    }
    b.session.warnings = sortWarnings(b.session.warnings);
  }

  // 13. Auf Tage aufteilen
  const days = new Map<string, DayAcc>();
  const day = (date: string): DayAcc => {
    let d = days.get(date);
    if (!d) {
      d = {
        sessions: [],
        starts: [],
        ends: [],
        breakMs: 0,
        work: 0,
        topUp: 0,
        pending: 0,
        warnings: new Set(),
      };
      days.set(date, d);
    }
    return d;
  };
  for (const b of built) {
    const pieces: { date: string; a: number; z: number; work: number; topUp: number }[] = [];
    let date = localDate(b.startMs, b.session.tz);
    let a = b.startMs;
    for (;;) {
      const next = startOfLocalDay(addDays(date, 1), b.session.tz);
      const z = Math.min(b.endMs, next);
      const breakMs = totalLength(
        clipRanges(
          b.breaks.map((x) => x.r),
          a,
          z,
        ),
      );
      pieces.push({ date, a, z, work: toMin(z - a - breakMs), topUp: 0 });
      if (!b.rejected) day(date).breakMs += breakMs;
      if (b.endMs <= next) break;
      a = next;
      date = addDays(date, 1);
    }
    if (b.counted) {
      let remaining = b.session.breakTopUpMin;
      for (const p of [...pieces].reverse()) {
        p.topUp = Math.min(remaining, p.work);
        remaining -= p.topUp;
      }
    }
    for (const [i, p] of pieces.entries()) {
      const d = day(p.date);
      d.sessions.push(b);
      if (b.rejected) continue;
      d.starts.push(p.a);
      const isLast = i === pieces.length - 1;
      d.ends.push(isLast && b.session.end === undefined ? undefined : p.z);
      if (b.counted) {
        d.work += p.work;
        d.topUp += p.topUp;
        for (const w of b.session.warnings) d.warnings.add(w);
      } else {
        d.pending += p.work;
        for (const w of b.session.warnings) {
          if (w !== 'break_violation' && w !== 'break_placement') d.warnings.add(w);
        }
      }
    }
  }

  // 15. Hinweise über Sitzungen hinweg
  let prevCounted: BuiltSession | undefined;
  const seenDates = new Set<string>();
  for (const b of built) {
    if (!b.counted) continue;
    const date = localDate(b.startMs, b.session.tz);
    if (!seenDates.has(date)) {
      seenDates.add(date);
      if (
        prevCounted &&
        localDate(prevCounted.startMs, prevCounted.session.tz) < date &&
        b.startMs - prevCounted.endMs < cfg.minRestH * HOUR_MS
      ) {
        day(date).warnings.add('rest_under_11h');
      }
    }
    prevCounted = b;
  }

  // 16. Abwesenheiten und Tageswarnungen
  const absenceByDate = new Map<string, number>();
  for (const a of absences) {
    absenceByDate.set(a.date, (absenceByDate.get(a.date) ?? 0) + a.minutes);
    day(a.date);
  }
  for (const [date, ws] of dayWarnings) for (const w of ws) day(date).warnings.add(w);

  const avgWindowDays = cfg.avgWeeks * 7;
  const avgWorkdays = cfg.avgWeeks * 6;
  const result: WorkDay[] = [];
  for (const date of [...days.keys()].sort()) {
    const d = day(date);
    const active = [...new Set(d.sessions)].filter((b) => !b.rejected);
    if (d.work > cfg.maxDayH * 60) d.warnings.add('over_10h');
    if (active.length > 0 && (weekday(date) === 0 || isHoliday(date, cfg.state))) {
      d.warnings.add('sunday_or_holiday');
    }
    if (d.work > 0) {
      let sum = 0;
      const from = addDays(date, -(avgWindowDays - 1));
      for (const [other, acc] of days) if (other >= from && other <= date) sum += acc.work;
      if (sum / avgWorkdays > cfg.avgDayH * 60) d.warnings.add('avg_over_8h');
    }
    const warnings = sortWarnings(d.warnings);
    let status: DayStatus = 'auto';
    if (active.some((b) => b.session.open)) status = 'open';
    else if (warnings.some(isReview)) status = 'unchecked';
    else if (active.length > 0 && active.every((b) => b.session.confirmed === true))
      status = 'confirmed';

    const wd: WorkDay = {
      date,
      sessions: [...new Set(d.sessions)].map((b) => b.session),
      breakMinutes: toMin(d.breakMs),
      workMinutes: d.work,
      breakTopUpMin: d.topUp,
      netMinutes: Math.max(0, d.work - d.topUp),
      pendingMinutes: d.pending,
      absenceMinutes: absenceByDate.get(date) ?? 0,
      targetMinutes: targetMinutes(date, cfg),
      status,
      corrected: active.some((b) => b.session.corrected),
      warnings,
    };
    if (d.starts.length > 0) wd.start = toIso(Math.min(...d.starts));
    const ends = d.ends;
    if (ends.length > 0 && ends.every((e) => e !== undefined)) wd.end = toIso(Math.max(...ends));
    result.push(wd);
  }
  return result;
}

/** Saldo = Σ(netMinutes + absenceMinutes) − Σ targetMinutes. */
export function computeBalance(days: readonly WorkDay[]): number {
  return days.reduce((sum, d) => sum + d.netMinutes + d.absenceMinutes - d.targetMinutes, 0);
}
