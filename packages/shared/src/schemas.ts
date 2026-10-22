// Zod-Schemas für alle API-Grenzen. Backend validiert damit Anfragen, Clients die Antworten.
import {
  ABSENCE_KINDS,
  type Break,
  EVENT_SOURCES,
  EVENT_TYPES,
  GERMAN_STATES,
  type Session,
  WARNINGS,
  type Warning,
  type WorkDay,
} from '@timelog/rules';
import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

/** Prüft eine IANA-Zeitzone über die eingebaute Intl-API. */
export const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Ungültige IANA-Zeitzone');

// ── Ereignisse ────────────────────────────────────────────────────────────────

/** Ereignis, wie es ein Client sendet. userId/deviceId setzt der Server aus dem Token. */
export const eventInput = z
  .object({
    id: z.uuid(),
    type: z.enum(EVENT_TYPES),
    source: z.enum(EVENT_SOURCES),
    ts: isoDateTime,
    endTs: isoDateTime.optional(),
    tz: timeZone,
    networkId: z.uuid().optional(),
    refEventId: z.string().min(1).max(200).optional(),
    createdAt: isoDateTime,
    flags: z
      .array(z.enum(['update_restart']))
      .max(4)
      .optional(),
  })
  .refine(
    (e) => (e.type === 'manual_break' || e.type === 'manual_work') === (e.endTs !== undefined),
    { message: 'endTs ist genau bei manual_break und manual_work Pflicht', path: ['endTs'] },
  )
  .refine((e) => e.endTs === undefined || Date.parse(e.endTs) > Date.parse(e.ts), {
    message: 'endTs muss nach ts liegen',
    path: ['endTs'],
  })
  .refine(
    (e) =>
      (e.type === 'session_confirm' || e.type === 'session_reject') ===
      (e.refEventId !== undefined),
    {
      message: 'refEventId ist genau bei session_confirm und session_reject Pflicht',
      path: ['refEventId'],
    },
  );
export type EventInput = z.infer<typeof eventInput>;

export const MAX_BATCH_EVENTS = 500;

export const eventBatchRequest = z.object({
  events: z.array(eventInput).min(1).max(MAX_BATCH_EVENTS),
});
export type EventBatchRequest = z.infer<typeof eventBatchRequest>;

export const eventBatchResponse = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
});
export type EventBatchResponse = z.infer<typeof eventBatchResponse>;

export const storedEvent = z.object({
  id: z.string(),
  deviceId: z.uuid(),
  type: z.enum(EVENT_TYPES),
  source: z.enum(EVENT_SOURCES),
  ts: isoDateTime,
  endTs: isoDateTime.optional(),
  tz: z.string(),
  networkId: z.string().optional(),
  refEventId: z.string().optional(),
  createdAt: isoDateTime,
  receivedAt: isoDateTime,
  flags: z.array(z.enum(['update_restart'])).optional(),
});
export type StoredEvent = z.infer<typeof storedEvent>;

export const cursorQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const eventPage = z.object({ events: z.array(storedEvent), nextCursor: z.number().int() });
export type EventPage = z.infer<typeof eventPage>;

// ── Aktiv-Spannen ─────────────────────────────────────────────────────────────

export const presenceInput = z
  .object({
    id: z.uuid(),
    start: isoDateTime,
    end: isoDateTime,
    open: z.boolean(),
  })
  .refine((s) => Date.parse(s.end) >= Date.parse(s.start), {
    message: 'end muss nach start liegen',
    path: ['end'],
  });

export const presenceRequest = z.object({ spans: z.array(presenceInput).min(1).max(200) });
export type PresenceRequest = z.infer<typeof presenceRequest>;

export const storedSpan = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  deviceKind: z.enum(['desktop', 'mobile']),
  start: isoDateTime,
  end: isoDateTime,
  open: z.boolean(),
});
export const presencePage = z.object({ spans: z.array(storedSpan), nextCursor: z.number().int() });
export type PresencePage = z.infer<typeof presencePage>;

