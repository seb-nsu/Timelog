import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';
import { currentStep, hotp } from '../src/security/totp.js';
import {
  PASSWORD,
  type TestEnv,
  createTestEnv,
  login,
  registerAndLogin,
  tokenFromMail,
  uniqueEmail,
} from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object, headers });

describe('Registrierung und Anmeldung', () => {
  it('verlangt eine bestätigte E-Mail-Adresse', async () => {
    const email = uniqueEmail();
    expect(
      (await post('/auth/register', { email, password: PASSWORD, name: 'A' })).statusCode,
    ).toBe(200);
    const device = { kind: 'desktop', os: 'x', name: 'y' };
    const before = await post('/auth/login', { email, password: PASSWORD, device });
    expect(before.statusCode).toBe(403);
    expect(before.json()).toMatchObject({ error: 'email_not_verified' });

    expect(
      (await post('/auth/verify', { token: tokenFromMail(env.mailer, email) })).statusCode,
    ).toBe(200);
    const after = await post('/auth/login', {
      email: email.toUpperCase(),
      password: PASSWORD,
      device,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ expiresIn: 900, totpSetupRequired: false });
  });

  it('verrät nicht, ob eine Adresse schon registriert ist', async () => {
    const email = uniqueEmail();
    await post('/auth/register', { email, password: PASSWORD, name: 'A' });
    const mails = env.mailer.outbox.length;
    const again = await post('/auth/register', { email, password: PASSWORD, name: 'B' });
    expect(again.statusCode).toBe(200);
    expect(env.mailer.outbox.length).toBe(mails);
  });

  it('lehnt falsche Passwörter, unbekannte Konten und schwache Passwörter ab', async () => {
    const { email } = await registerAndLogin(env);
    const device = { kind: 'desktop', os: 'x', name: 'y' };
    expect(
      (await post('/auth/login', { email, password: 'falsch-falsch', device })).statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/login', { email: uniqueEmail(), password: PASSWORD, device })).statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/register', { email: uniqueEmail(), password: 'kurz', name: 'A' }))
        .statusCode,
    ).toBe(400);
    expect((await post('/auth/verify', { token: 'x'.repeat(40) })).statusCode).toBe(400);
  });

  it('nutzt ein bekanntes Gerät beim erneuten Anmelden weiter', async () => {
    const first = await registerAndLogin(env);
    const second = await login(env, first.email, 'desktop', { deviceId: first.deviceId });
    expect(second.deviceId).toBe(first.deviceId);
    const other = await login(env, first.email, 'mobile', { deviceId: first.deviceId });
    expect(other.deviceId).not.toBe(first.deviceId);
  });
});

describe('Refresh-Token-Rotation', () => {
  it('rotiert und sperrt bei Wiederverwendung die ganze Familie', async () => {
    const t0 = await registerAndLogin(env);
    const r1 = await post('/auth/refresh', { refreshToken: t0.refreshToken });
    expect(r1.statusCode).toBe(200);
    const t1 = r1.json<{ refreshToken: string; deviceId: string }>();
    expect(t1.refreshToken).not.toBe(t0.refreshToken);
    expect(t1.deviceId).toBe(t0.deviceId);

    // Altes Token erneut benutzt → Diebstahl angenommen
    const reuse = await post('/auth/refresh', { refreshToken: t0.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ error: 'token_reused' });
    // Auch das neueste Token der Familie ist jetzt gesperrt
    expect((await post('/auth/refresh', { refreshToken: t1.refreshToken })).statusCode).toBe(401);
  });

  it('lehnt abgelaufene Tokens ab und meldet ab', async () => {
    const t0 = await registerAndLogin(env);
    const saved = env.clock.now;
    env.clock.now += 31 * 24 * 3_600_000;
    expect((await post('/auth/refresh', { refreshToken: t0.refreshToken })).json()).toMatchObject({
      error: 'token_expired',
    });
    env.clock.now = saved;

    const t1 = await registerAndLogin(env);
    expect((await post('/auth/logout', { refreshToken: t1.refreshToken })).statusCode).toBe(200);
    expect((await post('/auth/refresh', { refreshToken: t1.refreshToken })).statusCode).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: 'y'.repeat(43) })).statusCode).toBe(401);
  });

  it('Access-Token läuft nach 15 Minuten ab', async () => {
    const t = await registerAndLogin(env);
    const ok = await env.app.inject({ method: 'GET', url: '/api/v1/devices', headers: t.auth });
    expect(ok.statusCode).toBe(200);
    const saved = env.clock.now;
    env.clock.now += 16 * 60_000;
    const expired = await env.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: t.auth,
    });
    env.clock.now = saved;
    expect(expired.statusCode).toBe(401);
  });
});

