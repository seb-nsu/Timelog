// Firmenversion: Organisation, Einstellungen, Mitglieder, Teams, Einladungen, Firmen-Netze, Audit-Log.
import { DEFAULT_RULES_CONFIG } from '@timelog/rules';
import {
  ORG_RULES_KEYS,
  auditQuery,
  auditResponse,
  invitationSchema,
  invitationsResponse,
  inviteRequest,
  memberParams,
  memberSchema,
  memberUpdate,
  membersResponse,
  networkInput,
  networkParams,
  networkResponse,
  networksResponse,
  okResponse,
  orgConfigResponse,
  orgConfigUpdate,
  orgMeResponse,
  orgRulesConfig,
  ssoConfig,
  teamInput,
  teamParams,
  teamSchema,
  teamUpdate,
  teamsResponse,
} from '@timelog/shared';
import { and, count, desc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type App, type AppContext, HttpError } from '../../app.js';
import { type Tx, asSystem, withMember, withUser } from '../../db/index.js';
import {
  auditLog,
  devices,
  invitations,
  organizations,
  refreshTokens,
  teams,
  users,
  workNetworks,
} from '../../db/schema.js';
import { randomToken, sha256 } from '../../security/crypto.js';
import { networkHmac, networkKey } from '../profile.js';
import { assertOrgProject } from './extras.js';
import {
  ADMINS,
  type Actor,
  MEMBERS,
  actorOf,
  actorScope,
  audit,
  canSee,
  loadMember,
} from './access.js';

const security = [{ bearer: [] }];
const INVITE_TTL_MS = 7 * 86_400_000;

type OrgRow = typeof organizations.$inferSelect;
type UserRow = typeof users.$inferSelect;

export function parseSso(raw: unknown): z.infer<typeof ssoConfig> {
  const parsed = ssoConfig.safeParse(raw);
  return parsed.success ? parsed.data : ssoConfig.parse({});
}

async function loadOrg(tx: Tx, orgId: string): Promise<OrgRow> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new HttpError(404, 'not_found');
  return org;
}

function toConfig(org: OrgRow): z.infer<typeof orgConfigResponse> {
  const rules = orgRulesConfig.safeParse(org.rulesConfig);
  return {
    name: org.name,
    ...(org.slug ? { slug: org.slug } : {}),
    retentionYears: org.retentionYears,
    rules: rules.success ? rules.data : {},
    ruleDefaults: Object.fromEntries(ORG_RULES_KEYS.map((k) => [k, DEFAULT_RULES_CONFIG[k]])),
    rulesConfigVersion: org.rulesConfigVersion,
    sso: parseSso(org.sso),
  };
}

function toMember(actor: Actor, u: UserRow): z.infer<typeof memberSchema> {
  const base = { id: u.id, name: u.name, ...(u.teamId ? { teamId: u.teamId } : {}) };
  if (actor.role !== 'admin') return base;
  return {
    ...base,
    email: u.email,
    role: u.role,
    active: u.deactivatedAt === null,
    totpEnabled: u.totpSecret !== null,
  };
}

function toInvitation(r: typeof invitations.$inferSelect): z.infer<typeof invitationSchema> {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    ...(r.teamId ? { teamId: r.teamId } : {}),
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

function orgNetworkKey(ctx: AppContext, org: OrgRow): Buffer {
  return networkKey(ctx.networkSecret, `org:${org.id}:${org.fingerprintSalt}`);
}

async function assertTeamInOrg(tx: Tx, orgId: string, teamId: string): Promise<void> {
  const [team] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)));
  if (!team) throw new HttpError(400, 'invalid_team');
}

async function assertManagerCandidate(tx: Tx, orgId: string, userId: string): Promise<void> {
  const [u] = await tx
    .select({ role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId), isNull(users.deactivatedAt)));
  if (!u || u.role === 'user') throw new HttpError(400, 'invalid_manager');
}

