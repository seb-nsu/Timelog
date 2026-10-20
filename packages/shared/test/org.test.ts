import { describe, expect, it } from 'vitest';
import { createApiClient, managerDaySchema, orgConfigUpdate, ssoConfig } from '../src/index.js';

describe('Schemas der Firmenversion', () => {
  it('Manager-Tagesansicht lässt keine Sitzungen, Quellen oder Geräte durch', () => {
    const day = {
      date: '2026-10-14',
      start: '2026-10-14T06:00:00Z',
      end: '2026-10-14T15:05:00Z',
      breakMinutes: 0,
      breakTopUpMin: 45,
      netMinutes: 500,
      status: 'unchecked',
      warnings: ['break_violation'],
    };
    expect(managerDaySchema.safeParse(day).success).toBe(true);
    expect(managerDaySchema.safeParse({ ...day, sessions: [] }).success).toBe(false);
    expect(managerDaySchema.safeParse({ ...day, deviceId: 'x' }).success).toBe(false);
  });

  it('SSO-Secrets nur als Name einer SSO_-Umgebungsvariable', () => {
    const oidc = {
      provider: 'entra',
      issuer: 'https://login.microsoftonline.com/t/v2.0',
      clientId: 'c',
    };
    expect(ssoConfig.safeParse({ oidc: { ...oidc, clientSecretEnv: 'SSO_ACME' } }).success).toBe(
      true,
    );
    expect(ssoConfig.safeParse({ oidc: { ...oidc, clientSecretEnv: 'JWT_SECRET' } }).success).toBe(
      false,
    );
    expect(ssoConfig.safeParse({ oidc: { ...oidc, clientSecret: 'geheim' } }).success).toBe(false);
  });

  it('Aufbewahrung 2 bis 6 Jahre, gesetzliche Schwellen nicht einstellbar', () => {
    expect(orgConfigUpdate.safeParse({ retentionYears: 1 }).success).toBe(false);
    expect(orgConfigUpdate.safeParse({ retentionYears: 6 }).success).toBe(true);
    const parsed = orgConfigUpdate.parse({ rules: { shutdownBonusMin: 0, maxDayH: 12 } });
    expect(parsed.rules).toEqual({ shutdownBonusMin: 0 });
  });
});

describe('API-Client Firmenversion', () => {
  it('baut Pfade und Abfragen für Freigaben und SSO', async () => {
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'tok',
      fetch: (input) => {
        calls.push(input instanceof URL ? input.toString() : JSON.stringify(input));
        return Promise.resolve(new Response(JSON.stringify({ approvals: [] }), { status: 200 }));
      },
    });
    await client.org.approvals.list('2026-10', 'submitted');
    expect(calls[0]).toBe('https://api.test/api/v1/org/approvals?month=2026-10&status=submitted');
    expect(client.sso.startUrl('acme', 'oidc', 'https://admin.test/sso')).toBe(
      'https://api.test/api/v1/auth/sso/acme/start?method=oidc&redirect=https%3A%2F%2Fadmin.test%2Fsso',
    );
  });
});
