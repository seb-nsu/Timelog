// Firmenversion: Rollen, Teams, Einladungen, Firmen-Netze, Regelwerk-Parameter, Freigaben, Audit-Log.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { approvals, auditLog, corrections, invitations } from '../src/db/schema.js';
import { networkHmac, networkKey } from '../src/routes/profile.js';
import {
  PASSWORD,
  type TestEnv,
  createTestEnv,
  login,
  registerAndLogin,
  tokenFromMail,
  uniqueEmail,
} from './helpers.js';
import { type OrgSetup, api, createOrg, setupOrg, workday } from './org-helpers.js';

let env: TestEnv;
let org: OrgSetup;
beforeAll(async () => {
  env = await createTestEnv();
  org = await setupOrg(env);
});
afterAll(() => env.close());

async function auditActions(orgId: string): Promise<string[]> {
  const rows = await asOwner(env.database.db, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, orgId)),
  );
  return rows.map((r) => r.action);
}

describe('Organisation und Rollen', () => {
  it('Anlegen macht den Aufrufer zum Admin; Firmen-Endpunkte verlangen TOTP', async () => {
    const t = await registerAndLogin(env);
    const created = await api<{ orgId: string }>(env, t, 'POST', '/orgs', {
      name: 'Neu GmbH',
      slug: `neu-${String(Date.now())}`,
    });
    expect(created.status).toBe(200);
    // Altes Token kennt die Organisation noch nicht
    expect((await api(env, t, 'GET', '/org/me')).status).toBe(403);
    const fresh = await login(env, t.email);
    expect(fresh.totpSetupRequired).toBe(true);
    const me = await api(env, fresh, 'GET', '/org/me');
    expect(me.status).toBe(403);
    expect(me.body).toMatchObject({ error: 'totp_setup_required' });
    // Zweite Organisation für dasselbe Konto geht nicht
    expect((await api(env, t, 'POST', '/orgs', { name: 'X', slug: 'x-zweite' })).status).toBe(409);
  });

  it('/org/me liefert Rolle und Organisation; normale Nutzer kommen an nichts anderes', async () => {
    const me = await api<{ user: { role: string }; org: { id: string } }>(
      env,
      org.member,
      'GET',
      '/org/me',
    );
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('user');
    expect(me.body.org.id).toBe(org.orgId);
    for (const url of [
      '/org/members',
      '/org/teams',
      '/org/approvals?month=2026-10',
      '/org/audit',
    ]) {
      expect((await api(env, org.member, 'GET', url)).status).toBe(403);
    }
  });

  it('Manager sieht nur Mitglieder eigener Teams, ohne E-Mail und Rolle', async () => {
    const res = await api<{ members: Record<string, unknown>[] }>(
      env,
      org.manager,
      'GET',
      '/org/members',
    );
    expect(res.status).toBe(200);
    const ids = res.body.members.map((m) => m.id);
    expect(ids).toContain(org.member.userId);
    expect(ids).not.toContain(org.other.userId);
    expect(ids).not.toContain(org.admin.userId);
    for (const m of res.body.members)
      expect(Object.keys(m).sort()).toEqual(['id', 'name', 'teamId']);
    const teams = await api<{ teams: { id: string }[] }>(env, org.manager, 'GET', '/org/teams');
    expect(teams.body.teams.map((t) => t.id)).toEqual([org.teamA]);
  });

  it('Admin sieht alle Mitglieder mit Rolle; Manager darf keine Admin-Aktionen', async () => {
    const res = await api<{ members: { id: string; role?: string; email?: string }[] }>(
      env,
      org.admin,
      'GET',
      '/org/members',
    );
    expect(res.body.members).toHaveLength(4);
    expect(res.body.members.find((m) => m.id === org.manager.userId)?.role).toBe('manager');
    const forbidden: [string, string, unknown?][] = [
      ['GET', '/org/config'],
      ['PUT', '/org/config', { rules: { shutdownBonusMin: 0 } }],
      ['POST', '/org/invite', { email: uniqueEmail() }],
      ['POST', '/org/teams', { name: 'X' }],
      ['PATCH', `/org/members/${org.member.userId}`, { role: 'admin' }],
      ['GET', '/org/audit'],
      ['GET', '/org/export?month=2026-10'],
      ['POST', '/org/networks', { kind: 'fingerprint', label: 'Büro', fingerprint: 'abcdefgh12' }],
      [
        'PATCH',
        `/org/members/${org.member.userId}/days/2026-10-14`,
        { field: 'start', time: '2026-10-14T06:00:00Z', reason: 'x' },
      ],
    ];
    for (const [method, url, body] of forbidden) {
      const r = await api(env, org.manager, method as 'GET', url, body);
      expect(r.status, `${method} ${url}`).toBe(403);
    }
  });

  it('Rollenänderung wirkt sofort und landet im Audit-Log; letzter Admin bleibt Admin', async () => {
    const extra = await api<{ id: string }>(env, org.admin, 'POST', '/org/teams', { name: 'Tmp' });
    const res = await api<{ role: string; teamId: string }>(
      env,
      org.admin,
      'PATCH',
      `/org/members/${org.other.userId}`,
      { teamId: extra.body.id },
    );
    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(extra.body.id);
    await api(env, org.admin, 'PATCH', `/org/members/${org.other.userId}`, { teamId: org.teamB });
    await api(env, org.admin, 'DELETE', `/org/teams/${extra.body.id}`);
    const self = await api(env, org.admin, 'PATCH', `/org/members/${org.admin.userId}`, {
      role: 'user',
    });
    expect(self.status).toBe(409);
    expect(self.body).toMatchObject({ error: 'last_admin' });
    const actions = await auditActions(org.orgId);
    expect(actions).toEqual(
      expect.arrayContaining([
        'org.create',
        'team.create',
        'team.update',
        'team.delete',
        'member.invite',
        'invitation.accept',
        'member.update',
      ]),
    );
  });
});

