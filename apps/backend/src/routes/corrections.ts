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
import type { z } from 'zod';
import { type App, type AppContext, HttpError } from '../app.js';
import { type Tx, withUser } from '../db/index.js';
import { approvals, corrections, events, users } from '../db/schema.js';
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
export async function assertMonthOpen(tx: Tx, userId: string, date: string): Promise<void> {
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

/** Wer das Ereignis erzeugt: Nutzer und Gerät aus dem Token. */
interface Origin {
  sub: string;
  did: string;
}

async function insertUserEvent(
  tx: Tx,
  claims: Origin,
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

export interface CorrectionInput {
  /** Nutzer, dessen Tag korrigiert wird. */
  userId: string;
  /** Gerät des Akteurs (aus dessen Token). */
  deviceId: string;
  authorId: string;
  timezone: string;
  date: string;
  body: z.infer<typeof correctionRequest>;
  nowMs: number;
}

/**
 * Legt das passende manual_*-Ereignis und die corrections-Zeile an und liefert den neu berechneten Tag.
 * Die Prüfung, ob der Monat gesperrt ist, liegt beim Aufrufer.
 */
export async function applyCorrection(
  tx: Tx,
  input: CorrectionInput,
): Promise<z.infer<typeof correctionResponse>> {
  const { userId, date, body, timezone, nowMs } = input;
  const now = new Date(nowMs);
  const dayStart = startOfLocalDay(date, timezone);
  const dayEnd = startOfLocalDay(addDays(date, 1), timezone);
  const inRange = (ms: number) => ms >= dayStart - DAY_MS && ms <= dayEnd + DAY_MS;

  const before = (await computeUserDays(tx, userId, date, date, nowMs)).days[0];
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

  const eventId = await insertUserEvent(
    tx,
    { sub: userId, did: input.deviceId },
    timezone,
    now,
    event,
  );
  await tx.insert(corrections).values({
    userId,
    date,
    eventId,
    field: body.field,
    oldValue,
    newValue,
    reason: body.reason ?? null,
    authorId: input.authorId,
  });
  const after = (await computeUserDays(tx, userId, date, date, nowMs)).days[0];
  return after ? { eventId, day: after } : { eventId };
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
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        if (user.orgId && !body.reason) throw new HttpError(400, 'reason_required');
        await assertMonthOpen(tx, claims.sub, date);
        return applyCorrection(tx, {
          userId: claims.sub,
          deviceId: claims.did,
          authorId: claims.sub,
          timezone: user.timezone,
          date,
          body,
          nowMs: ctx.now(),
        });
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
