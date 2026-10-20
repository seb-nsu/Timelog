import type { TokenResponse } from '@timelog/shared';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { type App, buildApp } from '../src/app.js';
import { type Database, createDatabase } from '../src/db/index.js';
import { MemoryMailer } from '../src/mailer.js';

export const PASSWORD = 'korrekt-pferd-batterie';

export interface TestEnv {
  app: App;
  database: Database;
  mailer: MemoryMailer;
  clock: { now: number };
  close: () => Promise<void>;
}

export async function createTestEnv(limits = { auth: 1000, device: 1000 }): Promise<TestEnv> {
  const database = createDatabase(inject('databaseUrl'));
  const mailer = new MemoryMailer();
  const clock = { now: Date.parse('2026-10-15T07:00:00Z') };
  const app = await buildApp({
    db: database.db,
    mailer,
    jwtSecret: 'test-secret-test-secret-test-secret!',
    totpKey: Buffer.alloc(32, 7),
    networkSecret: 'network-secret-network-secret-123',
    appUrl: 'https://app.test',
    logLevel: 'silent',
    now: () => clock.now,
    limits,
  });
  await app.ready();
  return {
    app,
    database,
    mailer,
    clock,
    close: async () => {
      await app.close();
      await database.pool.end();
    },
  };
}

export function tokenFromMail(mailer: MemoryMailer, to: string): string {
  const mail = [...mailer.outbox].reverse().find((m) => m.to === to);
  const token = mail?.text.match(/token=([\w-]+)/)?.[1];
  if (!token) throw new Error(`Keine Mail mit Token an ${to}`);
  return token;
}

export const uniqueEmail = (): string => `nutzer-${randomUUID()}@example.test`;

export async function registerAndLogin(
  env: TestEnv,
  email = uniqueEmail(),
  kind: 'desktop' | 'mobile' = 'desktop',
): Promise<TokenResponse & { email: string; auth: { authorization: string } }> {
  const { app, mailer } = env;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: PASSWORD, name: 'Test' },
  });
  if (reg.statusCode !== 200) throw new Error(`register: ${reg.body}`);
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    payload: { token: tokenFromMail(mailer, email) },
  });
  return login(env, email, kind);
}

export async function login(
  env: TestEnv,
  email: string,
  kind: 'desktop' | 'mobile' = 'desktop',
  extra: Record<string, unknown> = {},
): Promise<TokenResponse & { email: string; auth: { authorization: string } }> {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email,
      password: PASSWORD,
      device: { kind, os: 'test-os', name: 'Testgerät' },
      ...extra,
    },
  });
  if (res.statusCode !== 200) throw new Error(`login: ${res.body}`);
  const body = res.json<TokenResponse>();
  return { ...body, email, auth: { authorization: `Bearer ${body.accessToken}` } };
}

export function event(type: string, ts: string, extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type,
    source: type.startsWith('manual') || type.startsWith('session') ? 'user' : 'system',
    ts,
    tz: 'Europe/Berlin',
    createdAt: ts,
    ...extra,
  };
}
