// Zod-Schemas für Urlaubs- und Überstundenkonto, Anträge, Teamkalender und Lohn-Export.
import { MAX_LEAVE_RANGE_DAYS } from '@timelog/rules';
import { z } from 'zod';
import { monthSchema } from './org.js';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const comment = z.string().trim().min(1).max(1000);
/** Tage in halben Schritten. */
const halfDays = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((d) => Number.isInteger(d * 2), 'Nur ganze oder halbe Tage');

export const LEAVE_KINDS = ['vacation', 'overtime'] as const;
export const leaveKind = z.enum(LEAVE_KINDS);
export type LeaveKindValue = z.infer<typeof leaveKind>;

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const leaveStatus = z.enum(LEAVE_STATUSES);
export type LeaveStatus = z.infer<typeof leaveStatus>;

// ── Anträge ───────────────────────────────────────────────────────────────────

export const leaveRequestInput = z
  .object({
    kind: leaveKind,
    from: isoDate,
    to: isoDate,
    halfDayStart: z.boolean().default(false),
    halfDayEnd: z.boolean().default(false),
    note: z.string().trim().max(500).optional(),
  })
  .refine((r) => r.from <= r.to, { message: 'from muss vor to liegen', path: ['to'] })
  .refine(
    (r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < MAX_LEAVE_RANGE_DAYS,
    { message: `Höchstens ${String(MAX_LEAVE_RANGE_DAYS)} Tage`, path: ['to'] },
  );
export type LeaveRequestInput = z.input<typeof leaveRequestInput>;

export const leaveHistoryEntry = z.object({
  action: z.enum(['request', 'approve', 'reject', 'cancel']),
  at: isoDateTime,
  actorName: z.string().optional(),
  comment: z.string().optional(),
});

export const leaveRequestSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string().optional(),
  kind: leaveKind,
  from: isoDate,
  to: isoDate,
  halfDayStart: z.boolean(),
  halfDayEnd: z.boolean(),
  /** Arbeitstage (halbe Tage möglich). */
  days: z.number(),
  /** Sollzeit der Tage in Minuten (Urlaub: Gutschrift; Überstundenabbau: Abbau). */
  minutes: z.number().int(),
  note: z.string().optional(),
  status: leaveStatus,
  createdAt: isoDateTime,
  decidedAt: isoDateTime.optional(),
  decisionComment: z.string().optional(),
  cancelledAt: isoDateTime.optional(),
  history: z.array(leaveHistoryEntry),
});
export type LeaveRequest = z.infer<typeof leaveRequestSchema>;

export const leaveRequestParams = z.object({ id: z.uuid() });
export const leaveDecisionRequest = z.object({ comment: comment.optional() });
export const leaveRejectRequest = z.object({ comment });
export const leaveCancelRequest = z.object({ comment: comment.optional() });
export const leaveCancelAdminRequest = z.object({ comment });

// ── Konto ─────────────────────────────────────────────────────────────────────

export const vacationAccountSchema = z.object({
  year: z.number().int(),
  entitlement: z.number(),
  correction: z.number(),
  carryOver: z.number(),
  carryOverManual: z.boolean(),
  carryOverUsed: z.number(),
  carryOverForfeited: z.number(),
  carryOverExpiry: isoDate,
  taken: z.number(),
  planned: z.number(),
  pending: z.number(),
  remaining: z.number(),
  remainingAfterPending: z.number(),
});
export type VacationAccountView = z.infer<typeof vacationAccountSchema>;

const monthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Stichtag als MM-TT');

/** Org-Einstellungen (Firma) bzw. Standard (privat). */
export const leaveSettingsSchema = z.object({
  defaultAnnualDays: halfDays(0, 60).default(30),
  standardWorkdaysPerWeek: z.number().min(1).max(7).default(5),
  carryOverExpiry: monthDay.default('03-31'),
  /** Verfall aktiv; nach BAG nur nach rechtzeitigem Hinweis des Arbeitgebers (keine Rechtsberatung). */
  carryOverExpires: z.boolean().default(true),
  /** Optionaler Höchstsaldo des Überstundenkontos (Minuten), darüber Warnung. */
  maxOvertimeMinutes: z.number().int().min(0).max(100_000).optional(),
});
export type LeaveSettings = z.infer<typeof leaveSettingsSchema>;
export const leaveSettingsUpdate = leaveSettingsSchema.partial().extend({
  maxOvertimeMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
});

