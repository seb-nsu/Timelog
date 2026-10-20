// Kalender-Anbindung (Google, Microsoft 365), nur lesend. OAuth 2.0 Authorization Code mit PKCE
// läuft serverseitig: Client-Secrets nur aus der Umgebung, Refresh-Tokens verschlüsselt.
import { type CalendarBlock, absenceSuggestions, gapSuggestions } from '@timelog/rules';
import {
  CALENDAR_PROVIDERS,
  type CalendarProviderId,
  calendarCallbackQuery,
  calendarConnectRequest,
  calendarConnectResponse,
  calendarProviderParams,
  calendarStatusResponse,
  calendarSyncResponse,
  okResponse,
  suggestionsQuery,
  suggestionsResponse,
} from '@timelog/shared';
import { and, count, eq, gt, gte, lte, lt } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { type App, type AppContext, HttpError, limit } from '../app.js';
import { CalendarError } from '../calendar/providers.js';
import { asSystem, withUser } from '../db/index.js';
import {
  absences,
  calendarConnections,
  calendarEntries,
  calendarOauthStates,
  users,
} from '../db/schema.js';
import { featuresOf } from '../features.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { loadDays } from './days.js';
import { authOf, scopeOf } from './guard.js';

const tags = ['calendar'];
const security = [{ bearer: [] }];
const STATE_TTL_MS = 10 * 60_000;

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

export function callbackUri(ctx: AppContext, provider: CalendarProviderId): string {
  return `${ctx.apiUrl}/api/v1/calendar/${provider}/callback`;
}

/** Bestätigungsseite, wenn kein Rücksprung angegeben ist (Desktop- und Handy-App öffnen den Browser). */
function resultPage(ok: boolean): string {
  const title = ok ? 'Kalender verbunden' : 'Kalender nicht verbunden';
  const text = ok
    ? 'Die Verbindung ist eingerichtet. Du kannst dieses Fenster schließen und in TimeLog „Jetzt abrufen“ wählen.'
    : 'Die Verbindung wurde abgebrochen oder ist fehlgeschlagen. Bitte versuche es in TimeLog erneut.';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#111;background:#fff}@media (prefers-color-scheme: dark){body{color:#eee;background:#111}}</style></head><body><main><h1>${title}</h1><p role="status">${text}</p></main></body></html>`;
}

function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

/** Ganztägige und sonstige Termine als Eingabe für die Regeln. */
export function toBlock(r: typeof calendarEntries.$inferSelect): CalendarBlock {
  return {
    from: r.startAt.toISOString(),
    to: r.endAt.toISOString(),
    kind: r.kind,
    allDay: r.allDay,
    ...(r.startDate ? { startDate: r.startDate } : {}),
    ...(r.endDate ? { endDate: r.endDate } : {}),
  };
}

