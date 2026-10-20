// Offene Rückfragen für Geräte ohne Push (Desktop) und für die Anzeige in der App.
import { addDays, localDate } from '@timelog/rules';
import {
  type Prompt,
  endPromptPayload,
  okResponse,
  promptDismissRequest,
  promptsResponse,
  weekPromptPayload,
} from '@timelog/shared';
import { and, eq, gte, isNull } from 'drizzle-orm';
import type { App, AppContext } from '../app.js';
import { withUser } from '../db/index.js';
import { pushPrompts, users } from '../db/schema.js';
import { loadDays } from './days.js';
import { authOf, scopeOf } from './guard.js';

const security = [{ bearer: [] }];
const DAY_MS = 86_400_000;

export function promptRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/prompts',
    {
      schema: {
        tags: ['prompts'],
        security,
        description:
          'Offene Rückfragen: Arbeitsende bestätigen (3 Tage), Ende fehlt (3 Tage), Wochenrückblick (7 Tage). Erledigte (Sitzung entschieden, Ende ergänzt) und ausgeblendete fehlen.',
        response: { 200: promptsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const now = ctx.now();
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const rows = await tx
          .select()
          .from(pushPrompts)
          .where(
            and(
              eq(pushPrompts.userId, claims.sub),
              isNull(pushPrompts.dismissedAt),
              gte(pushPrompts.createdAt, new Date(now - 7 * DAY_MS)),
            ),
          )
          .orderBy(pushPrompts.createdAt);
        if (rows.length === 0) return { prompts: [] };
        const [user] = await tx
          .select({ timezone: users.timezone })
          .from(users)
          .where(eq(users.id, claims.sub));
        const today = localDate(now, user?.timezone ?? 'Europe/Berlin');
        const { days } = await loadDays(tx, claims.sub, addDays(today, -8), today, now);
        const sessions = new Map(days.flatMap((d) => d.sessions.map((s) => [s.id, s])));
        const prompts: Prompt[] = [];
        for (const r of rows) {
          const createdAt = r.createdAt.toISOString();
          if (r.kind === 'week_review') {
            const payload = weekPromptPayload.safeParse(r.payload);
            if (payload.success) {
              prompts.push({ kind: r.kind, ref: r.ref, createdAt, payload: payload.data });
            }
            continue;
          }
          const payload = endPromptPayload.safeParse(r.payload);
          if (!payload.success || now - r.createdAt.getTime() > 3 * DAY_MS) continue;
          const session = sessions.get(payload.data.sessionId);
          // Erledigt: Sitzung entschieden bzw. Ende ergänzt (Warnung weg)
          if (!session || session.confirmed !== undefined) continue;
          if (
            r.kind === 'end_missing' &&
            !session.warnings.includes('no_end') &&
            !session.warnings.includes('gap_end')
          ) {
            continue;
          }
          prompts.push({ kind: r.kind, ref: r.ref, createdAt, payload: payload.data });
        }
        return { prompts };
      });
    },
  );

  app.post(
    '/prompts/dismiss',
    {
      schema: {
        tags: ['prompts'],
        security,
        description: 'Blendet eine Rückfrage auf allen Geräten aus.',
        body: promptDismissRequest,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      await withUser(ctx.db, scopeOf(claims), (tx) =>
        tx
          .update(pushPrompts)
          .set({ dismissedAt: new Date(ctx.now()) })
          .where(
            and(
              eq(pushPrompts.userId, claims.sub),
              eq(pushPrompts.kind, request.body.kind),
              eq(pushPrompts.ref, request.body.ref),
            ),
          ),
      );
      return { ok: true as const };
    },
  );
}
