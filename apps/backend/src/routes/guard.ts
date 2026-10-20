import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { type AppContext, HttpError } from '../app.js';
import { type Scope, withUser } from '../db/index.js';
import { devices } from '../db/schema.js';
import type { AccessClaims } from '../security/jwt.js';

/** Routen, die auch ohne eingerichtetes TOTP erreichbar sind (für Manager und Admins). */
const MFA_EXEMPT = ['/auth/totp/setup', '/auth/totp/verify'];

/**
 * Prüft das Access-Token und das Gerät. user_id und device_id kommen ausschließlich aus dem Token;
 * Werte im Request werden nie verwendet.
 */
export function requireAuth(ctx: AppContext) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? await ctx.signer.verify(token, ctx.now()) : undefined;
    if (!claims) throw new HttpError(401, 'unauthorized');

    const active = await withUser(ctx.db, scopeOf(claims), (tx) =>
      tx
        .update(devices)
        .set({ lastSeenAt: new Date(ctx.now()) })
        .where(
          and(
            eq(devices.id, claims.did),
            eq(devices.userId, claims.sub),
            isNull(devices.revokedAt),
          ),
        )
        .returning({ id: devices.id }),
    );
    if (active.length === 0) throw new HttpError(401, 'device_revoked');

    if (!claims.mfa && !MFA_EXEMPT.some((p) => request.url.endsWith(p))) {
      throw new HttpError(403, 'totp_setup_required');
    }
    request.auth = claims;
  };
}

export function scopeOf(claims: AccessClaims): Scope {
  return { userId: claims.sub, orgId: claims.org };
}

export function authOf(request: FastifyRequest): AccessClaims {
  if (!request.auth) throw new HttpError(401, 'unauthorized');
  return request.auth;
}
