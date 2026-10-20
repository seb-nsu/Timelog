// SSO je Organisation mit gemockten IdPs: OIDC (lokaler Server mit Discovery, JWKS, Token-Endpunkt)
// und SAML 2.0 (signierte Assertion, Schlüssel werden im Test erzeugt).
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestEnv, createTestEnv, login, uniqueEmail } from './helpers.js';
import { type OrgSetup, api, setupOrg } from './org-helpers.js';

const CLIENT_ID = 'timelog-test';
const CLIENT_SECRET = 'idp-client-secret';
const REDIRECT = 'https://app.test/sso';
const device = { kind: 'desktop', os: 'test-os', name: 'Browser' };

// ── Gemockter OIDC-IdP ─────────────────────────────────────────────────────────
interface Grant {
  nonce: string;
  challenge: string;
  sub: string;
  email: string;
  emailVerified?: boolean;
}
const grants = new Map<string, Grant>();
let issuer = '';
let idp: Server;
let signKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function startOidcIdp(): Promise<void> {
  const keys = await generateKeyPair('RS256');
  signKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      json(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(raw);
          const basic = req.headers.authorization?.startsWith('Basic ')
            ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
            : [];
          const secret = form.get('client_secret') ?? decodeURIComponent(basic[1] ?? '');
          const grant = grants.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (secret !== CLIENT_SECRET || !grant || grant.challenge !== challenge) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          grants.delete(form.get('code') ?? '');
          const now = Math.floor(Date.now() / 1000);
          const idToken = await new SignJWT({
            nonce: grant.nonce,
            email: grant.email,
            email_verified: grant.emailVerified ?? true,
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(issuer)
            .setAudience(CLIENT_ID)
            .setSubject(grant.sub)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(signKey);
          json(200, {
            access_token: 'at',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          });
        })();
      });
      return undefined;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${String((idp.address() as AddressInfo).port)}`;
}

// ── Testumgebung ──────────────────────────────────────────────────────────────
let env: TestEnv;
let org: OrgSetup;
let slug: string;

beforeAll(async () => {
  await startOidcIdp();
  env = await createTestEnv(undefined, {
    apiUrl: 'https://api.test',
    sso: {
      allowInsecure: true,
      secret: (name) => (name === 'SSO_TEST_CLIENT_SECRET' ? CLIENT_SECRET : undefined),
    },
  });
  org = await setupOrg(env, 'SSO GmbH');
  const me = await api<{ org: { slug: string } }>(env, org.admin, 'GET', '/org/me');
  slug = me.body.org.slug;
});
afterAll(async () => {
  await env.close();
  await new Promise((resolve) => idp.close(resolve));
});

async function configure(sso: Record<string, unknown>): Promise<void> {
  const res = await api(env, org.admin, 'PUT', '/org/config', { sso });
  if (res.status !== 200) throw new Error(`config: ${res.raw}`);
}

const oidcConfig = (provider = 'oidc') => ({
  oidc: { provider, issuer, clientId: CLIENT_ID, clientSecretEnv: 'SSO_TEST_CLIENT_SECRET' },
});

/** Startet die Anmeldung, „meldet beim IdP an“ und liefert die Rücksprung-URL des Servers. */
async function oidcLogin(email: string, sub = `sub-${email}`, emailVerified = true): Promise<URL> {
  const start = await env.app.inject({
    method: 'GET',
    url: `/api/v1/auth/sso/${slug}/start?method=oidc&redirect=${encodeURIComponent(REDIRECT)}`,
  });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(start.headers.location ?? '');
  expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
  expect(authorize.searchParams.get('redirect_uri')).toBe(
    `https://api.test/api/v1/auth/sso/${slug}/oidc/callback`,
  );
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const code = randomUUID();
  grants.set(code, {
    nonce: authorize.searchParams.get('nonce') ?? '',
    challenge: authorize.searchParams.get('code_challenge') ?? '',
    sub,
    email,
    emailVerified,
  });
  const state = authorize.searchParams.get('state') ?? '';
  const cb = await env.app.inject({
    method: 'GET',
    url: `/api/v1/auth/sso/${slug}/oidc/callback?code=${code}&state=${state}`,
  });
  expect(cb.statusCode).toBe(302);
  const back = new URL(cb.headers.location ?? '');
  back.searchParams.set('_state', state);
  return back;
}

async function exchange(code: string) {
  return env.app.inject({
    method: 'POST',
    url: '/api/v1/auth/sso/exchange',
    payload: { code, device },
  });
}

