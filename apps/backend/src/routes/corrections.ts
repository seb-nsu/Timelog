// Korrekturen sind Ereignisse: jede Änderung erzeugt ein manual_*-Ereignis und eine corrections-Zeile.
import { addDays, startOfLocalDay } from '@timelog/rules';
import {
  confirmResponse,
  correctionRequest,
  correctionResponse,
  dateParams,
  sessionParams,
} from '@timelog/shared';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { type App, type AppContext, HttpError } from '../app.js';
import { type Tx, withUser } from '../db/index.js';
import { approvals, corrections, events, users } from '../db/schema.js';
import type { AccessClaims } from '../security/jwt.js';
import { computeUserDays } from './days.js';
import { authOf, scopeOf } from './guard.js';

const tags = ['corrections'];
const security = [{ bearer: [] }];
const DAY_MS = 86_400_000;

type User = typeof users.$inferSelect;

async function loadUser(tx: Tx, userId: string): Promise<User> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) throw new HttpError(401, 'unauthorized');
  return user;
}

/** Freigegebene Monate sind gesperrt (Snapshot). */
async function assertMonthOpen(tx: Tx, userId: string, date: string): Promise<void> {
  const [row] = await tx
    .select({ status: approvals.status })
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.month, date.slice(0, 7))));
  if (row?.status === 'approved') throw new HttpError(409, 'month_locked');
}

interface NewEvent {
  type:
    | 'manual_start'
    | 'manual_end'
    | 'manual_break'
    | 'manual_work'
    | 'session_confirm'
    | 'session_reject';
  ts: Date;
  endTs?: Date;
  refEventId?: string;
}

async function insertUserEvent(
  tx: Tx,
  claims: AccessClaims,
  tz: string,
  now: Date,
  e: NewEvent,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(events).values({
    userId: claims.sub,
    id,
    deviceId: claims.did,
    type: e.type,
    source: 'user',
    ts: e.ts,
    endTs: e.endTs ?? null,
    tz,
    refEventId: e.refEventId ?? null,
    createdAt: now,
    receivedAt: now,
  });
  return id;
}

export function correctionRoutes(app: App, ctx: AppContext): void {
  app.patch(
    '/days/:date',
    {
      schema: {
        tags,
        security,
        description:
          'Korrektur: erzeugt ein manual_*-Ereignis und eine corrections-Zeile. reason ist bei Firmenkonten Pflicht.',
        params: dateParams,
        body: correctionRequest,
        response: { 200: correctionResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { date } = request.params;
      const body = request.body;
      const now = new Date(ctx.now());
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        if (user.orgId && !body.reason) throw new HttpError(400, 'reason_required');
        await assertMonthOpen(tx, claims.sub, date);

        const dayStart = startOfLocalDay(date, user.timezone);
        const dayEnd = startOfLocalDay(addDays(date, 1), user.timezone);
        const inRange = (ms: number) => ms >= dayStart - DAY_MS && ms <= dayEnd + DAY_MS;

        const before = (await computeUserDays(tx, claims.sub, date, date, ctx.now())).days[0];
        let event: NewEvent;
        let oldValue: string | null = null;
        let newValue: string;
        if (body.field === 'start' || body.field === 'end') {
          const ts = new Date(body.time);
          if (!inRange(ts.getTime())) throw new HttpError(400, 'out_of_range');
          event = { type: body.field === 'start' ? 'manual_start' : 'manual_end', ts };
          oldValue = (body.field === 'start' ? before?.start : before?.end) ?? null;
          newValue = ts.toISOString();
        } else {
          const from = new Date(body.from);
          const to = new Date(body.to);
          if (to <= from) throw new HttpError(400, 'invalid_range');
          if (!inRange(from.getTime()) || !inRange(to.getTime()))
            throw new HttpError(400, 'out_of_range');
          event = {
            type: body.field === 'break' ? 'manual_break' : 'manual_work',
            ts: from,
            endTs: to,
          };
          newValue = `${from.toISOString()}/${to.toISOString()}`;
        }

        const eventId = await insertUserEvent(tx, claims, user.timezone, now, event);
        await tx.insert(corrections).values({
          userId: claims.sub,
          date,
          eventId,
          field: body.field,
          oldValue,
          newValue,
          reason: body.reason ?? null,
          authorId: claims.sub,
        });
        const after = (await computeUserDays(tx, claims.sub, date, date, ctx.now())).days[0];
        return after ? { eventId, day: after } : { eventId };
      });
    },
  );

  app.post(
    '/days/:date/confirm',
    {
      schema: {
        tags,
        security,
        description: 'Bestätigt alle noch nicht bestätigten Sitzungen des Tages.',
        params: dateParams,
        response: { 200: confirmResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { date } = request.params;
      const now = new Date(ctx.now());
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        await assertMonthOpen(tx, claims.sub, date);
        const day = (await computeUserDays(tx, claims.sub, date, date, ctx.now())).days[0];
        const open = day?.sessions.filter((s) => s.confirmed === undefined) ?? [];
        for (const s of open) {
          await insertUserEvent(tx, claims, user.timezone, now, {
            type: 'session_confirm',
            ts: now,
            refEventId: s.id,
          });
        }
        return { confirmed: open.length };
      });
    },
  );

  for (const action of ['confirm', 'reject'] as const) {
    app.post(
      `/sessions/:id/${action}`,
      {
        schema: {
          tags,
          security,
          description:
            action === 'confirm'
              ? 'Sitzung (per Start-Ereignis-ID) bestätigen: zählt dann zur Arbeitszeit.'
              : 'Sitzung verwerfen: zählt gar nicht.',
          params: sessionParams,
          response: { 200: confirmResponse },
        },
      },
      async (request) => {
        const claims = authOf(request);
        const now = new Date(ctx.now());
        await withUser(ctx.db, scopeOf(claims), async (tx) => {
          const user = await loadUser(tx, claims.sub);
          await insertUserEvent(tx, claims, user.timezone, now, {
            type: action === 'confirm' ? 'session_confirm' : 'session_reject',
            ts: now,
            refEventId: request.params.id,
          });
        });
        return { confirmed: action === 'confirm' ? 1 : 0 };
      },
    );
  }
}