export function calendarRoutes(app: App, ctx: AppContext): void {
  const allowedRedirect = (url: string): boolean => {
    const origin = originOf(url);
    const allowed = [ctx.adminUrl, ctx.appUrl, ...ctx.sso.redirectOrigins].map(originOf);
    return origin !== undefined && allowed.includes(origin);
  };

  async function assertAllowed(userId: string, scope: ReturnType<typeof scopeOf>) {
    await withUser(ctx.db, scope, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw new HttpError(401, 'unauthorized');
      if (!(await featuresOf(tx, user)).calendar) throw new HttpError(403, 'calendar_disabled');
    });
  }

  app.get(
    '/calendar',
    {
      schema: {
        tags,
        security,
        description: 'Verfügbare Anbieter und eigene Kalender-Verbindungen (ohne Tokens).',
        response: { 200: calendarStatusResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, claims.sub));
        if (!user) throw new HttpError(401, 'unauthorized');
        const features = await featuresOf(tx, user);
        const conns = await tx
          .select()
          .from(calendarConnections)
          .where(eq(calendarConnections.userId, claims.sub));
        const counts = await tx
          .select({ connectionId: calendarEntries.connectionId, n: count() })
          .from(calendarEntries)
          .where(eq(calendarEntries.userId, claims.sub))
          .groupBy(calendarEntries.connectionId);
        const byConn = new Map(counts.map((c) => [c.connectionId, c.n]));
        return {
          allowed: features.calendar,
          providers: CALENDAR_PROVIDERS.map((p) => ({
            provider: p,
            configured: ctx.calendar.provider(p) !== undefined,
          })),
          connections: conns.map((c) => ({
            provider: c.provider,
            status: c.status,
            ...(c.lastSyncAt ? { lastSyncAt: c.lastSyncAt.toISOString() } : {}),
            ...(c.lastError ? { lastError: c.lastError } : {}),
            entries: byConn.get(c.id) ?? 0,
          })),
        };
      });
    },
  );

  app.post(
    '/calendar/:provider/connect',
    {
      schema: {
        tags,
        security,
        description:
          'Startet die Anmeldung beim Anbieter (Authorization Code + PKCE). Liefert die Adresse, die der Client im Browser öffnet.',
        params: calendarProviderParams,
        body: calendarConnectRequest,
        response: { 200: calendarConnectResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { provider: id } = request.params;
      const provider = ctx.calendar.provider(id);
      if (!provider) throw new HttpError(404, 'provider_not_configured');
      const { redirect } = request.body;
      if (redirect && !allowedRedirect(redirect)) throw new HttpError(400, 'invalid_redirect');
      await assertAllowed(claims.sub, scopeOf(claims));
      const state = randomToken(24);
      const verifier = randomToken(48);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      await withUser(ctx.db, scopeOf(claims), (tx) =>
        tx.insert(calendarOauthStates).values({
          id: sha256(state),
          userId: claims.sub,
          provider: id,
          codeVerifier: ctx.calendar.sealToken(verifier),
          redirect: redirect ?? null,
          expiresAt: new Date(ctx.now() + STATE_TTL_MS),
        }),
      );
      return {
        url: provider.authorizeUrl({
          state,
          codeChallenge: challenge,
          redirectUri: callbackUri(ctx, id),
        }),
      };
    },
  );

  app.post(
    '/calendar/:provider/sync',
    {
      schema: {
        tags,
        security,
        description: '„Jetzt abrufen“: Termine des Abrufzeitraums neu laden.',
        params: calendarProviderParams,
        response: { 200: calendarSyncResponse },
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      limit(ctx, reply, `calendar:${claims.sub}`, 10);
      await assertAllowed(claims.sub, scopeOf(claims));
      try {
        return { entries: await ctx.calendar.sync(claims.sub, request.params.provider, ctx.now()) };
      } catch (err) {
        if (err instanceof CalendarError) {
          throw new HttpError(err.code === 'not_found' ? 404 : 502, `calendar_${err.code}`);
        }
        throw err;
      }
    },
  );

  app.delete(
    '/calendar/:provider',
    {
      schema: {
        tags,
        security,
        description:
          'Trennt die Verbindung: widerruft die Freigabe beim Anbieter (soweit möglich) und löscht Token und alle gespeicherten Termine.',
        params: calendarProviderParams,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const id = request.params.provider;
      const removed = await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [conn] = await tx
          .select()
          .from(calendarConnections)
          .where(
            and(eq(calendarConnections.userId, claims.sub), eq(calendarConnections.provider, id)),
          );
        if (!conn) return undefined;
        await tx.delete(calendarEntries).where(eq(calendarEntries.connectionId, conn.id));
        await tx.delete(calendarConnections).where(eq(calendarConnections.id, conn.id));
        await tx
          .delete(calendarOauthStates)
          .where(
            and(eq(calendarOauthStates.userId, claims.sub), eq(calendarOauthStates.provider, id)),
          );
        return conn;
      });
      if (!removed) throw new HttpError(404, 'not_found');
      const provider = ctx.calendar.provider(id);
      if (provider) {
        try {
          await provider.revoke(ctx.calendar.openToken(removed.refreshToken));
        } catch {
          // Widerruf ist bestmöglich; lokal ist alles gelöscht.
        }
      }
      return { ok: true as const };
    },
  );

  app.get(
    '/calendar/suggestions',
    {
      schema: {
        tags,
        security,
        description:
          'Vorschläge aus Terminen: Lücken/Pausen in Terminen („War Arbeit (Termin)“) und ganztägige Abwesenheiten. Nichts wird automatisch umgebucht.',
        querystring: suggestionsQuery,
        response: { 200: suggestionsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { from, to } = request.query;
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const loaded = await loadDays(tx, claims.sub, from, to, ctx.now());
        const rows = await tx
          .select()
          .from(calendarEntries)
          .where(
            and(
              eq(calendarEntries.userId, claims.sub),
              lt(calendarEntries.startAt, new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000)),
              gt(calendarEntries.endAt, new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000)),
            ),
          );
        const blocks = rows.map(toBlock);
        const locked = new Set(loaded.approvedMonths);
        const gaps = loaded.days
          .filter((d) => !locked.has(d.date.slice(0, 7)))
          .flatMap((d) => gapSuggestions(d, blocks));
        const own = await tx
          .select()
          .from(absences)
          .where(
            and(eq(absences.userId, claims.sub), gte(absences.date, from), lte(absences.date, to)),
          );
        const absenceList = absenceSuggestions(
          blocks,
          own.map((a) => ({ date: a.date, kind: a.kind, minutes: a.minutes })),
          loaded.timezone,
          from,
          to,
        ).filter((a) => !locked.has(a.date.slice(0, 7)));
        return { gaps, absences: absenceList };
      });
    },
  );
}

