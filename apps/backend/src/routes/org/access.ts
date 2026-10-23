// Zentrale Zugriffsprüfung der Firmenversion (Fastify-Hook). Zweite Linie: Row-Level-Security
// (0003_org_rls.sql) prüft dieselben Regeln in der Datenbank.
import type { Role } from '@timelog/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { type AppContext, HttpError } from '../../app.js';
import { type Tx, withUser } from '../../db/index.js';
import { auditLog, teams, users } from '../../db/schema.js';
import { authOf, scopeOf } from '../guard.js';

export interface Actor {
  id: string;
  orgId: string;
  role: Role;
  name: string;
  teamId: string | null;
  /** Teams, die der Akteur als Manager leitet. */
  managedTeamIds: string[];
  /** Gerät aus dem Token (für Korrektur-Ereignisse). */
  deviceId: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Erlaubte Rollen; Standard: manager und admin. */
    roles?: readonly Role[];
  }
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export const MANAGERS: readonly Role[] = ['manager', 'admin'];
export const ADMINS: readonly Role[] = ['admin'];
export const MEMBERS: readonly Role[] = ['user', 'manager', 'admin'];

/**
 * Lädt Rolle und Teams des Akteurs aus der Datenbank (nicht aus dem Token, damit Rollenänderungen
 * sofort wirken) und prüft Organisation, Rolle und Zwei-Faktor-Pflicht.
 */
export function requireOrgRole(ctx: AppContext) {
  return async (request: FastifyRequest): Promise<void> => {
    const claims = authOf(request);
    const orgId = claims.org;
    if (!orgId) throw new HttpError(403, 'no_organization');
    const roles = request.routeOptions.config.roles ?? MANAGERS;
    const found = await withUser(ctx.db, scopeOf(claims), async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, claims.sub));
      if (!user) return undefined;
      const managed = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.orgId, orgId), eq(teams.managerId, user.id)));
      return { user, managed: managed.map((t) => t.id) };
    });
    const user = found?.user;
    if (!found || !user || user.orgId !== orgId || user.deletedAt || user.deactivatedAt) {
      throw new HttpError(403, 'not_a_member');
    }
    if (!roles.includes(user.role)) throw new HttpError(403, 'forbidden');
    if (user.role !== 'user' && user.totpSecret === null && claims.sso !== true) {
      throw new HttpError(403, 'totp_setup_required');
    }
    request.actor = {
      id: user.id,
      orgId,
      role: user.role,
      name: user.name,
      teamId: user.teamId,
      managedTeamIds: user.role === 'manager' ? found.managed : [],
      deviceId: claims.did,
    };
  };
}

export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw new HttpError(403, 'forbidden');
  return request.actor;
}

export function actorScope(actor: Actor) {
  return { userId: actor.id, orgId: actor.orgId };
}

type MemberRow = typeof users.$inferSelect;

/**
 * Darf der Akteur dieses Mitglied sehen? Admin: alle der eigenen Organisation; Manager: Mitglieder
 * der eigenen Teams. Die Datenbank prüft dasselbe noch einmal (app_can_view).
 */
export function canSee(actor: Actor, member: Pick<MemberRow, 'orgId' | 'teamId'>): boolean {
  if (member.orgId !== actor.orgId) return false;
  if (actor.role === 'admin') return true;
  return member.teamId !== null && actor.managedTeamIds.includes(member.teamId);
}

/** Lädt ein sichtbares Mitglied oder wirft 404 (auch bei fremden Organisationen). */
export async function loadMember(tx: Tx, actor: Actor, memberId: string): Promise<MemberRow> {
  const [member] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, memberId), isNull(users.deletedAt)));
  if (!member || !canSee(actor, member)) throw new HttpError(404, 'not_found');
  return member;
}

/** Schreibt einen Eintrag ins Audit-Log (ohne RETURNING: Lesen darf nur der Admin). */
export async function audit(
  tx: Tx,
  actor: { id: string; orgId: string },
  action: string,
  target?: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: actor.orgId,
    actorId: actor.id,
    action,
    target: target ?? null,
    payload: payload ?? null,
  });
}