export const okResponse = z.object({ ok: z.literal(true) });

// ── Auth ──────────────────────────────────────────────────────────────────────

const email = z
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());
const password = z.string().min(10, 'Mindestens 10 Zeichen').max(200);

export const deviceInfo = z.object({
  kind: z.enum(['desktop', 'mobile']),
  os: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
});
export type DeviceInfo = z.infer<typeof deviceInfo>;

export const registerRequest = z.object({
  email,
  password,
  name: z.string().min(1).max(100),
  timezone: timeZone.default('Europe/Berlin'),
  state: z.enum(GERMAN_STATES).default('BE'),
});
export type RegisterRequest = z.input<typeof registerRequest>;

export const verifyRequest = z.object({ token: z.string().min(20).max(200) });

export const loginRequest = z.object({
  email,
  password: z.string().min(1).max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  deviceId: z.uuid().optional(),
  device: deviceInfo,
});
export type LoginRequest = z.input<typeof loginRequest>;

export const tokenResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  deviceId: z.uuid(),
  totpSetupRequired: z.boolean(),
});
export type TokenResponse = z.infer<typeof tokenResponse>;

export const refreshRequest = z.object({ refreshToken: z.string().min(20).max(200) });

export const passwordResetRequest = z.object({ email });
export const passwordResetConfirm = z.object({ token: z.string().min(20).max(200), password });

export const totpSetupResponse = z.object({ secret: z.string(), otpauthUrl: z.string() });
export const totpVerifyRequest = z.object({ code: z.string().regex(/^\d{6}$/) });

export const errorResponse = z.object({ error: z.string(), message: z.string().optional() });
export type ErrorResponse = z.infer<typeof errorResponse>;

// ── Geräte ────────────────────────────────────────────────────────────────────

export const deviceUpdate = z.object({
  os: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(100).optional(),
  pushToken: z.string().min(1).max(4096).optional(),
  /** Sprache der Push-Texte für dieses Gerät. */
  locale: z.enum(['de', 'en']).optional(),
});
export const deviceResponse = z.object({
  id: z.uuid(),
  kind: z.enum(['desktop', 'mobile']),
  os: z.string(),
  name: z.string(),
  lastSeenAt: isoDateTime.optional(),
  revokedAt: isoDateTime.optional(),
});
export type DeviceResponse = z.infer<typeof deviceResponse>;
export const devicesResponse = z.object({ devices: z.array(deviceResponse) });
export const deviceIdParams = z.object({ id: z.uuid() });

// ── Arbeitstage ───────────────────────────────────────────────────────────────

const warning = z.enum(WARNINGS as [Warning, ...Warning[]]);

export const breakSchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  source: z.enum(['standby', 'net_gap', 'manual']),
  countsLegally: z.boolean(),
});

export const sessionSchema = z.object({
  id: z.string(),
  start: isoDateTime,
  end: isoDateTime.optional(),
  tz: z.string(),
  startSource: z.enum([...EVENT_TYPES, 'resume']),
  endSource: z.enum([...EVENT_TYPES, 'last_presence', 'capped']).optional(),
  breaks: z.array(breakSchema),
  workMinutes: z.number().int(),
  breakTopUpMin: z.number().int(),
  needsConfirmation: z.boolean(),
  confirmed: z.boolean().optional(),
  open: z.boolean(),
  corrected: z.boolean(),
  warnings: z.array(warning),
});

export const workDaySchema = z.object({
  date: isoDate,
  sessions: z.array(sessionSchema),
  start: isoDateTime.optional(),
  end: isoDateTime.optional(),
  breakMinutes: z.number().int(),
  workMinutes: z.number().int(),
  breakTopUpMin: z.number().int(),
  netMinutes: z.number().int(),
  pendingMinutes: z.number().int(),
  absenceMinutes: z.number().int(),
  targetMinutes: z.number().int(),
  status: z.enum(['open', 'unchecked', 'auto', 'confirmed']),
  corrected: z.boolean(),
  warnings: z.array(warning),
});

