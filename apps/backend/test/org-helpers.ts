// Hilfen für Tests der Firmenversion: Organisation mit Admin, Teams, Manager und Mitgliedern.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { asOwner } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { currentStep, hotp } from '../src/security/totp.js';
import {
  PASSWORD,
  type TestEnv,
  event,
  login,
  registerAndLogin,
  tokenFromMail,
  uniqueEmail,
} from './helpers.js';

export type Login = Awaited<ReturnType<typeof login>>;
export interface Person extends Login {
  userId: string;
  totpSecret?: string;
}

export async function userIdOf(env: TestEnv, email: string): Promise<string> {
  const [u] = await asOwner(env.database.db, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)),
  );
  if (!u) throw new Error(`user ${email}`);
  return u.id;
}

/** Richtet TOTP ein und meldet neu an (mit Code), damit das Token mfa = true trägt. */
export async function withTotp(env: TestEnv, t: Login): Promise<Person> {
  const setup = await env.app.inject({
    method: 'POST',
    url: '/api/v1/auth/totp/setup',
    headers: t.auth,
    payload: {},
  });
  const { secret } = setup.json<{ secret: string }>();
  const verify = await env.app.inject({
    method: 'POST',
    url: '/api/v1/auth/totp/verify',
    headers: t.auth,
    payload: { code: hotp(secret, currentStep(env.clock.now)) },
  });
  if (verify.statusCode !== 200) throw new Error(`totp verify: ${verify.body}`);
  env.clock.now += 30_000;
  const fresh = await login(env, t.email, 'desktop', {
    totp: hotp(secret, currentStep(env.clock.now)),
  });
  return { ...fresh, userId: await userIdOf(env, t.email), totpSecret: secret };
}

// T beschreibt die erwartete Antwort; der Test legt sie fest.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function api<T = unknown>(
  env: TestEnv,
  who: { auth: { authorization: string } },
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T; raw: string }> {
  const res = await env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: who.auth,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  let body: unknown;
  try {
    body = res.json();
  } catch {
    body = undefined;
  }
  return { status: res.statusCode, body: body as T, raw: res.body };
}

/** Legt eine Organisation an; der Aufrufer wird Admin mit TOTP. */
export async function createOrg(env: TestEnv, name = 'Firma'): Promise<Person & { orgId: string }> {
  const t = await registerAndLogin(env);
  const slug = `firma-${randomUUID().slice(0, 8)}`;
  const created = await api<{ orgId: string }>(env, t, 'POST', '/orgs', { name, slug });
  if (created.status !== 200) throw new Error(`create org: ${created.raw}`);
  const admin = await withTotp(env, await login(env, t.email));
  return { ...admin, orgId: created.body.orgId };
}

/** Lädt per Admin ein, nimmt die Einladung an und meldet an (Manager/Admin mit TOTP). */
export async function invite(
  env: TestEnv,
  admin: Login,
  role: 'user' | 'manager' | 'admin',
  teamId?: string,
): Promise<Person> {
  const email = uniqueEmail();
  const res = await api(env, admin, 'POST', '/org/invite', {
    email,
    role,
    ...(teamId ? { teamId } : {}),
  });
  if (res.status !== 200) throw new Error(`invite: ${res.raw}`);
  const accepted = await env.app.inject({
    method: 'POST',
    url: '/api/v1/auth/invite/accept',
    payload: {
      token: tokenFromMail(env.mailer, email),
      name: `Person ${role}`,
      password: PASSWORD,
    },
  });
  if (accepted.statusCode !== 200) throw new Error(`accept: ${accepted.body}`);
  const t = await login(env, email);
  if (role === 'user') return { ...t, userId: await userIdOf(env, email) };
  return withTotp(env, t);
}

export interface OrgSetup {
  orgId: string;
  admin: Person;
  manager: Person;
  member: Person;
  other: Person;
  teamA: string;
  teamB: string;
}

/** Admin; Team A (Manager + Mitglied), Team B (anderes Mitglied, ohne diesen Manager). */
export async function setupOrg(env: TestEnv, name = 'Firma'): Promise<OrgSetup> {
  const admin = await createOrg(env, name);
  const teamA = await api<{ id: string }>(env, admin, 'POST', '/org/teams', { name: 'Team A' });
  const teamB = await api<{ id: string }>(env, admin, 'POST', '/org/teams', { name: 'Team B' });
  const manager = await invite(env, admin, 'manager', teamA.body.id);
  await api(env, admin, 'PATCH', `/org/teams/${teamA.body.id}`, { managerId: manager.userId });
  const member = await invite(env, admin, 'user', teamA.body.id);
  const other = await invite(env, admin, 'user', teamB.body.id);
  return {
    orgId: admin.orgId,
    admin,
    manager,
    member,
    other,
    teamA: teamA.body.id,
    teamB: teamB.body.id,
  };
}

/** Mi 14.10.2026, Europe/Berlin: boot 08:00, shutdown 17:00 (Laptop durchgehend aktiv). */
export async function workday(
  env: TestEnv,
  t: Login,
  date = '2026-10-14',
  from = '06:00',
  to = '15:00',
): Promise<void> {
  const start = `${date}T${from}:00Z`;
  const end = `${date}T${to}:00Z`;
  await env.app.inject({
    method: 'POST',
    url: '/api/v1/events/batch',
    headers: t.auth,
    payload: {
      events: [
        event('boot', start, { createdAt: new Date(Date.parse(start) + 300_000).toISOString() }),
        event('shutdown', end),
      ],
    },
  });
  await env.app.inject({
    method: 'PUT',
    url: '/api/v1/presence',
    headers: t.auth,
    payload: { spans: [{ id: randomUUID(), start, end, open: false }] },
  });
}
