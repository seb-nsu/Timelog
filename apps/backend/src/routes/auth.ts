import {
  loginRequest,
  okResponse,
  passwordResetConfirm,
  passwordResetRequest,
  refreshRequest,
  registerRequest,
  ssoConfig,
  tokenResponse,
  totpSetupResponse,
  totpVerifyRequest,
  verifyRequest,
} from '@timelog/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { type App, type AppContext, HttpError, limit } from '../app.js';
import { type Tx, asSystem, withUser } from '../db/index.js';
import { authTokens, devices, organizations, refreshTokens, users } from '../db/schema.js';
import { decrypt, encrypt, randomToken, sha256 } from '../security/crypto.js';
import { ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_MS } from '../security/jwt.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../security/password.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../security/totp.js';
import { authOf, requireAuth, scopeOf } from './guard.js';

const VERIFY_TTL_MS = 48 * 3_600_000;
const RESET_TTL_MS = 3_600_000;
const tags = ['auth'];

type User = typeof users.$inferSelect;

export async function createOneTimeToken(
  tx: Tx,
  userId: string,
  purpose: 'verify_email' | 'password_reset' | 'sso_login',
  ttlMs: number,
  now: number,
): Promise<string> {
  const token = randomToken();
  await tx.insert(authTokens).values({
    userId,
    purpose,
    tokenHash: sha256(token),
    expiresAt: new Date(now + ttlMs),
  });
  return token;
}

export async function consumeOneTimeToken(
  tx: Tx,
  token: string,
  purpose: 'verify_email' | 'password_reset' | 'sso_login',
  now: number,
): Promise<string> {
  const rows = await tx
    .update(authTokens)
    .set({ usedAt: new Date(now) })
    .where(
      and(
        eq(authTokens.tokenHash, sha256(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date(now)),
      ),
    )
    .returning({ userId: authTokens.userId });
  const row = rows[0];
  if (!row) throw new HttpError(400, 'invalid_token');
  return row.userId;
}

export async function issueTokens(
  ctx: AppContext,
  tx: Tx,
  user: User,
  deviceId: string,
  familyId: string,
  sso = false,
) {
  const now = ctx.now();
  const refreshToken = randomToken();
  await tx.insert(refreshTokens).values({
    userId: user.id,
    deviceId,
    tokenHash: sha256(refreshToken),
    familyId,
    sso,
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
  });
  // TOTP ist Pflicht für Manager und Admins – außer bei Anmeldung über SSO (MFA beim IdP).
  const secondFactor = user.totpSecret !== null || sso;
  const needsMfa = user.role !== 'user';
  const accessToken = await ctx.signer.sign(
    {
      sub: user.id,
      did: deviceId,
      org: user.orgId,
      role: user.role,
      mfa: !needsMfa || secondFactor,
      ...(sso ? { sso: true } : {}),
    },
    now,
  );
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_S,
    deviceId,
    totpSetupRequired: needsMfa && !secondFactor,
  };
}

/** Verwendet ein bekanntes Gerät des Nutzers wieder oder legt ein neues an. */
export async function bindDevice(
  ctx: AppContext,
  tx: Tx,
  userId: string,
  deviceId: string | undefined,
  device: { kind: 'desktop' | 'mobile'; os: string; name: string },
): Promise<string> {
  let id: string | undefined;
  if (deviceId) {
    const reused = await tx
      .update(devices)
      .set({ os: device.os, name: device.name, lastSeenAt: new Date(ctx.now()) })
      .where(
        and(
          eq(devices.id, deviceId),
          eq(devices.userId, userId),
          eq(devices.kind, device.kind),
          isNull(devices.revokedAt),
        ),
      )
      .returning({ id: devices.id });
    id = reused[0]?.id;
  }
  if (!id) {
    const created = await tx
      .insert(devices)
      .values({ userId, ...device, lastSeenAt: new Date(ctx.now()) })
      .returning({ id: devices.id });
    id = created[0]?.id;
  }
  if (!id) throw new HttpError(500, 'internal_error');
  return id;
}

