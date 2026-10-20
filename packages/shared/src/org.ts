// Zod-Schemas der Firmenversion: Organisation, Rollen, Teams, Einladungen, Freigaben, Audit, SSO.
import { GERMAN_STATES, WARNINGS, type Warning } from '@timelog/rules';
import { z } from 'zod';
import { deviceInfo, timeZone } from './schemas.js';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

export const ROLES = ['user', 'manager', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Monat als JJJJ-MM');

const slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Kleinbuchstaben, Ziffern und Bindestrich');
const orgName = z.string().trim().min(1).max(100);
const comment = z.string().trim().min(1).max(1000);

// ── Regelwerk-Parameter je Organisation ───────────────────────────────────────

/**
 * Was eine Firma einstellen darf. Gesetzliche Schwellen (Pausenregeln, 10 h, 11 h Ruhezeit) sind
 * bewusst nicht einstellbar.
 */
export const orgRulesConfig = z
  .object({
    shutdownBonusMin: z.number().int().min(0).max(30),
    restartWindowMin: z.number().int().min(0).max(120),
    updateRestartWindowMin: z.number().int().min(0).max(240),
    netGraceMin: z.number().int().min(0).max(60),
    standbyBreakMin: z.number().int().min(1).max(120),
    maxStandbyMin: z.number().int().min(15).max(720),
    maxBreakMin: z.number().int().min(15).max(720),
    maxSessionH: z.number().int().min(1).max(24),
  })
  .partial();
export type OrgRulesConfig = z.infer<typeof orgRulesConfig>;
export const ORG_RULES_KEYS = Object.keys(orgRulesConfig.shape) as (keyof OrgRulesConfig)[];

// ── SSO ───────────────────────────────────────────────────────────────────────

/** Secrets stehen nie in der Datenbank, nur der Name der Umgebungsvariable (Präfix SSO_). */
export const ssoSecretEnv = z
  .string()
  .regex(/^SSO_[A-Z0-9_]{1,64}$/, 'Name einer Umgebungsvariable mit Präfix SSO_');

export const oidcConfig = z.object({
  provider: z.enum(['entra', 'google', 'oidc']),
  /** Entra ID: https://login.microsoftonline.com/<tenant-id>/v2.0, Google: https://accounts.google.com */
  issuer: z.url(),
  clientId: z.string().min(1).max(200),
  clientSecretEnv: ssoSecretEnv,
});
export type OidcConfig = z.infer<typeof oidcConfig>;

export const samlConfig = z.object({
  entryPoint: z.url(),
  /** Öffentliches Signaturzertifikat des IdP (PEM oder Base64). */
  idpCert: z.string().min(20).max(20_000),
  idpIssuer: z.string().max(500).optional(),
  /** Attribut mit der E-Mail-Adresse; Standard: NameID bzw. das übliche E-Mail-Claim. */
  emailAttribute: z.string().max(200).optional(),
});
export type SamlConfig = z.infer<typeof samlConfig>;

const domain = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'Domain in Kleinbuchstaben');

export const ssoConfig = z.object({
  oidc: oidcConfig.optional(),
  saml: samlConfig.optional(),
  /** Passwort-Anmeldung für Mitglieder abschalten (Admins behalten Passwort + TOTP als Notzugang). */
  enforced: z.boolean().default(false),
  /** Unbekannte Personen aus erlaubten Domains bei der ersten SSO-Anmeldung als „user“ anlegen. */
  autoProvision: z.boolean().default(false),
  allowedDomains: z.array(domain).max(20).default([]),
});
export type SsoConfig = z.infer<typeof ssoConfig>;

export const ssoMethod = z.enum(['oidc', 'saml']);

export const ssoInfoResponse = z.object({
  orgName: z.string(),
  methods: z.array(ssoMethod),
  provider: z.enum(['entra', 'google', 'oidc']).optional(),
  enforced: z.boolean(),
});
export type SsoInfoResponse = z.infer<typeof ssoInfoResponse>;

