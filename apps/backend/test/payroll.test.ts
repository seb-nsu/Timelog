// Lohn-Export und Personio-Übertragung: nur Admin, nur freigegebene Monate (Snapshot), Audit.
import type { PayrollTransfer } from '@timelog/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { auditLog, payrollCredentials } from '../src/db/schema.js';
import { type TestEnv, createTestEnv } from './helpers.js';
import { type OrgSetup, api, setupOrg, workday } from './org-helpers.js';

interface Call {
  method: string;
  path: string;
  body: string;
}

/** Nachgebildete Personio-API v2 (Token, Personen, Attendance Periods). */
function fakePersonio(emails: Record<string, string>) {
  const calls: Call[] = [];
  let next = 1;
  const state = { failCreate: false };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (url.pathname === '/v2/auth/token') {
      const form = new URLSearchParams(body);
      return Promise.resolve(
        form.get('client_secret') === 'geheim'
          ? json(200, { access_token: 'tok', expires_in: 86400 })
          : json(401, { type: 'unauthorized' }),
      );
    }
    if (auth !== 'Bearer tok') return Promise.resolve(json(401, { type: 'unauthorized' }));
    if (url.pathname === '/v2/persons') {
      const email = url.searchParams.get('email') ?? '';
      const id = emails[email];
      return Promise.resolve(json(200, { _data: id ? [{ id, email }] : [] }));
    }
    if (url.pathname === '/v2/attendance-periods' && method === 'POST') {
      if (state.failCreate) return Promise.resolve(json(422, { type: 'invalid_period' }));
      return Promise.resolve(json(201, { id: `p${String(next++)}` }));
    }
    if (url.pathname.startsWith('/v2/attendance-periods/') && method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(json(404, { type: 'not_found' }));
  };
  return { calls, state, fetch: fetchFn };
}

let env: TestEnv;
let org: OrgSetup;
let personio: ReturnType<typeof fakePersonio>;

beforeAll(async () => {
  const emails: Record<string, string> = {};
  personio = fakePersonio(emails);
  env = await createTestEnv(undefined, {
    personio: { baseUrl: 'https://personio.test', fetch: personio.fetch },
  });
  org = await setupOrg(env);
  emails[org.member.email] = '9001';
  await workday(env, org.member);
  await workday(env, org.other);
  // Nur der Monat des Mitglieds wird freigegeben
  await api(env, org.member, 'POST', '/approvals/2026-10');
  const ok = await api(
    env,
    org.manager,
    'POST',
    `/org/approvals/${org.member.userId}/2026-10/approve`,
    {},
  );
  if (ok.status !== 200) throw new Error(`approve: ${ok.raw}`);
});
afterAll(() => env.close());

async function actions(): Promise<string[]> {
  const rows = await asOwner(env.database.db, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, org.orgId)),
  );
  return rows.map((r) => r.action);
}

const exportUrl = (format: string, month = '2026-10') =>
  `/api/v1/org/payroll/export?month=${month}&format=${format}`;

