// Firmenversion: Anträge entscheiden, Teamkalender, Urlaubsregeln, Konten der Mitglieder pflegen.
import { addDays, weekday } from '@timelog/rules';
import {
  type CalendarEntry,
  calendarQuery,
  calendarResponse,
  leaveAdjustmentInput,
  leaveAdjustmentSchema,
  leaveCancelAdminRequest,
  leaveDecisionRequest,
  leaveProfileUpdate,
  leaveRejectRequest,
  leaveRequestParams,
  leaveRequestSchema,
  leaveSettingsSchema,
  leaveSettingsUpdate,
  memberLeaveResponse,
  memberParams,
  okResponse,
  orgLeaveRequestsQuery,
  orgLeaveRequestsResponse,
  overtimeBookingInput,
  overtimeBookingSchema,
  overtimeResponse,
  yearQuery,
} from '@timelog/shared';
import { and, eq, gte, lte } from 'drizzle-orm';
import { type App, type AppContext, HttpError } from '../../app.js';
import { type Tx, withMember, withUser } from '../../db/index.js';
import {
  absences,
  leaveAdjustments,
  leaveRequests,
  organizations,
  overtimeBookings,
  users,
} from '../../db/schema.js';
import { notifyDecided } from '../../leave/notify.js';
import {
  type RequestRow,
  applyApproved,
  approvedMonths,
  daysTotal,
  hydrateRequests,
  leaveContext,
  loadLeaveOverview,
  loadOvertime,
  loadRequest,
  logRequestEvent,
  minutesTotal,
  monthsOf,
  parseLeaveSettings,
  removeRequestAbsences,
  reopenApproval,
  requestDays,
  requestsOf,
  saveProfile,
} from '../../leave/service.js';
import { ADMINS, type Actor, actorOf, actorScope, audit, loadMember } from './access.js';
import { visibleMembers } from './manage.js';

const tags = ['org'];
const security = [{ bearer: [] }];
type UserRow = typeof users.$inferSelect;

interface Span {
  userId: string;
  from: string;
  to: string;
  kind: CalendarEntry['kind'];
  pending: boolean;
}

/** Fasst Tage zu Zeiträumen zusammen; Wochenenden dazwischen trennen nicht. */
export function mergeDates(
  userId: string,
  dates: readonly { date: string; kind: CalendarEntry['kind'] }[],
): Span[] {
  const sorted = [...dates].sort(
    (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
  );
  const out: Span[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && last.kind === d.kind && d.date > last.to) {
      let gapOnlyWeekend = true;
      for (let x = addDays(last.to, 1); x < d.date; x = addDays(x, 1)) {
        const w = weekday(x);
        if (w !== 0 && w !== 6) gapOnlyWeekend = false;
      }
      if (gapOnlyWeekend) {
        last.to = d.date;
        continue;
      }
    }
    if (last && last.kind === d.kind && d.date <= last.to) continue;
    out.push({ userId, from: d.date, to: d.date, kind: d.kind, pending: false });
  }
  return out;
}

/** Krankheit, Feiertag und Sonstiges erscheinen nur als „abwesend“ (keine Art). */
const calendarKind = (k: string): CalendarEntry['kind'] =>
  k === 'vacation' ? 'vacation' : k === 'overtime' ? 'overtime' : 'absent';

/** Abwesenheiten und offene Anträge sichtbarer Mitglieder im Zeitraum. */
async function calendarFor(
  ctx: AppContext,
  actor: Actor,
  members: readonly UserRow[],
  from: string,
  to: string,
): Promise<CalendarEntry[]> {
  const entries: CalendarEntry[] = [];
  const names = new Map(members.map((m) => [m.id, m.name]));
  for (const m of members) {
    const rows = await withMember(ctx.db, actorScope(actor), m.id, (tx) =>
      tx
        .select({ date: absences.date, kind: absences.kind })
        .from(absences)
        .where(and(eq(absences.userId, m.id), gte(absences.date, from), lte(absences.date, to))),
    );
    for (const s of mergeDates(
      m.id,
      rows.map((r) => ({ date: r.date, kind: calendarKind(r.kind) })),
    )) {
      entries.push({ ...s, name: m.name });
    }
  }
  const pending = await withUser(ctx.db, actorScope(actor), (tx) =>
    requestsOf(
      tx,
      members.map((m) => m.id),
      { status: 'pending', from, to },
    ),
  );
  for (const r of pending) {
    entries.push({
      userId: r.userId,
      name: names.get(r.userId) ?? '',
      from: r.fromDate < from ? from : r.fromDate,
      to: r.toDate > to ? to : r.toDate,
      kind: r.kind,
      pending: true,
    });
  }
  return entries.sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));
}