export const ssoSlugParams = z.object({ slug });
export const ssoStartQuery = z.object({ method: ssoMethod, redirect: z.url() });
export const ssoCallbackQuery = z.object({
  code: z.string().max(2000).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
});
export const samlAcsBody = z.object({
  SAMLResponse: z.string().min(1).max(500_000),
  RelayState: z.string().max(200).optional(),
});
export const ssoExchangeRequest = z.object({
  code: z.string().min(20).max(200),
  deviceId: z.uuid().optional(),
  device: deviceInfo,
});
export type SsoExchangeRequest = z.input<typeof ssoExchangeRequest>;

// ── Organisation ──────────────────────────────────────────────────────────────

export const createOrgRequest = z.object({ name: orgName, slug });
export const createOrgResponse = z.object({ orgId: z.uuid() });

export const orgMeResponse = z.object({
  user: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: roleSchema,
    teamId: z.uuid().optional(),
  }),
  org: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string().optional(),
    plan: z.enum(['private', 'company']),
  }),
  managedTeamIds: z.array(z.uuid()),
});
export type OrgMeResponse = z.infer<typeof orgMeResponse>;

export const orgConfigResponse = z.object({
  name: z.string(),
  slug: z.string().optional(),
  retentionYears: z.number().int(),
  rules: orgRulesConfig,
  /** Standardwerte der einstellbaren Parameter. */
  ruleDefaults: z.record(z.string(), z.number()),
  rulesConfigVersion: z.number().int(),
  sso: ssoConfig,
});
export type OrgConfigResponse = z.infer<typeof orgConfigResponse>;

export const orgConfigUpdate = z.object({
  name: orgName.optional(),
  slug: slug.optional(),
  /** § 16 Abs. 2 ArbZG: mindestens 2 Jahre; für Lohnunterlagen bis 6 Jahre. */
  retentionYears: z.number().int().min(2).max(6).optional(),
  rules: orgRulesConfig.optional(),
  sso: ssoConfig.optional(),
});
export type OrgConfigUpdate = z.input<typeof orgConfigUpdate>;

// ── Mitglieder und Teams ──────────────────────────────────────────────────────

/** Manager sehen nur Name und Team; E-Mail, Rolle und Sicherheitsstatus nur Admins. */
export const memberSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  teamId: z.uuid().optional(),
  email: z.string().optional(),
  role: roleSchema.optional(),
  active: z.boolean().optional(),
  totpEnabled: z.boolean().optional(),
});
export type Member = z.infer<typeof memberSchema>;
export const membersResponse = z.object({ members: z.array(memberSchema) });
export const memberParams = z.object({ id: z.uuid() });
export const memberUpdate = z
  .object({ role: roleSchema.optional(), teamId: z.uuid().nullable().optional() })
  .refine((b) => b.role !== undefined || b.teamId !== undefined, 'Nichts zu ändern');
export type MemberUpdate = z.input<typeof memberUpdate>;

export const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  managerId: z.uuid().optional(),
  memberCount: z.number().int(),
});
export type Team = z.infer<typeof teamSchema>;
export const teamsResponse = z.object({ teams: z.array(teamSchema) });
export const teamInput = z.object({
  name: z.string().trim().min(1).max(100),
  managerId: z.uuid().nullable().optional(),
});
export const teamUpdate = teamInput.partial();
export const teamParams = z.object({ id: z.uuid() });

// ── Einladungen ───────────────────────────────────────────────────────────────

const email = z
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());

export const inviteRequest = z.object({
  email,
  role: roleSchema.default('user'),
  teamId: z.uuid().optional(),
});
export type InviteRequest = z.input<typeof inviteRequest>;
export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: roleSchema,
  teamId: z.uuid().optional(),
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
});
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationsResponse = z.object({ invitations: z.array(invitationSchema) });

