// Eigenes Urlaubs- und Überstundenkonto, Anträge stellen und stornieren.
import {
  leaveAdjustmentInput,
  leaveAdjustmentSchema,
  leaveCancelRequest,
  leaveOverviewResponse,
  leaveProfileUpdate,
  leaveRequestInput,
  leaveRequestParams,
  leaveRequestSchema,
  leaveSettingsSchema,
  leaveSettingsUpdate,
  okResponse,
  overtimeBookingInput,
  overtimeBookingSchema,
  overtimeResponse,
  yearQuery,
} from '@timelog/shared';
import { eq } from 'drizzle-orm';
import { type App, type AppContext, HttpError } from '../app.js';
import { withUser } from '../db/index.js';
import { leaveAdjustments, leaveProfiles, leaveRequests, overtimeBookings } from '../db/schema.js';
import { notifyRequested } from '../leave/notify.js';
import {
  applyApproved,
  approvedMonths,
  assertNoOverlap,
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
  requestDays,
  saveProfile,
} from '../leave/service.js';
import { authOf, scopeOf } from './guard.js';
import { audit } from './org/access.js';

const security = [{ bearer: [] }];
const tags = ['leave'];

export function leaveRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/leave',
    {
      schema: {
        tags,
        security,
        description:
          'Urlaubskonto eines Jahres (Anspruch, Übertrag mit Verfall, genommen, geplant, beantragt, Rest), eigene Anträge und Buchungen.',
        querystring: yearQuery,
        response: { 200: leaveOverviewResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const lc = await leaveContext(tx, claims.sub, ctx.now());
        return loadLeaveOverview(ctx.db, tx, lc, request.query.year);
      });
    },
  );

  app.post(
    '/leave/requests',
    {
      schema: {
        tags,
        security,
        description:
          'Antrag auf Urlaub oder Überstundenabbau. Firmenkonto: offen, bis Manager/Admin entscheiden (E-Mail an die Teamleitung, sonst an die Admins). Privatkonto: sofort genehmigt. Es zählen nur Arbeitstage laut Sollzeit und Feiertagen.',
        body: leaveRequestInput,
        response: { 200: leaveRequestSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const body = request.body;
      const now = new Date(ctx.now());
      const { row, managed, name } = await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const lc = await leaveContext(tx, claims.sub, ctx.now());
        const days = requestDays(lc.config, body);
        if ((await approvedMonths(tx, claims.sub, monthsOf(days))).length > 0) {
          throw new HttpError(409, 'month_locked');
        }
        await assertNoOverlap(tx, claims.sub, body.from, body.to);
        const [inserted] = await tx
          .insert(leaveRequests)
          .values({
            userId: claims.sub,
            orgId: lc.user.orgId,
            kind: body.kind,
            fromDate: body.from,
            toDate: body.to,
            halfDayStart: body.halfDayStart,
            halfDayEnd: body.halfDayEnd,
            days: daysTotal(days),
            minutes: minutesTotal(days),
            note: body.note ?? null,
            status: lc.managed ? 'pending' : 'approved',
            ...(lc.managed ? {} : { decidedBy: claims.sub, decidedAt: now }),
          })
          .returning();
        if (!inserted) throw new HttpError(500, 'insert_failed');
        await logRequestEvent(tx, inserted, 'request', claims.sub, body.note);
        if (lc.managed && lc.user.orgId) {
          await audit(tx, { id: claims.sub, orgId: lc.user.orgId }, 'leave.request', inserted.id, {
            kind: inserted.kind,
            from: inserted.fromDate,
            to: inserted.toDate,
            days: inserted.days,
          });
        } else {
          // Privat: sofort genehmigt, Abwesenheiten entstehen direkt.
          await logRequestEvent(tx, inserted, 'approve', claims.sub);
          await applyApproved(tx, inserted, days);
        }
        const [hydrated] = await hydrateRequests(ctx.db, tx, [inserted]);
        if (!hydrated) throw new HttpError(500, 'insert_failed');
        return { row: hydrated, managed: lc.managed, name: lc.user.name };
      });
      if (managed) {
        await notifyRequested(
          ctx,
          {
            id: row.id,
            userId: row.userId,
            kind: row.kind,
            from: row.from,
            to: row.to,
            days: row.days,
          },
          name,
        ).catch((err: unknown) => {
          request.log.warn(
            { err: { message: err instanceof Error ? err.message : 'unknown' } },
            'leave notification failed',
          );
        });
      }
      return row;
    },
  );

  app.post(
    '/leave/requests/:id/cancel',
    {
      schema: {
        tags,
        security,
        description:
          'Storniert einen eigenen offenen oder genehmigten Antrag vor dessen Beginn; danach nur durch einen Admin. Die Stornierung wird protokolliert.',
        params: leaveRequestParams,
        body: leaveCancelRequest,
        response: { 200: leaveRequestSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const now = new Date(ctx.now());
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const lc = await leaveContext(tx, claims.sub, ctx.now());
        const row = await loadRequest(tx, request.params.id);
        if (row.userId !== claims.sub) throw new HttpError(404, 'not_found');
        if (row.status !== 'pending' && row.status !== 'approved') {
          throw new HttpError(409, 'not_cancellable');
        }
        if (row.fromDate <= lc.today) throw new HttpError(409, 'already_started');
        const months = monthsOf([{ date: row.fromDate }, { date: row.toDate }]);
        if ((await approvedMonths(tx, claims.sub, months)).length > 0) {
          throw new HttpError(409, 'month_locked');
        }
        const comment = request.body.comment ?? null;
        const [updated] = await tx
          .update(leaveRequests)
          .set({
            status: 'cancelled',
            cancelledBy: claims.sub,
            cancelledAt: now,
            cancelComment: comment,
          })
          .where(eq(leaveRequests.id, row.id))
          .returning();
        if (!updated) throw new HttpError(404, 'not_found');
        await removeRequestAbsences(tx, row);
        await logRequestEvent(tx, row, 'cancel', claims.sub, comment);
        if (lc.user.orgId) {
          await audit(tx, { id: claims.sub, orgId: lc.user.orgId }, 'leave.cancel', row.id, {
            previousStatus: row.status,
          });
        }
        const [hydrated] = await hydrateRequests(ctx.db, tx, [updated]);
        if (!hydrated) throw new HttpError(500, 'update_failed');
        return hydrated;
      });
    },
  );

  // ── Nur Privatkonto: Anspruch, Regeln, Buchungen selbst pflegen ──────────────
  const privateOnly = async (tx: Parameters<Parameters<typeof withUser>[2]>[0], userId: string) => {
    const lc = await leaveContext(tx, userId, ctx.now());
    if (lc.managed) throw new HttpError(403, 'managed_by_admin');
    return lc;
  };

  app.put(
    '/leave/profile',
    {
      schema: {
        tags,
        security,
        description:
          'Privatkonto: Jahresanspruch, Arbeitstage je Woche, Eintritt/Austritt. Firmenkonten pflegt der Admin.',
        body: leaveProfileUpdate,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      await withUser(ctx.db, scopeOf(claims), async (tx) => {
        await privateOnly(tx, claims.sub);
        await saveProfile(tx, claims.sub, request.body, ctx.now());
      });
      return { ok: true as const };
    },
  );

  app.put(
    '/leave/settings',
    {
      schema: {
        tags,
        security,
        description:
          'Privatkonto: Standardanspruch, Verfall des Resturlaubs (Stichtag, an/aus), Höchstsaldo der Überstunden.',
        body: leaveSettingsUpdate,
        response: { 200: leaveSettingsSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const lc = await privateOnly(tx, claims.sub);
        const { maxOvertimeMinutes, ...rest } = request.body;
        const merged = parseLeaveSettings({
          ...lc.settings,
          ...rest,
          ...(maxOvertimeMinutes !== undefined && maxOvertimeMinutes !== null
            ? { maxOvertimeMinutes }
            : {}),
        });
        if (maxOvertimeMinutes === null) delete merged.maxOvertimeMinutes;
        await tx
          .insert(leaveProfiles)
          .values({ userId: claims.sub, settings: merged, updatedAt: new Date(ctx.now()) })
          .onConflictDoUpdate({
            target: leaveProfiles.userId,
            set: { settings: merged, updatedAt: new Date(ctx.now()) },
          });
        return merged;
      });
    },
  );

  app.post(
    '/leave/adjustments',
    {
      schema: {
        tags,
        security,
        description:
          'Privatkonto: Übertrag manuell setzen (überschreibt die Automatik) oder Tage korrigieren. Nur anhängbar.',
        body: leaveAdjustmentInput,
        response: { 200: leaveAdjustmentSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        await privateOnly(tx, claims.sub);
        const [row] = await tx
          .insert(leaveAdjustments)
          .values({ userId: claims.sub, ...request.body, authorId: claims.sub })
          .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        return { ...request.body, id: row.id, createdAt: row.createdAt.toISOString() };
      });
    },
  );

  app.get(
    '/overtime',
    {
      schema: {
        tags,
        security,
        description:
          'Überstundenkonto: Saldo-Verlauf je Monat bis heute (freigegebene Monate aus dem Snapshot), Buchungen, Höchstsaldo.',
        querystring: yearQuery,
        response: { 200: overtimeResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const lc = await leaveContext(tx, claims.sub, ctx.now());
        return loadOvertime(ctx.db, tx, lc, request.query.year, ctx.now());
      });
    },
  );

  app.post(
    '/overtime/bookings',
    {
      schema: {
        tags,
        security,
        description:
          'Privatkonto: manuelle Buchung (Auszahlung, Kappung, Korrektur) mit Kommentar; nur anhängbar. Firmenkonten bucht der Admin.',
        body: overtimeBookingInput,
        response: { 200: overtimeBookingSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        await privateOnly(tx, claims.sub);
        const [row] = await tx
          .insert(overtimeBookings)
          .values({ userId: claims.sub, ...request.body, authorId: claims.sub })
          .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        return { ...request.body, id: row.id, createdAt: row.createdAt.toISOString() };
      });
    },
  );
}
