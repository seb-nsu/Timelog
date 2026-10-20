// Bindeglied zwischen lokal gespeicherten Daten und dem Regelwerk. Fachlich rechnet nur @timelog/rules.
import {
  type Absence,
  type Break,
  type DeviceKind,
  type EventFlag,
  type EventSource,
  type EventType,
  type GermanState,
  REVIEW_WARNINGS,
  type TargetSchedule,
  type TimeEvent,
  type Warning,
  type WorkDay,
  computeBalance,
  computeDays,
  localDate,
  resolveConfig,
} from '@timelog/rules';

/** Ereignis, wie es der Client lokal speichert (ohne userId/deviceId). */
export interface LocalEvent {
  id: string;
  type: EventType;
  source: EventSource;
  ts: string;
  endTs?: string;
  tz: string;
  networkId?: string;
  refEventId?: string;
  createdAt: string;
  flags?: EventFlag[];
}

export interface LocalSpan {
  id: string;
  start: string;
  end: string;
  open: boolean;
}

export interface LocalData {
  events: LocalEvent[];
  spans: LocalSpan[];
}

/** Profil des Nutzers, wie es der Client zwischenspeichert. */
export interface Profile {
  state: GermanState;
  timezone: string;
  targetSchedule?: TargetSchedule[];
  absences?: Absence[];
}

const LOCAL_DEVICE = 'local';
const LOCAL_USER = 'local';

export function computeLocalDays(
  data: LocalData,
  profile: Profile,
  now: string,
  deviceKind: DeviceKind = 'desktop',
): WorkDay[] {
  const events: TimeEvent[] = data.events.map((e) => ({
    ...e,
    deviceId: LOCAL_DEVICE,
    userId: LOCAL_USER,
  }));
  const spans = data.spans.map((s) => ({
    deviceId: LOCAL_DEVICE,
    deviceKind,
    start: s.start,
    end: s.end,
    open: s.open,
  }));
  const config = resolveConfig({
    state: profile.state,
    ...(profile.targetSchedule && profile.targetSchedule.length > 0
      ? { targetSchedule: profile.targetSchedule }
      : {}),
  });
  return computeDays(events, spans, profile.absences ?? [], config, now);
}

export interface TodaySummary {
  date: string;
  day: WorkDay | undefined;
  running: boolean;
  /** Beginn der laufenden Sitzung (UTC), falls sie läuft. */
  since: string | undefined;
  netMinutes: number;
  breakMinutes: number;
  balanceMinutes: number;
}

export function todaySummary(days: readonly WorkDay[], now: string, tz: string): TodaySummary {
  const date = localDate(Date.parse(now), tz);
  const day = days.find((d) => d.date === date);
  const open = day?.sessions.find((s) => s.open);
  return {
    date,
    day,
    running: day?.status === 'open',
    since: open?.start,
    netMinutes: day?.netMinutes ?? 0,
    breakMinutes: day ? day.breakMinutes + day.breakTopUpMin : 0,
    balanceMinutes: computeBalance(days),
  };
}

export interface ReviewItem {
  date: string;
  sessionId: string;
  from: string;
  to: string | undefined;
  tz: string;
  warnings: Warning[];
  /** Sitzung wartet auf „Bestätigen“ oder „Verwerfen“. */
  needsDecision: boolean;
}

const isReview = (w: Warning): boolean => (REVIEW_WARNINGS as readonly Warning[]).includes(w);

/** Sitzungen für die Liste „Zu prüfen“, jüngste zuerst. Eine Sitzung über Mitternacht erscheint einmal. */
export function reviewItems(days: readonly WorkDay[]): ReviewItem[] {
  const seen = new Set<string>();
  const items: ReviewItem[] = [];
  for (const day of [...days].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const s of day.sessions) {
      if (seen.has(s.id)) continue;
      const needsDecision = s.needsConfirmation && s.confirmed === undefined;
      const warnings = s.warnings.filter(isReview);
      if (!needsDecision && warnings.length === 0) continue;
      seen.add(s.id);
      items.push({
        date: day.date,
        sessionId: s.id,
        from: s.start,
        to: s.end,
        tz: s.tz,
        warnings,
        needsDecision,
      });
    }
  }
  return items;
}

export interface BreakItem extends Break {
  sessionId: string;
  tz: string;
}

/** Erkannte Pausen eines Tages, für „War Arbeit“ (nur automatisch erkannte, keine manuellen). */
export function detectedBreaks(day: WorkDay | undefined): BreakItem[] {
  if (!day) return [];
  return day.sessions.flatMap((s) =>
    s.breaks.filter((b) => b.source !== 'manual').map((b) => ({ ...b, sessionId: s.id, tz: s.tz })),
  );
}

/** Ereignisse eines lokalen Tages für das Tagesprotokoll, chronologisch. */
export function eventsOfDay(events: readonly LocalEvent[], date: string): LocalEvent[] {
  return events
    .filter((e) => localDate(Date.parse(e.ts), e.tz) === date)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