// Typprüfung: Ergebnisse des Regelwerks passen in die Schemas.
type Assignable<T, U extends T> = U;
export type _BreakFits = Assignable<z.input<typeof breakSchema>, Break>;
export type _SessionFits = Assignable<z.input<typeof sessionSchema>, Session>;
export type _WorkDayFits = Assignable<z.input<typeof workDaySchema>, WorkDay>;

export const MAX_DAY_RANGE = 93;

export const daysQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: 'from muss vor to liegen', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_DAY_RANGE, {
    message: `Höchstens ${String(MAX_DAY_RANGE)} Tage`,
    path: ['to'],
  });
export type DaysQuery = z.infer<typeof daysQuery>;

export const daysResponse = z.object({
  days: z.array(workDaySchema),
  balanceMinutes: z.number().int(),
});
export type DaysResponse = z.infer<typeof daysResponse>;

export const statusResponse = z.object({
  date: isoDate,
  running: z.boolean(),
  since: isoDateTime.optional(),
  today: workDaySchema.optional(),
  toReview: z.array(isoDate),
});
export type StatusResponse = z.infer<typeof statusResponse>;

// ── Korrekturen und Bestätigungen (Phase 2b) ──────────────────────────────────

const reason = z.string().trim().min(1).max(500);

export const correctionRequest = z.discriminatedUnion('field', [
  z.object({ field: z.literal('start'), time: isoDateTime, reason: reason.optional() }),
  z.object({ field: z.literal('end'), time: isoDateTime, reason: reason.optional() }),
  z.object({
    field: z.literal('break'),
    from: isoDateTime,
    to: isoDateTime,
    reason: reason.optional(),
  }),
  z.object({
    field: z.literal('work'),
    from: isoDateTime,
    to: isoDateTime,
    reason: reason.optional(),
  }),
]);
export type CorrectionRequest = z.infer<typeof correctionRequest>;

export const dateParams = z.object({ date: isoDate });
export const sessionParams = z.object({ id: z.string().min(1).max(200) });

export const correctionResponse = z.object({ eventId: z.uuid(), day: workDaySchema.optional() });
export const confirmResponse = z.object({ confirmed: z.number().int() });

// ── Einstellungen ─────────────────────────────────────────────────────────────

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const settingsSchema = z.object({
  triggers: z
    .object({
      boot: z.boolean().default(true),
      shutdown: z.boolean().default(true),
      network: z.boolean().default(true),
      geofence: z.boolean().default(false),
      standbyBreaks: z.boolean().default(true),
    })
    .prefault({}),
  notifications: z
    .object({
      forgotEnd: z.boolean().default(true),
      over10h: z.boolean().default(true),
      breakViolation: z.boolean().default(true),
      confirmDay: z.boolean().default(true),
      /** Rückfrage „Feierabend um … erkannt, stimmt das?“ nach automatisch erkanntem Ende. */
      confirmEnd: z.boolean().default(true),
      /** Wochenrückblick: Wochentag (0 = Sonntag) und Uhrzeit in der Zeitzone des Kontos. */
      weekReview: z
        .object({
          enabled: z.boolean().default(true),
          weekday: z.number().int().min(0).max(6).default(5),
          time: clock.default('15:00'),
        })
        .prefault({}),
      quietHours: z
        .object({ from: clock.default('20:00'), to: clock.default('07:00') })
        .prefault({}),
    })
    .prefault({}),
  /** Abweichende Arbeitstage (0 = Sonntag); leer = Sollzeiten bestimmen die Arbeitstage. */
  workdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  /** Privatversion ohne Synchronisation. */
  localOnly: z.boolean().default(false),
  personnelNumber: z.string().max(50).optional(),
  /** Projekte und Tätigkeiten (Privatkonto; bei Firmenkonten schaltet der Admin). */
  projects: z.boolean().default(false),
  /** Zusatzfunktion Kalender-Anbindung in der Oberfläche zeigen (Firma: nur wenn erlaubt). */
  calendar: z.boolean().default(false),
  /** Zusatzfunktion Arbeitsort und Homeoffice-Nachweis in der Oberfläche zeigen. */
  homeOffice: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsResponse = z.object({
  name: z.string(),
  email: z.string(),
  timezone: z.string(),
  state: z.enum(GERMAN_STATES),
  settings: settingsSchema,
});
export const settingsUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  timezone: timeZone.optional(),
  state: z.enum(GERMAN_STATES).optional(),
  settings: settingsSchema.optional(),
});