describe('SSO-Konfiguration', () => {
  it('Secrets nur als Name einer SSO_-Variable; Info-Endpunkt zeigt die Verfahren', async () => {
    const bad = await api(env, org.admin, 'PUT', '/org/config', {
      sso: { oidc: { provider: 'oidc', issuer, clientId: 'x', clientSecretEnv: 'JWT_SECRET' } },
    });
    expect(bad.status).toBe(400);
    await configure(oidcConfig());
    const info = await env.app.inject({ method: 'GET', url: `/api/v1/auth/sso/${slug}` });
    expect(info.json()).toEqual({
      orgName: 'SSO GmbH',
      methods: ['oidc'],
      provider: 'oidc',
      enforced: false,
    });
    const cfg = await api<{ sso: Record<string, unknown> }>(env, org.admin, 'GET', '/org/config');
    expect(JSON.stringify(cfg.body)).not.toContain(CLIENT_SECRET);
  });

  it('Rücksprung nur zu erlaubten Ursprüngen', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/v1/auth/sso/${slug}/start?method=oidc&redirect=${encodeURIComponent('https://evil.test/x')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'redirect_not_allowed' });
  });
});

describe('OIDC', () => {
  it('Mitglied meldet sich an; Code ist einmalig; Token ist gerätegebunden', async () => {
    await configure(oidcConfig());
    const back = await oidcLogin(org.member.email);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    const code = back.searchParams.get('code') ?? '';
    const tokens = await exchange(code);
    expect(tokens.statusCode).toBe(200);
    const body = tokens.json<{ accessToken: string; deviceId: string }>();
    const me = await api<{ user: { id: string } }>(
      env,
      { auth: { authorization: `Bearer ${body.accessToken}` } },
      'GET',
      '/org/me',
    );
    expect(me.body.user.id).toBe(org.member.userId);
    expect((await exchange(code)).statusCode).toBe(400);
    // state ist verbraucht: derselbe Rücksprung geht nicht zweimal
    const replay = await env.app.inject({
      method: 'GET',
      url: `/api/v1/auth/sso/${slug}/oidc/callback?code=x&state=${back.searchParams.get('_state') ?? ''}`,
    });
    expect(replay.statusCode).toBe(400);
  });

  it('Eingeladener Manager wird bei der ersten Anmeldung angelegt; SSO ersetzt TOTP, auch nach Refresh', async () => {
    const email = uniqueEmail();
    await api(env, org.admin, 'POST', '/org/invite', { email, role: 'manager', teamId: org.teamA });
    const back = await oidcLogin(email);
    const tokens = (await exchange(back.searchParams.get('code') ?? '')).json<{
      accessToken: string;
      refreshToken: string;
      totpSetupRequired: boolean;
    }>();
    expect(tokens.totpSetupRequired).toBe(false);
    const auth = { auth: { authorization: `Bearer ${tokens.accessToken}` } };
    const me = await api<{ user: { role: string } }>(env, auth, 'GET', '/org/me');
    expect(me.body.user.role).toBe('manager');
    expect((await api(env, auth, 'GET', '/org/members')).status).toBe(200);
    const refreshed = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });
    const again = {
      auth: { authorization: `Bearer ${refreshed.json<{ accessToken: string }>().accessToken}` },
    };
    expect((await api(env, again, 'GET', '/org/members')).status).toBe(200);
    // Passwort-Anmeldung gibt es für dieses Konto nicht
    await expect(login(env, email)).rejects.toThrow(/invalid_credentials/);
  });

  it('Unbekannte, fremde oder umgehängte Identitäten werden abgewiesen', async () => {
    expect((await oidcLogin(uniqueEmail())).searchParams.get('sso_error')).toBe('not_a_member');
    // Gleiche Adresse, anderer Subject beim IdP (z. B. neu angelegtes Konto)
    expect((await oidcLogin(org.member.email, 'anderes-sub')).searchParams.get('sso_error')).toBe(
      'subject_mismatch',
    );
    // Google: unbestätigte Adresse zählt nicht
    await configure(oidcConfig('google'));
    expect(
      (await oidcLogin(org.other.email, 'sub-other', false)).searchParams.get('sso_error'),
    ).toBe('email_missing');
    // Erlaubte Domains
    await configure({ ...oidcConfig(), allowedDomains: ['firma.example'] });
    expect((await oidcLogin(org.other.email)).searchParams.get('sso_error')).toBe(
      'domain_not_allowed',
    );
  });

  it('Automatische Anlage nur für erlaubte Domains', async () => {
    await configure({ ...oidcConfig(), autoProvision: true, allowedDomains: ['firma.example'] });
    const back = await oidcLogin(`neu-${randomUUID().slice(0, 6)}@firma.example`);
    const tokens = await exchange(back.searchParams.get('code') ?? '');
    expect(tokens.statusCode).toBe(200);
    const audit = await api<{ entries: { action: string }[] }>(
      env,
      org.admin,
      'GET',
      '/org/audit?limit=5',
    );
    expect(audit.body.entries.map((e) => e.action)).toContain('member.provision');
  });

  it('SSO-Pflicht sperrt die Passwort-Anmeldung für Mitglieder, nicht für Admins', async () => {
    await configure({ ...oidcConfig(), enforced: true });
    await expect(login(env, org.other.email)).rejects.toThrow(/sso_required/);
    expect(
      await login(env, org.admin.email, 'desktop', { totp: undefined }).catch((e: unknown) =>
        String(e),
      ),
    ).toMatch(/totp_required/);
    await configure(oidcConfig());
    expect((await login(env, org.other.email)).accessToken).toBeTruthy();
  });
});

