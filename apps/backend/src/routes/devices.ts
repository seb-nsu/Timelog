import { deviceIdParams, deviceResponse, deviceUpdate, okResponse } from '@timelog/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type App, type AppContext, HttpError } from '../app.js';
import { withUser } from '../db/index.js';
import { devices, refreshTokens } from '../db/schema.js';
import { authOf, scopeOf } from './guard.js';

const tags = ['devices'];
const security = [{ bearer: [] }];

function toResponse(d: typeof devices.$inferSelect): z.infer<typeof deviceResponse> {
  const out: z.infer<typeof deviceResponse> = { id: d.id, kind: d.kind, os: d.os, name: d.name };
  if (d.lastSeenAt) out.lastSeenAt = d.lastSeenAt.toISOString();
  if (d.revokedAt) out.revokedAt = d.revokedAt.toISOString();
  return out;
}

export function deviceRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/devices',
    {
      schema: { tags, security, response: { 200: z.object({ devices: z.array(deviceResponse) }) } },
    },
    async (request) => {
      const rows = await withUser(ctx.db, scopeOf(authOf(request)), (tx) =>
        tx.select().from(devices).orderBy(devices.createdAt),
      );
      return { devices: rows.map(toResponse) };
    },
  );

  // Registriert das aktuelle Gerät (aus dem Token) neu: Name, System, Push-Token.
  app.post(
    '/devices',
    { schema: { tags, security, body: deviceUpdate, response: { 200: deviceResponse } } },
    async (request) => {
      const claims = authOf(request);
      const [row] = await withUser(ctx.db, scopeOf(claims), (tx) =>
        tx.update(devices).set(request.body).where(eq(devices.id, claims.did)).returning(),
      );
      if (!row) throw new HttpError(404, 'not_found');
      return toResponse(row);
    },
  );

  app.delete(
    '/devices/:id',
    { schema: { tags, security, params: deviceIdParams, response: { 200: okResponse } } },
    async (request) => {
      const claims = authOf(request);
      const now = new Date(ctx.now());
      await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const rows = await tx
          .update(devices)
          .set({ revokedAt: now })
          .where(and(eq(devices.id, request.params.id), isNull(devices.revokedAt)))
          .returning({ id: devices.id });
        if (rows.length === 0) throw new HttpError(404, 'not_found');
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(
            and(eq(refreshTokens.deviceId, request.params.id), isNull(refreshTokens.revokedAt)),
          );
      });
      return { ok: true as const };
    },
  );
}