export function authRoutes(app: App, ctx: AppContext): void {
  const ipLimit = (ip: string, reply: Parameters<typeof limit>[1]): void => {
    limit(ctx, reply, `auth:ip:${ip}`, ctx.limits.auth);
  };
  const accountLimit = (email: string, reply: Parameters<typeof limit>[1]): void => {
    limit(ctx, reply, `auth:acct:${sha256(email)}`, ctx.limits.auth);
  };

  app.post(
    '/auth/register',
    { schema: { tags, body: registerRequest, response: { 200: okResponse } } },
    async (request, reply) => {
      ipLimit(request.ip, reply);
      accountLimit(request.body.email, reply);
      const { email, password, name, timezone, state } = request.body;
      const passwordHash = await hashPassword(password);
      const token = await asSystem(ctx.db, async (tx) => {
        const inserted = await tx
          .insert(users)
          .values({ email, passwordHash, name, timezone, state })
          .onConflictDoNothing()
          .returning({ id: users.id });
        const user = inserted[0];
        // Bestehende Adresse: gleiche Antwort, damit sich Konten nicht ausforschen lassen.
        return user
          ? createOneTimeToken(tx, user.id, 'verify_email', VERIFY_TTL_MS, ctx.now())
          : undefined;
      });
      if (token) {
        await ctx.mailer.send({
          to: email,
          subject: 'TimeLog: E-Mail-Adresse bestätigen',
          text: `Bitte bestätige deine Adresse: ${ctx.appUrl}/verify?token=${token}`,
        });
      }
      return { ok: true as const };
    },
  );

  app.post(
    '/auth/verify',
    { schema: { tags, body: verifyRequest, response: { 200: okResponse } } },
    async (request, reply) => {
      ipLimit(request.ip, reply);
      await asSystem(ctx.db, async (tx) => {
        const userId = await consumeOneTimeToken(tx, request.body.token, 'verify_email', ctx.now());
        await tx
          .update(users)
          .set({ emailVerifiedAt: new Date(ctx.now()) })
          .where(eq(users.id, userId));
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/auth/login',
    { schema: { tags, body: loginRequest, response: { 200: tokenResponse } } },
    async (request, reply) => {
      ipLimit(request.ip, reply);
      accountLimit(request.body.email, reply);
      const { email, password, totp, deviceId, device } = request.body;
      const found = await asSystem(ctx.db, (tx) =>
        tx
          .select()
          .from(users)
          .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt))),
      );
      const user = found[0];
      if (!user) {
        await burnPasswordCheck(password);
        throw new HttpError(401, 'invalid_credentials');
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        throw new HttpError(401, 'invalid_credentials');
      }
      if (!user.emailVerifiedAt) throw new HttpError(403, 'email_not_verified');
      if (user.deactivatedAt) throw new HttpError(403, 'account_deactivated');
      if (user.orgId && user.role !== 'admin') {
        const [org] = await asSystem(ctx.db, (tx) =>
          tx
            .select({ sso: organizations.sso })
            .from(organizations)
            .where(eq(organizations.id, user.orgId ?? '')),
        );
        // Admins behalten Passwort + TOTP als Notzugang.
        if (ssoConfig.safeParse(org?.sso).data?.enforced) throw new HttpError(403, 'sso_required');
      }

      let totpStep: number | undefined;
      if (user.totpSecret) {
        if (!totp) throw new HttpError(401, 'totp_required');
        totpStep = verifyTotp(
          decrypt(user.totpSecret, ctx.totpKey),
          totp,
          ctx.now(),
          user.totpLastStep ?? -1,
        );
        if (totpStep === undefined) throw new HttpError(401, 'invalid_totp');
      }

      return withUser(ctx.db, { userId: user.id, orgId: user.orgId }, async (tx) => {
        if (totpStep !== undefined) {
          await tx.update(users).set({ totpLastStep: totpStep }).where(eq(users.id, user.id));
        }
        const id = await bindDevice(ctx, tx, user.id, deviceId, device);
        return issueTokens(ctx, tx, user, id, randomUUID());
      });
    },
  );

  app.post(
    '/auth/refresh',
    { schema: { tags, body: refreshRequest, response: { 200: tokenResponse } } },
    async (request, reply) => {
      ipLimit(request.ip, reply);
      const now = ctx.now();
      const result = await asSystem(ctx.db, async (tx) => {
        const rows = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, sha256(request.body.refreshToken)))
          .for('update');
        const row = rows[0];
        if (!row) return { ok: false, error: 'invalid_token' } as const;
        if (row.usedAt || row.revokedAt) {
          // Wiederverwendung: ganze Familie sperren
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date(now) })
            .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
          return { ok: false, error: 'token_reused' } as const;
        }
        if (row.expiresAt.getTime() <= now) return { ok: false, error: 'token_expired' } as const;
        const [device] = await tx.select().from(devices).where(eq(devices.id, row.deviceId));
        const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
        if (!device || device.revokedAt || !user || user.deletedAt || user.deactivatedAt) {
          return { ok: false, error: 'invalid_token' } as const;
        }
        await tx
          .update(refreshTokens)
          .set({ usedAt: new Date(now) })
          .where(eq(refreshTokens.id, row.id));
        return {
          ok: true,
          tokens: await issueTokens(ctx, tx, user, device.id, row.familyId, row.sso),
        } as const;
      });
      if (!result.ok) throw new HttpError(401, result.error);
      return result.tokens;
    },
  );

  app.post(
    '/auth/logout',
    { schema: { tags, body: refreshRequest, response: { 200: okResponse } } },
    async (request) => {
      await asSystem(ctx.db, async (tx) => {
        const [row] = await tx
          .select({ familyId: refreshTokens.familyId })
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, sha256(request.body.refreshToken)));
        if (row) {
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date(ctx.now()) })
            .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
        }
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/auth/password-reset',
    { schema: { tags, body: passwordResetRequest, response: { 200: okResponse } } },
    async (request, reply) => {
      ipLimit(request.ip, reply);
      accountLimit(request.body.email, reply);
      const { email } = request.body;
      const token = await asSystem(ctx.db, async (tx) => {
        const [user] = await tx
          .select({ id: users.id, verified: users.emailVerifiedAt })
          .from(users)
          .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)));
        if (!user?.verified) return undefined;
        return createOneTimeToken(tx, user.id, 'password_reset', RESET_TTL_MS, ctx.now());
      });
      if (token) {
        await ctx.mailer.send({
          to: email,
          subject: 'TimeLog: Passwort zurücksetzen',
          text: `Neues Passwort setzen (1 Stunde gültig): ${ctx.appUrl}/reset?token=${token}`,
        });
      }
      return { ok: true as const };
    },
  );

  app.post(
    '/auth/password-reset/confirm',
    { schema: { tags, body: passwordResetConfirm, response: { 200: okResponse } } },
    async (request, reply) => {
      ipLimit(request.ip, reply);
      const passwordHash = await hashPassword(request.body.password);
      await asSystem(ctx.db, async (tx) => {
        const userId = await consumeOneTimeToken(
          tx,
          request.body.token,
          'password_reset',
          ctx.now(),
        );
        await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date(ctx.now()) })
          .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
      });
      return { ok: true as const };
    },
  );

  const auth = requireAuth(ctx);

  app.post(
    '/auth/totp/setup',
    {
      onRequest: auth,
      schema: { tags, security: [{ bearer: [] }], response: { 200: totpSetupResponse } },
    },
    async (request) => {
      const claims = authOf(request);
      const secret = generateSecret();
      const email = await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [user] = await tx
          .update(users)
          .set({ totpPendingSecret: encrypt(secret, ctx.totpKey) })
          .where(eq(users.id, claims.sub))
          .returning({ email: users.email });
        return user?.email ?? '';
      });
      return { secret, otpauthUrl: otpauthUrl(secret, email) };
    },
  );

  app.post(
    '/auth/totp/verify',
    {
      onRequest: auth,
      schema: {
        tags,
        security: [{ bearer: [] }],
        body: totpVerifyRequest,
        response: { 200: okResponse },
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      limit(ctx, reply, `totp:${claims.sub}`, ctx.limits.auth);
      await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, claims.sub));
        if (!user?.totpPendingSecret) throw new HttpError(400, 'totp_not_started');
        const step = verifyTotp(
          decrypt(user.totpPendingSecret, ctx.totpKey),
          request.body.code,
          ctx.now(),
        );
        if (step === undefined) throw new HttpError(400, 'invalid_totp');
        await tx
          .update(users)
          .set({ totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpLastStep: step })
          .where(eq(users.id, claims.sub));
      });
      return { ok: true as const };
    },
  );
}
