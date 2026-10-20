// Datenbankschema laut docs/IMPLEMENTATION.md. Row-Level-Security steht in der Migration 0001_rls.sql.
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => tstz('created_at').notNull().defaultNow();

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  plan: text('plan', { enum: ['private', 'company'] })
    .notNull()
    .default('private'),
  rulesConfig: jsonb('rules_config').notNull().default({}),
  rulesConfigVersion: integer('rules_config_version').notNull().default(1),
  retentionYears: integer('retention_years').notNull().default(2),
  fingerprintSalt: text('fingerprint_salt')
    .notNull()
    .default(sql`encode(sha256(gen_random_uuid()::text::bytea), 'hex')`),
  /** Kurzname für die SSO-Anmeldung (z. B. „acme“). */
  slug: text('slug').unique(),
  /** SSO-Einstellungen (OIDC/SAML); Secrets nur als Name einer Umgebungsvariable. */
  sso: jsonb('sso').notNull().default({}),
  createdAt: createdAt(),
});

export const teams = pgTable('teams', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  managerId: uuid('manager_id'),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id),
    email: text('email').notNull(),
    emailVerifiedAt: tstz('email_verified_at'),
    passwordHash: text('password_hash').notNull(),
    totpSecret: text('totp_secret'), // verschlüsselt (AES-256-GCM); gesetzt = TOTP aktiv
    totpPendingSecret: text('totp_pending_secret'),
    totpLastStep: integer('totp_last_step'),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('Europe/Berlin'),
    state: text('state').notNull().default('BE'),
    role: text('role', { enum: ['user', 'manager', 'admin'] })
      .notNull()
      .default('user'),
    teamId: uuid('team_id').references(() => teams.id),
    settings: jsonb('settings').notNull().default({}),
    createdAt: createdAt(),
    deletedAt: tstz('deleted_at'),
    /** Von der Organisation deaktiviert: keine Anmeldung mehr, Daten bleiben bis zur Löschfrist. */
    deactivatedAt: tstz('deactivated_at'),
    /** Unveränderliche Kennung beim IdP (Issuer|Subject), nach der ersten SSO-Anmeldung gesetzt. */
    ssoSubject: text('sso_subject'),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const targetHours = pgTable(
  'target_hours',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    weekday: smallint('weekday').notNull(),
    minutes: integer('minutes').notNull(),
    validFrom: date('valid_from').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.weekday, t.validFrom] })],
);

export const absences = pgTable(
  'absences',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    date: date('date').notNull(),
    kind: text('kind', { enum: ['vacation', 'sick', 'holiday', 'other'] }).notNull(),
    minutes: integer('minutes').notNull(),
    note: text('note'),
  },
  (t) => [index('absences_user_date').on(t.userId, t.date)],
);

export const holidays = pgTable(
  'holidays',
  {
    state: text('state').notNull(),
    date: date('date').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.state, t.date] })],
);

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['desktop', 'mobile'] }).notNull(),
    os: text('os').notNull(),
    name: text('name').notNull(),
    pushToken: text('push_token'),
    lastSeenAt: tstz('last_seen_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('devices_user').on(t.userId)],
);

export const workNetworks = pgTable('work_networks', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  orgId: uuid('org_id').references(() => organizations.id),
  label: text('label').notNull(),
  kind: text('kind', { enum: ['ssid', 'fingerprint', 'geofence'] }).notNull(),
  ssid: text('ssid'),
  bssidHmac: text('bssid_hmac'),
  fingerprintHmac: text('fingerprint_hmac'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  radius: integer('radius'),
});

export const events = pgTable(
  'events',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    id: uuid('id').notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    type: text('type').notNull(),
    source: text('source').notNull(),
    ts: tstz('ts').notNull(),
    endTs: tstz('end_ts'),
    tz: text('tz').notNull(),
    networkId: uuid('network_id'),
    refEventId: text('ref_event_id'),
    createdAt: tstz('created_at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    flags: text('flags').array(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('events_user_ts').on(t.userId, t.ts),
    index('events_user_seq').on(t.userId, t.seq),
  ],
);

export const presenceSpans = pgTable(
  'presence_spans',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    id: uuid('id').notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    start: tstz('start').notNull(),
    end: tstz('end').notNull(),
    open: boolean('open').notNull(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('presence_user_start').on(t.userId, t.start),
    index('presence_user_seq').on(t.userId, t.seq),
  ],
);

export const workDays = pgTable(
  'work_days',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    date: date('date').notNull(),
    sessions: jsonb('sessions').notNull(),
    workMin: integer('work_min').notNull(),
    netMin: integer('net_min').notNull(),
    pendingMin: integer('pending_min').notNull(),
    absenceMin: integer('absence_min').notNull(),
    targetMin: integer('target_min').notNull(),
    status: text('status').notNull(),
    corrected: boolean('corrected').notNull(),
    warnings: jsonb('warnings').notNull(),
    rulesConfigVersion: integer('rules_config_version').notNull(),
    computedAt: tstz('computed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
);

export const corrections = pgTable('corrections', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  date: date('date').notNull(),
  eventId: uuid('event_id').notNull(),
  field: text('field').notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  reason: text('reason'),
  authorId: uuid('author_id').notNull(),
  createdAt: createdAt(),
});

export const approvals = pgTable(
  'approvals',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    month: text('month').notNull(),
    status: text('status', { enum: ['submitted', 'approved', 'rejected'] }).notNull(),
    submittedAt: tstz('submitted_at'),
    snapshot: jsonb('snapshot'),
    rulesConfigVersion: integer('rules_config_version'),
    approverId: uuid('approver_id'),
    comment: text('comment'),
    decidedAt: tstz('decided_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] })],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    /** Familie stammt aus einer SSO-Anmeldung (ersetzt TOTP für Manager und Admins). */
    sso: boolean('sso').notNull().default(false),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash').on(t.tokenHash),
    index('refresh_tokens_family').on(t.familyId),
  ],
);

/** Einmal-Tokens für E-Mail-Bestätigung, Passwort-Reset und SSO-Anmeldecode (nur Hash gespeichert). */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    purpose: text('purpose', { enum: ['verify_email', 'password_reset', 'sso_login'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('auth_tokens_hash').on(t.tokenHash)],
);

export const auditLog = pgTable('audit_log', {
  id: id(),
  orgId: uuid('org_id').references(() => organizations.id),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  target: text('target'),
  payload: jsonb('payload'),
  createdAt: createdAt(),
});

/** Einladungen in eine Organisation (nur Hash des Tokens gespeichert). */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    email: text('email').notNull(),
    role: text('role', { enum: ['user', 'manager', 'admin'] }).notNull(),
    teamId: uuid('team_id').references(() => teams.id),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invitations_hash').on(t.tokenHash), index('invitations_org').on(t.orgId)],
);

/** Offene SSO-Anfragen (OIDC: state mit PKCE-Verifier und Nonce; SAML: AuthnRequest-ID). */
export const ssoRequests = pgTable('sso_requests', {
  id: text('id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id),
  kind: text('kind', { enum: ['oidc', 'saml'] }).notNull(),
  codeVerifier: text('code_verifier'),
  nonce: text('nonce'),
  redirect: text('redirect').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  createdAt: createdAt(),
});