describe('Lohn-Export', () => {
  it('nur Admins; Konfiguration und Personalnummern mit Audit', async () => {
    expect((await api(env, org.manager, 'GET', '/org/payroll/config')).status).toBe(403);
    expect((await api(env, org.member, 'GET', '/org/payroll/members')).status).toBe(403);
    const res = await env.app.inject({
      method: 'GET',
      url: exportUrl('lexware'),
      headers: org.manager.auth,
    });
    expect(res.statusCode).toBe(403);

    // Ohne Lohnart: unvollständig
    await api(env, org.admin, 'PUT', `/org/payroll/members/${org.member.userId}`, {
      personnelNumber: '00042',
    });
    const incomplete = await env.app.inject({
      method: 'GET',
      url: exportUrl('lexware'),
      headers: org.admin.auth,
    });
    expect(incomplete.statusCode).toBe(400);

    const cfg = await api(env, org.admin, 'PUT', '/org/payroll/config', {
      datev: { beraterNr: '1234567', mandantenNr: '12345', wageTypes: { hours: '100' } },
      lexware: { wageTypes: { hours: '1000', vacation: '1300' } },
    });
    expect(cfg.status).toBe(200);
    const members = await api<{ members: { userId: string; personnelNumber?: string }[] }>(
      env,
      org.admin,
      'GET',
      '/org/payroll/members',
    );
    expect(members.body.members.find((m) => m.userId === org.member.userId)?.personnelNumber).toBe(
      '00042',
    );
    const acts = await actions();
    expect(acts).toContain('payroll.config');
    expect(acts).toContain('payroll.member');
  });

  it('exportiert nur freigegebene Monate mit Personalnummer, aus dem Snapshot', async () => {
    await api(env, org.admin, 'PUT', `/org/payroll/members/${org.other.userId}`, {
      personnelNumber: '00043',
    });
    const res = await env.app.inject({
      method: 'GET',
      url: exportUrl('lexware'),
      headers: org.admin.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/windows-1252/);
    expect(res.headers['content-disposition']).toContain('lohn_lexware_2026-10.csv');
    expect(res.headers['x-timelog-exported']).toBe('1');
    const text = res.body;
    expect(text.split('\r\n')[0]).toBe('Jahr;Monat;Personalnummer;Lohnartnummer;Wert');
    expect(text).toMatch(/^2026;10;00042;1000;\d+,\d\d$/m);
    expect(text).not.toContain('00043'); // Monat nicht freigegeben

    // Spätere Ereignisse ändern den freigegebenen Monat nicht (Snapshot)
    await workday(env, org.member, '2026-10-13');
    const again = await env.app.inject({
      method: 'GET',
      url: exportUrl('lexware'),
      headers: org.admin.auth,
    });
    expect(again.body).toBe(text);

    const lodas = await env.app.inject({
      method: 'GET',
      url: exportUrl('datev_lodas'),
      headers: org.admin.auth,
    });
    expect(lodas.statusCode).toBe(200);
    expect(lodas.body).toContain('[Bewegungsdaten]');
    expect(lodas.body).toMatch(/^1;01\/10\/2026;\d+,\d\d;01;100;00042;$/m);

    const none = await env.app.inject({
      method: 'GET',
      url: exportUrl('lexware', '2026-09'),
      headers: org.admin.auth,
    });
    expect(none.statusCode).toBe(409);
    expect(await actions()).toContain('payroll.export');
  });
});

describe('Personio', () => {
  it('Zugangsdaten verschlüsselt, Secret wird nie ausgegeben', async () => {
    expect(
      (await api(env, org.admin, 'POST', '/org/payroll/personio/transfer', { month: '2026-10' }))
        .status,
    ).toBe(409);
    const set = await api<{ configured: boolean; clientId: string }>(
      env,
      org.admin,
      'PUT',
      '/org/payroll/personio',
      {
        clientId: 'papi-1',
        clientSecret: 'geheim',
      },
    );
    expect(set.body).toMatchObject({ configured: true, clientId: 'papi-1' });
    expect(set.raw).not.toContain('geheim');
    const [row] = await asOwner(env.database.db, (tx) =>
      tx.select().from(payrollCredentials).where(eq(payrollCredentials.orgId, org.orgId)),
    );
    expect(row?.clientSecretEnc).not.toContain('geheim');
    expect((await api(env, org.manager, 'GET', '/org/payroll/personio')).status).toBe(403);
  });

  it('überträgt Arbeitsabschnitte freigegebener Monate und protokolliert das Ergebnis', async () => {
    const res = await api<PayrollTransfer>(
      env,
      org.admin,
      'POST',
      '/org/payroll/personio/transfer',
      {
        month: '2026-10',
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const member = res.body.members.find((m) => m.userId === org.member.userId);
    expect(member?.status).toBe('transferred');
    expect(member?.periods).toBeGreaterThan(0);
    expect(res.body.members.find((m) => m.userId === org.other.userId)?.status).toBe('skipped');

    const creates = personio.calls.filter(
      (c) => c.method === 'POST' && c.path.startsWith('/v2/attendance-periods'),
    );
    expect(creates.length).toBe(member?.periods);
    expect(creates[0]?.path).toContain('skip_approval=true');
    const body = JSON.parse(creates[0]?.body ?? '{}') as {
      person: { id: string };
      type: string;
      start: { date_time: string };
    };
    expect(body).toMatchObject({ person: { id: '9001' }, type: 'WORK' });
    // Lokale Zeit ohne Offset (Europe/Berlin): Arbeitsbeginn 08:00
    expect(body.start.date_time).toBe('2026-10-14T08:00:00');

    // Erneute Übertragung ersetzt die früheren Perioden
    personio.calls.length = 0;
    const second = await api<PayrollTransfer>(
      env,
      org.admin,
      'POST',
      '/org/payroll/personio/transfer',
      {
        month: '2026-10',
      },
    );
    expect(second.body.status).toBe('ok');
    expect(personio.calls.filter((c) => c.method === 'DELETE')).toHaveLength(member?.periods ?? -1);

    // Fehler von Personio landen im Protokoll, ohne den Rest abzubrechen
    personio.state.failCreate = true;
    const failed = await api<PayrollTransfer>(
      env,
      org.admin,
      'POST',
      '/org/payroll/personio/transfer',
      {
        month: '2026-10',
      },
    );
    personio.state.failCreate = false;
    expect(failed.body.status).toBe('failed');
    expect(failed.body.members.find((m) => m.userId === org.member.userId)?.message).toContain(
      '422',
    );

    const log = await api<{ transfers: PayrollTransfer[] }>(
      env,
      org.admin,
      'GET',
      '/org/payroll/transfers',
    );
    expect(log.body.transfers.map((t) => t.status)).toEqual(['failed', 'ok', 'ok']);
    expect(await actions()).toContain('payroll.transfer');
  });
});