export const inviteInfoQuery = z.object({ token: z.string().min(20).max(200) });
export const inviteInfoResponse = z.object({
  orgName: z.string(),
  email: z.string(),
  role: roleSchema,
});
export const inviteAcceptRequest = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(10, 'Mindestens 10 Zeichen').max(200),
  timezone: timeZone.default('Europe/Berlin'),
  state: z.enum(GERMAN_STATES).default('BE'),
});
export type InviteAcceptRequest = z.input<typeof inviteAcceptRequest>;

// ── Eingeschränkte Tagesansicht und Freigaben ─────────────────────────────────

const warning = z.enum(WARNINGS as [Warning, ...Warning[]]);

/**
 * Was Manager und Admins je Tag sehen: Beginn, Ende, Pausensumme, Auffüllung, Netto, Status,
 * Warnungen – nie Sitzungen, Quellen, Ereignisse oder Geräte.
 */
export const managerDaySchema = z.strictObject({
  date: isoDate,
  start: isoDateTime.optional(),
  end: isoDateTime.optional(),
  breakMinutes: z.number().int(),
  breakTopUpMin: z.number().int(),
  netMinutes: z.number().int(),
  status: z.enum(['open', 'unchecked', 'auto', 'confirmed']),
  warnings: z.array(warning),
});
export type ManagerDay = z.infer<typeof managerDaySchema>;

export const APPROVAL_STATUSES = ['none', 'submitted', 'approved', 'rejected'] as const;
export const approvalSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  teamId: z.uuid().optional(),
  month: monthSchema,
  status: z.enum(APPROVAL_STATUSES),
  submittedAt: isoDateTime.optional(),
  decidedAt: isoDateTime.optional(),
  approverId: z.uuid().optional(),
  comment: z.string().optional(),
});
export type Approval = z.infer<typeof approvalSchema>;
export const approvalsQuery = z.object({
  month: monthSchema,
  status: z.enum(APPROVAL_STATUSES).optional(),
});
export const approvalsResponse = z.object({ approvals: z.array(approvalSchema) });
export const approvalParams = z.object({ userId: z.uuid(), month: monthSchema });
export const approvalDetailResponse = z.object({
  approval: approvalSchema,
  /** Bei freigegebenen Monaten der gespeicherte Snapshot, sonst frisch berechnet. */
  days: z.array(managerDaySchema),
  snapshot: z.boolean(),
  totals: z.object({
    netMinutes: z.number().int(),
    breakTopUpMin: z.number().int(),
    uncheckedDays: z.number().int(),
    openDays: z.number().int(),
  }),
});
export type ApprovalDetail = z.infer<typeof approvalDetailResponse>;
export const approveRequest = z.object({ comment: comment.optional() });
export const rejectRequest = z.object({ comment });

export const memberDaysQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: 'from muss vor to liegen', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 93, {
    message: 'Höchstens 93 Tage',
    path: ['to'],
  });
export const memberDaysResponse = z.object({ days: z.array(managerDaySchema) });
export const memberDateParams = z.object({ id: z.uuid(), date: isoDate });

/** Eigene Monatsfreigaben (Mitglied). */
export const ownApprovalSchema = z.object({
  month: monthSchema,
  status: z.enum(['submitted', 'approved', 'rejected']),
  submittedAt: isoDateTime.optional(),
  decidedAt: isoDateTime.optional(),
  comment: z.string().optional(),
});
export const ownApprovalsResponse = z.object({ approvals: z.array(ownApprovalSchema) });
export const monthParams = z.object({ month: monthSchema });

// ── Export und Audit ──────────────────────────────────────────────────────────

export const orgExportQuery = z.object({
  month: monthSchema,
  format: z.enum(['csv', 'pdf']).default('csv'),
  teamId: z.uuid().optional(),
});

export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: isoDateTime.optional(),
});
export const auditEntrySchema = z.object({
  id: z.uuid(),
  actorId: z.uuid().optional(),
  actorName: z.string().optional(),
  action: z.string(),
  target: z.string().optional(),
  payload: z.unknown().optional(),
  createdAt: isoDateTime,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditResponse = z.object({
  entries: z.array(auditEntrySchema),
  nextBefore: isoDateTime.optional(),
});