export function orgManageRoutes(app: App, ctx: AppContext): void {
  const tags = ['org'];

  // ── Eigene Rolle und Organisation ───────────────────────────────────────────
  app.get(
    '/me',
    {
      config: { roles: MEMBERS },
      schema: { tags, security, response: { 200: orgMeResponse } },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const org = await loadOrg(tx, actor.orgId);
        const [u] = await tx.select().from(users).where(eq(users.id, actor.id));
        if (!u) throw new HttpError(403, 'not_a_member');
        return {
          user: {
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            ...(u.teamId ? { teamId: u.teamId } : {}),
          },
          org: {
            id: org.id,
            name: org.name,
            ...(org.slug ? { slug: org.slug } : {}),
            plan: org.plan,
          },
          managedTeamIds: actor.managedTeamIds,
        };
      });
    },
  );

  // ── Einstellungen: Regelwerk-Parameter, Aufbewahrung, SSO ───────────────────
  app.get(
    '/config',
    {
      config: { roles: ADMINS },
      schema: { tags, security, response: { 200: orgConfigResponse } },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) =>
        toConfig(await loadOrg(tx, actor.orgId)),
      );
    },
  );

  app.put(
    '/config',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Regelwerk-Parameter (z. B. shutdownBonusMin, standbyBreakMin), Aufbewahrungsfrist und SSO. Änderungen am Regelwerk erhöhen rules_config_version und wirken nur auf nicht freigegebene Monate.',
        body: orgConfigUpdate,
        response: { 200: orgConfigResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body;
      if (
        body.sso?.oidc &&
        !ctx.sso.allowInsecure &&
        !body.sso.oidc.issuer.startsWith('https://')
      ) {
        throw new HttpError(400, 'issuer_must_be_https');
      }
      if (body.slug) {
        const taken = await asSystem(ctx.db, (tx) =>
          tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(and(eq(organizations.slug, body.slug ?? ''), ne(organizations.id, actor.orgId))),
        );
        if (taken.length > 0) throw new HttpError(409, 'slug_taken');
      }
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const org = await loadOrg(tx, actor.orgId);
        const rulesChanged =
          body.rules !== undefined &&
          JSON.stringify(body.rules) !== JSON.stringify(toConfig(org).rules);
        const [updated] = await tx
          .update(organizations)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.slug !== undefined ? { slug: body.slug } : {}),
            ...(body.retentionYears !== undefined ? { retentionYears: body.retentionYears } : {}),
            ...(body.rules !== undefined ? { rulesConfig: body.rules } : {}),
            ...(rulesChanged ? { rulesConfigVersion: org.rulesConfigVersion + 1 } : {}),
            ...(body.sso !== undefined ? { sso: body.sso } : {}),
          })
          .where(eq(organizations.id, actor.orgId))
          .returning();
        if (!updated) throw new HttpError(404, 'not_found');
        await audit(tx, actor, 'config.update', actor.orgId, {
          fields: Object.keys(body).sort(),
          ...(body.rules !== undefined ? { rules: body.rules } : {}),
          ...(body.retentionYears !== undefined ? { retentionYears: body.retentionYears } : {}),
          ...(rulesChanged ? { rulesConfigVersion: updated.rulesConfigVersion } : {}),
        });
        return toConfig(updated);
      });
    },
  );

  // ── Mitglieder ──────────────────────────────────────────────────────────────
  app.get(
    '/members',
    {
      schema: {
        tags,
        security,
        description:
          'Admin: alle Mitglieder mit E-Mail und Rolle. Manager: nur Name und Team der Mitglieder eigener Teams.',
        response: { 200: membersResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const rows = await withUser(ctx.db, actorScope(actor), (tx) =>
        tx
          .select()
          .from(users)
          .where(and(eq(users.orgId, actor.orgId), isNull(users.deletedAt)))
          .orderBy(users.name),
      );
      return { members: rows.filter((u) => canSee(actor, u)).map((u) => toMember(actor, u)) };
    },
  );

  app.patch(
    '/members/:id',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description: 'Rolle und Team eines Mitglieds ändern.',
        params: memberParams,
        body: memberUpdate,
        response: { 200: memberSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { role, teamId } = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const member = await loadMember(tx, actor, request.params.id);
        if (teamId) await assertTeamInOrg(tx, actor.orgId, teamId);
        if (role !== undefined && role !== 'admin' && member.role === 'admin') {
          const [admins] = await tx
            .select({ n: count() })
            .from(users)
            .where(
              and(
                eq(users.orgId, actor.orgId),
                eq(users.role, 'admin'),
                isNull(users.deactivatedAt),
                isNull(users.deletedAt),
              ),
            );
          if ((admins?.n ?? 0) <= 1) throw new HttpError(409, 'last_admin');
        }
        const [updated] = await tx
          .update(users)
          .set({
            ...(role !== undefined ? { role } : {}),
            ...(teamId !== undefined ? { teamId } : {}),
          })
          .where(eq(users.id, member.id))
          .returning();
        if (!updated) throw new HttpError(404, 'not_found');
        if (role === 'user') {
          // Wer nicht mehr Manager ist, leitet auch kein Team mehr.
          await tx.update(teams).set({ managerId: null }).where(eq(teams.managerId, member.id));
        }
        await audit(tx, actor, 'member.update', member.id, {
          ...(role !== undefined ? { role, previousRole: member.role } : {}),
          ...(teamId !== undefined ? { teamId } : {}),
        });
        return toMember(actor, updated);
      });
    },
  );

  app.post(
    '/members/:id/deactivate',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Deaktiviert ein Mitglied: Anmeldung und Geräte gesperrt. Die Daten bleiben bis zum Ende der Aufbewahrungsfrist.',
        params: memberParams,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      if (request.params.id === actor.id) throw new HttpError(409, 'cannot_deactivate_self');
      await withUser(ctx.db, actorScope(actor), (tx) => loadMember(tx, actor, request.params.id));
      const now = new Date(ctx.now());
      await withMember(ctx.db, actorScope(actor), request.params.id, async (tx) => {
        await tx
          .update(users)
          .set({ deactivatedAt: now, role: 'user' })
          .where(eq(users.id, request.params.id));
        await tx
          .update(teams)
          .set({ managerId: null })
          .where(eq(teams.managerId, request.params.id));
        await tx
          .update(devices)
          .set({ revokedAt: now })
          .where(and(eq(devices.userId, request.params.id), isNull(devices.revokedAt)));
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(refreshTokens.userId, request.params.id), isNull(refreshTokens.revokedAt)));
        await audit(tx, actor, 'member.deactivate', request.params.id);
      });
      return { ok: true as const };
    },
  );

  // ── Teams ───────────────────────────────────────────────────────────────────
  const listTeams = async (tx: Tx, actor: Actor) => {
    const rows = await tx
      .select({
        id: teams.id,
        name: teams.name,
        managerId: teams.managerId,
        memberCount: sql<number>`(select count(*)::int from users u where u.team_id = ${teams.id} and u.deleted_at is null and u.deactivated_at is null)`,
      })
      .from(teams)
      .where(eq(teams.orgId, actor.orgId))
      .orderBy(teams.name);
    return rows
      .filter((t) => actor.role === 'admin' || actor.managedTeamIds.includes(t.id))
      .map((t): z.infer<typeof teamSchema> => ({
        id: t.id,
        name: t.name,
        ...(t.managerId ? { managerId: t.managerId } : {}),
        memberCount: t.memberCount,
      }));
  };

  app.get(
    '/teams',
    {
      schema: {
        tags,
        security,
        description: 'Admin: alle Teams. Manager: die eigenen Teams.',
        response: { 200: teamsResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return { teams: await withUser(ctx.db, actorScope(actor), (tx) => listTeams(tx, actor)) };
    },
  );

  app.post(
    '/teams',
    {
      config: { roles: ADMINS },
      schema: { tags, security, body: teamInput, response: { 200: teamSchema } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { name, managerId } = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        if (managerId) await assertManagerCandidate(tx, actor.orgId, managerId);
        const [team] = await tx
          .insert(teams)
          .values({ orgId: actor.orgId, name, managerId: managerId ?? null })
          .returning();
        if (!team) throw new HttpError(500, 'insert_failed');
        await audit(tx, actor, 'team.create', team.id, { name, managerId: managerId ?? null });
        return {
          id: team.id,
          name: team.name,
          ...(team.managerId ? { managerId: team.managerId } : {}),
          memberCount: 0,
        };
      });
    },
  );

  app.patch(
    '/teams/:id',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        params: teamParams,
        body: teamUpdate,
        response: { 200: teamSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { name, managerId } = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        if (managerId) await assertManagerCandidate(tx, actor.orgId, managerId);
        const updated = await tx
          .update(teams)
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(managerId !== undefined ? { managerId } : {}),
          })
          .where(and(eq(teams.id, request.params.id), eq(teams.orgId, actor.orgId)))
          .returning({ id: teams.id });
        if (updated.length === 0) throw new HttpError(404, 'not_found');
        await audit(tx, actor, 'team.update', request.params.id, {
          ...(name !== undefined ? { name } : {}),
          ...(managerId !== undefined ? { managerId } : {}),
        });
        const team = (await listTeams(tx, actor)).find((t) => t.id === request.params.id);
        if (!team) throw new HttpError(404, 'not_found');
        return team;
      });
    },
  );

  app.delete(
    '/teams/:id',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description: 'Löscht ein Team; seine Mitglieder sind danach keinem Team zugeordnet.',
        params: teamParams,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await withUser(ctx.db, actorScope(actor), async (tx) => {
        const [team] = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(and(eq(teams.id, request.params.id), eq(teams.orgId, actor.orgId)));
        if (!team) throw new HttpError(404, 'not_found');
        await tx
          .update(users)
          .set({ teamId: null })
          .where(and(eq(users.orgId, actor.orgId), eq(users.teamId, team.id)));
        await tx.update(invitations).set({ teamId: null }).where(eq(invitations.teamId, team.id));
        await tx.delete(teams).where(eq(teams.id, team.id));
        await audit(tx, actor, 'team.delete', team.id);
      });
      return { ok: true as const };
    },
  );

  // ── Einladungen ─────────────────────────────────────────────────────────────
  app.post(
    '/invite',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Lädt eine Person per E-Mail ein (Link 7 Tage gültig). Eine frühere offene Einladung an dieselbe Adresse wird ersetzt.',
        body: inviteRequest,
        response: { 200: invitationSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { email, role, teamId } = request.body;
      // Adressen sind global eindeutig; die Prüfung braucht daher den Systemzugriff (nur lesend).
      const existing = await asSystem(ctx.db, (tx) =>
        tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`),
      );
      if (existing.length > 0) throw new HttpError(409, 'email_in_use');
      const token = randomToken();
      const { row, orgName } = await withUser(ctx.db, actorScope(actor), async (tx) => {
        if (teamId) await assertTeamInOrg(tx, actor.orgId, teamId);
        const org = await loadOrg(tx, actor.orgId);
        await tx
          .update(invitations)
          .set({ revokedAt: new Date(ctx.now()) })
          .where(
            and(
              eq(invitations.orgId, actor.orgId),
              eq(invitations.email, email),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          );
        const [inserted] = await tx
          .insert(invitations)
          .values({
            orgId: actor.orgId,
            email,
            role,
            teamId: teamId ?? null,
            tokenHash: sha256(token),
            invitedBy: actor.id,
            expiresAt: new Date(ctx.now() + INVITE_TTL_MS),
          })
          .returning();
        if (!inserted) throw new HttpError(500, 'insert_failed');
        await audit(tx, actor, 'member.invite', inserted.id, { role, teamId: teamId ?? null });
        return { row: inserted, orgName: org.name };
      });
      await ctx.mailer.send({
        to: email,
        subject: `TimeLog: Einladung von ${orgName}`,
        text: `Du wurdest zu ${orgName} eingeladen. Konto anlegen (7 Tage gültig): ${ctx.adminUrl}/invite?token=${token}`,
      });
      return toInvitation(row);
    },
  );

  app.get(
    '/invitations',
    {
      config: { roles: ADMINS },
      schema: { tags, security, response: { 200: invitationsResponse } },
    },
    async (request) => {
      const actor = actorOf(request);
      const rows = await withUser(ctx.db, actorScope(actor), (tx) =>
        tx
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.orgId, actor.orgId),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              sql`${invitations.expiresAt} > ${new Date(ctx.now())}`,
            ),
          )
          .orderBy(desc(invitations.createdAt)),
      );
      return { invitations: rows.map(toInvitation) };
    },
  );

  app.delete(
    '/invitations/:id',
    {
      config: { roles: ADMINS },
      schema: { tags, security, params: memberParams, response: { 200: okResponse } },
    },
    async (request) => {
      const actor = actorOf(request);
      await withUser(ctx.db, actorScope(actor), async (tx) => {
        const revoked = await tx
          .update(invitations)
          .set({ revokedAt: new Date(ctx.now()) })
          .where(
            and(
              eq(invitations.id, request.params.id),
              eq(invitations.orgId, actor.orgId),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (revoked.length === 0) throw new HttpError(404, 'not_found');
        await audit(tx, actor, 'invitation.revoke', request.params.id);
      });
      return { ok: true as const };
    },
  );

  // ── Firmen-Arbeitsnetze ─────────────────────────────────────────────────────
  const toNetwork = (r: typeof workNetworks.$inferSelect): z.infer<typeof networkResponse> => ({
    id: r.id,
    scope: 'org',
    kind: r.kind,
    label: r.label,
    location: r.location,
    ...(r.defaultProjectId ? { defaultProjectId: r.defaultProjectId } : {}),
    ...(r.ssid ? { ssid: r.ssid } : {}),
    ...(r.bssidHmac ? { bssidHmac: r.bssidHmac } : {}),
    ...(r.fingerprintHmac ? { fingerprintHmac: r.fingerprintHmac } : {}),
    ...(r.lat !== null ? { lat: r.lat } : {}),
    ...(r.lng !== null ? { lng: r.lng } : {}),
    ...(r.radius !== null ? { radius: r.radius } : {}),
  });

  app.get(
    '/networks',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description: 'Firmen-Arbeitsnetze; sie gelten automatisch für alle Mitglieder.',
        response: { 200: networksResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const org = await loadOrg(tx, actor.orgId);
        const rows = await tx
          .select()
          .from(workNetworks)
          .where(and(eq(workNetworks.orgId, actor.orgId), isNull(workNetworks.userId)));
        const key = orgNetworkKey(ctx, org);
        return {
          networks: rows.map(toNetwork),
          keys: {
            user: networkKey(ctx.networkSecret, `user:${actor.id}`).toString('base64'),
            org: key.toString('base64'),
          },
        };
      });
    },
  );

  app.post(
    '/networks',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Fügt ein Firmen-Arbeitsnetz hinzu. Netzwerk-Kennung (Standard) und BSSID werden nur als HMAC mit dem Organisationsschlüssel gespeichert.',
        body: networkInput,
        response: { 200: networkResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const n = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const org = await loadOrg(tx, actor.orgId);
        await assertOrgProject(tx, actor.orgId, n.defaultProjectId);
        const key = orgNetworkKey(ctx, org);
        const [row] = await tx
          .insert(workNetworks)
          .values({
            orgId: org.id,
            userId: null,
            label: n.label,
            kind: n.kind,
            ssid: n.kind === 'ssid' ? n.ssid : null,
            bssidHmac: n.kind === 'ssid' && n.bssid ? networkHmac(key, n.bssid) : null,
            fingerprintHmac: n.kind === 'fingerprint' ? networkHmac(key, n.fingerprint) : null,
            lat: n.kind === 'geofence' ? n.lat : null,
            lng: n.kind === 'geofence' ? n.lng : null,
            radius: n.kind === 'geofence' ? n.radius : null,
            location: n.location,
            defaultProjectId: n.defaultProjectId ?? null,
          })
          .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        await audit(tx, actor, 'network.create', row.id, { kind: n.kind, label: n.label });
        return toNetwork(row);
      });
    },
  );

  app.delete(
    '/networks/:id',
    {
      config: { roles: ADMINS },
      schema: { tags, security, params: networkParams, response: { 200: okResponse } },
    },
    async (request) => {
      const actor = actorOf(request);
      await withUser(ctx.db, actorScope(actor), async (tx) => {
        const removed = await tx
          .delete(workNetworks)
          .where(and(eq(workNetworks.id, request.params.id), eq(workNetworks.orgId, actor.orgId)))
          .returning({ id: workNetworks.id });
        if (removed.length === 0) throw new HttpError(404, 'not_found');
        await audit(tx, actor, 'network.delete', request.params.id);
      });
      return { ok: true as const };
    },
  );

  // ── Audit-Log ───────────────────────────────────────────────────────────────
  app.get(
    '/audit',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description: 'Audit-Log der Organisation, neueste zuerst.',
        querystring: auditQuery,
        response: { 200: auditResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { limit, before } = request.query;
      const rows = await withUser(ctx.db, actorScope(actor), (tx) =>
        tx
          .select({ entry: auditLog, actorName: users.name })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.actorId))
          .where(
            and(
              eq(auditLog.orgId, actor.orgId),
              before ? lt(auditLog.createdAt, new Date(before)) : undefined,
            ),
          )
          .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
          .limit(limit + 1),
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        entries: page.map(({ entry, actorName }) => ({
          id: entry.id,
          ...(entry.actorId ? { actorId: entry.actorId } : {}),
          ...(actorName ? { actorName } : {}),
          action: entry.action,
          ...(entry.target ? { target: entry.target } : {}),
          ...(entry.payload !== null ? { payload: entry.payload } : {}),
          createdAt: entry.createdAt.toISOString(),
        })),
        ...(rows.length > limit && last ? { nextBefore: last.entry.createdAt.toISOString() } : {}),
      };
    },
  );
}

/** Mitglieder, die der Akteur sehen darf (für Freigaben und Export). */
export async function visibleMembers(tx: Tx, actor: Actor, teamId?: string): Promise<UserRow[]> {
  const rows = await tx
    .select()
    .from(users)
    .where(
      and(
        eq(users.orgId, actor.orgId),
        isNull(users.deletedAt),
        teamId ? eq(users.teamId, teamId) : undefined,
      ),
    )
    .orderBy(users.name);
  return rows.filter((u) => canSee(actor, u));
}