export function orgLeaveRoutes(app: App, ctx: AppContext): void {
  const loadVisibleRequest = async (actor: Actor, id: string) =>
    withUser(ctx.db, actorScope(actor), async (tx) => {
      const row = await loadRequest(tx, id);
      const member = await loadMember(tx, actor, row.userId);
      return { row, member };
    });

  /** Freigegebene Monate: Manager → 409, Admin → Freigabe zurücksetzen (Audit). */
  const handleLockedMonths = async (tx: Tx, actor: Actor, row: RequestRow, reason: string) => {
    const locked = await approvedMonths(
      tx,
      row.userId,
      monthsOf([{ date: row.fromDate }, { date: row.toDate }]),
    );
    if (locked.length === 0) return;
    if (actor.role !== 'admin') throw new HttpError(409, 'month_locked');
    for (const month of locked) await reopenApproval(tx, actor, row.userId, month, reason);
  };

  app.get(
    '/leave/requests',
    {
      schema: {
        tags,
        security,
        description:
          'Anträge sichtbarer Mitglieder (Manager: eigene Teams, Admin: alle; ohne die eigenen) mit Überschneidungen im selben Team.',
        querystring: orgLeaveRequestsQuery,
        response: { 200: orgLeaveRequestsResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { status, from, to } = request.query;
      const members = await withUser(ctx.db, actorScope(actor), (tx) => visibleMembers(tx, actor));
      const { requests } = await withUser(ctx.db, actorScope(actor), async (tx) => {
        const rows = await requestsOf(
          tx,
          // eigene Anträge entscheidet nie man selbst → nicht in der Entscheidungsliste
          members.filter((m) => m.id !== actor.id).map((m) => m.id),
          { ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) },
        );
        return { requests: await hydrateRequests(ctx.db, tx, rows) };
      });
      const open = requests.filter((r) => r.status === 'pending' || r.status === 'approved');
      if (open.length === 0) return { requests: requests.map((r) => ({ ...r, overlaps: [] })) };
      const rangeFrom = open.reduce((m, r) => (r.from < m ? r.from : m), open[0]?.from ?? '');
      let rangeTo = open.reduce((m, r) => (r.to > m ? r.to : m), open[0]?.to ?? '');
      if (rangeTo > addDays(rangeFrom, 400)) rangeTo = addDays(rangeFrom, 400);
      // Puffer, damit überlappende Zeiträume nicht am Rand abgeschnitten erscheinen
      const calendar = await calendarFor(
        ctx,
        actor,
        members,
        addDays(rangeFrom, -31),
        addDays(rangeTo, 31),
      );
      const teamOf = new Map(members.map((m) => [m.id, m.teamId]));
      return {
        requests: requests.map((r) => ({
          ...r,
          overlaps:
            r.status === 'pending' || r.status === 'approved'
              ? calendar
                  .filter(
                    (c) =>
                      c.userId !== r.userId &&
                      teamOf.get(c.userId) !== null &&
                      teamOf.get(c.userId) === teamOf.get(r.userId) &&
                      c.from <= r.to &&
                      c.to >= r.from,
                  )
                  .map((c) => ({ name: c.name, from: c.from, to: c.to }))
              : [],
        })),
      };
    },
  );

  for (const action of ['approve', 'reject'] as const) {
    app.post(
      `/leave/requests/:id/${action}`,
      {
        schema: {
          tags,
          security,
          description:
            action === 'approve'
              ? 'Genehmigt einen offenen Antrag: Es entstehen Abwesenheiten je Arbeitstag. Nie den eigenen Antrag. In freigegebenen Monaten nur Admin (Freigabe wird zurückgesetzt).'
              : 'Lehnt einen offenen Antrag mit Kommentar ab.',
          params: leaveRequestParams,
          body: action === 'approve' ? leaveDecisionRequest : leaveRejectRequest,
          response: { 200: leaveRequestSchema },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        const { row, member } = await loadVisibleRequest(actor, request.params.id);
        if (row.userId === actor.id) throw new HttpError(403, 'self_approval');
        const comment = request.body.comment ?? null;
        const now = new Date(ctx.now());
        const result = await withMember(ctx.db, actorScope(actor), member.id, async (tx) => {
          const current = await loadRequest(tx, row.id);
          if (current.status !== 'pending') throw new HttpError(409, 'not_pending');
          let days = null;
          if (action === 'approve') {
            await handleLockedMonths(tx, actor, current, 'leave');
            const lc = await leaveContext(tx, member.id, ctx.now());
            days = requestDays(lc.config, {
              from: current.fromDate,
              to: current.toDate,
              halfDayStart: current.halfDayStart,
              halfDayEnd: current.halfDayEnd,
            });
          }
          const [updated] = await tx
            .update(leaveRequests)
            .set({
              status: action === 'approve' ? 'approved' : 'rejected',
              decidedBy: actor.id,
              decidedAt: now,
              decisionComment: comment,
              ...(days ? { days: daysTotal(days), minutes: minutesTotal(days) } : {}),
            })
            .where(eq(leaveRequests.id, current.id))
            .returning();
          if (!updated) throw new HttpError(404, 'not_found');
          if (days) await applyApproved(tx, updated, days);
          await logRequestEvent(tx, updated, action, actor.id, comment);
          await audit(tx, actor, `leave.${action}`, updated.id, {
            member: member.id,
            kind: updated.kind,
            days: updated.days,
            ...(comment ? { comment } : {}),
          });
          const [hydrated] = await hydrateRequests(ctx.db, tx, [updated]);
          if (!hydrated) throw new HttpError(500, 'update_failed');
          return hydrated;
        });
        await notifyDecided(
          ctx,
          { ...result, userId: member.id },
          action === 'approve' ? 'approved' : 'rejected',
          comment ?? undefined,
        ).catch(() => {
          request.log.warn('leave notification failed');
        });
        return result;
      },
    );
  }

  app.post(
    '/leave/requests/:id/cancel',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Admin storniert einen offenen oder genehmigten Antrag (auch nach Beginn) mit Kommentar; die Abwesenheiten werden entfernt, die Stornierung protokolliert.',
        params: leaveRequestParams,
        body: leaveCancelAdminRequest,
        response: { 200: leaveRequestSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { row, member } = await loadVisibleRequest(actor, request.params.id);
      if (row.userId === actor.id) throw new HttpError(409, 'use_own_cancel');
      const now = new Date(ctx.now());
      const comment = request.body.comment;
      const result = await withMember(ctx.db, actorScope(actor), member.id, async (tx) => {
        const current = await loadRequest(tx, row.id);
        if (current.status !== 'pending' && current.status !== 'approved') {
          throw new HttpError(409, 'not_cancellable');
        }
        if (current.status === 'approved') await handleLockedMonths(tx, actor, current, 'leave');
        const [updated] = await tx
          .update(leaveRequests)
          .set({
            status: 'cancelled',
            cancelledBy: actor.id,
            cancelledAt: now,
            cancelComment: comment,
          })
          .where(eq(leaveRequests.id, current.id))
          .returning();
        if (!updated) throw new HttpError(404, 'not_found');
        await removeRequestAbsences(tx, current);
        await logRequestEvent(tx, updated, 'cancel', actor.id, comment);
        await audit(tx, actor, 'leave.cancel', updated.id, {
          member: member.id,
          previousStatus: current.status,
          comment,
        });
        const [hydrated] = await hydrateRequests(ctx.db, tx, [updated]);
        if (!hydrated) throw new HttpError(500, 'update_failed');
        return hydrated;
      });
      await notifyDecided(ctx, { ...result, userId: member.id }, 'cancelled', comment).catch(() => {
        request.log.warn('leave notification failed');
      });
      return result;
    },
  );

  app.get(
    '/leave/calendar',
    {
      schema: {
        tags,
        security,
        description:
          'Teamkalender: wer ist wann weg – nur Name und Zeitraum. Urlaub und Überstundenabbau mit Art, Krankheit und Sonstiges nur als „abwesend“. Offene Anträge markiert.',
        querystring: calendarQuery,
        response: { 200: calendarResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { from, to, teamId } = request.query;
      const members = (
        await withUser(ctx.db, actorScope(actor), (tx) => visibleMembers(tx, actor, teamId))
      ).filter((m) => m.deactivatedAt === null);
      return { entries: await calendarFor(ctx, actor, members, from, to) };
    },
  );

  // ── Urlaubsregeln der Organisation ──────────────────────────────────────────
  app.get(
    '/leave/settings',
    { schema: { tags, security, response: { 200: leaveSettingsSchema } } },
    async (request) => {
      const actor = actorOf(request);
      const [org] = await withUser(ctx.db, actorScope(actor), (tx) =>
        tx.select().from(organizations).where(eq(organizations.id, actor.orgId)),
      );
      return parseLeaveSettings(org?.leaveConfig);
    },
  );

  app.put(
    '/leave/settings',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Standard-Jahresanspruch, Arbeitstage je Woche, Verfall des Resturlaubs (Stichtag; nach BAG nur nach Hinweis des Arbeitgebers), Höchstsaldo der Überstunden.',
        body: leaveSettingsUpdate,
        response: { 200: leaveSettingsSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const [org] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, actor.orgId));
        if (!org) throw new HttpError(404, 'not_found');
        const { maxOvertimeMinutes, ...rest } = request.body;
        const merged = parseLeaveSettings({
          ...parseLeaveSettings(org.leaveConfig),
          ...rest,
          ...(typeof maxOvertimeMinutes === 'number' ? { maxOvertimeMinutes } : {}),
        });
        if (maxOvertimeMinutes === null) delete merged.maxOvertimeMinutes;
        await tx
          .update(organizations)
          .set({ leaveConfig: merged })
          .where(eq(organizations.id, actor.orgId));
        await audit(tx, actor, 'leave.settings', actor.orgId, { ...merged });
        return merged;
      });
    },
  );

  // ── Konten einzelner Mitglieder ─────────────────────────────────────────────
  const visible = (actor: Actor, id: string) =>
    withUser(ctx.db, actorScope(actor), (tx) => loadMember(tx, actor, id));

  app.get(
    '/members/:id/leave',
    {
      schema: {
        tags,
        security,
        description: 'Urlaubskonto eines sichtbaren Mitglieds (Manager: eigene Teams).',
        params: memberParams,
        querystring: yearQuery,
        response: { 200: memberLeaveResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const member = await visible(actor, request.params.id);
      const overview = await withMember(ctx.db, actorScope(actor), member.id, async (tx) => {
        const lc = await leaveContext(tx, member.id, ctx.now());
        return loadLeaveOverview(ctx.db, tx, lc, request.query.year);
      });
      return { ...overview, name: member.name };
    },
  );

  app.get(
    '/members/:id/overtime',
    {
      schema: {
        tags,
        security,
        description: 'Überstundenkonto eines sichtbaren Mitglieds.',
        params: memberParams,
        querystring: yearQuery,
        response: { 200: overtimeResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const member = await visible(actor, request.params.id);
      return withMember(ctx.db, actorScope(actor), member.id, async (tx) => {
        const lc = await leaveContext(tx, member.id, ctx.now());
        return loadOvertime(ctx.db, tx, lc, request.query.year, ctx.now());
      });
    },
  );

  app.put(
    '/members/:id/leave-profile',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Jahresanspruch (leer = Standard der Organisation), Arbeitstage je Woche (Teilzeit), Eintritt/Austritt (anteilig).',
        params: memberParams,
        body: leaveProfileUpdate,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const member = await visible(actor, request.params.id);
      await withMember(ctx.db, actorScope(actor), member.id, async (tx) => {
        await saveProfile(tx, member.id, request.body, ctx.now());
        await audit(tx, actor, 'leave.profile', member.id, { ...request.body });
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/members/:id/leave-adjustments',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Manuelle Urlaubsbuchung mit Kommentar: Übertrag setzen (überschreibt die Automatik) oder Tage korrigieren. Nur anhängbar.',
        params: memberParams,
        body: leaveAdjustmentInput,
        response: { 200: leaveAdjustmentSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const member = await visible(actor, request.params.id);
      if (member.id === actor.id) throw new HttpError(403, 'self_booking');
      return withMember(ctx.db, actorScope(actor), member.id, async (tx) => {
        const [row] = await tx
          .insert(leaveAdjustments)
          .values({ userId: member.id, ...request.body, authorId: actor.id })
          .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        await audit(tx, actor, 'leave.adjust', member.id, { ...request.body });
        return {
          ...request.body,
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          authorName: actor.name,
        };
      });
    },
  );

  app.post(
    '/members/:id/overtime-bookings',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Manuelle Überstundenbuchung (Auszahlung, Kappung, Korrektur) mit Pflicht-Kommentar; nur anhängbar, im Audit-Log.',
        params: memberParams,
        body: overtimeBookingInput,
        response: { 200: overtimeBookingSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const member = await visible(actor, request.params.id);
      if (member.id === actor.id) throw new HttpError(403, 'self_booking');
      return withMember(ctx.db, actorScope(actor), member.id, async (tx) => {
        const [row] = await tx
          .insert(overtimeBookings)
          .values({ userId: member.id, ...request.body, authorId: actor.id })
          .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        await audit(tx, actor, 'overtime.book', member.id, { ...request.body });
        return {
          ...request.body,
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          authorName: actor.name,
        };
      });
    },
  );
}