export const leaveProfileSchema = z.object({
  /** Jahresanspruch in Tagen; fehlt = Standard der Organisation (privat: 30). */
  annualDays: halfDays(0, 60).optional(),
  workdaysPerWeek: z.number().min(0).max(7).optional(),
  entryDate: isoDate.optional(),
  exitDate: isoDate.optional(),
});
export type LeaveProfile = z.infer<typeof leaveProfileSchema>;
export const leaveProfileUpdate = z.object({
  annualDays: halfDays(0, 60).nullable().optional(),
  workdaysPerWeek: z.number().min(0).max(7).nullable().optional(),
  entryDate: isoDate.nullable().optional(),
  exitDate: isoDate.nullable().optional(),
});

export const leaveAdjustmentInput = z.object({
  year: z.number().int().min(2000).max(2100),
  /** carry_over: Übertrag aus dem Vorjahr manuell setzen (überschreibt Automatik); correction: +/− Tage. */
  kind: z.enum(['carry_over', 'correction']),
  days: halfDays(-100, 100),
  comment,
});
export const leaveAdjustmentSchema = leaveAdjustmentInput.extend({
  id: z.uuid(),
  createdAt: isoDateTime,
  authorName: z.string().optional(),
});

export const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

export const leaveOverviewResponse = z.object({
  year: z.number().int(),
  account: vacationAccountSchema,
  requests: z.array(leaveRequestSchema),
  profile: leaveProfileSchema,
  adjustments: z.array(leaveAdjustmentSchema),
  settings: leaveSettingsSchema,
  /** true = Firmenkonto: Anspruch pflegt der Admin, Anträge genehmigt Manager/Admin. */
  managed: z.boolean(),
});
export type LeaveOverview = z.infer<typeof leaveOverviewResponse>;

// ── Überstundenkonto ──────────────────────────────────────────────────────────

export const OVERTIME_BOOKING_KINDS = ['payout', 'cap', 'correction'] as const;
export const overtimeBookingInput = z.object({
  month: monthSchema,
  /** Negativ = Auszahlung bzw. Kappung. */
  minutes: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .refine((m) => m !== 0, 'Nicht 0'),
  kind: z.enum(OVERTIME_BOOKING_KINDS),
  comment,
});
export type OvertimeBookingInput = z.input<typeof overtimeBookingInput>;
export const overtimeBookingSchema = overtimeBookingInput.extend({
  id: z.uuid(),
  createdAt: isoDateTime,
  authorName: z.string().optional(),
});

export const overtimeMonthSchema = z.object({
  month: monthSchema,
  workMinutes: z.number().int(),
  bookedMinutes: z.number().int(),
  reducedMinutes: z.number().int(),
  balanceMinutes: z.number().int(),
  overMax: z.boolean(),
  /** Monat freigegeben: Werte aus dem Snapshot. */
  approved: z.boolean(),
});
export const overtimeResponse = z.object({
  year: z.number().int(),
  /** Kontostand vor Januar (Vorjahre). */
  startBalanceMinutes: z.number().int(),
  months: z.array(overtimeMonthSchema),
  balanceMinutes: z.number().int(),
  maxBalanceMinutes: z.number().int().optional(),
  overMax: z.boolean(),
  bookings: z.array(overtimeBookingSchema),
});
export type OvertimeView = z.infer<typeof overtimeResponse>;

// ── Firmenansicht ─────────────────────────────────────────────────────────────

