// Kleiner Backend-Ersatz für Tests. Prüft Anfragen mit denselben Zod-Schemas wie das Backend,
// damit die App nur gültige Daten sendet.
import {
  absencesUpdate,
  correctionRequest,
  deviceUpdate,
  eventBatchRequest,
  leaveRequestInput,
  loginRequest,
  networkInput,
  presenceRequest,
  settingsSchema,
  settingsUpdate,
  targetHoursUpdate,
} from '@timelog/shared';
import { createHmac } from 'node:crypto';

type Json = Record<string, unknown>;

export interface FakeServer {
  fetch: typeof fetch;
  offline: boolean;
  /** Ereignis-IDs, die /events/batch mit 400 ablehnt */
  rejectIds: Set<string>;
  requests: string[];
  events: (Json & { id: string; deviceId: string; receivedAt: string })[];
  spans: (Json & { id: string; deviceId: string; deviceKind: string })[];
  networks: Json[];
  settings: Json;
  state: string;
  schedule: Json[];
  absences: Json[];
  leaveRequests: (Json & { id: string; status: string })[];
  devices: Json[];
  corrections: Json[];
  pushTokens: string[];
  /** Sprache der Push-Texte je POST /devices */
  pushLocales: string[];
  refreshTokens: Set<string>;
  orgAccount: boolean;
  totpRequired: boolean;
  /** Access-Token sofort ungültig machen (simuliert Ablauf nach 15 min) */
  expireAccess: () => void;
  addLaptopEvent: (e: Json & { id: string }) => void;
  /** Zusätzliche Antworten je „METHODE /pfad“ (Projekte, Kalender, Orte); Funktion erhält den Body */
  extra: Record<string, unknown>;
}

export const USER_KEY = Buffer.alloc(32, 7).toString('base64');
const MOBILE_ID = '22222222-2222-4222-8222-222222222222';
export const LAPTOP_ID = '33333333-3333-4333-8333-333333333333';

