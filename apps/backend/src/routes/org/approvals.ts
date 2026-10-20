// Firmenversion: eingeschränkte Tagesansicht, Monatsfreigabe mit Snapshot, Admin-Korrekturen, Export.
import { type WorkDay, addDays } from '@timelog/rules';
import {
  type ManagerDay,
  approvalDetailResponse,
  approvalParams,
  approvalSchema,
  approvalsQuery,
  approvalsResponse,
  approveRequest,
  correctionRequest,
  correctionResponse,
  memberDateParams,
  memberDaysQuery,
  memberDaysResponse,
  memberParams,
  okResponse,
  orgExportQuery,
  rejectRequest,
  targetHoursResponse,
  targetHoursUpdate,
} from '@timelog/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type App, type AppContext, HttpError } from '../../app.js';
import { type Tx, withMember, withUser } from '../../db/index.js';
import { approvals, organizations, targetHours, users } from '../../db/schema.js';
import { renderPdf } from '../../export/pdf.js';
import { applyCorrection } from '../corrections.js';
import { computeUserDays, loadDays } from '../days.js';
import { CSV_HEADER, csvCell, exportRows } from '../privacy.js';
import { ADMINS, type Actor, actorOf, actorScope, audit, loadMember } from './access.js';
import { visibleMembers } from './manage.js';

const tags = ['org'];
const security = [{ bearer: [] }];