describe('Passwort-Reset', () => {
  it('setzt das Passwort und sperrt alle Refresh-Tokens', async () => {
    const t = await registerAndLogin(env);
    expect((await post('/auth/password-reset', { email: t.email })).statusCode).toBe(200);
    const token = tokenFromMail(env.mailer, t.email);
    const newPassword = 'ein-ganz-neues-passwort';
    expect(
      (await post('/auth/password-reset/confirm', { token, password: newPassword })).statusCode,
    ).toBe(200);
    expect(
      (await post('/auth/password-reset/confirm', { token, password: newPassword })).statusCode,
    ).toBe(400);
    expect((await post('/auth/refresh', { refreshToken: t.refreshToken })).statusCode).toBe(401);
    const device = { kind: 'desktop', os: 'x', name: 'y' };
    expect(
      (await post('/auth/login', { email: t.email, password: newPassword, device })).statusCode,
    ).toBe(200);
    // Unbekannte Adresse: gleiche Antwort, keine Mail
    const mails = env.mailer.outbox.length;
    expect((await post('/auth/password-reset', { email: uniqueEmail() })).statusCode).toBe(200);
    expect(env.mailer.outbox.length).toBe(mails);
  });
});

describe('Zwei-Faktor (TOTP)', () => {
  it('richtet TOTP ein und verlangt es danach beim Anmelden', async () => {
    const t = await registerAndLogin(env);
    const setup = await post('/auth/totp/setup', {}, t.auth);
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUrl } = setup.json<{ secret: string; otpauthUrl: string }>();
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect((await post('/auth/totp/verify', { code: '000000' }, t.auth)).statusCode).toBe(400);
    const code = hotp(secret, currentStep(env.clock.now));
    expect((await post('/auth/totp/verify', { code }, t.auth)).statusCode).toBe(200);

    const device = { kind: 'desktop', os: 'x', name: 'y' };
    const without = await post('/auth/login', { email: t.email, password: PASSWORD, device });
    expect(without.json()).toMatchObject({ error: 'totp_required' });
    // Derselbe Code darf nicht erneut verwendet werden
    const replay = await post('/auth/login', {
      email: t.email,
      password: PASSWORD,
      device,
      totp: code,
    });
    expect(replay.json()).toMatchObject({ error: 'invalid_totp' });
    env.clock.now += 30_000;
    const next = hotp(secret, currentStep(env.clock.now));
    expect(
      (await post('/auth/login', { email: t.email, password: PASSWORD, device, totp: next }))
        .statusCode,
    ).toBe(200);
  });

  it('Manager ohne TOTP erreichen nur die TOTP-Einrichtung', async () => {
    const t = await registerAndLogin(env);
    await env.database.db.update(users).set({ role: 'manager' }).where(eq(users.email, t.email));
    const m = await login(env, t.email);
    expect(m.totpSetupRequired).toBe(true);
    const blocked = await env.app.inject({ method: 'GET', url: '/api/v1/status', headers: m.auth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: 'totp_setup_required' });
    expect((await post('/auth/totp/setup', {}, m.auth)).statusCode).toBe(200);
  });
});

describe('Rate-Limits', () => {
  it('begrenzt /auth/* auf 10 Anfragen je Minute', async () => {
    const limited = await createTestEnv({ auth: 10, device: 60 });
    try {
      const device = { kind: 'desktop', os: 'x', name: 'y' };
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'a@example.test', password: 'falsch', device },
        });
        codes.push(res.statusCode);
      }
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes[10]).toBe(429);
      limited.clock.now += 61_000;
      const later = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'a@example.test', password: 'falsch', device },
      });
      expect(later.statusCode).toBe(401);
    } finally {
      await limited.close();
    }
  });
});