// ── Arbeitsnetze ──────────────────────────────────────────────────────────────

/** Ort eines Arbeitsnetzes für den Homeoffice-Nachweis. */
export const networkLocation = z.enum(['office', 'home', 'other']);
const networkExtras = {
  location: networkLocation.default('office'),
  /** Standardprojekt für Arbeitszeit in diesem Netz (Automatik-Regel) */
  defaultProjectId: z.uuid().nullable().optional(),
};

/** Klartext-Kennungen gehen nur beim Hinterlegen an den Server und werden dort als HMAC gespeichert. */
export const networkInput = z.discriminatedUnion('kind', [
  z.object({
    ...networkExtras,
    kind: z.literal('ssid'),
    label: z.string().min(1).max(100),
    ssid: z.string().min(1).max(64),
    bssid: z
      .string()
      .regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/)
      .optional(),
  }),
  z.object({
    ...networkExtras,
    kind: z.literal('fingerprint'),
    label: z.string().min(1).max(100),
    fingerprint: z.string().min(8).max(512),
  }),
  z.object({
    ...networkExtras,
    kind: z.literal('geofence'),
    label: z.string().min(1).max(100),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radius: z.number().int().min(50).max(1000),
  }),
]);
export const MAX_USER_NETWORKS = 20;
export const networksUpdate = z.object({
  networks: z.array(networkInput).max(MAX_USER_NETWORKS),
});
export const networkParams = z.object({ id: z.uuid() });
/** Ort, Bezeichnung und Standardprojekt eines Netzes ändern (Kennungen bleiben). */
export const networkUpdate = z.object({
  label: z.string().min(1).max(100).optional(),
  location: networkLocation.optional(),
  defaultProjectId: z.uuid().nullable().optional(),
});

export const networkResponse = z.object({
  id: z.uuid(),
  scope: z.enum(['user', 'org']),
  kind: z.enum(['ssid', 'fingerprint', 'geofence']),
  label: z.string(),
  location: networkLocation.default('office'),
  defaultProjectId: z.uuid().optional(),
  ssid: z.string().optional(),
  bssidHmac: z.string().optional(),
  fingerprintHmac: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  radius: z.number().optional(),
});
export const networksResponse = z.object({
  networks: z.array(networkResponse),
  /** HMAC-Schlüssel (Base64), mit denen Geräte die aktuelle Kennung vergleichen. */
  keys: z.object({ user: z.string(), org: z.string().optional() }),
});
export type NetworksResponse = z.infer<typeof networksResponse>;

// ── Sollzeiten und Abwesenheiten ──────────────────────────────────────────────

const weekMinutes = z.tuple([
  z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440),
]);

export const targetHoursEntry = z.object({ validFrom: isoDate, minutesByWeekday: weekMinutes });
export const targetHoursResponse = z.object({ schedule: z.array(targetHoursEntry) });
export const targetHoursUpdate = targetHoursEntry;

export const absenceSchema = z.object({
  date: isoDate,
  kind: z.enum(ABSENCE_KINDS),
  minutes: z.number().int().min(0).max(1440),
  note: z.string().max(500).optional(),
});
export const absencesQuery = z.object({ from: isoDate, to: isoDate });
export const absencesResponse = z.object({ absences: z.array(absenceSchema) });
export const absencesUpdate = z
  .object({ from: isoDate, to: isoDate, absences: z.array(absenceSchema).max(400) })
  .refine((b) => b.absences.every((a) => a.date >= b.from && a.date <= b.to), {
    message: 'Abwesenheiten müssen im Zeitraum liegen',
    path: ['absences'],
  });