/** Erster und letzter Tag eines Monats (JJJJ-MM). */
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const next =
    m === 12 ? `${String(y + 1)}-01-01` : `${String(y)}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}

/** Projektion für Manager und Admins: keine Sitzungen, Quellen, Ereignisse oder Geräte. */
export function toManagerDay(d: WorkDay): ManagerDay {
  return {
    date: d.date,
    ...(d.start ? { start: d.start } : {}),
    ...(d.end ? { end: d.end } : {}),
    breakMinutes: d.breakMinutes,
    breakTopUpMin: d.breakTopUpMin,
    netMinutes: d.netMinutes,
    status: d.status,
    warnings: [...d.warnings],
  };
}

const APPROVAL_DE = {
  none: 'nicht eingereicht',
  submitted: 'eingereicht',
  approved: 'freigegeben',
  rejected: 'zurückgewiesen',
} as const;

type ApprovalRow = typeof approvals.$inferSelect;
type UserRow = typeof users.$inferSelect;

function toApproval(
  member: UserRow,
  month: string,
  row: ApprovalRow | undefined,
): z.infer<typeof approvalSchema> {
  return {
    userId: member.id,
    name: member.name,
    ...(member.teamId ? { teamId: member.teamId } : {}),
    month,
    status: row?.status ?? 'none',
    ...(row?.submittedAt ? { submittedAt: row.submittedAt.toISOString() } : {}),
    ...(row?.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row?.approverId ? { approverId: row.approverId } : {}),
    ...(row?.comment ? { comment: row.comment } : {}),
  };
}

async function loadApproval(tx: Tx, userId: string, month: string) {
  const [row] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.month, month)));
  return row;
}

/** Prüft Sichtbarkeit (Hook-Ebene) und liefert das Mitglied. */
async function visibleMember(ctx: AppContext, actor: Actor, memberId: string): Promise<UserRow> {
  return withUser(ctx.db, actorScope(actor), (tx) => loadMember(tx, actor, memberId));
}

export function orgApprovalRoutes(app: App, ctx: AppContext): void {
  // ── Eingeschränkte Tagesansicht ─────────────────────────────────────────────
  app.get(
    '/members/:id/days',
    {
      schema: {
        tags,
        security,
        description:
          'Je Tag nur Beginn, Ende, Pausensumme, Auffüllung, Netto, Status und Warnungen – keine Sitzungen, Quellen, Ereignisse oder Geräte. Freigegebene Monate als Snapshot.',
        params: memberParams,
        querystring: memberDaysQuery,
        response: { 200: memberDaysResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await visibleMember(ctx, actor, request.params.id);
      const { from, to } = request.query;
      const { days } = await withMember(ctx.db, actorScope(actor), request.params.id, (tx) =>
        loadDays(tx, request.params.id, from, to, ctx.now()),
      );
      return { days: days.map(toManagerDay) };
    },
  );

  // ── Sollzeiten der Mitglieder (Admin) ───────────────────────────────────────
  app.get(
    '/members/:id/target-hours',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        params: memberParams,
        response: { 200: targetHoursResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await visibleMember(ctx, actor, request.params.id);
      const rows = await withMember(ctx.db, actorScope(actor), request.params.id, (tx) =>
        tx.select().from(targetHours).orderBy(targetHours.validFrom, targetHours.weekday),
      );
      const byDate = new Map<string, z.infer<typeof targetHoursResponse>['schedule'][number]>();
      for (const r of rows) {
        let e = byDate.get(r.validFrom);
        if (!e) {
          e = { validFrom: r.validFrom, minutesByWeekday: [0, 0, 0, 0, 0, 0, 0] };
          byDate.set(r.validFrom, e);
        }
        e.minutesByWeekday[r.weekday] = r.minutes;
      }
      return { schedule: [...byDate.values()] };
    },
  );

  app.put(
    '/members/:id/target-hours',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description: 'Sollzeiten eines Mitglieds je Wochentag (0 = Sonntag) ab einem Datum.',
        params: memberParams,
        body: targetHoursUpdate,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const memberId = request.params.id;
      await visibleMember(ctx, actor, memberId);
      const { validFrom, minutesByWeekday } = request.body;
      await withMember(ctx.db, actorScope(actor), memberId, async (tx) => {
        await tx
          .delete(targetHours)
          .where(and(eq(targetHours.userId, memberId), eq(targetHours.validFrom, validFrom)));
        await tx.insert(targetHours).values(
          minutesByWeekday.map((minutes, weekday) => ({
            userId: memberId,
            weekday,
            minutes,
            validFrom,
          })),
        );
        await audit(tx, actor, 'target_hours.update', memberId, { validFrom, minutesByWeekday });
      });
      return { ok: true as const };
    },
  );

  // ── Korrektur durch Admin (auch in freigegebenen Monaten) ───────────────────
  app.patch(
    '/members/:id/days/:date',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Admin-Korrektur mit Pflicht-Begründung: erzeugt manual_*-Ereignis und corrections-Zeile (Autor = Admin). Ist der Monat freigegeben, wird die Freigabe zurückgesetzt (wieder „eingereicht“) und muss neu erteilt werden.',
        params: memberDateParams,
        body: correctionRequest,
        response: { 200: correctionResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id: memberId, date } = request.params;
      const body = request.body;
      if (!body.reason) throw new HttpError(400, 'reason_required');
      if (memberId === actor.id) throw new HttpError(409, 'use_own_correction');
      const member = await visibleMember(ctx, actor, memberId);
      return withMember(ctx.db, actorScope(actor), memberId, async (tx) => {
        const month = date.slice(0, 7);
        const approval = await loadApproval(tx, memberId, month);
        const result = await applyCorrection(tx, {
          userId: memberId,
          deviceId: actor.deviceId,
          authorId: actor.id,
          timezone: member.timezone,
          date,
          body,
          nowMs: ctx.now(),
        });
        await audit(tx, actor, 'day.correct', `${memberId}:${date}`, {
          field: body.field,
          reason: body.reason,
          eventId: result.eventId,
        });
        if (approval?.status === 'approved') {
          await tx
            .update(approvals)
            .set({
              status: 'submitted',
              snapshot: null,
              rulesConfigVersion: null,
              approverId: null,
              decidedAt: null,
              comment: null,
            })
            .where(and(eq(approvals.userId, memberId), eq(approvals.month, month)));
          await audit(tx, actor, 'approval.reopen', `${memberId}:${month}`, {
            reason: 'correction',
          });
        }
        return result;
      });
    },
  );

  // ── Monatsfreigaben ─────────────────────────────────────────────────────────
  app.get(
    '/approvals',
    {
      schema: {
        tags,
        security,
        description:
          'Freigabestatus eines Monats für alle sichtbaren Mitglieder (Manager: eigene Teams, ohne sich selbst).',
        querystring: approvalsQuery,
        response: { 200: approvalsResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { month, status } = request.query;
      const list = await withUser(ctx.db, actorScope(actor), async (tx) => {
        const members = (await visibleMembers(tx, actor)).filter(
          (m) => m.id !== actor.id && m.deactivatedAt === null,
        );
        const rows = await tx.select().from(approvals).where(eq(approvals.month, month));
        const byUser = new Map(rows.map((r) => [r.userId, r]));
        return members.map((m) => toApproval(m, month, byUser.get(m.id)));
      });
      return { approvals: status ? list.filter((a) => a.status === status) : list };
    },
  );

  app.get(
    '/approvals/:userId/:month',
    {
      schema: {
        tags,
        security,
        params: approvalParams,
        response: { 200: approvalDetailResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { userId, month } = request.params;
      const member = await visibleMember(ctx, actor, userId);
      const { from, to } = monthRange(month);
      return withMember(ctx.db, actorScope(actor), userId, async (tx) => {
        const row = await loadApproval(tx, userId, month);
        const { days, approvedMonths } = await loadDays(tx, userId, from, to, ctx.now());
        const view = days.map(toManagerDay);
        return {
          approval: toApproval(member, month, row),
          days: view,
          snapshot: approvedMonths.includes(month),
          totals: {
            netMinutes: view.reduce((s, d) => s + d.netMinutes, 0),
            breakTopUpMin: view.reduce((s, d) => s + d.breakTopUpMin, 0),
            uncheckedDays: view.filter((d) => d.status === 'unchecked').length,
            openDays: view.filter((d) => d.status === 'open').length,
          },
        };
      });
    },
  );

  for (const action of ['approve', 'reject'] as const) {
    app.post(
      `/approvals/:userId/:month/${action}`,
      {
        schema: {
          tags,
          security,
          description:
            action === 'approve'
              ? 'Gibt einen eingereichten Monat frei: Die Arbeitstage werden als Snapshot gespeichert und danach nie neu berechnet.'
              : 'Weist einen eingereichten Monat mit Kommentar zurück; das Mitglied kann korrigieren und erneut einreichen.',
          params: approvalParams,
          body: action === 'approve' ? approveRequest : rejectRequest,
          response: { 200: approvalSchema },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        const { userId, month } = request.params;
        if (userId === actor.id) throw new HttpError(403, 'self_approval');
        const member = await visibleMember(ctx, actor, userId);
        const comment = request.body.comment ?? null;
        const now = new Date(ctx.now());
        return withMember(ctx.db, actorScope(actor), userId, async (tx) => {
          const row = await loadApproval(tx, userId, month);
          if (row?.status !== 'submitted') throw new HttpError(409, 'not_submitted');
          let snapshot: WorkDay[] | null = null;
          let version: number | null = null;
          if (action === 'approve') {
            const { from, to } = monthRange(month);
            snapshot = (await computeUserDays(tx, userId, from, to, ctx.now())).days;
            const [org] = await tx
              .select({ v: organizations.rulesConfigVersion })
              .from(organizations)
              .where(eq(organizations.id, actor.orgId));
            version = org?.v ?? null;
          }
          const [updated] = await tx
            .update(approvals)
            .set({
              status: action === 'approve' ? 'approved' : 'rejected',
              snapshot,
              rulesConfigVersion: version,
              approverId: actor.id,
              comment,
              decidedAt: now,
            })
            .where(and(eq(approvals.userId, userId), eq(approvals.month, month)))
            .returning();
          await audit(tx, actor, `approval.${action}`, `${userId}:${month}`, {
            ...(comment ? { comment } : {}),
            ...(version !== null ? { rulesConfigVersion: version } : {}),
          });
          return toApproval(member, month, updated);
        });
      },
    );
  }

  // ── Export (Admin) ──────────────────────────────────────────────────────────
  app.get(
    '/export',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Monatsexport aller (bzw. eines Teams) Mitglieder als CSV oder PDF; freigegebene Monate aus dem Snapshot.',
        querystring: orgExportQuery,
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { month, format, teamId } = request.query;
      const { from, to } = monthRange(month);
      const members = await withUser(ctx.db, actorScope(actor), (tx) =>
        visibleMembers(tx, actor, teamId),
      );
      const rows: string[][] = [];
      for (const m of members) {
        const result = await withMember(ctx.db, actorScope(actor), m.id, async (tx) => {
          const loaded = await loadDays(tx, m.id, from, to, ctx.now());
          const approval = await loadApproval(tx, m.id, month);
          return { ...loaded, approval };
        });
        const settings = z.object({ personnelNumber: z.string().optional() }).safeParse(m.settings);
        const pn = (settings.success ? settings.data.personnelNumber : undefined) ?? '';
        for (const r of exportRows(result.days, result.timezone, pn)) {
          rows.push([
            r[0] ?? '',
            m.name,
            ...r.slice(1),
            APPROVAL_DE[result.approval?.status ?? 'none'],
          ]);
        }
      }
      await withUser(ctx.db, actorScope(actor), (tx) =>
        audit(tx, actor, 'export.create', month, {
          format,
          teamId: teamId ?? null,
          members: members.length,
        }),
      );
      const header = [CSV_HEADER[0] ?? '', 'Name', ...CSV_HEADER.slice(1), 'Freigabe'];
      const filename = `arbeitszeit_${month}${teamId ? '_team' : ''}`;
      if (format === 'pdf') {
        const widths = [55, 90, 60, 38, 38, 45, 60, 45, 60, 60, 45, 100, 50];
        const pdf = renderPdf({
          title: `Arbeitszeit ${month}`,
          subtitle: `${String(members.length)} Mitglieder`,
          columns: widths.map((width, i) => ({ label: header[i] ?? '', width })),
          rows,
        });
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="${filename}.pdf"`)
          .send(pdf);
      }
      const csv =
        '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}.csv"`)
        .send(csv);
    },
  );
}
