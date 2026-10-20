import {
  cursorQuery,
  eventBatchRequest,
  eventBatchResponse,
  eventPage,
  okResponse,
  presencePage,
  presenceRequest,
  type StoredEvent,
} from '@timelog/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { type App, type AppContext, HttpError, limit } from '../app.js';
import { withUser } from '../db/index.js';
import { devices, events, presenceSpans } from '../db/schema.js';
import { authOf, scopeOf } from './guard.js';

const security = [{ bearer: [] }];

export function toStoredEvent(r: typeof events.$inferSelect): StoredEvent {
  const e: StoredEvent = {
    id: r.id,
    deviceId: r.deviceId,
    type: r.type as StoredEvent['type'],
    source: r.source as StoredEvent['source'],
    ts: r.ts.toISOString(),
    tz: r.tz,
    createdAt: r.createdAt.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
  };
  if (r.endTs) e.endTs = r.endTs.toISOString();
  if (r.networkId) e.networkId = r.networkId;
  if (r.refEventId) e.refEventId = r.refEventId;
  if (r.flags && r.flags.length > 0) e.flags = r.flags as NonNullable<StoredEvent['flags']>;
  return e;
}

export function eventRoutes(app: App, ctx: AppContext): void {
  app.post(
    '/events/batch',
    {
      schema: {
        tags: ['events'],
        security,
        description: 'Bis 500 Ereignisse, max. 256 KB; idempotent über (user_id, id).',
        body: eventBatchRequest,
        response: { 200: eventBatchResponse },
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      limit(ctx, reply, `device:${claims.did}`, ctx.limits.device);
      const receivedAt = new Date(ctx.now());
      const rows = request.body.events.map((e) => ({
        userId: claims.sub, // nie aus dem Request
        deviceId: claims.did,
        id: e.id,
        type: e.type,
        source: e.source,
        ts: new Date(e.ts),
        endTs: e.endTs ? new Date(e.endTs) : null,
        tz: e.tz,
        networkId: e.networkId ?? null,
        refEventId: e.refEventId ?? null,
        createdAt: new Date(e.createdAt),
        receivedAt,
        flags: e.flags ?? null,
      }));
      const inserted = await withUser(ctx.db, scopeOf(claims), (tx) =>
        tx.insert(events).values(rows).onConflictDoNothing().returning({ id: events.id }),
      );
      return { accepted: inserted.length, duplicates: rows.length - inserted.length };
    },
  );

  app.get(
    '/events',
    {
      schema: {
        tags: ['events'],
        security,
        querystring: cursorQuery,
        response: { 200: eventPage },
      },
    },
    async (request) => {
      const { since, limit: max } = request.query;
      const rows = await withUser(ctx.db, scopeOf(authOf(request)), (tx) =>
        tx.select().from(events).where(gt(events.seq, since)).orderBy(asc(events.seq)).limit(max),
      );
      return { events: rows.map(toStoredEvent), nextCursor: rows.at(-1)?.seq ?? since };
    },
  );

  app.put(
    '/presence',
    {
      schema: {
        tags: ['presence'],
        security,
        description:
          'Offene Aktiv-Spanne anlegen bzw. verlängern, abgeschlossene Spannen nachreichen.',
        body: presenceRequest,
        response: { 200: okResponse },
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      limit(ctx, reply, `device:${claims.did}`, ctx.limits.device);
      await withUser(ctx.db, scopeOf(claims), async (tx) => {
        for (const s of request.body.spans) {
          const rows = await tx
            .insert(presenceSpans)
            .values({
              userId: claims.sub,
              id: s.id,
              deviceId: claims.did,
              start: new Date(s.start),
              end: new Date(s.end),
              open: s.open,
            })
            .onConflictDoUpdate({
              target: [presenceSpans.userId, presenceSpans.id],
              set: {
                end: sql`greatest(${presenceSpans.end}, excluded.end)`,
                open: sql`excluded.open`,
                seq: sql`nextval(pg_get_serial_sequence('presence_spans', 'seq'))`,
              },
              // Eine Spanne gehört genau einem Gerät
              setWhere: eq(presenceSpans.deviceId, claims.did),
            })
            .returning({ id: presenceSpans.id });
          if (rows.length === 0) throw new HttpError(409, 'span_owned_by_other_device');
        }
      });
      return { ok: true as const };
    },
  );

  app.get(
    '/presence',
    {
      schema: {
        tags: ['presence'],
        security,
        querystring: cursorQuery,
        response: { 200: presencePage },
      },
    },
    async (request) => {
      const { since, limit: max } = request.query;
      const rows = await withUser(ctx.db, scopeOf(authOf(request)), (tx) =>
        tx
          .select({ span: presenceSpans, kind: devices.kind })
          .from(presenceSpans)
          .innerJoin(devices, eq(devices.id, presenceSpans.deviceId))
          .where(and(gt(presenceSpans.seq, since)))
          .orderBy(asc(presenceSpans.seq))
          .limit(max),
      );
      return {
        spans: rows.map(({ span, kind }) => ({
          id: span.id,
          deviceId: span.deviceId,
          deviceKind: kind,
          start: span.start.toISOString(),
          end: span.end.toISOString(),
          open: span.open,
        })),
        nextCursor: rows.at(-1)?.span.seq ?? since,
      };
    },
  );
}