describe('Einladungen', () => {
  it('Info, Annahme, kein zweites Konto mit derselben Adresse, Widerruf', async () => {
    const email = uniqueEmail();
    const inv = await api<{ id: string }>(env, org.admin, 'POST', '/org/invite', {
      email,
      role: 'user',
      teamId: org.teamA,
    });
    expect(inv.status).toBe(200);
    const token = tokenFromMail(env.mailer, email);
    const info = await env.app.inject({ method: 'GET', url: `/api/v1/auth/invite?token=${token}` });
    expect(info.json()).toEqual({ orgName: 'Firma', email, role: 'user' });
    const list = await api<{ invitations: { id: string }[] }>(
      env,
      org.admin,
      'GET',
      '/org/invitations',
    );
    expect(list.body.invitations.map((i) => i.id)).toContain(inv.body.id);

    const accept = () =>
      env.app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite/accept',
        payload: { token, name: 'Neu', password: PASSWORD },
      });
    expect((await accept()).statusCode).toBe(200);
    expect((await accept()).statusCode).toBe(400); // Einmal-Link
    const t = await login(env, email);
    const me = await api<{ user: { teamId: string } }>(env, t, 'GET', '/org/me');
    expect(me.body.user.teamId).toBe(org.teamA);

    expect((await api(env, org.admin, 'POST', '/org/invite', { email })).status).toBe(409);

    const email2 = uniqueEmail();
    const inv2 = await api<{ id: string }>(env, org.admin, 'POST', '/org/invite', {
      email: email2,
    });
    expect((await api(env, org.admin, 'DELETE', `/org/invitations/${inv2.body.id}`)).status).toBe(
      200,
    );
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/accept',
      payload: { token: tokenFromMail(env.mailer, email2), name: 'X', password: PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    const [row] = await asOwner(env.database.db, (tx) =>
      tx.select().from(invitations).where(eq(invitations.id, inv2.body.id)),
    );
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe('Eingeschränkte Tagesansicht', () => {
  it('Manager sieht je Tag nur Beginn, Ende, Pausen, Auffüllung, Netto, Status, Warnungen', async () => {
    await workday(env, org.member);
    const res = await api<{ days: Record<string, unknown>[] }>(
      env,
      org.manager,
      'GET',
      `/org/members/${org.member.userId}/days?from=2026-10-14&to=2026-10-14`,
    );
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    const day = res.body.days[0] ?? {};
    expect(Object.keys(day).sort()).toEqual(
      [
        'breakMinutes',
        'breakTopUpMin',
        'date',
        'end',
        'netMinutes',
        'start',
        'status',
        'warnings',
      ].sort(),
    );
    expect(day).toMatchObject({
      start: '2026-10-14T06:00:00.000Z',
      end: '2026-10-14T15:05:00.000Z',
      netMinutes: 500,
      breakTopUpMin: 45,
    });
    // Keine Spur von Sitzungen, Quellen, Ereignissen oder Geräten in der Antwort
    expect(res.raw).not.toMatch(/sessions|startSource|endSource|deviceId|source|"boot"|"shutdown"/);
  });

  it('Manager sieht keine Mitglieder fremder Teams; Rohereignisse bleiben privat', async () => {
    const res = await api(
      env,
      org.manager,
      'GET',
      `/org/members/${org.other.userId}/days?from=2026-10-14&to=2026-10-14`,
    );
    expect(res.status).toBe(404);
    const detail = await api(env, org.manager, 'GET', `/org/approvals/${org.other.userId}/2026-10`);
    expect(detail.status).toBe(404);
    // Es gibt keinen Org-Endpunkt für Ereignisse, Spannen oder Geräte von Mitgliedern
    for (const url of [
      `/org/members/${org.member.userId}/events`,
      `/org/members/${org.member.userId}/devices`,
    ]) {
      expect((await api(env, org.manager, 'GET', url)).status).toBe(404);
    }
    // /events liefert immer nur die eigenen Ereignisse
    const own = await api<{ events: unknown[] }>(env, org.manager, 'GET', '/events');
    expect(own.body.events).toEqual([]);
  });

  it('Mandantentrennung: Admin einer anderen Firma sieht nichts', async () => {
    const foreign = await createOrg(env, 'Andere');
    for (const url of [
      `/org/members/${org.member.userId}/days?from=2026-10-14&to=2026-10-14`,
      `/org/approvals/${org.member.userId}/2026-10`,
    ]) {
      expect((await api(env, foreign, 'GET', url)).status).toBe(404);
    }
    const members = await api<{ members: { id: string }[] }>(env, foreign, 'GET', '/org/members');
    expect(members.body.members.map((m) => m.id)).toEqual([foreign.userId]);
    const audit = await api<{ entries: { action: string }[] }>(env, foreign, 'GET', '/org/audit');
    expect(audit.body.entries.map((e) => e.action)).toEqual(['org.create']);
    expect(
      (await api(env, foreign, 'PATCH', `/org/members/${org.member.userId}`, { role: 'admin' }))
        .status,
    ).toBe(404);
  });
});

describe('Regelwerk-Parameter und Firmen-Netze', () => {
  it('shutdownBonusMin 0 wirkt auf die Berechnung, Version steigt, Audit-Eintrag', async () => {
    const before = await api<{ rulesConfigVersion: number; ruleDefaults: Record<string, number> }>(
      env,
      org.admin,
      'GET',
      '/org/config',
    );
    expect(before.body.ruleDefaults.shutdownBonusMin).toBe(5);
    const put = await api<{
      rules: Record<string, number>;
      rulesConfigVersion: number;
      retentionYears: number;
    }>(env, org.admin, 'PUT', '/org/config', {
      rules: { shutdownBonusMin: 0, standbyBreakMin: 20 },
      retentionYears: 3,
    });
    expect(put.status).toBe(200);
    expect(put.body.rules).toEqual({ shutdownBonusMin: 0, standbyBreakMin: 20 });
    expect(put.body.rulesConfigVersion).toBe(before.body.rulesConfigVersion + 1);
    const days = await api<{ days: { end: string }[] }>(
      env,
      org.member,
      'GET',
      '/days?from=2026-10-14&to=2026-10-14',
    );
    expect(days.body.days[0]?.end).toBe('2026-10-14T15:00:00.000Z');
    // Ungültige Werte (gesetzliche Schwellen sind gar nicht einstellbar)
    expect(
      (await api(env, org.admin, 'PUT', '/org/config', { rules: { shutdownBonusMin: -1 } })).status,
    ).toBe(400);
    expect((await api(env, org.admin, 'PUT', '/org/config', { retentionYears: 1 })).status).toBe(
      400,
    );
    await api(env, org.admin, 'PUT', '/org/config', { rules: {} });
    expect(await auditActions(org.orgId)).toContain('config.update');
  });

  it('Firmen-Netz gilt für alle Mitglieder, HMAC mit Org-Schlüssel, nur Admin verwaltet es', async () => {
    const add = await api<{ id: string; fingerprintHmac: string; scope: string }>(
      env,
      org.admin,
      'POST',
      '/org/networks',
      {
        kind: 'fingerprint',
        label: 'Büro',
        fingerprint: 'gw:AA-BB-CC-DD-EE-FF',
      },
    );
    expect(add.status).toBe(200);
    expect(add.body.scope).toBe('org');
    const mine = await api<{
      networks: { id: string; scope: string; fingerprintHmac?: string }[];
      keys: { org?: string };
    }>(env, org.member, 'GET', '/networks');
    const n = mine.body.networks.find((x) => x.id === add.body.id);
    expect(n?.scope).toBe('org');
    const orgKey = Buffer.from(mine.body.keys.org ?? '', 'base64');
    expect(n?.fingerprintHmac).toBe(networkHmac(orgKey, 'gw:aa:bb:cc:dd:ee:ff'));
    expect(add.raw).not.toContain('AA-BB');
    expect(orgKey.equals(networkKey('x', 'y'))).toBe(false);
    // Mitglied kann Firmen-Netz nicht löschen
    expect((await api(env, org.member, 'DELETE', `/networks/${add.body.id}`)).status).toBe(404);
    expect((await api(env, org.admin, 'DELETE', `/org/networks/${add.body.id}`)).status).toBe(200);
    expect(await auditActions(org.orgId)).toEqual(
      expect.arrayContaining(['network.create', 'network.delete']),
    );
  });
});

describe('Monatsfreigabe', () => {
  it('Einreichen, Freigeben mit Snapshot; freigegebene Monate werden nie neu berechnet', async () => {
    const m = org.member;
    expect((await api(env, m, 'POST', '/approvals/2026-11')).status).toBe(400); // Zukunft
    const sub = await api<{ status: string }>(env, m, 'POST', '/approvals/2026-10');
    expect(sub.body.status).toBe('submitted');
    const list = await api<{ approvals: { userId: string; status: string }[] }>(
      env,
      org.manager,
      'GET',
      '/org/approvals?month=2026-10',
    );
    expect(list.body.approvals.find((a) => a.userId === m.userId)?.status).toBe('submitted');
    expect(list.body.approvals.map((a) => a.userId)).not.toContain(org.manager.userId);

    const detail = await api<{ totals: { netMinutes: number }; snapshot: boolean }>(
      env,
      org.manager,
      'GET',
      `/org/approvals/${m.userId}/2026-10`,
    );
    expect(detail.body.snapshot).toBe(false);
    expect(detail.body.totals.netMinutes).toBe(500);

    const ok = await api<{ status: string; approverId: string }>(
      env,
      org.manager,
      'POST',
      `/org/approvals/${m.userId}/2026-10/approve`,
      {},
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', approverId: org.manager.userId });
    expect(
      (await api(env, org.manager, 'POST', `/org/approvals/${m.userId}/2026-10/approve`, {}))
        .status,
    ).toBe(409);

    // Nachträgliches Ereignis und Regelwerk-Änderung ändern den freigegebenen Monat nicht
    await workday(env, m, '2026-10-13');
    await api(env, org.admin, 'PUT', '/org/config', { rules: { shutdownBonusMin: 0 } });
    const days = await api<{ days: { date: string; end: string }[] }>(
      env,
      m,
      'GET',
      '/days?from=2026-10-13&to=2026-10-14',
    );
    expect(days.body.days.map((d) => d.date)).toEqual(['2026-10-14']);
    expect(days.body.days[0]?.end).toBe('2026-10-14T15:05:00.000Z');
    const frozen = await api<{ snapshot: boolean; days: { date: string }[] }>(
      env,
      org.manager,
      'GET',
      `/org/approvals/${m.userId}/2026-10`,
    );
    expect(frozen.body.snapshot).toBe(true);
    expect(frozen.body.days.map((d) => d.date)).toEqual(['2026-10-14']);
    await api(env, org.admin, 'PUT', '/org/config', { rules: {} });

    // Mitglied kann den Monat nicht mehr korrigieren oder erneut einreichen
    const patch = await api(env, m, 'PATCH', '/days/2026-10-14', {
      field: 'start',
      time: '2026-10-14T05:30:00Z',
      reason: 'früher',
    });
    expect(patch.status).toBe(409);
    expect((await api(env, m, 'POST', '/approvals/2026-10')).status).toBe(409);
    const own = await api<{ approvals: { month: string; status: string }[] }>(
      env,
      m,
      'GET',
      '/approvals',
    );
    expect(own.body.approvals[0]).toMatchObject({ month: '2026-10', status: 'approved' });

    const [row] = await asOwner(env.database.db, (tx) =>
      tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.userId, m.userId), eq(approvals.month, '2026-10'))),
    );
    // Snapshot Version 2: Tage samt Projektaufteilung und Tagesorten
    expect(row?.snapshot).toMatchObject({ version: 2, projects: [] });
    expect(Array.isArray((row?.snapshot as { days?: unknown }).days)).toBe(true);
    expect(row?.rulesConfigVersion).toBeGreaterThan(0);
  });

  it('Admin korrigiert im freigegebenen Monat: Ereignis + Korrektur, Freigabe zurückgesetzt, Audit', async () => {
    const m = org.member;
    const noReason = await api(
      env,
      org.admin,
      'PATCH',
      `/org/members/${m.userId}/days/2026-10-14`,
      { field: 'start', time: '2026-10-14T05:30:00Z' },
    );
    expect(noReason.status).toBe(400);
    const res = await api<{ eventId: string; day: { start: string } }>(
      env,
      org.admin,
      'PATCH',
      `/org/members/${m.userId}/days/2026-10-14`,
      {
        field: 'start',
        time: '2026-10-14T05:30:00Z',
        reason: 'Laut Dienstplan früher begonnen',
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.day.start).toBe('2026-10-14T05:30:00.000Z');
    const [corr] = await asOwner(env.database.db, (tx) =>
      tx.select().from(corrections).where(eq(corrections.eventId, res.body.eventId)),
    );
    expect(corr).toMatchObject({ userId: m.userId, authorId: org.admin.userId, field: 'start' });
    const own = await api<{ approvals: { status: string }[] }>(env, m, 'GET', '/approvals');
    expect(own.body.approvals[0]?.status).toBe('submitted');
    expect(await auditActions(org.orgId)).toEqual(
      expect.arrayContaining([
        'approval.submit',
        'approval.approve',
        'day.correct',
        'approval.reopen',
      ]),
    );
  });

  it('Zurückweisen braucht Kommentar; erneutes Einreichen; keine Selbstfreigabe', async () => {
    const m = org.member;
    expect(
      (await api(env, org.manager, 'POST', `/org/approvals/${m.userId}/2026-10/reject`, {})).status,
    ).toBe(400);
    const rej = await api<{ status: string; comment: string }>(
      env,
      org.manager,
      'POST',
      `/org/approvals/${m.userId}/2026-10/reject`,
      { comment: 'Pause am 14. fehlt' },
    );
    expect(rej.body).toMatchObject({ status: 'rejected', comment: 'Pause am 14. fehlt' });
    const own = await api<{ approvals: { status: string; comment: string }[] }>(
      env,
      m,
      'GET',
      '/approvals',
    );
    expect(own.body.approvals[0]).toMatchObject({
      status: 'rejected',
      comment: 'Pause am 14. fehlt',
    });
    expect((await api(env, m, 'POST', '/approvals/2026-10')).status).toBe(200);

    await api(env, org.manager, 'POST', '/approvals/2026-10');
    const self = await api(
      env,
      org.manager,
      'POST',
      `/org/approvals/${org.manager.userId}/2026-10/approve`,
      {},
    );
    expect(self.status).toBe(403);
    // Admin darf den Monat des Managers freigeben
    expect(
      (
        await api(
          env,
          org.admin,
          'POST',
          `/org/approvals/${org.manager.userId}/2026-10/approve`,
          {},
        )
      ).status,
    ).toBe(200);
    expect(await auditActions(org.orgId)).toContain('approval.reject');
  });
});

describe('Export, Audit, Deaktivieren', () => {
  it('Admin exportiert den Monat als CSV und PDF; Export wird protokolliert', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/org/export?month=2026-10',
      headers: org.admin.auth,
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Personalnummer;Name;Datum;Beginn;Ende;Pause (min);davon aufgefüllt (min);Netto (min);Abwesenheit (min);Status;korrigiert;Warnungen;Freigabe',
    );
    expect(lines.some((l) => l.includes(';Person user;2026-10-14;'))).toBe(true);
    const pdf = await env.app.inject({
      method: 'GET',
      url: `/api/v1/org/export?month=2026-10&format=pdf&teamId=${org.teamA}`,
      headers: org.admin.auth,
    });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    const audit = await api<{ entries: { action: string; actorName?: string }[] }>(
      env,
      org.admin,
      'GET',
      '/org/audit?limit=2',
    );
    expect(audit.body.entries[0]).toMatchObject({ action: 'export.create' });
  });

  it('Audit-Log blättert seitenweise', async () => {
    const first = await api<{ entries: { id: string }[]; nextBefore?: string }>(
      env,
      org.admin,
      'GET',
      '/org/audit?limit=3',
    );
    expect(first.body.entries).toHaveLength(3);
    expect(first.body.nextBefore).toBeDefined();
    const second = await api<{ entries: { id: string }[] }>(
      env,
      org.admin,
      'GET',
      `/org/audit?limit=3&before=${encodeURIComponent(first.body.nextBefore ?? '')}`,
    );
    expect(second.body.entries.length).toBeGreaterThan(0);
  });

  it('Deaktiviertes Mitglied kann sich nicht mehr anmelden; Geräte gesperrt', async () => {
    const t = await registerAndLogin(env);
    expect(
      (await api(env, org.admin, 'POST', `/org/members/${org.admin.userId}/deactivate`)).status,
    ).toBe(409);
    const email = uniqueEmail();
    await api(env, org.admin, 'POST', '/org/invite', { email });
    await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/accept',
      payload: { token: tokenFromMail(env.mailer, email), name: 'Weg', password: PASSWORD },
    });
    const leaver = await login(env, email);
    const me = await api<{ user: { id: string } }>(env, leaver, 'GET', '/org/me');
    expect(
      (await api(env, org.admin, 'POST', `/org/members/${me.body.user.id}/deactivate`)).status,
    ).toBe(200);
    expect((await api(env, leaver, 'GET', '/status')).status).toBe(401);
    await expect(login(env, email)).rejects.toThrow(/account_deactivated/);
    expect(await auditActions(org.orgId)).toContain('member.deactivate');
    // Privates Konto ohne Organisation kommt an /org nicht heran
    expect((await api(env, t, 'GET', '/org/me')).status).toBe(403);
  });
});
