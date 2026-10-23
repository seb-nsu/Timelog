// Lädt die JSON-Fixtures (Format laut docs/IMPLEMENTATION.md) und übersetzt sie in Eingaben für computeDays.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Absence,
  type EventFlag,
  type EventSource,
  type EventType,
  type GermanState,
  type PresenceSpan,
  type RulesConfig,
  type TimeEvent,
  type Warning,
  type WorkDay,
  addDays,
  localDate,
  localTime,
  resolveConfig,
  zonedToUtc,
} from '../src/index.js';

export const TZ = 'Europe/Berlin';
export const DEFAULT_DATE = '2026-10-14';

export interface EventOpts {
  device?: string;
  date?: string;
  endTs?: string;
  createdAt?: string;
  receivedAt?: string;
  refEventId?: string;
  source?: EventSource;
  flags?: EventFlag[];
  tz?: string;
}

export interface Expectation {
  date: string;
  start?: string;
  end?: string;
  breaksMin?: number;
  workMin: number;
  topUpMin: number;
  netMin: number;
  pendingMin?: number;
  absenceMin?: number;
  targetMin?: number;
  status: WorkDay['status'];
  corrected?: boolean;
  warnings: Warning[];
}

export interface Scenario {
  name: string;
  now?: string;
  config?: Partial<RulesConfig>;
  state?: GermanState;
  absences?: Absence[];
  events: [string, EventType, EventOpts?][];
  spans?: [string, string, string][];
  expect: Expectation[];
  balanceMin?: number;
}

export interface Input {
  events: TimeEvent[];
  spans: PresenceSpan[];
  absences: Absence[];
  config: RulesConfig;
  now: string;
}

const FIXTURES = join(import.meta.dirname, 'fixtures');

export function loadScenarios(): { file: string; scenario: Scenario }[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((file) => ({
      file,
      scenario: JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Scenario,
    }));
}

/** "HH:MM" (Datum aus dem Kontext) oder "YYYY-MM-DD HH:MM" → UTC-Millisekunden. */
function at(value: string, date: string, tz = TZ): number {
  const [d, t] = value.includes(' ') ? value.split(' ') : [date, value];
  if (d === undefined || t === undefined) throw new Error(`Ungültige Zeit: ${value}`);
  return zonedToUtc(d, t, tz);
}

const iso = (ms: number): string => new Date(ms).toISOString();

function defaultSource(type: EventType): EventSource {
  if (type === 'boot' || type === 'shutdown' || type === 'restart') return 'system';
  if (type === 'net_connected' || type === 'net_lost') return 'wifi';
  return 'user';
}

export function toInput(s: Scenario): Input {
  const events: TimeEvent[] = s.events.map(([time, type, opts = {}], i) => {
    const tz = opts.tz ?? TZ;
    const date = opts.date ?? DEFAULT_DATE;
    const ts = at(time, date, tz);
    const createdAt =
      opts.createdAt !== undefined
        ? at(opts.createdAt, date, tz)
        : type === 'boot'
          ? ts + 5 * 60_000
          : ts;
    const e: TimeEvent = {
      id: `e${String(i + 1)}`,
      deviceId: opts.device ?? 'L',
      userId: 'u1',
      type,
      source: opts.source ?? defaultSource(type),
      ts: iso(ts),
      tz,
      createdAt: iso(createdAt),
    };
    if (opts.endTs !== undefined) e.endTs = iso(at(opts.endTs, date, tz));
    if (opts.refEventId !== undefined) e.refEventId = opts.refEventId;
    if (opts.receivedAt !== undefined) e.receivedAt = iso(at(opts.receivedAt, date, tz));
    if (opts.flags !== undefined) e.flags = opts.flags;
    return e;
  });

  const kind = (device: string): PresenceSpan['deviceKind'] =>
    events.some((e) => e.deviceId === device && e.type === 'boot') || device === 'L'
      ? 'desktop'
      : 'mobile';

  let spans: PresenceSpan[];
  if (s.spans) {
    spans = s.spans.map(([device, from, to]) => ({
      deviceId: device,
      deviceKind: kind(device),
      start: iso(at(from, DEFAULT_DATE)),
      end: iso(at(to, DEFAULT_DATE)),
      open: false,
    }));
  } else {
    // Standard: durchgehend aktiv zwischen boot und shutdown bzw. net_connected und net_lost
    spans = [];
    const open = new Map<string, string>();
    for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
      const desktop = kind(e.deviceId) === 'desktop';
      const opens = desktop ? e.type === 'boot' : e.type === 'net_connected';
      const closes = desktop
        ? e.type === 'shutdown' || e.type === 'restart'
        : e.type === 'net_lost';
      const started = open.get(e.deviceId);
      if (opens && started === undefined) open.set(e.deviceId, e.ts);
      if (closes && started !== undefined) {
        spans.push({
          deviceId: e.deviceId,
          deviceKind: kind(e.deviceId),
          start: started,
          end: e.ts,
          open: false,
        });
        open.delete(e.deviceId);
      }
    }
  }

  const lastDate = s.events.reduce((max, [time, , opts]) => {
    const d = time.includes(' ') ? time.slice(0, 10) : (opts?.date ?? DEFAULT_DATE);
    return d > max ? d : max;
  }, DEFAULT_DATE);
  const now = s.now !== undefined ? at(s.now, lastDate) : at('09:00', addDays(lastDate, 1));

  const config = resolveConfig({ ...s.config, ...(s.state ? { state: s.state } : {}) });
  return { events, spans, absences: s.absences ?? [], config, now: iso(now) };
}

/** Projiziert einen berechneten Arbeitstag auf die Felder einer Erwartung. */
export function project(day: WorkDay, like: Partial<Expectation>): Expectation {
  const out: Expectation = {
    date: day.date,
    workMin: day.workMinutes,
    topUpMin: day.breakTopUpMin,
    netMin: day.netMinutes,
    status: day.status,
    warnings: [...day.warnings].sort(),
  };
  if (day.start !== undefined) out.start = localTime(Date.parse(day.start), TZ);
  if (day.end !== undefined) {
    const ms = Date.parse(day.end);
    out.end = localDate(ms, TZ) === day.date ? localTime(ms, TZ) : '24:00';
  }
  if ('breaksMin' in like) out.breaksMin = day.breakMinutes;
  if ('pendingMin' in like) out.pendingMin = day.pendingMinutes;
  if ('absenceMin' in like) out.absenceMin = day.absenceMinutes;
  if ('targetMin' in like) out.targetMin = day.targetMinutes;
  if ('corrected' in like) out.corrected = day.corrected;
  return out;
}

export function normalize(e: Expectation): Expectation {
  return { ...e, warnings: [...e.warnings].sort() };
}
