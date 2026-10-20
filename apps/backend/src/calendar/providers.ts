// Kalender-Anbieter (nur lesend): Google Calendar API v3 und Microsoft Graph v1.0.
// OAuth 2.0 Authorization Code mit PKCE (S256), vertrauliche Clients (Secret nur aus der Umgebung).
// Quellen und Prüfstand: docs/PROJEKTE_KALENDER.md.
import { zonedToUtc } from '@timelog/rules';
import type { CalendarProviderId } from '@timelog/shared';
import { z } from 'zod';

/** Termin, wie ihn ein Anbieter liefert. Der Titel lebt nur bis zum Stichwortabgleich. */
export interface RawEntry {
  start: string;
  end: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  kind: 'busy' | 'absence';
  title: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchange(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  list(accessToken: string, from: Date, to: Date, tz: string): Promise<RawEntry[]>;
  /** Widerruft die Freigabe beim Anbieter, soweit möglich (Fehler werden ignoriert). */
  revoke(refreshToken: string): Promise<void>;
}

/** Fehler mit festem Code ohne personenbezogene Inhalte (landet in calendar_connections.last_error). */
export class CalendarError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
});
const oauthError = z.object({ error: z.string() });

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new CalendarError('provider_unreachable');
  }
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = oauthError.safeParse(json);
    // invalid_grant = Freigabe widerrufen oder Refresh-Token abgelaufen
    throw new CalendarError(
      err.success && err.data.error === 'invalid_grant' ? 'invalid_grant' : 'token_failed',
    );
  }
  const parsed = tokenSchema.safeParse(json);
  if (!parsed.success) throw new CalendarError('token_failed');
  return {
    accessToken: parsed.data.access_token,
    ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
  };
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>) {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers } });
  } catch {
    throw new CalendarError('provider_unreachable');
  }
  if (res.status === 401) throw new CalendarError('unauthorized');
  if (!res.ok) throw new CalendarError('list_failed');
  return (await res.json()) as unknown;
}

const MAX_PAGES = 20;

