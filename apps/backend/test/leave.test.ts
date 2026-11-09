// Urlaubs- und Überstundenkonto: Anträge privat und in der Firma, Rollen, Stornierung, Audit.
import type { LeaveOverview, LeaveRequest, OvertimeView } from '@timelog/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../src/db/index.js';
import { absences, auditLog } from '../src/db/schema.js';
import { type TestEnv, createTestEnv, registerAndLogin } from './helpers.js';
import { type OrgSetup, api, setupOrg, userIdOf } from './org-helpers.js';

let env: TestEnv;
let org: OrgSetup;
beforeAll(async () => {
  env = await createTestEnv();
  org = await setupOrg(env);
});
afterAll(() => env.close());

async function actions(orgId: string): Promise<string[]> {
  const rows = await asOwner(env.database.db, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, orgId)),
  );
  return rows.map((r) => r.action);
}

async function absenceRows(userId: string) {
  return asOwner(env.database.db, (tx) =>
    tx
      .select({ date: absences.date, kind: absences.kind, requestId: absences.requestId })
      .from(absences)
      .where(eq(absences.userId, userId))
      .orderBy(absences.date),
  );
}

describe('Privatkonto', () => {
  it('Antrag ist sofort genehmigt, zählt nur Arbeitstage und erzeugt Abwesenheiten', async () => {
    const t = await registerAndLogin(env);
    const userId = await userIdOf(env, t.email);
    // Mo 02.11. – Mo 09.11.2026, letzter Tag halb: 5 + 0,5 Tage (Wochenende zählt nicht)
    const res = await api<LeaveRequest>(env, t, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-11-02',
      to: '2026-11-09',
      halfDayEnd: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', days: 5.5, minutes: 5.5 * 480 });
    const rows = await absenceRows(userId);
    expect(rows.map((r) => r.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-09',
    ]);
    expect(rows.every((r) => r.requestId === res.body.id)).toBe(true);

    const overview = await api<LeaveOverview>(env, t, 'GET', '/leave?year=2026');
    expect(overview.body.managed).toBe(false);
    expect(overview.body.account).toMatchObject({
      entitlement: 30,
      planned: 5.5,
      taken: 0,
      remaining: 24.5,
    });

    // Überschneidung mit dem eigenen Antrag
    const dup = await api(env, t, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-11-04',
      to: '2026-11-04',
    });
    expect(dup.status).toBe(409);
    // Nur Wochenende → keine Arbeitstage
    const weekend = await api(env, t, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-11-07',
      to: '2026-11-08',
    });
    expect(weekend.status).toBe(400);

    // Stornieren vor Beginn entfernt die Abwesenheiten; Historie bleibt
    const cancel = await api<LeaveRequest>(
      env,
      t,
      'POST',
      `/leave/requests/${res.body.id}/cancel`,
      {},
    );
    expect(cancel.body.status).toBe('cancelled');
    expect(cancel.body.history.map((h) => h.action)).toEqual(['request', 'approve', 'cancel']);
    expect(await absenceRows(userId)).toEqual([]);
  });

  it('Anspruch anteilig: Teilzeit und Eintritt im Jahr; Übertrag manuell setzbar', async () => {
    const t = await registerAndLogin(env);
    expect(
      (
        await api(env, t, 'PUT', '/leave/profile', {
          annualDays: 30,
          workdaysPerWeek: 4,
          entryDate: '2026-07-01',
        })
      ).status,
    ).toBe(200);
    const o = await api<LeaveOverview>(env, t, 'GET', '/leave?year=2026');
    // 30 · 4/5 = 24; 6 volle Monate → 12 Tage
    expect(o.body.account.entitlement).toBe(12);
    const adj = await api(env, t, 'POST', '/leave/adjustments', {
      year: 2026,
      kind: 'carry_over',
      days: 3,
      comment: 'Rest aus altem Arbeitgeber',
    });
    expect(adj.status).toBe(200);
    const o2 = await api<LeaveOverview>(env, t, 'GET', '/leave?year=2026');
    expect(o2.body.account).toMatchObject({ carryOver: 3, carryOverManual: true });
    expect(o2.body.adjustments).toHaveLength(1);
  });

  it('Überstundenabbau senkt den Saldo; Buchung und Höchstsaldo mit Warnung', async () => {
    const t = await registerAndLogin(env);
    const req = await api<LeaveRequest>(env, t, 'POST', '/leave/requests', {
      kind: 'overtime',
      from: '2026-10-14',
      to: '2026-10-14',
    });
    expect(req.body).toMatchObject({ status: 'approved', days: 1 });
    const before = env.clock.now;
    try {
      const ot = await api<OvertimeView>(env, t, 'GET', '/overtime?year=2026');
      expect(ot.status).toBe(200);
      // Soll bleibt (8 h), Gutschrift 0 → Saldo sinkt um 8 h
      expect(ot.body.balanceMinutes).toBe(-480);
      const oct = ot.body.months.find((m) => m.month === '2026-10');
      expect(oct).toMatchObject({ reducedMinutes: 480, balanceMinutes: -480 });

      await api(env, t, 'PUT', '/leave/settings', { maxOvertimeMinutes: 60 });
      const book = await api(env, t, 'POST', '/overtime/bookings', {
        month: '2026-10',
        minutes: 600,
        kind: 'correction',
        comment: 'Übertrag aus Papierliste',
      });
      expect(book.status).toBe(200);
      const ot2 = await api<OvertimeView>(env, t, 'GET', '/overtime?year=2026');
      expect(ot2.body).toMatchObject({ balanceMinutes: 120, maxBalanceMinutes: 60, overMax: true });
      expect(ot2.body.bookings).toHaveLength(1);
    } finally {
      env.clock.now = before;
    }
  });
});

