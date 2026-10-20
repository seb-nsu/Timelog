// Zod-Schemas für Projekte/Tätigkeiten, Kalender-Anbindung und Homeoffice-Nachweis.
import { ABSENCE_KINDS, WORK_LOCATIONS } from '@timelog/rules';
import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const DAY_MS = 86_400_000;

const range = (maxDays: number) =>
  z
    .object({ from: isoDate, to: isoDate })
    .refine((q) => q.from <= q.to, { message: 'from muss vor to liegen', path: ['to'] })
    .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / DAY_MS < maxDays, {
      message: `Höchstens ${String(maxDays)} Tage`,
      path: ['to'],
    });

// ── Projekte ──────────────────────────────────────────────────────────────────

export const projectColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #RRGGBB');
const keyword = z.string().trim().min(2).max(60);
export const MAX_KEYWORDS = 20;

export const projectSchema = z.object({
  id: z.uuid(),
  /** user = eigenes Projekt (Privatkonto), org = Projekt der Organisation */
  scope: z.enum(['user', 'org']),
  /** nur für ein Team sichtbar (Firmenprojekt) */
  teamId: z.uuid().optional(),
  name: z.string(),
  customer: z.string().optional(),
  color: projectColor,
  keywords: z.array(z.string()),
  archived: z.boolean(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectsResponse = z.object({
  /** Projekte sind eingeschaltet (privat: Einstellung, Firma: vom Admin) */
  enabled: z.boolean(),
  /** darf eigene Projekte anlegen (nur Privatkonten; Firmenprojekte verwaltet der Admin) */
  canManage: z.boolean(),
  projects: z.array(projectSchema),
});
export type ProjectsResponse = z.infer<typeof projectsResponse>;

export const projectInput = z.object({
  name: z.string().trim().min(1).max(100),
  customer: z.string().trim().min(1).max(100).optional(),
  color: projectColor.default('#1d4ed8'),
  keywords: z.array(keyword).max(MAX_KEYWORDS).default([]),
});
export const projectUpdate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  customer: z.string().trim().max(100).nullable().optional(),
  color: projectColor.optional(),
  keywords: z.array(keyword).max(MAX_KEYWORDS).optional(),
  archived: z.boolean().optional(),
});
export const orgProjectInput = projectInput.extend({ teamId: z.uuid().optional() });
export const orgProjectUpdate = projectUpdate.extend({ teamId: z.uuid().nullable().optional() });
export const projectParams = z.object({ id: z.uuid() });
export const MAX_PROJECTS = 200;

/** Manuelle Zuordnung eines Zeitabschnitts (überschreibt die Automatik, gesperrt). */
export const projectAssignmentInput = z
  .object({
    from: isoDateTime,
    to: isoDateTime,
    /** null = ausdrücklich keinem Projekt zuordnen */
    projectId: z.uuid().nullable(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((a) => Date.parse(a.to) > Date.parse(a.from), {
    message: 'to muss nach from liegen',
    path: ['to'],
  })
  .refine((a) => Date.parse(a.to) - Date.parse(a.from) <= DAY_MS, {
    message: 'Höchstens 24 Stunden',
    path: ['to'],
  });
export type ProjectAssignmentInput = z.infer<typeof projectAssignmentInput>;

export const projectShareSchema = z.object({
  projectId: z.uuid().nullable(),
  workMinutes: z.number().int(),
  topUpMinutes: z.number().int(),
  netMinutes: z.number().int(),
  manual: z.boolean(),
});
export const dayProjectsSchema = z.object({ date: isoDate, items: z.array(projectShareSchema) });
export type DayProjectsView = z.infer<typeof dayProjectsSchema>;

export const projectSegmentSchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  projectId: z.uuid().nullable(),
  manual: z.boolean(),
});
export const assignmentRecord = z.object({
  id: z.uuid(),
  from: isoDateTime,
  to: isoDateTime,
  projectId: z.uuid().nullable(),
  createdAt: isoDateTime,
});
export const dayProjectsResponse = z.object({
  day: dayProjectsSchema,
  /** Arbeitszeit des Tages, nach Zuordnung zerlegt (für die Auswahl im Tagesprotokoll) */
  segments: z.array(projectSegmentSchema),
  /** eigene manuelle Zuordnungen (unveränderlich, neueste gewinnt) */
  assignments: z.array(assignmentRecord),
  locked: z.boolean(),
});
export type DayProjectsResponse = z.infer<typeof dayProjectsResponse>;

export const projectReportQuery = range(400);
export const projectTotalSchema = z.object({
  projectId: z.uuid().nullable(),
  name: z.string().optional(),
  customer: z.string().optional(),
  workMinutes: z.number().int(),
  topUpMinutes: z.number().int(),
  netMinutes: z.number().int(),
});
export const projectReportResponse = z.object({
  from: isoDate,
  to: isoDate,
  days: z.array(dayProjectsSchema),
  totals: z.array(projectTotalSchema),
  /** Summe je Kunde (ohne Kunde: customer fehlt) */
  customers: z.array(z.object({ customer: z.string().optional(), netMinutes: z.number().int() })),
});
export type ProjectReport = z.infer<typeof projectReportResponse>;
export const projectExportQuery = range(400).and(
  z.object({ format: z.enum(['csv', 'pdf']).default('csv') }),
);

// ── Tagesort / Homeoffice ─────────────────────────────────────────────────────

export const workLocation = z.enum(WORK_LOCATIONS);
export const locationUpdate = z.object({
  /** null = wieder automatisch ermitteln */
  location: workLocation.nullable(),
});
export const dayLocationSchema = z.object({
  date: isoDate,
  location: workLocation.optional(),
  source: z.enum(['auto', 'manual']),
  officeMinutes: z.number().int(),
  homeMinutes: z.number().int(),
});
export type DayLocationView = z.infer<typeof dayLocationSchema>;
export const locationsQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
export const homeOfficeSummarySchema = z.object({
  homeDays: z.number().int(),
  officeDays: z.number().int(),
  otherDays: z.number().int(),
  homeDaysByMonth: z.array(z.number().int()).length(12),
  maxDays: z.number().int(),
  amountCents: z.number().int(),
});
export const allowanceSchema = z.object({
  perDayCents: z.number().int(),
  maxPerYearCents: z.number().int(),
  legalBasis: z.string(),
});
export const locationsResponse = z.object({
  year: z.number().int(),
  days: z.array(dayLocationSchema),
  summary: homeOfficeSummarySchema,
  allowance: allowanceSchema,
});
export type LocationsResponse = z.infer<typeof locationsResponse>;
export const locationsExportQuery = locationsQuery.extend({
  format: z.enum(['csv', 'pdf']).default('csv'),
});

// ── Kalender ──────────────────────────────────────────────────────────────────

export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const;
export const calendarProvider = z.enum(CALENDAR_PROVIDERS);
export type CalendarProviderId = z.infer<typeof calendarProvider>;
export const calendarProviderParams = z.object({ provider: calendarProvider });

export const calendarConnectionSchema = z.object({
  provider: calendarProvider,
  status: z.enum(['active', 'error']),
  lastSyncAt: isoDateTime.optional(),
  /** Fehlercode ohne personenbezogene Inhalte, z. B. invalid_grant */
  lastError: z.string().optional(),
  entries: z.number().int(),
});
export const calendarStatusResponse = z.object({
  /** Firmenkonten: vom Admin erlaubt */
  allowed: z.boolean(),
  providers: z.array(z.object({ provider: calendarProvider, configured: z.boolean() })),
  connections: z.array(calendarConnectionSchema),
});
export type CalendarStatus = z.infer<typeof calendarStatusResponse>;
export const calendarConnectRequest = z.object({
  /** Rücksprung nach der Anmeldung (nur erlaubte Ursprünge); ohne Angabe eine Bestätigungsseite */
  redirect: z.url().optional(),
});
export const calendarConnectResponse = z.object({ url: z.url() });
export const calendarCallbackQuery = z.object({
  state: z.string().min(16).max(200),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(200).optional(),
});
export const calendarSyncResponse = z.object({ entries: z.number().int() });

export const suggestionsQuery = range(93);
export const gapSuggestionSchema = z.object({
  date: isoDate,
  sessionId: z.string(),
  from: isoDateTime,
  to: isoDateTime,
  kind: z.enum(['break', 'gap']),
});
export const absenceSuggestionSchema = z.object({
  date: isoDate,
  kind: z.enum(ABSENCE_KINDS),
});
export const suggestionsResponse = z.object({
  gaps: z.array(gapSuggestionSchema),
  absences: z.array(absenceSuggestionSchema),
});
export type Suggestions = z.infer<typeof suggestionsResponse>;

// ── Firmenversion ─────────────────────────────────────────────────────────────

/** Schalter der Organisation (Admin). */
export const orgFeatures = z.object({
  projects: z.boolean().default(false),
  calendar: z.boolean().default(true),
  /** Admin sieht die Anzahl der Homeoffice-Tage je Monat (keine Tagesdetails) */
  homeOfficeReport: z.boolean().default(false),
});
export type OrgFeatures = z.infer<typeof orgFeatures>;
/** Teil-Update ohne Standardwerte (sonst würden nicht genannte Schalter zurückgesetzt). */
export const orgFeaturesUpdate = z.object({
  projects: z.boolean().optional(),
  calendar: z.boolean().optional(),
  homeOfficeReport: z.boolean().optional(),
});
export const orgHomeOfficeQuery = locationsQuery;
export const orgHomeOfficeResponse = z.object({
  year: z.number().int(),
  members: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      homeDaysByMonth: z.array(z.number().int()).length(12),
    }),
  ),
});
