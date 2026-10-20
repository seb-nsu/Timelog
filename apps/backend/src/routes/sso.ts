// SSO je Organisation: OIDC (Microsoft Entra ID, Google, generisch) mit openid-client und SAML 2.0
// mit @node-saml/node-saml. Nach erfolgreicher Anmeldung leitet der Server mit einem Einmal-Code
// (2 Minuten gültig) zurück; der Client tauscht ihn gerätegebunden gegen Tokens (/auth/sso/exchange).
import { type CacheProvider, type Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import {
  type OidcConfig,
  type SamlConfig,
  type SsoConfig,
  samlAcsBody,
  ssoCallbackQuery,
  ssoExchangeRequest,
  ssoInfoResponse,
  ssoSlugParams,
  ssoStartQuery,
  tokenResponse,
} from '@timelog/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { type App, type AppContext, HttpError, limit } from '../app.js';
import { type Tx, asSystem, withUser } from '../db/index.js';
import { invitations, organizations, ssoRequests, users } from '../db/schema.js';
import { bindDevice, consumeOneTimeToken, createOneTimeToken, issueTokens } from './auth.js';
import { findInvitationByEmail } from './membership.js';
import { audit } from './org/access.js';
import { parseSso } from './org/manage.js';

const tags = ['sso'];
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const OIDC_CACHE_MS = 60 * 60_000;

type OrgRow = typeof organizations.$inferSelect;

/** Fehler, die zum Client zurückgeleitet werden (Code im Parameter sso_error). */
class SsoError extends Error {}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

/** Liefert nur bekannte, nicht leere Strings aus einem IdP-Profil. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const EMAIL_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';

export function samlEmail(profile: Profile, cfg: SamlConfig): string | undefined {
  if (cfg.emailAttribute) return str(profile[cfg.emailAttribute]);
  const fromAttr = str(profile.email) ?? str(profile.mail) ?? str(profile[EMAIL_CLAIM]);
  if (fromAttr) return fromAttr;
  return profile.nameID.includes('@') ? profile.nameID : undefined;
}

export function ssoRoutes(app: App, ctx: AppContext): void {
  const oidcCache = new Map<string, { config: oidc.Configuration; at: number }>();

  const apiBase = (slug: string) => `${ctx.apiUrl}/api/v1/auth/sso/${slug}`;

  const allowedRedirect = (url: string): boolean => {
    const origin = originOf(url);
    if (!origin) return false;
    const allowed = [ctx.adminUrl, ctx.appUrl, ...ctx.sso.redirectOrigins]
      .map(originOf)
      .filter((o): o is string => o !== undefined);
    return allowed.includes(origin);
  };

  async function loadOrg(slug: string): Promise<{ org: OrgRow; sso: SsoConfig }> {
    const [org] = await asSystem(ctx.db, (tx) =>
      tx.select().from(organizations).where(eq(organizations.slug, slug)),
    );
    if (org?.plan !== 'company') throw new HttpError(404, 'not_found');
    return { org, sso: parseSso(org.sso) };
  }

  async function oidcClient(org: OrgRow, cfg: OidcConfig): Promise<oidc.Configuration> {
    if (!ctx.sso.allowInsecure && !cfg.issuer.startsWith('https://')) {
      throw new HttpError(400, 'issuer_must_be_https');
    }
    const secret = ctx.sso.secret(cfg.clientSecretEnv);
    if (!secret) throw new HttpError(500, 'sso_secret_missing');
    const key = [org.id, cfg.issuer, cfg.clientId, cfg.clientSecretEnv].join('|');
    const cached = oidcCache.get(key);
    if (cached && Date.now() - cached.at < OIDC_CACHE_MS) return cached.config;
    const config = await oidc.discovery(
      new URL(cfg.issuer),
      cfg.clientId,
      secret,
      undefined,
      // Nur für Tests mit lokalem IdP; produktiv ist https Pflicht.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      ctx.sso.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
    oidcCache.set(key, { config, at: Date.now() });
    return config;
  }

  /** Request-IDs der SAML-AuthnRequests liegen in sso_requests (für die InResponseTo-Prüfung). */
  function samlCache(orgId: string): CacheProvider {
    return {
      saveAsync: (_key, value) => Promise.resolve({ value, createdAt: Date.now() }),
      getAsync: async (key) => {
        const rows = await asSystem(ctx.db, (tx) =>
          tx
            .select({ createdAt: ssoRequests.createdAt })
            .from(ssoRequests)
            .where(
              and(
                eq(ssoRequests.id, key),
                eq(ssoRequests.orgId, orgId),
                eq(ssoRequests.kind, 'saml'),
                gt(ssoRequests.expiresAt, new Date(ctx.now())),
              ),
            ),
        );
        // node-saml erwartet den Zeitpunkt der Anfrage (prüft requestIdExpirationPeriodMs).
        return rows[0] ? rows[0].createdAt.toISOString() : null;
      },
      removeAsync: async (key) => {
        if (key === null) return null;
        const removed = await asSystem(ctx.db, (tx) =>
          tx.delete(ssoRequests).where(eq(ssoRequests.id, key)).returning({ id: ssoRequests.id }),
        );
        return removed[0] ? key : null;
      },
    };
  }

  function samlClient(org: OrgRow, slug: string, cfg: SamlConfig, requestId?: string): SAML {
    const issuer = `${apiBase(slug)}/saml/metadata`;
    return new SAML({
      callbackUrl: `${apiBase(slug)}/saml/acs`,
      entryPoint: cfg.entryPoint,
      issuer,
      audience: issuer,
      idpCert: cfg.idpCert,
      ...(cfg.idpIssuer ? { idpIssuer: cfg.idpIssuer } : {}),
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_MS,
      cacheProvider: samlCache(org.id),
      acceptedClockSkewMs: 60_000,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      disableRequestedAuthnContext: true,
      ...(requestId ? { generateUniqueId: () => requestId } : {}),
    });
  }

  /**
   * Ordnet die IdP-Identität einem Mitglied der Organisation zu. Erste Anmeldung über die E-Mail
   * (bestehendes Mitglied oder offene Einladung, optional automatische Anlage); danach muss die
   * unveränderliche IdP-Kennung (Issuer|Subject) passen.
   */
  async function resolveUser(
    tx: Tx,
    org: OrgRow,
    sso: SsoConfig,
    rawEmail: string,
    subject: string,
  ): Promise<string> {
    const email = rawEmail.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (sso.allowedDomains.length > 0 && !sso.allowedDomains.includes(domain)) {
      throw new SsoError('domain_not_allowed');
    }
    const [user] = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    const now = new Date(ctx.now());
    if (user) {
      if (user.orgId !== org.id) throw new SsoError('not_a_member');
      if (user.deactivatedAt || user.deletedAt) throw new SsoError('account_deactivated');
      if (user.ssoSubject && user.ssoSubject !== subject) throw new SsoError('subject_mismatch');
      if (!user.ssoSubject) {
        await tx.update(users).set({ ssoSubject: subject }).where(eq(users.id, user.id));
      }
      return user.id;
    }
    const invitation = await findInvitationByEmail(tx, org.id, email, ctx.now());
    const autoProvision = sso.autoProvision && sso.allowedDomains.includes(domain);
    if (!invitation && !autoProvision) throw new SsoError('not_a_member');
    const [created] = await tx
      .insert(users)
      .values({
        email,
        passwordHash: '!', // keine Passwort-Anmeldung; Passwort-Reset setzt bei Bedarf eines
        name: email.split('@')[0] ?? email,
        orgId: org.id,
        role: invitation?.role ?? 'user',
        teamId: invitation?.teamId ?? null,
        emailVerifiedAt: now,
        ssoSubject: subject,
      })
      .returning({ id: users.id });
    if (!created) throw new HttpError(500, 'insert_failed');
    if (invitation) {
      await tx
        .update(invitations)
        .set({ acceptedAt: now })
        .where(eq(invitations.id, invitation.id));
      await audit(tx, { id: created.id, orgId: org.id }, 'invitation.accept', invitation.id, {
        via: 'sso',
      });
    } else {
      await audit(tx, { id: created.id, orgId: org.id }, 'member.provision', created.id, {
        via: 'sso',
      });
    }
    return created.id;
  }

  /** Legt den Einmal-Code an und liefert die Rücksprung-URL. */
  async function finish(
    org: OrgRow,
    sso: SsoConfig,
    redirect: string,
    email: string | undefined,
    subject: string,
  ): Promise<string> {
    try {
      if (!email) throw new SsoError('email_missing');
      const code = await asSystem(ctx.db, async (tx) => {
        const userId = await resolveUser(tx, org, sso, email, subject);
        return createOneTimeToken(tx, userId, 'sso_login', CODE_TTL_MS, ctx.now());
      });
      return withParam(redirect, 'code', code);
    } catch (err) {
      if (err instanceof SsoError) return withParam(redirect, 'sso_error', err.message);
      throw err;
    }
  }

  app.get(
    '/auth/sso/:slug',
    {
      schema: {
        tags,
        description: 'Welche SSO-Verfahren eine Organisation anbietet (für die Anmeldemaske).',
        params: ssoSlugParams,
        response: { 200: ssoInfoResponse },
      },
    },
    async (request, reply) => {
      limit(ctx, reply, `auth:ip:${request.ip}`, ctx.limits.auth);
      const { org, sso } = await loadOrg(request.params.slug);
      return {
        orgName: org.name,
        methods: [...(sso.oidc ? ['oidc' as const] : []), ...(sso.saml ? ['saml' as const] : [])],
        ...(sso.oidc ? { provider: sso.oidc.provider } : {}),
        enforced: sso.enforced,
      };
    },
  );

  app.get(
    '/auth/sso/:slug/start',
    {
      schema: {
        tags,
        description:
          'Startet die SSO-Anmeldung und leitet zum IdP weiter. redirect muss zu ADMIN_URL, APP_URL oder SSO_REDIRECT_ORIGINS gehören.',
        params: ssoSlugParams,
        querystring: ssoStartQuery,
      },
    },
    async (request, reply) => {
      limit(ctx, reply, `auth:ip:${request.ip}`, ctx.limits.auth);
      const { slug } = request.params;
      const { method, redirect } = request.query;
      if (!allowedRedirect(redirect)) throw new HttpError(400, 'redirect_not_allowed');
      const { org, sso } = await loadOrg(slug);
      const expiresAt = new Date(ctx.now() + REQUEST_TTL_MS);

      if (method === 'oidc') {
        if (!sso.oidc) throw new HttpError(404, 'sso_not_configured');
        const config = await oidcClient(org, sso.oidc);
        const codeVerifier = oidc.randomPKCECodeVerifier();
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        await asSystem(ctx.db, (tx) =>
          tx.insert(ssoRequests).values({
            id: `oidc:${state}`,
            orgId: org.id,
            kind: 'oidc',
            codeVerifier,
            nonce,
            redirect,
            expiresAt,
          }),
        );
        const url = oidc.buildAuthorizationUrl(config, {
          redirect_uri: `${apiBase(slug)}/oidc/callback`,
          scope: 'openid email profile',
          code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
          code_challenge_method: 'S256',
          state,
          nonce,
        });
        return reply.redirect(url.href, 302);
      }

      if (!sso.saml) throw new HttpError(404, 'sso_not_configured');
      const requestId = `_${randomBytes(20).toString('hex')}`;
      await asSystem(ctx.db, (tx) =>
        tx.insert(ssoRequests).values({
          id: requestId,
          orgId: org.id,
          kind: 'saml',
          redirect,
          expiresAt,
        }),
      );
      const url = await samlClient(org, slug, sso.saml, requestId).getAuthorizeUrlAsync(
        requestId,
        undefined,
        {},
      );
      return reply.redirect(url, 302);
    },
  );

  app.get(
    '/auth/sso/:slug/oidc/callback',
    {
      schema: {
        tags,
        description: 'Rücksprung vom OIDC-IdP (redirect_uri).',
        params: ssoSlugParams,
        querystring: ssoCallbackQuery,
      },
    },
    async (request, reply) => {
      limit(ctx, reply, `auth:ip:${request.ip}`, ctx.limits.auth);
      const { slug } = request.params;
      const { state } = request.query;
      if (!state) throw new HttpError(400, 'invalid_state');
      const { org, sso } = await loadOrg(slug);
      const [pending] = await asSystem(ctx.db, (tx) =>
        tx
          .delete(ssoRequests)
          .where(
            and(
              eq(ssoRequests.id, `oidc:${state}`),
              eq(ssoRequests.orgId, org.id),
              gt(ssoRequests.expiresAt, new Date(ctx.now())),
            ),
          )
          .returning(),
      );
      if (!pending?.codeVerifier || !pending.nonce) throw new HttpError(400, 'invalid_state');
      if (!sso.oidc)
        return reply.redirect(withParam(pending.redirect, 'sso_error', 'not_configured'), 302);
      if (request.query.error) {
        return reply.redirect(withParam(pending.redirect, 'sso_error', 'idp_error'), 302);
      }
      const config = await oidcClient(org, sso.oidc);
      const current = new URL(`${apiBase(slug)}/oidc/callback`);
      current.search = new URL(request.url, 'http://localhost').search;
      let claims: oidc.IDToken | undefined;
      try {
        const tokens = await oidc.authorizationCodeGrant(config, current, {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: state,
          expectedNonce: pending.nonce,
        });
        claims = tokens.claims();
      } catch (err) {
        request.log.warn({ err: { message: (err as Error).message } }, 'oidc callback failed');
        return reply.redirect(withParam(pending.redirect, 'sso_error', 'invalid_response'), 302);
      }
      if (!claims) {
        return reply.redirect(withParam(pending.redirect, 'sso_error', 'invalid_response'), 302);
      }
      // Google: nur bestätigte Adressen. Entra ID: email ist optional, sonst preferred_username (UPN).
      let email = str(claims.email);
      if (sso.oidc.provider === 'google' && claims.email_verified !== true) email = undefined;
      if (!email && sso.oidc.provider === 'entra') email = str(claims.preferred_username);
      const target = await finish(org, sso, pending.redirect, email, `${claims.iss}|${claims.sub}`);
      return reply.redirect(target, 302);
    },
  );

  app.post(
    '/auth/sso/:slug/saml/acs',
    {
      schema: {
        tags,
        description: 'Assertion Consumer Service (HTTP-POST-Binding) für SAML 2.0.',
        params: ssoSlugParams,
        body: samlAcsBody,
      },
    },
    async (request, reply) => {
      limit(ctx, reply, `auth:ip:${request.ip}`, ctx.limits.auth);
      const { slug } = request.params;
      const { org, sso } = await loadOrg(slug);
      const relay = request.body.RelayState;
      if (!relay) throw new HttpError(400, 'invalid_state');
      const [pending] = await asSystem(ctx.db, (tx) =>
        tx
          .select()
          .from(ssoRequests)
          .where(
            and(
              eq(ssoRequests.id, relay),
              eq(ssoRequests.orgId, org.id),
              eq(ssoRequests.kind, 'saml'),
              gt(ssoRequests.expiresAt, new Date(ctx.now())),
            ),
          ),
      );
      if (!pending) throw new HttpError(400, 'invalid_state');
      if (!sso.saml)
        return reply.redirect(withParam(pending.redirect, 'sso_error', 'not_configured'), 302);
      let profile: Profile | null;
      try {
        const result = await samlClient(org, slug, sso.saml).validatePostResponseAsync({
          SAMLResponse: request.body.SAMLResponse,
        });
        profile = result.profile;
      } catch (err) {
        request.log.warn({ err: { message: (err as Error).message } }, 'saml response rejected');
        profile = null;
      } finally {
        await asSystem(ctx.db, (tx) => tx.delete(ssoRequests).where(eq(ssoRequests.id, relay)));
      }
      if (!profile) {
        return reply.redirect(withParam(pending.redirect, 'sso_error', 'invalid_response'), 302);
      }
      const target = await finish(
        org,
        sso,
        pending.redirect,
        samlEmail(profile, sso.saml),
        `${profile.issuer}|${profile.nameID}`,
      );
      return reply.redirect(target, 302);
    },
  );

  app.get(
    '/auth/sso/:slug/saml/metadata',
    {
      schema: {
        tags,
        description: 'SAML-Metadaten des Service Providers (Entity-ID und ACS-URL) für den IdP.',
        params: ssoSlugParams,
      },
    },
    async (request, reply) => {
      const { slug } = request.params;
      const { org, sso } = await loadOrg(slug);
      const cfg: SamlConfig = sso.saml ?? {
        entryPoint: 'https://idp.invalid/',
        idpCert: 'not-configured-yet-not-configured',
      };
      const xml = samlClient(org, slug, cfg).generateServiceProviderMetadata(null, null);
      return reply.header('content-type', 'application/samlmetadata+xml').send(xml);
    },
  );

  app.post(
    '/auth/sso/exchange',
    {
      schema: {
        tags,
        description:
          'Tauscht den Einmal-Code aus dem SSO-Rücksprung gegen Tokens (gerätegebunden). SSO ersetzt TOTP für Manager und Admins.',
        body: ssoExchangeRequest,
        response: { 200: tokenResponse },
      },
    },
    async (request, reply) => {
      limit(ctx, reply, `auth:ip:${request.ip}`, ctx.limits.auth);
      const { code, deviceId, device } = request.body;
      const user = await asSystem(ctx.db, async (tx) => {
        const userId = await consumeOneTimeToken(tx, code, 'sso_login', ctx.now());
        const [u] = await tx.select().from(users).where(eq(users.id, userId));
        return u;
      });
      if (!user || user.deactivatedAt || user.deletedAt) throw new HttpError(401, 'invalid_token');
      return withUser(ctx.db, { userId: user.id, orgId: user.orgId }, async (tx) => {
        const id = await bindDevice(ctx, tx, user.id, deviceId, device);
        return issueTokens(ctx, tx, user, id, crypto.randomUUID(), true);
      });
    },
  );
}