describe('Firmenkonto', () => {
  it('Antrag ist offen, Manager wird benachrichtigt, Mitglied darf Konto nicht selbst pflegen', async () => {
    const res = await api<LeaveRequest>(env, org.member, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-11-16',
      to: '2026-11-20',
      note: 'Familienbesuch',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(await absenceRows(org.member.userId)).toEqual([]);
    const mail = [...env.mailer.outbox].reverse().find((m) => m.to === org.manager.email);
    expect(mail?.subject).toMatch(/Urlaub/);
    expect(mail?.text).not.toMatch(/Familienbesuch/); // Notiz bleibt in der App
    expect(await actions(org.orgId)).toContain('leave.request');

    expect((await api(env, org.member, 'PUT', '/leave/profile', { annualDays: 40 })).status).toBe(
      403,
    );
    expect(
      (
        await api(env, org.member, 'POST', '/overtime/bookings', {
          month: '2026-10',
          minutes: 60,
          kind: 'correction',
          comment: 'x',
        })
      ).status,
    ).toBe(403);
    // Urlaub nur per Antrag, nicht frei als Abwesenheit
    const free = await api(env, org.member, 'PUT', '/absences', {
      from: '2026-12-01',
      to: '2026-12-01',
      absences: [{ date: '2026-12-01', kind: 'vacation', minutes: 480 }],
    });
    expect(free.status).toBe(409);
    expect((free.body as { error: string }).error).toBe('leave_request_required');
  });

  it('Manager sieht Anträge seines Teams mit Überschneidungen, genehmigt mit Kommentar', async () => {
    // zweites Mitglied in Team A über den Admin
    const second = await api<LeaveRequest>(env, org.manager, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-11-19',
      to: '2026-11-23',
    });
    expect(second.body.status).toBe('pending');
    await api(env, org.other, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-11-16',
      to: '2026-11-16',
    });

    const list = await api<{
      requests: (LeaveRequest & { overlaps: { name: string; from: string; to: string }[] })[];
    }>(env, org.manager, 'GET', '/org/leave/requests?status=pending');
    expect(list.status).toBe(200);
    const users = list.body.requests.map((r) => r.userId);
    expect(users).toContain(org.member.userId);
    expect(users).not.toContain(org.other.userId); // Team B
    expect(users).not.toContain(org.manager.userId); // eigener Antrag nicht zur Entscheidung
    const mine = list.body.requests.find((r) => r.userId === org.member.userId);
    expect(mine?.overlaps).toContainEqual({
      name: 'Person manager',
      from: '2026-11-19',
      to: '2026-11-23',
    });

    const id = mine?.id ?? '';
    // Ablehnen braucht einen Kommentar
    expect(
      (await api(env, org.manager, 'POST', `/org/leave/requests/${id}/reject`, {})).status,
    ).toBe(400);
    const ok = await api<LeaveRequest>(
      env,
      org.manager,
      'POST',
      `/org/leave/requests/${id}/approve`,
      {
        comment: 'Viel Erholung',
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decisionComment: 'Viel Erholung' });
    expect(await absenceRows(org.member.userId)).toHaveLength(5);
    expect(
      env.mailer.outbox.some((m) => m.to === org.member.email && /genehmigt/.test(m.subject)),
    ).toBe(true);
    expect(await actions(org.orgId)).toContain('leave.approve');
    expect(
      (await api(env, org.manager, 'POST', `/org/leave/requests/${id}/approve`, {})).status,
    ).toBe(409);

    // Eigener Antrag: Selbstgenehmigung verboten, der Admin entscheidet
    expect(
      (await api(env, org.manager, 'POST', `/org/leave/requests/${second.body.id}/approve`, {}))
        .status,
    ).toBe(403);
    const rej = await api<LeaveRequest>(
      env,
      org.admin,
      'POST',
      `/org/leave/requests/${second.body.id}/reject`,
      { comment: 'Projektabschluss' },
    );
    expect(rej.body.status).toBe('rejected');
    expect(await actions(org.orgId)).toContain('leave.reject');
  });

  it('Manager darf über fremde Teams nicht entscheiden', async () => {
    const own = await api<{ requests: LeaveRequest[] }>(env, org.other, 'GET', '/leave?year=2026');
    const req = own.body.requests.find((r) => r.status === 'pending');
    expect(req).toBeDefined();
    const res = await api(
      env,
      org.manager,
      'POST',
      `/org/leave/requests/${req?.id ?? ''}/approve`,
      {},
    );
    expect([403, 404]).toContain(res.status);
  });

  it('Teamkalender: nur Name und Zeitraum, Krankheit erscheint als „abwesend“', async () => {
    await api(env, org.member, 'PUT', '/absences', {
      from: '2026-11-02',
      to: '2026-11-03',
      absences: [
        { date: '2026-11-02', kind: 'sick', minutes: 480 },
        { date: '2026-11-03', kind: 'sick', minutes: 480 },
      ],
    });
    const cal = await api<{
      entries: { userId: string; name: string; from: string; to: string; kind: string }[];
    }>(env, org.manager, 'GET', '/org/leave/calendar?from=2026-11-01&to=2026-11-30');
    expect(cal.status).toBe(200);
    const member = cal.body.entries.filter((e) => e.userId === org.member.userId);
    expect(member).toContainEqual(
      expect.objectContaining({ from: '2026-11-02', to: '2026-11-03', kind: 'absent' }),
    );
    expect(member).toContainEqual(
      expect.objectContaining({ from: '2026-11-16', to: '2026-11-20', kind: 'vacation' }),
    );
    expect(JSON.stringify(cal.body)).not.toMatch(/sick|note|Familienbesuch/);
    expect(cal.body.entries.map((e) => e.userId)).not.toContain(org.other.userId);
    // Freie Abwesenheiten ändern genehmigten Urlaub nicht
    expect(
      (await absenceRows(org.member.userId)).filter((a) => a.kind === 'vacation'),
    ).toHaveLength(5);
  });

  it('Stornierung: Person vor Beginn, danach nur Admin mit Kommentar', async () => {
    const r = await api<LeaveRequest>(env, org.other, 'POST', '/leave/requests', {
      kind: 'overtime',
      from: '2026-10-13',
      to: '2026-10-13',
    });
    await api(env, org.admin, 'POST', `/org/leave/requests/${r.body.id}/approve`, {});
    const before = env.clock.now;
    try {
      const own = await api<{ error: string }>(
        env,
        org.other,
        'POST',
        `/leave/requests/${r.body.id}/cancel`,
        {},
      );
      expect(own.status).toBe(409);
      expect(own.body.error).toBe('already_started');
      expect(
        (await api(env, org.admin, 'POST', `/org/leave/requests/${r.body.id}/cancel`, {})).status,
      ).toBe(400);
      expect(
        (
          await api(env, org.manager, 'POST', `/org/leave/requests/${r.body.id}/cancel`, {
            comment: 'x',
          })
        ).status,
      ).toBe(403);
      const ok = await api<LeaveRequest>(
        env,
        org.admin,
        'POST',
        `/org/leave/requests/${r.body.id}/cancel`,
        { comment: 'doch gearbeitet' },
      );
      expect(ok.body.status).toBe('cancelled');
      expect(ok.body.history.map((h) => h.action)).toEqual(['request', 'approve', 'cancel']);
    } finally {
      env.clock.now = before;
    }
    expect(await actions(org.orgId)).toContain('leave.cancel');
    const rows = await asOwner(env.database.db, (tx) =>
      tx
        .select()
        .from(absences)
        .where(and(eq(absences.userId, org.other.userId), eq(absences.kind, 'overtime'))),
    );
    expect(rows).toEqual([]);
  });

  it('Admin pflegt Anspruch und bucht Überstunden mit Audit, nie für sich selbst', async () => {
    const prof = await api(
      env,
      org.admin,
      'PUT',
      `/org/members/${org.member.userId}/leave-profile`,
      {
        annualDays: 28,
      },
    );
    expect(prof.status).toBe(200);
    const acc = await api<LeaveOverview & { name: string }>(
      env,
      org.manager,
      'GET',
      `/org/members/${org.member.userId}/leave?year=2026`,
    );
    expect(acc.body.account).toMatchObject({ entitlement: 28, planned: 5 });
    // Manager darf lesen, aber nicht pflegen
    expect(
      (
        await api(env, org.manager, 'PUT', `/org/members/${org.member.userId}/leave-profile`, {
          annualDays: 40,
        })
      ).status,
    ).toBe(403);
    const book = await api(
      env,
      org.admin,
      'POST',
      `/org/members/${org.member.userId}/overtime-bookings`,
      {
        month: '2026-10',
        minutes: -300,
        kind: 'payout',
        comment: 'Auszahlung Oktober',
      },
    );
    expect(book.status).toBe(200);
    expect(
      (
        await api(env, org.admin, 'POST', `/org/members/${org.admin.userId}/overtime-bookings`, {
          month: '2026-10',
          minutes: 60,
          kind: 'correction',
          comment: 'selbst',
        })
      ).status,
    ).toBe(403);
    const ot = await api<OvertimeView>(
      env,
      org.manager,
      'GET',
      `/org/members/${org.member.userId}/overtime?year=2026`,
    );
    expect(ot.body.bookings.map((b) => b.minutes)).toEqual([-300]);
    const acts = await actions(org.orgId);
    expect(acts).toContain('leave.profile');
    expect(acts).toContain('overtime.book');

    // Organisationseinstellung: Standardanspruch gilt für Mitglieder ohne eigenen Wert
    expect(
      (await api(env, org.admin, 'PUT', '/org/leave/settings', { defaultAnnualDays: 26 })).status,
    ).toBe(200);
    const other = await api<LeaveOverview>(env, org.other, 'GET', '/leave?year=2026');
    expect(other.body.account.entitlement).toBe(26);
    expect(other.body.managed).toBe(true);
  });

  it('Freigegebener Monat sperrt Anträge; Admin-Genehmigung öffnet die Freigabe neu', async () => {
    const r = await api<LeaveRequest>(env, org.member, 'POST', '/leave/requests', {
      kind: 'vacation',
      from: '2026-10-09',
      to: '2026-10-09',
    });
    expect(r.body.status).toBe('pending');
    expect((await api(env, org.member, 'POST', '/approvals/2026-10')).status).toBe(200);
    expect(
      (
        await api(
          env,
          org.manager,
          'POST',
          `/org/approvals/${org.member.userId}/2026-10/approve`,
          {},
        )
      ).status,
    ).toBe(200);
    // Neuer Antrag im gesperrten Monat
    expect(
      (
        await api(env, org.member, 'POST', '/leave/requests', {
          kind: 'vacation',
          from: '2026-10-08',
          to: '2026-10-08',
        })
      ).status,
    ).toBe(409);
    // Manager darf den gesperrten Monat nicht ändern
    expect(
      (await api(env, org.manager, 'POST', `/org/leave/requests/${r.body.id}/approve`, {})).status,
    ).toBe(409);
    const ok = await api<LeaveRequest>(
      env,
      org.admin,
      'POST',
      `/org/leave/requests/${r.body.id}/approve`,
      {},
    );
    expect(ok.body.status).toBe('approved');
    const own = await api<{ approvals: { month: string; status: string }[] }>(
      env,
      org.member,
      'GET',
      '/approvals',
    );
    expect(own.body.approvals.find((a) => a.month === '2026-10')?.status).toBe('submitted');
    expect(await actions(org.orgId)).toContain('approval.reopen');
  });
});