// ── Google ────────────────────────────────────────────────────────────────────

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const googleTime = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const googlePage = z.object({
  items: z
    .array(
      z.object({
        status: z.string().optional(),
        summary: z.string().optional(),
        eventType: z.string().optional(),
        transparency: z.string().optional(),
        start: googleTime.optional(),
        end: googleTime.optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

export function googleProvider(
  creds: ClientCredentials,
  fetchImpl: typeof fetch = fetch,
): CalendarProvider {
  return {
    id: 'google',
    authorizeUrl: ({ state, codeChallenge, redirectUri }) => {
      const u = new URL(GOOGLE_AUTH);
      u.search = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return u.toString();
    },
    exchange: ({ code, codeVerifier, redirectUri }) =>
      postForm(fetchImpl, GOOGLE_TOKEN, {
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
    refresh: (refreshToken) =>
      postForm(fetchImpl, GOOGLE_TOKEN, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
    list: async (accessToken, from, to, tz) => {
      const out: RawEntry[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const u = new URL(GOOGLE_EVENTS);
        const q = new URLSearchParams({
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: 'true',
          maxResults: '2500',
          // Nur die nötigen Felder: keine Teilnehmer, Orte oder Beschreibungen übertragen
          fields: 'items(status,summary,eventType,transparency,start,end),nextPageToken',
        });
        for (const t of ['default', 'outOfOffice', 'focusTime']) q.append('eventTypes', t);
        if (pageToken) q.set('pageToken', pageToken);
        u.search = q.toString();
        const parsed = googlePage.safeParse(
          await getJson(fetchImpl, u.toString(), { authorization: `Bearer ${accessToken}` }),
        );
        if (!parsed.success) throw new CalendarError('list_failed');
        for (const e of parsed.data.items) {
          if (e.status === 'cancelled' || !e.start || !e.end) continue;
          const absence = e.eventType === 'outOfOffice';
          if (!absence && e.transparency === 'transparent') continue;
          const kind = absence ? 'absence' : 'busy';
          const title = e.summary ?? '';
          if (e.start.date && e.end.date) {
            out.push({
              start: new Date(zonedToUtc(e.start.date, '00:00', tz)).toISOString(),
              end: new Date(zonedToUtc(e.end.date, '00:00', tz)).toISOString(),
              allDay: true,
              startDate: e.start.date,
              endDate: e.end.date,
              kind,
              title,
            });
          } else if (e.start.dateTime && e.end.dateTime) {
            out.push({
              start: new Date(e.start.dateTime).toISOString(),
              end: new Date(e.end.dateTime).toISOString(),
              allDay: false,
              kind,
              title,
            });
          }
        }
        pageToken = parsed.data.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    },
    revoke: async (refreshToken) => {
      try {
        await fetchImpl(
          `${GOOGLE_REVOKE}?${new URLSearchParams({ token: refreshToken }).toString()}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
          },
        );
      } catch {
        // Widerruf ist nur bestmöglich; die lokalen Daten werden trotzdem gelöscht.
      }
    },
  };
}

// ── Microsoft Graph ───────────────────────────────────────────────────────────

/** Kleinste Berechtigung für calendarView: Termine ohne Text, Anhänge und Erweiterungen. */
export const MICROSOFT_SCOPE = 'offline_access Calendars.ReadBasic';
const GRAPH_VIEW = 'https://graph.microsoft.com/v1.0/me/calendarView';

const graphTime = z.object({ dateTime: z.string() });
const graphPage = z.object({
  value: z
    .array(
      z.object({
        subject: z.string().nullable().optional(),
        isAllDay: z.boolean().optional(),
        isCancelled: z.boolean().optional(),
        showAs: z.string().optional(),
        start: graphTime,
        end: graphTime,
      }),
    )
    .default([]),
  '@odata.nextLink': z.url().optional(),
});

/** „2026-10-14T09:00:00.0000000“ in der angefragten Zeitzone → UTC. */
function graphLocal(dateTime: string, tz: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(dateTime);
  if (!m?.[1] || !m[2]) throw new CalendarError('list_failed');
  try {
    return zonedToUtc(m[1], m[2], tz);
  } catch {
    // Uhrzeit in der Lücke der Zeitumstellung: eine Stunde später
    return zonedToUtc(
      m[1],
      `${String(Number(m[2].slice(0, 2)) + 1).padStart(2, '0')}${m[2].slice(2)}`,
      tz,
    );
  }
}

export function microsoftProvider(
  creds: ClientCredentials & { tenant: string },
  fetchImpl: typeof fetch = fetch,
): CalendarProvider {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenant)}/oauth2/v2.0`;
  return {
    id: 'microsoft',
    authorizeUrl: ({ state, codeChallenge, redirectUri }) => {
      const u = new URL(`${base}/authorize`);
      u.search = new URLSearchParams({
        client_id: creds.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: MICROSOFT_SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return u.toString();
    },
    exchange: ({ code, codeVerifier, redirectUri }) =>
      postForm(fetchImpl, `${base}/token`, {
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: MICROSOFT_SCOPE,
      }),
    refresh: (refreshToken) =>
      postForm(fetchImpl, `${base}/token`, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: MICROSOFT_SCOPE,
      }),
    list: async (accessToken, from, to, tz) => {
      const out: RawEntry[] = [];
      const first = new URL(GRAPH_VIEW);
      first.search = new URLSearchParams({
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $select: 'subject,start,end,isAllDay,showAs,isCancelled',
        $top: '500',
      }).toString();
      let next: string | undefined = first.toString();
      for (let page = 0; page < MAX_PAGES && next; page++) {
        const parsed = graphPage.safeParse(
          await getJson(fetchImpl, next, {
            authorization: `Bearer ${accessToken}`,
            prefer: `outlook.timezone="${tz}"`,
          }),
        );
        if (!parsed.success) throw new CalendarError('list_failed');
        for (const e of parsed.data.value) {
          if (e.isCancelled || e.showAs === 'free') continue;
          const kind = e.showAs === 'oof' ? 'absence' : 'busy';
          const title = e.subject ?? '';
          if (e.isAllDay) {
            const startDate = e.start.dateTime.slice(0, 10);
            const endDate = e.end.dateTime.slice(0, 10);
            out.push({
              start: new Date(zonedToUtc(startDate, '00:00', tz)).toISOString(),
              end: new Date(zonedToUtc(endDate, '00:00', tz)).toISOString(),
              allDay: true,
              startDate,
              endDate,
              kind,
              title,
            });
          } else {
            out.push({
              start: new Date(graphLocal(e.start.dateTime, tz)).toISOString(),
              end: new Date(graphLocal(e.end.dateTime, tz)).toISOString(),
              allDay: false,
              kind,
              title,
            });
          }
        }
        next = parsed.data['@odata.nextLink'];
      }
      return out;
    },
    // Microsoft bietet keinen Widerruf eines einzelnen Refresh-Tokens für vertrauliche Clients;
    // die Freigabe entfernt der Nutzer unter myapps.microsoft.com bzw. account.live.com/consent.
    revoke: () => Promise.resolve(),
  };
}