/** Rücksprung vom Anbieter (ohne Bearer-Token; Zuordnung über den einmaligen state). */
export function calendarCallbackRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/calendar/:provider/callback',
    {
      schema: {
        tags,
        description:
          'OAuth-Rücksprung des Anbieters. Tauscht den Code (mit PKCE-Verifier) gegen Tokens.',
        params: calendarProviderParams,
        querystring: calendarCallbackQuery,
      },
    },
    async (request, reply) => {
      const { provider: id } = request.params;
      const { state, code, error } = request.query;
      const stored = await asSystem(ctx.db, async (tx) => {
        const [row] = await tx
          .delete(calendarOauthStates)
          .where(eq(calendarOauthStates.id, sha256(state)))
          .returning();
        return row;
      });
      const finish = (ok: boolean, reason?: string) => {
        if (stored?.redirect) {
          return reply.redirect(
            withParam(stored.redirect, 'calendar', ok ? 'connected' : (reason ?? 'error')),
            303,
          );
        }
        return reply
          .code(ok ? 200 : 400)
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(resultPage(ok));
      };
      const provider = ctx.calendar.provider(id);
      if (
        !stored ||
        stored.provider !== id ||
        stored.expiresAt.getTime() < ctx.now() ||
        !provider
      ) {
        return finish(false, 'invalid_state');
      }
      if (error || !code) return finish(false, 'denied');
      let refreshToken: string | undefined;
      try {
        const tokens = await provider.exchange({
          code,
          codeVerifier: ctx.calendar.openToken(stored.codeVerifier),
          redirectUri: callbackUri(ctx, id),
        });
        refreshToken = tokens.refreshToken;
      } catch {
        return finish(false, 'exchange_failed');
      }
      if (!refreshToken) return finish(false, 'no_refresh_token');
      const [user] = await asSystem(ctx.db, (tx) =>
        tx.select({ orgId: users.orgId }).from(users).where(eq(users.id, stored.userId)),
      );
      const sealed = ctx.calendar.sealToken(refreshToken);
      await withUser(ctx.db, { userId: stored.userId, orgId: user?.orgId ?? null }, (tx) =>
        tx
          .insert(calendarConnections)
          .values({ userId: stored.userId, provider: id, refreshToken: sealed })
          .onConflictDoUpdate({
            target: [calendarConnections.userId, calendarConnections.provider],
            set: { refreshToken: sealed, status: 'active', lastError: null },
          }),
      );
      try {
        await ctx.calendar.sync(stored.userId, id, ctx.now());
      } catch {
        // Erster Abruf darf scheitern; der Status zeigt den Fehler, „Jetzt abrufen“ wiederholt ihn.
      }
      return finish(true);
    },
  );
}