export const orgLeaveRequestsQuery = z.object({
  status: leaveStatus.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export const overlapSchema = z.object({ name: z.string(), from: isoDate, to: isoDate });
export const orgLeaveRequestSchema = leaveRequestSchema.extend({
  /** Andere Mitglieder desselben Teams, die im Zeitraum abwesend sind (ohne Art). */
  overlaps: z.array(overlapSchema),
});
export type OrgLeaveRequest = z.infer<typeof orgLeaveRequestSchema>;
export const orgLeaveRequestsResponse = z.object({ requests: z.array(orgLeaveRequestSchema) });

export const calendarQuery = z
  .object({ from: isoDate, to: isoDate, teamId: z.uuid().optional() })
  .refine((q) => q.from <= q.to, { message: 'from muss vor to liegen', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 93, {
    message: 'Höchstens 93 Tage',
    path: ['to'],
  });
/** Teamkalender: nur Name und Zeitraum; Krankheit und Sonstiges erscheinen als „abwesend“. */
export const calendarEntrySchema = z.strictObject({
  userId: z.uuid(),
  name: z.string(),
  from: isoDate,
  to: isoDate,
  kind: z.enum(['vacation', 'overtime', 'absent']),
  pending: z.boolean(),
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;
export const calendarResponse = z.object({ entries: z.array(calendarEntrySchema) });

export const memberLeaveResponse = leaveOverviewResponse.extend({ name: z.string() });

// ── Lohn-Export ───────────────────────────────────────────────────────────────

const wageType = z.string().regex(/^\d{1,4}$/, 'Lohnart: 1–4 Ziffern');
const absenceCode = z
  .string()
  .regex(/^[A-Za-z0-9]{1,3}$/, 'Ausfallschlüssel: 1–3 Buchstaben oder Ziffern');
const wageTypes = z
  .object({
    hours: wageType.optional(),
    vacation: wageType.optional(),
    sick: wageType.optional(),
    overtime: wageType.optional(),
  })
  .prefault({});

export const payrollConfigSchema = z.object({
  datev: z
    .object({
      beraterNr: z
        .string()
        .regex(/^\d{4,7}$/, 'Beraternummer: 4–7 Ziffern')
        .optional(),
      mandantenNr: z
        .string()
        .regex(/^\d{1,5}$/, 'Mandantennummer: 1–5 Ziffern')
        .optional(),
      wageTypes,
      /** LODAS-Kalendarium: Ausfallschlüssel je Art (Mandantenvorgabe). */
      absenceCodes: z
        .object({
          vacation: absenceCode.optional(),
          sick: absenceCode.optional(),
          overtime: absenceCode.optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  lexware: z.object({ wageTypes }).prefault({}),
  personio: z
    .object({
      /** Personio-Genehmigung überspringen (Monat ist in TimeLog bereits freigegeben). */
      skipApproval: z.boolean().default(true),
      matchBy: z.enum(['email', 'personio_id']).default('email'),
    })
    .prefault({}),
});
export type PayrollConfig = z.infer<typeof payrollConfigSchema>;
export const payrollConfigUpdate = payrollConfigSchema;

export const payrollMemberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string().optional(),
  personnelNumber: z.string().optional(),
  personioId: z.string().optional(),
});
export const payrollMembersResponse = z.object({ members: z.array(payrollMemberSchema) });
export const payrollMemberUpdate = z.object({
  personnelNumber: z
    .string()
    .regex(/^[0-9A-Za-z-]{1,19}$/, 'Personalnummer: bis 19 Zeichen')
    .nullable()
    .optional(),
  personioId: z
    .string()
    .regex(/^[0-9A-Za-z-]{1,64}$/)
    .nullable()
    .optional(),
});

export const PAYROLL_FORMATS = ['datev_lodas', 'datev_lug', 'lexware'] as const;
export const payrollExportQuery = z.object({
  month: monthSchema,
  format: z.enum(PAYROLL_FORMATS),
  teamId: z.uuid().optional(),
});

export const personioCredentialsInput = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
});
export const personioStatusResponse = z.object({
  configured: z.boolean(),
  clientId: z.string().optional(),
  updatedAt: isoDateTime.optional(),
});

export const transferMemberResult = z.object({
  userId: z.uuid(),
  name: z.string(),
  status: z.enum(['transferred', 'skipped', 'failed']),
  periods: z.number().int(),
  /** Grund (z. B. „Monat nicht freigegeben“, „keine Personio-Person“), ohne personenbezogene Inhalte. */
  message: z.string().optional(),
});
export const transferSchema = z.object({
  id: z.uuid(),
  month: monthSchema,
  createdAt: isoDateTime,
  actorName: z.string().optional(),
  status: z.enum(['ok', 'partial', 'failed']),
  members: z.array(transferMemberResult),
});
export type PayrollTransfer = z.infer<typeof transferSchema>;
export const personioTransferRequest = z.object({ month: monthSchema });
export const transfersResponse = z.object({ transfers: z.array(transferSchema) });