function hmac(value: string): string {
  return createHmac('sha256', Buffer.from(USER_KEY, 'base64'))
    .update(value.trim().toLowerCase().replaceAll('-', ':'))
    .digest('hex');
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (status: number, code: string) => json({ error: code }, status);

export function fakeServer(clock: () => number = Date.now): FakeServer {
  let accessCounter = 0;
  let refreshCounter = 0;
  let validAccess = new Set<string>();
  const server: FakeServer = {
    offline: false,
    rejectIds: new Set(),
    requests: [],
    events: [],
    spans: [],
    networks: [],
    settings: settingsSchema.parse({}),
    state: 'BE',
    schedule: [],
    absences: [],
    leaveRequests: [],
    devices: [
      { id: MOBILE_ID, kind: 'mobile', os: 'android 16', name: 'Pixel' },
      { id: LAPTOP_ID, kind: 'desktop', os: 'windows', name: 'Laptop' },
    ],
    corrections: [],
    pushTokens: [],
    pushLocales: [],
    refreshTokens: new Set(),
    orgAccount: false,
    totpRequired: false,
    extra: {},
    expireAccess: () => {
      validAccess = new Set();
    },
    addLaptopEvent: (e) => {
      server.events.push({
        tz: 'Europe/Berlin',
        source: 'system',
        createdAt: e.ts,
        ...e,
        deviceId: LAPTOP_ID,
        receivedAt: new Date(clock()).toISOString(),
      });
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- async wandelt Ausnahmen in abgelehnte Promises
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      server.requests.push(`${method} ${path}`);
      if (server.offline) throw new TypeError('Network request failed');

      const tokens = () => {
        accessCounter += 1;
        refreshCounter += 1;
        const access = `access-${String(accessCounter)}`;
        const refresh = `refresh-token-${String(refreshCounter)}-xxxxxxxxxxxxxxxx`;
        validAccess.add(access);
        server.refreshTokens.add(refresh);
        return {
          accessToken: access,
          refreshToken: refresh,
          expiresIn: 900,
          deviceId: MOBILE_ID,
          totpSetupRequired: false,
        };
      };

      // ── ohne Anmeldung ──
      if (method === 'POST' && path === '/auth/login') {
        const parsed = loginRequest.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        if (parsed.data.password !== 'geheim-geheim') return error(401, 'invalid_credentials');
        if (server.totpRequired && !parsed.data.totp) return error(401, 'totp_required');
        return json(tokens());
      }
      if (method === 'POST' && path === '/auth/refresh') {
        const token = (body as { refreshToken?: string } | undefined)?.refreshToken ?? '';
        if (!server.refreshTokens.delete(token)) return error(401, 'invalid_token');
        return json(tokens());
      }
      if (method === 'POST' && path === '/auth/logout') return json({ ok: true });

      // ── mit Anmeldung ──
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
      if (!validAccess.has(auth.replace(/^Bearer /, ''))) return error(401, 'unauthorized');

      if (method === 'POST' && path === '/events/batch') {
        const parsed = eventBatchRequest.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        if (parsed.data.events.some((e) => server.rejectIds.has(e.id)))
          return error(400, 'invalid_request');
        let accepted = 0;
        for (const e of parsed.data.events) {
          if (server.events.some((x) => x.id === e.id)) continue;
          accepted += 1;
          server.events.push({
            ...e,
            deviceId: MOBILE_ID,
            receivedAt: new Date(clock()).toISOString(),
          });
        }
        return json({ accepted, duplicates: parsed.data.events.length - accepted });
      }
      if (method === 'GET' && path === '/events') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 500);
        const page = server.events.slice(since, since + limit);
        return json({ events: page, nextCursor: since + page.length });
      }
      if (method === 'PUT' && path === '/presence') {
        const parsed = presenceRequest.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        for (const s of parsed.data.spans) {
          const i = server.spans.findIndex((x) => x.id === s.id);
          const row = { ...s, deviceId: MOBILE_ID, deviceKind: 'mobile' };
          if (i >= 0) server.spans[i] = row;
          else server.spans.push(row);
        }
        return json({ ok: true });
      }
      if (method === 'GET' && path === '/presence') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const page = server.spans.slice(since);
        return json({ spans: page, nextCursor: since + page.length });
      }
      if (method === 'GET' && path === '/networks') {
        return json({ networks: server.networks, keys: { user: USER_KEY } });
      }
      if (method === 'POST' && path === '/networks') {
        const parsed = networkInput.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        const n = parsed.data;
        const row: Json = {
          id: `44444444-4444-4444-8444-${String(server.networks.length).padStart(12, '0')}`,
          scope: 'user',
          kind: n.kind,
          label: n.label,
          ...(n.kind === 'fingerprint' ? { fingerprintHmac: hmac(n.fingerprint) } : {}),
          ...(n.kind === 'ssid' ? { ssid: n.ssid } : {}),
        };
        server.networks.push(row);
        return json(row);
      }
      if (method === 'DELETE' && path.startsWith('/networks/')) {
        const id = path.split('/')[2];
        server.networks = server.networks.filter((n) => n.id !== id);
        return json({ ok: true });
      }
      if (path === '/settings') {
        if (method === 'PUT') {
          const parsed = settingsUpdate.safeParse(body);
          if (!parsed.success) return error(400, 'invalid_request');
          if (parsed.data.state) server.state = parsed.data.state;
          if (parsed.data.settings) server.settings = parsed.data.settings;
        }
        return json({
          name: 'Test',
          email: 'a@example.com',
          timezone: 'Europe/Berlin',
          state: server.state,
          settings: server.settings,
        });
      }
      if (path === '/target-hours') {
        if (method === 'PUT') {
          const parsed = targetHoursUpdate.safeParse(body);
          if (!parsed.success) return error(400, 'invalid_request');
          server.schedule.push(parsed.data);
          return json({ ok: true });
        }
        return json({ schedule: server.schedule });
      }
      if (path === '/absences') {
        if (method === 'PUT') {
          const parsed = absencesUpdate.safeParse(body);
          if (!parsed.success) return error(400, 'invalid_request');
          const { from, to, absences } = parsed.data;
          if (server.orgAccount && absences.some((a) => a.kind === 'vacation'))
            return error(409, 'leave_request_required');
          server.absences = [
            ...server.absences.filter((a) => String(a.date) < from || String(a.date) > to),
            ...absences,
          ];
          return json({ ok: true });
        }
        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        return json({
          absences: server.absences.filter((a) => String(a.date) >= from && String(a.date) <= to),
        });
      }
      if (path === '/leave' && method === 'GET') {
        return json({
          year: Number(url.searchParams.get('year')),
          account: {
            year: Number(url.searchParams.get('year')),
            entitlement: 30,
            correction: 0,
            carryOver: 0,
            carryOverManual: false,
            carryOverUsed: 0,
            carryOverForfeited: 0,
            carryOverExpiry: '2026-03-31',
            taken: 10,
            planned: 0,
            pending: 0,
            remaining: 20,
            remainingAfterPending: 20,
          },
          requests: server.leaveRequests,
          profile: {},
          adjustments: [],
          settings: {
            defaultAnnualDays: 30,
            standardWorkdaysPerWeek: 5,
            carryOverExpiry: '03-31',
            carryOverExpires: true,
          },
          managed: server.orgAccount,
        });
      }
      if (path === '/leave/requests' && method === 'POST') {
        const parsed = leaveRequestInput.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        const r = {
          id: `66666666-6666-4666-8666-${String(server.leaveRequests.length).padStart(12, '0')}`,
          userId: '77777777-7777-4777-8777-777777777777',
          ...parsed.data,
          days: 1,
          minutes: 480,
          status: server.orgAccount ? 'pending' : 'approved',
          createdAt: new Date(clock()).toISOString(),
          history: [],
        };
        server.leaveRequests.push(r);
        return json(r);
      }
      if (method === 'POST' && /^\/leave\/requests\/[\w-]+\/cancel$/.test(path)) {
        const r = server.leaveRequests.find((x) => x.id === path.split('/')[3]);
        if (!r) return error(404, 'not_found');
        r.status = 'cancelled';
        return json(r);
      }
      if (path === '/overtime' && method === 'GET') {
        return json({
          year: Number(url.searchParams.get('year')),
          startBalanceMinutes: 0,
          months: [
            {
              month: '2026-10',
              workMinutes: 90,
              bookedMinutes: 0,
              reducedMinutes: 0,
              balanceMinutes: 90,
              overMax: true,
              approved: false,
            },
          ],
          balanceMinutes: 90,
          maxBalanceMinutes: 60,
          overMax: true,
          bookings: [],
        });
      }
      if (method === 'PATCH' && path.startsWith('/days/')) {
        const parsed = correctionRequest.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        if (server.orgAccount && !parsed.data.reason) return error(400, 'reason_required');
        const eventId = `55555555-5555-4555-8555-${String(server.corrections.length).padStart(12, '0')}`;
        server.corrections.push({ date: path.split('/')[2], eventId, ...parsed.data });
        return json({ eventId });
      }
      if (method === 'POST' && /^\/days\/[\d-]+\/confirm$/.test(path))
        return json({ confirmed: 1 });
      if (path === '/devices' && method === 'GET') return json({ devices: server.devices });
      if (path === '/devices' && method === 'POST') {
        const parsed = deviceUpdate.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        if (parsed.data.pushToken) server.pushTokens.push(parsed.data.pushToken);
        if (parsed.data.locale) server.pushLocales.push(parsed.data.locale);
        return json(server.devices[0]);
      }
      if (method === 'DELETE' && path.startsWith('/devices/')) {
        const id = path.split('/')[2];
        server.devices = server.devices.map((d) =>
          d.id === id ? { ...d, revokedAt: new Date(clock()).toISOString() } : d,
        );
        return json({ ok: true });
      }
      if (method === 'GET' && path === '/export') {
        return new Response('Datum;Netto\n2026-10-14;480\n', { status: 200 });
      }
      if (method === 'GET' && path === '/me/export') return json({ events: server.events });
      if (method === 'DELETE' && path === '/me') {
        const password = (body as { password?: string } | undefined)?.password;
        if (password !== 'geheim-geheim') return error(401, 'invalid_credentials');
        return json({ mode: 'deleted' });
      }
      const extra = server.extra[`${method} ${path}`];
      if (extra !== undefined) {
        return json(typeof extra === 'function' ? (extra as (b: unknown) => unknown)(body) : extra);
      }
      return error(404, 'not_found');
    },
  };
  return server;
}
