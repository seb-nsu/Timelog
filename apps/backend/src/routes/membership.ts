// Firmenversion aus Sicht des Mitglieds: Organisation anlegen, Monat einreichen, Einladung annehmen.
import { localDate } from '@timelog/rules';
import {
  createOrgRequest,
  createOrgResponse,
  inviteAcceptRequest,
  inviteInfoQuery,
  inviteInfoResponse,
  monthParams,
  okResponse,
  ownApprovalSchema,
  ownApprovalsResponse,
} from '@timelog/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type App, type AppContext, HttpError, limit } from '../app.js';
import { type Tx, asSystem, withUser } from '../db/index.js';
import { approvals, invitations, organizations, users } from '../db/schema.js';
import { sha256 } from '../security/crypto.js';
import { hashPassword } from '../security/password.js';
import { authOf, scopeOf } from './guard.js';
import { audit } from './org/access.js';

const security = [{ bearer: [] }];

function toOwnApproval(r: typeof approvals.$inferSelect): z.infer<typeof ownApprovalSchema> {
  return {
    month: r.month,
    status: r.status,
    ...(r.submittedAt ? { submittedAt: r.submittedAt.toISOString() } : {}),
    ...(r.decidedAt ? { decidedAt: r.decidedAt.toISOString() } : {}),
    ...(r.comment ? { comment: r.comment } : {}),
  };
}

/** Offene, gültige Einladung zum Token (nur im Systemzugriff). */
export async function findInvitation(tx: Tx, token: string, nowMs: number) {
  const [row] = await tx
    .select({ invitation: invitations, orgName: organizations.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(
      and(
        eq(invitations.tokenHash, sha256(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date(nowMs)),
      ),
    );
  return row;
}

/** Offene Einladung für eine Adresse in einer Organisation (SSO-Erstanmeldung). */
export async function findInvitationByEmail(tx: Tx, orgId: string, email: string, nowMs: number) {
  const [row] = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, orgId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date(nowMs)),
      ),
    )
    .orderBy(desc(invitations.createdAt));
  return row;
}

export function membershipRoutes(app: App, ctx: AppContext): void {
  app.post(
    '/orgs',
    {
      schema: {
        tags: ['org'],
        security,
        description:
          'Legt eine Firmen-Organisation an; das eigene Konto wird ihr Admin. Danach Token erneuern (/auth/refresh) und TOTP einrichten.',
        body: createOrgRequest,
        response: { 200: createOrgResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { name, slug } = request.body;
      return asSystem(ctx.db, async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, claims.sub));
        if (!user) throw new HttpError(401, 'unauthorized');
        if (user.orgId) throw new HttpError(409, 'already_member');
        const taken = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, slug));
        if (taken.length > 0) throw new HttpError(409, 'slug_taken');
        const [org] = await tx
          .insert(organizations)
          .values({ name, slug, plan: 'company' })
          .returning({ id: organizations.id });
        if (!org) throw new HttpError(500, 'insert_failed');
        await tx.update(users).set({ orgId: org.id, role: 'admin' }).where(eq(users.id, user.id));
        await audit(tx, { id: user.id, orgId: org.id }, 'org.create', org.id, { slug });
        return { orgId: org.id };
      });
    },
  );

  app.get(
    '/approvals',
    {
      schema: {
        tags: ['approvals'],
        security,
        description: 'Eigene Monatsfreigaben (Firmenkonto).',
        response: { 200: ownApprovalsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const rows = await withUser(ctx.db, scopeOf(claims), (tx) =>
        tx
          .select()
          .from(approvals)
          .where(eq(approvals.userId, claims.sub))
          .orderBy(desc(approvals.month)),
      );
      return { approvals: rows.map(toOwnApproval) };
    },
  );

  app.post(
    '/approvals/:month',
    {
      schema: {
        tags: ['approvals'],
        security,
        description:
          'Reicht einen Monat zur Freigabe ein (auch erneut nach Zurückweisung). Freigegebene Monate sind gesperrt.',
        params: monthParams,
        response: { 200: ownApprovalSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { month } = request.params;
      const now = new Date(ctx.now());
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, claims.sub));
        if (!user?.orgId) throw new HttpError(403, 'no_organization');
        if (month > localDate(ctx.now(), user.timezone).slice(0, 7)) {
          throw new HttpError(400, 'month_in_future');
        }
        const [existing] = await tx
          .select()
          .from(approvals)
          .where(and(eq(approvals.userId, user.id), eq(approvals.month, month)));
        if (existing?.status === 'approved') throw new HttpError(409, 'month_locked');
        if (existing?.status === 'submitted') return toOwnApproval(existing);
        const [row] = existing
          ? await tx
              .update(approvals)
              .set({ status: 'submitted', submittedAt: now })
              .where(and(eq(approvals.userId, user.id), eq(approvals.month, month)))
              .returning()
          : await tx
              .insert(approvals)
              .values({ userId: user.id, month, status: 'submitted', submittedAt: now })
              .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        await audit(
          tx,
          { id: user.id, orgId: user.orgId },
          'approval.submit',
          `${user.id}:${month}`,
        );
        return toOwnApproval(row);
      });
    },
  );
}

/** Öffentliche Routen: Einladung ansehen und annehmen. */
export function invitationRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/auth/invite',
    {
      schema: {
        tags: ['auth'],
        description: 'Zeigt Organisation, Adresse und Rolle einer offenen Einladung.',
        querystring: inviteInfoQuery,
        response: { 200: inviteInfoResponse },
      },
    },
    async (request, reply) => {
      limit(ctx, reply, `auth:ip:${request.ip}`, ctx.limits.auth);
      const found = await asSystem(ctx.db, (tx) =>
        findInvitation(tx, request.query.token, ctx.now()),
      );
      if (!found) throw new HttpError(400, 'invalid_token');
      return {
        orgName: found.orgName,
        email: found.invitation.email,
        role: found.invitation.role,
      };
    },
  );

  app.post(
    '/auth/invite/accept',
    {
      schema: {
        tags: ['auth'],
        description:
          'Nimmt eine Einladung an und legt das Firmenkonto an (Adresse gilt durch den Link als bestätigt).',
        body: inviteAcceptRequest,
        response: { 200: okResponse },
      },
    },
    async (request, reply) => {
      limit(ctx, reply, `auth:ip:${request.ip}`, ctx.limits.auth);
      const { token, name, password, timezone, state } = request.body;
      const passwordHash = await hashPassword(password);
      await asSystem(ctx.db, async (tx) => {
        const found = await findInvitation(tx, token, ctx.now());
        if (!found) throw new HttpError(400, 'invalid_token');
        const inv = found.invitation;
        const existing = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${inv.email}`);
        if (existing.length > 0) throw new HttpError(409, 'email_in_use');
        const [user] = await tx
          .insert(users)
          .values({
            email: inv.email,
            passwordHash,
            name,
            timezone,
            state,
            orgId: inv.orgId,
            role: inv.role,
            teamId: inv.teamId,
            emailVerifiedAt: new Date(ctx.now()),
          })
          .returning({ id: users.id });
        if (!user) throw new HttpError(500, 'insert_failed');
        await tx
          .update(invitations)
          .set({ acceptedAt: new Date(ctx.now()) })
          .where(eq(invitations.id, inv.id));
        await audit(tx, { id: user.id, orgId: inv.orgId }, 'invitation.accept', inv.id);
      });
      return { ok: true as const };
    },
  );
}