// ── SAML ──────────────────────────────────────────────────────────────────────
const saml = generateKeyPairSync('rsa', { modulusLength: 2048 });
const samlPrivate = saml.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const samlPublic = saml.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function samlResponse(opts: { requestId: string; email: string; audience: string; acs: string }) {
  const now = new Date(Date.now() - 1000).toISOString();
  const later = new Date(Date.now() + 5 * 60_000).toISOString();
  const id = `_${randomUUID().replaceAll('-', '')}`;
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${id}" Version="2.0" IssueInstant="${now}" Destination="${opts.acs}" InResponseTo="${opts.requestId}"><saml:Issuer>https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${id}" Version="2.0" IssueInstant="${now}"><saml:Issuer>https://idp.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${opts.requestId}" NotOnOrAfter="${later}" Recipient="${opts.acs}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${now}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
}

function sign(xml: string): string {
  const sig = new SignedXml({
    privateKey: samlPrivate,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  sig.computeSignature(xml, {
    prefix: 'ds',
    location: {
      reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: 'after',
    },
  });
  return sig.getSignedXml();
}

async function samlStart(): Promise<{ requestId: string; relay: string }> {
  const start = await env.app.inject({
    method: 'GET',
    url: `/api/v1/auth/sso/${slug}/start?method=saml&redirect=${encodeURIComponent(REDIRECT)}`,
  });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location ?? '');
  expect(loc.origin).toBe('https://idp.test');
  const request = inflateRawSync(
    Buffer.from(loc.searchParams.get('SAMLRequest') ?? '', 'base64'),
  ).toString();
  const requestId = /ID="([^"]+)"/.exec(request)?.[1] ?? '';
  return { requestId, relay: loc.searchParams.get('RelayState') ?? '' };
}

async function postAcs(xml: string, relay: string) {
  return env.app.inject({
    method: 'POST',
    url: `/api/v1/auth/sso/${slug}/saml/acs`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      SAMLResponse: Buffer.from(xml).toString('base64'),
      RelayState: relay,
    }).toString(),
  });
}

describe('SAML', () => {
  const sp = () => ({
    audience: `https://api.test/api/v1/auth/sso/${slug}/saml/metadata`,
    acs: `https://api.test/api/v1/auth/sso/${slug}/saml/acs`,
  });

  it('Metadaten nennen Entity-ID und ACS-URL', async () => {
    await configure({ saml: { entryPoint: 'https://idp.test/sso', idpCert: samlPublic } });
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/v1/auth/sso/${slug}/saml/metadata`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`entityID="${sp().audience}"`);
    expect(res.body).toContain(`Location="${sp().acs}"`);
  });

  it('Signierte Assertion meldet das Mitglied an; Wiederholung wird abgewiesen', async () => {
    await configure({ saml: { entryPoint: 'https://idp.test/sso', idpCert: samlPublic } });
    const { requestId, relay } = await samlStart();
    expect(relay).toBe(requestId);
    const xml = sign(samlResponse({ requestId, email: org.other.email, ...sp() }));
    const res = await postAcs(xml, relay);
    expect(res.statusCode).toBe(302);
    const back = new URL(res.headers.location ?? '');
    expect(back.searchParams.get('sso_error')).toBeNull();
    const tokens = await exchange(back.searchParams.get('code') ?? '');
    expect(tokens.statusCode).toBe(200);
    expect((await postAcs(xml, relay)).statusCode).toBe(400);
  });

  it('Manipulierte oder unsignierte Antworten und falsche Audience werden abgewiesen', async () => {
    await configure({ saml: { entryPoint: 'https://idp.test/sso', idpCert: samlPublic } });
    const cases = [
      (id: string) =>
        sign(samlResponse({ requestId: id, email: org.other.email, ...sp() })).replace(
          org.other.email,
          org.admin.email,
        ),
      (id: string) => samlResponse({ requestId: id, email: org.other.email, ...sp() }),
      (id: string) =>
        sign(
          samlResponse({
            requestId: id,
            email: org.other.email,
            ...sp(),
            audience: 'https://andere.test',
          }),
        ),
      () => sign(samlResponse({ requestId: '_unbekannt', email: org.other.email, ...sp() })),
    ];
    for (const make of cases) {
      const { requestId, relay } = await samlStart();
      const res = await postAcs(make(requestId), relay);
      expect(res.statusCode).toBe(302);
      expect(new URL(res.headers.location ?? '').searchParams.get('sso_error')).toBe(
        'invalid_response',
      );
    }
  });
});
