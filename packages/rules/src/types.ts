export type EventType =
  | 'boot' // Rechner läuft seit ≥ 5 min; ts = echte Einschaltzeit (nicht bei Aufwachen aus Ruhezustand)
  | 'shutdown' // echtes Herunterfahren (kein Neustart, kein Logout)
  | 'restart' // Neustart erkannt → wird ignoriert
  | 'net_connected'
  | 'net_lost' // nur für hinterlegte Arbeitsnetze
  | 'manual_start'
  | 'manual_end' // Start/Stopp-Knopf oder nachträgliche Korrektur
  | 'manual_break' // mit endTs: Pause nachtragen
  | 'manual_work' // mit endTs: Zeitraum als Arbeit werten (z. B. Meeting ohne Laptop)
  | 'session_confirm'
  | 'session_reject'; // refEventId = Start-Ereignis der Sitzung

export const EVENT_TYPES = [
  'boot',
  'shutdown',
  'restart',
  'net_connected',
  'net_lost',
  'manual_start',
  'manual_end',
  'manual_break',
  'manual_work',
  'session_confirm',
  'session_reject',
] as const satisfies readonly EventType[];

export type EventSource = 'system' | 'wifi' | 'lan' | 'geofence' | 'shortcut' | 'user';

export const EVENT_SOURCES = [
  'system',
  'wifi',
  'lan',
  'geofence',
  'shortcut',
  'user',
] as const satisfies readonly EventSource[];

/** Zusatzangaben des Clients; `update_restart` verlängert das Neustart-Fenster. */
export type EventFlag = 'update_restart';

export interface TimeEvent {
  id: string;
  deviceId: string;
  userId: string; // userId/deviceId setzt der Server aus dem Token
  type: EventType;
  source: EventSource;
  ts: string; // ISO 8601 UTC
  endTs?: string;
  tz: string; // IANA-Zeitzone des Geräts zum Ereigniszeitpunkt
  networkId?: string;
  refEventId?: string;
  createdAt: string; // Gerätezeit der Erzeugung
  receivedAt?: string; // vom Server gesetzt, nur Info
  flags?: EventFlag[];
}

export type DeviceKind = 'desktop' | 'mobile';

/**
 * Aktiv-Spanne: Gerät wach und entsperrt (Desktop) bzw. im Arbeitsnetz (Mobile).
 * Ersetzt einzelne Heartbeats; der Client verlängert die offene Spanne laufend.
 */
export interface PresenceSpan {
  deviceId: string;
  deviceKind: DeviceKind;
  start: string;
  end: string;
  open: boolean;
}

export type AbsenceKind = 'vacation' | 'sick' | 'holiday' | 'other';

export interface Absence {
  date: string;
  kind: AbsenceKind;
  minutes: number;
}

export type BreakSource = 'standby' | 'net_gap' | 'manual';

export interface Break {
  from: string;
  to: string;
  source: BreakSource;
  countsLegally: boolean;
}

/** Warnungen, die eine Prüfung verlangen (Status `unchecked`). */
export const REVIEW_WARNINGS = [
  'break_violation',
  'break_placement',
  'gap_end',
  'no_end',
  'session_capped',
  'late_event',
  'future_event',
  'second_session',
  'non_workday',
] as const;

/** Reine Hinweise. */
export const HINT_WARNINGS = [
  'over_10h',
  'rest_under_11h',
  'sunday_or_holiday',
  'avg_over_8h',
  'crash_restart',
] as const;

export type ReviewWarning = (typeof REVIEW_WARNINGS)[number];
export type HintWarning = (typeof HINT_WARNINGS)[number];
export type Warning = ReviewWarning | HintWarning;

export const WARNINGS: readonly Warning[] = [...REVIEW_WARNINGS, ...HINT_WARNINGS];

export interface Session {
  id: string; // = id des Start-Ereignisses (stabil, Ziel von session_confirm)
  start: string;
  end?: string; // fehlt, solange die Sitzung offen ist oder ihr Ende unbekannt ist
  tz: string; // Zeitzone des Start-Ereignisses
  startSource: EventType | 'resume';
  endSource?: EventType | 'last_presence' | 'capped';
  breaks: Break[];
  workMinutes: number; // tatsächlich: Ende − Start − echte Pausen
  breakTopUpMin: number; // ausgewiesener Abzug bis zur Mindestpause
  needsConfirmation: boolean;
  confirmed?: boolean;
  open: boolean;
  corrected: boolean;
  warnings: Warning[];
}

export type DayStatus = 'open' | 'unchecked' | 'auto' | 'confirmed';

export interface WorkDay {
  date: string; // YYYY-MM-DD in Zeitzone der Sitzung
  sessions: Session[];
  start?: string; // frühester Beginn gezählter oder offener Sitzungen an diesem Tag (UTC)
  end?: string; // spätestes Ende an diesem Tag (UTC); fehlt bei offenem bzw. unbekanntem Ende
  breakMinutes: number;
  workMinutes: number; // tatsächliche Arbeitszeit des Tages (gezählte Sitzungen)
  breakTopUpMin: number; // Anteil der Auffüllung, der auf diesen Tag fällt
  netMinutes: number; // workMinutes − Auffüllung; nie negativ
  pendingMinutes: number; // unbestätigte Sitzungen
  absenceMinutes: number;
  targetMinutes: number;
  status: DayStatus;
  corrected: boolean;
  warnings: Warning[];
}

export type GermanState =
  | 'BW'
  | 'BY'
  | 'BE'
  | 'BB'
  | 'HB'
  | 'HH'
  | 'HE'
  | 'MV'
  | 'NI'
  | 'NW'
  | 'RP'
  | 'SL'
  | 'SN'
  | 'ST'
  | 'SH'
  | 'TH';

export const GERMAN_STATES = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
] as const satisfies readonly GermanState[];

export interface BreakRule {
  /** Gilt, wenn die tatsächliche Arbeitszeit diesen Wert (Minuten) übersteigt. */
  overMin: number;
  /** Mindestpause in Minuten. */
  breakMin: number;
}

/** Sollzeit je Wochentag (Index 0 = Sonntag) ab einem Datum. */
export interface TargetSchedule {
  validFrom: string;
  minutesByWeekday: [number, number, number, number, number, number, number];
}

export interface RulesConfig {
  bootConfirmMin: number;
  shutdownBonusMin: number;
  restartWindowMin: number;
  updateRestartWindowMin: number;
  netGraceMin: number;
  standbyBreakMin: number;
  maxStandbyMin: number;
  maxBreakMin: number;
  maxSessionH: number;
  legalBreakPieceMin: number;
  breakRules: BreakRule[];
  maxContinuousH: number;
  maxDayH: number;
  minRestH: number;
  avgDayH: number;
  avgWeeks: number;
  backdateH: number;
  futureToleranceMin: number;
  correctionThresholdMin: number;
  /** Nutzerbezogen: Bundesland für Feiertage. */
  state: GermanState;
  /** Nutzerbezogen: Sollzeiten mit Gültigkeitsdatum (Teilzeit-Wechsel). */
  targetSchedule: TargetSchedule[];
}