export const holidaysQuery = z.object({ year: z.coerce.number().int().min(1990).max(2100) });
export const holidaysResponse = z.object({
  state: z.enum(GERMAN_STATES),
  holidays: z.array(z.object({ date: isoDate, name: z.string() })),
});

// ── Rückfragen und Wochenrückblick (Push) ─────────────────────────────────────

export const PROMPT_KINDS = ['end_confirm', 'end_missing', 'week_review'] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

const weekId = z.string().regex(/^\d{4}-W\d{2}$/);

/** Daten einer Rückfrage zum Arbeitsende. Keine Namen oder E-Mails, nur Zeiten. */
export const endPromptPayload = z.object({
  sessionId: z.string().min(1).max(200),
  /** Tag (Zeitzone der Sitzung), an dem die Sitzung endet bzw. zuletzt aktiv war */
  date: isoDate,
  /** Erkanntes Ende bzw. letzte Aktivität (UTC); fehlt, wenn unbekannt */
  end: isoDateTime.optional(),
  tz: z.string(),
  endSource: z.string().max(40).optional(),
});
export type EndPromptPayload = z.infer<typeof endPromptPayload>;

export const weekPromptPayload = z.object({
  week: weekId,
  from: isoDate,
  to: isoDate,
  netMinutes: z.number().int(),
  balanceMinutes: z.number().int(),
  openDays: z.number().int().min(0),
  legalHints: z.number().int().min(0),
});
export type WeekPromptPayload = z.infer<typeof weekPromptPayload>;

const promptBase = { ref: z.string(), createdAt: isoDateTime };
export const promptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('end_confirm'), ...promptBase, payload: endPromptPayload }),
  z.object({ kind: z.literal('end_missing'), ...promptBase, payload: endPromptPayload }),
  z.object({ kind: z.literal('week_review'), ...promptBase, payload: weekPromptPayload }),
]);
export type Prompt = z.infer<typeof promptSchema>;
export const promptsResponse = z.object({ prompts: z.array(promptSchema) });
export const promptDismissRequest = z.object({
  kind: z.enum(PROMPT_KINDS),
  ref: z.string().min(1).max(200),
});

/**
 * Daten, die mit der Push-Nachricht auf das Gerät gehen (Android: `data.body`, iOS: `body`).
 * Nur Kennungen, Datum und Uhrzeit – die App prüft sie mit diesem Schema.
 */
export const pushData = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('end_confirm'),
    sessionId: z.string().min(1).max(200),
    date: isoDate,
  }),
  z.object({
    kind: z.literal('end_missing'),
    sessionId: z.string().min(1).max(200),
    date: isoDate,
    end: isoDateTime.optional(),
  }),
  z.object({ kind: z.literal('week_review'), week: weekId, date: isoDate }),
]);
export type PushData = z.infer<typeof pushData>;

/** Benachrichtigungskategorien (iOS UNNotificationCategory, Android-Aktionen) und ihre Aktionen. */
export const PUSH_CATEGORIES = {
  end_confirm: 'timelog.end_confirm',
  end_missing: 'timelog.end_missing',
  week_review: 'timelog.week_review',
} as const satisfies Record<PromptKind, string>;
export const PUSH_ACTIONS = { confirm: 'confirm', correct: 'correct', open: 'open' } as const;

// ── Export, Datenauskunft, Löschung ───────────────────────────────────────────

export const exportQuery = z
  .object({ from: isoDate, to: isoDate, format: z.enum(['csv', 'pdf']).default('csv') })
  .refine((q) => q.from <= q.to, { message: 'from muss vor to liegen', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 400, {
    message: 'Höchstens 400 Tage',
    path: ['to'],
  });

export const deleteAccountRequest = z.object({ password: z.string().min(1).max(200) });
export const deleteAccountResponse = z.object({ mode: z.enum(['deleted', 'anonymized']) });
