// Zod-Schemas für alle API-Grenzen. Backend validiert damit Anfragen, Clients die Antworten.
import {
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
