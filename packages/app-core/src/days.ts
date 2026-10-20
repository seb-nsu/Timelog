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
  addDays,
  computeBalance,
  computeDays,
  creditedAbsenceMinutes,
  localDate,
  resolveConfig,
  targetMinutes,
} from '@timelog/rules';
import type { ReminderSettings } from './reminders.js';

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
  /** Erinnerungen und Ruhezeit aus den Kontoeinstellungen. */
  reminders?: ReminderSettings;
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
  return computeDays(events, spans, profile.absences ?? [], configOf(profile), now);
}

/** Ereignis mit Gerät, z. B. vom Server geladene Daten aller Geräte des Nutzers. */
export interface DeviceEvent extends LocalEvent {
  deviceId: string;
}

export interface DeviceSpan extends LocalSpan {
  deviceId: string;
  deviceKind: DeviceKind;
}

export interface DeviceData {
  events: DeviceEvent[];
  spans: DeviceSpan[];
}

/**
 * Wie `computeLocalDays`, aber mit Daten mehrerer Geräte (Handy zeigt auch die Laptop-Zeiten).
 * Gerätezuordnung bleibt erhalten, damit das Regelwerk Neustarts und Waisen je Gerät erkennt.
 */
export function computeDeviceDays(data: DeviceData, profile: Profile, now: string): WorkDay[] {
  const events: TimeEvent[] = data.events.map((e) => ({ ...e, userId: LOCAL_USER }));
  const spans = data.spans.map((s) => ({
    deviceId: s.deviceId,
    deviceKind: s.deviceKind,
    start: s.start,
    end: s.end,
    open: s.open,
  }));
  return computeDays(events, spans, profile.absences ?? [], configOf(profile), now);
}

export interface PeriodSummary {
  /** Jeder Kalendertag von `from` bis `to`, Tage ohne Daten mit Sollzeit des Regelwerks. */
  days: WorkDay[];
  netMinutes: number;
  targetMinutes: number;
  absenceMinutes: number;
  /**
   * Saldo bis einschließlich `until` (zukünftige Tage zählen nicht). Wie am Desktop zählen nur
   * Tage mit Erfassung oder Abwesenheit; leere Tage gehen nicht als Minus ein.
   */
  balanceMinutes: number;
}

/**
 * Woche/Monat für die Übersicht. Das Regelwerk liefert nur Tage mit Daten; für die Anzeige
 * kommen Tage ohne Erfassung mit ihrer Sollzeit (aus `targetMinutes` des Regelwerks) dazu.
 */
export function periodDays(
  days: readonly WorkDay[],
  profile: Profile,
  from: string,
  to: string,
  until: string,
): PeriodSummary {
  const cfg = configOf(profile);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const absence = new Map<string, number>();
  // Überstundenabbau zählt als Abwesenheitstag, schreibt aber nichts gut (Regelwerk).
  for (const a of profile.absences ?? [])
    absence.set(a.date, (absence.get(a.date) ?? 0) + creditedAbsenceMinutes(a));
  const list: WorkDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    list.push(
      byDate.get(date) ?? {
        date,
        sessions: [],
        breakMinutes: 0,
        workMinutes: 0,
        breakTopUpMin: 0,
        netMinutes: 0,
        pendingMinutes: 0,
        absenceMinutes: absence.get(date) ?? 0,
        targetMinutes: targetMinutes(date, cfg),
        status: 'auto',
        corrected: false,
        warnings: [],
      },
    );
  }
  const sum = (f: (d: WorkDay) => number) => list.reduce((s, d) => s + f(d), 0);
  return {
    days: list,
    netMinutes: sum((d) => d.netMinutes),
    targetMinutes: sum((d) => d.targetMinutes),
    absenceMinutes: sum((d) => d.absenceMinutes),
    balanceMinutes: computeBalance(
      list.filter((d) => d.date <= until && (byDate.has(d.date) || absence.has(d.date))),
    ),
  };
}

function configOf(profile: Profile) {
  return resolveConfig({
    state: profile.state,
    ...(profile.targetSchedule && profile.targetSchedule.length > 0
      ? { targetSchedule: profile.targetSchedule }
      : {}),
  });
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