describe('Sprache der E-Mails', () => {
  it('folgt der hinterlegten Gerätesprache der empfangenden Person', async () => {
    await api(env, org.manager, 'POST', '/devices', { locale: 'en' });
    await api(env, org.member, 'POST', '/devices', { locale: 'en' });
    try {
      const res = await api<LeaveRequest>(env, org.member, 'POST', '/leave/requests', {
        kind: 'vacation',
        from: '2027-03-01',
        to: '2027-03-02',
      });
      expect(res.status).toBe(200);
      const toManager = [...env.mailer.outbox].reverse().find((m) => m.to === org.manager.email);
      expect(toManager?.subject).toMatch(/requests vacation/);
      expect(toManager?.text).toMatch(/Please approve or reject/);

      await api(env, org.manager, 'POST', `/org/leave/requests/${res.body.id}/reject`, {
        comment: 'Team offsite',
      });
      const toMember = [...env.mailer.outbox].reverse().find((m) => m.to === org.member.email);
      expect(toMember?.subject).toBe('TimeLog: vacation rejected');
      expect(toMember?.text).toMatch(
        /^Your request for vacation .* was rejected\. Comment: Team offsite$/,
      );
    } finally {
      await api(env, org.manager, 'POST', '/devices', { locale: 'de' });
      await api(env, org.member, 'POST', '/devices', { locale: 'de' });
    }
  });
});
