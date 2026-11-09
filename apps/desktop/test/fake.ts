// Attrappe des Rust-Kerns für Oberflächentests.
import type { LocalData, Profile } from '@timelog/app-core';
import { createApiClient } from '@timelog/shared';
import { vi } from 'vitest';
import type { AppState, DesktopBackend } from '../src/backend.js';

export interface Fake extends DesktopBackend {
  notifications: [string, string][];
  stored: Map<string, string>;
  calls: {
    manual: string[];
    ranges: [string, string, string][];
    decisions: [string, boolean][];
    requests: string[];
  };
  data: LocalData;
  state: AppState;
  /** Antworten des gefakten Servers je „METHODE /pfad“ (ohne Query); Funktion = dynamisch */
  responses: Record<string, unknown>;
  emit: () => void;
}

export const LEAVE_REQUEST = {
  id: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  kind: 'vacation',
  from: '2026-11-02',
  to: '2026-11-06',
  halfDayStart: false,
  halfDayEnd: false,
  days: 5,
  minutes: 2400,
  status: 'approved',
  createdAt: '2026-10-01T08:00:00Z',
  decisionComment: 'Viel Erholung',
  history: [],
} as const;

export const LEAVE_OVERVIEW = {
  year: 2026,
  account: {
    year: 2026,
    entitlement: 30,
    correction: 0,
    carryOver: 2,
    carryOverManual: false,
    carryOverUsed: 2,
    carryOverForfeited: 0,
    carryOverExpiry: '2026-03-31',
    taken: 12.5,
    planned: 5,
    pending: 0,
    remaining: 14.5,
    remainingAfterPending: 14.5,
  },
  requests: [LEAVE_REQUEST],
  profile: {},
  adjustments: [],
  settings: {
    defaultAnnualDays: 30,
    standardWorkdaysPerWeek: 5,
    carryOverExpiry: '03-31',
    carryOverExpires: true,
    maxOvertimeMinutes: 600,
  },
  managed: true,
};

export const OVERTIME = {
  year: 2026,
  startBalanceMinutes: 120,
  months: [
    {
      month: '2026-09',
      workMinutes: 600,
      bookedMinutes: 0,
      reducedMinutes: 0,
      balanceMinutes: 720,
      overMax: true,
      approved: true,
    },
    {
      month: '2026-10',
      workMinutes: -480,
      bookedMinutes: 0,
      reducedMinutes: 480,
      balanceMinutes: 240,
      overMax: false,
      approved: false,
    },
  ],
  balanceMinutes: 240,
  maxBalanceMinutes: 600,
  overMax: false,
  bookings: [],
};

export function fakeBackend(
  overrides: Partial<AppState> = {},
  data: LocalData = { events: [], spans: [] },
): Fake {
  const listeners = new Set<() => void>();
  const calls: Fake['calls'] = { manual: [], ranges: [], decisions: [], requests: [] };
  let profile: Profile | undefined = { state: 'BE', timezone: 'Europe/Berlin' };
  const responses: Record<string, unknown> = {
    'GET /api/v1/networks': { networks: [], keys: { user: 'a2V5' } },
    'POST /api/v1/networks': {
      id: '11111111-1111-4111-8111-111111111111',
      scope: 'user',
      kind: 'fingerprint',
      label: 'Arbeitsplatz',
    },
    'PUT /api/v1/settings': {
      name: 'Test',
      email: 'a@b.de',
      timezone: 'Europe/Berlin',
      state: 'BY',
      settings: {
        triggers: {
          boot: true,
          shutdown: true,
          network: true,
          geofence: false,
          standbyBreaks: true,
        },
        notifications: { forgotEnd: true, over10h: true, breakViolation: true },
        workdays: [1, 2, 3, 4, 5],
        localOnly: false,
      },
    },
    'PUT /api/v1/target-hours': { ok: true },
    'GET /api/v1/target-hours': { schedule: [] },
    'GET /api/v1/absences': { absences: [] },
    'GET /api/v1/prompts': { prompts: [] },
    'POST /api/v1/prompts/dismiss': { ok: true },
    'GET /api/v1/leave': LEAVE_OVERVIEW,
    'GET /api/v1/overtime': OVERTIME,
    'POST /api/v1/leave/requests': { ...LEAVE_REQUEST, status: 'pending' },
    [`POST /api/v1/leave/requests/${LEAVE_REQUEST.id}/cancel`]: {
      ...LEAVE_REQUEST,
      status: 'cancelled',
    },
  };
  responses['GET /api/v1/settings'] = responses['PUT /api/v1/settings'];

  const fetchFake: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.requests.push(`${key}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`);
    const entry = responses[key];
    const body: unknown =
      typeof entry === 'function'
        ? (entry as (b: unknown) => unknown)(
            typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
          )
        : entry;
    return Promise.resolve(
      body === undefined
        ? new Response('{"error":"not_found"}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  };

  const stored = new Map<string, string>();
  const notifications: [string, string][] = [];
  const fake: Fake = {
    notifications,
    stored,
    responses,
    notify: (title, body) => {
      notifications.push([title, body]);
      return Promise.resolve();
    },
    storage: {
      get: (key) => stored.get(key) ?? null,
      set: (key, value) => {
        stored.set(key, value);
      },
    },
    calls,
    data,
    state: {
      loggedIn: true,
      baseUrl: 'https://zeit.example',
      setupDone: true,
      sync: { state: 'ok', at: '2026-10-15T07:00:00Z' },
      pending: 0,
      tracker: {
        bootTime: '2026-10-15T06:00:00Z',
        bootReported: true,
        active: true,
        networkId: null,
        timezone: 'Europe/Berlin',
      },
      ...overrides,
    },
    emit: () => {
      for (const l of listeners) l();
    },
    api: createApiClient({ baseUrl: 'https://server.invalid', fetch: fetchFake }),
    getState: () => Promise.resolve(fake.state),
    login: vi.fn(() => {
      fake.state = { ...fake.state, loggedIn: true };
      return Promise.resolve({ totpSetupRequired: false });
    }),
    logout: vi.fn(() => Promise.resolve()),
    localData: () => Promise.resolve(fake.data),
    manual: (kind) => {
      calls.manual.push(kind);
      return Promise.resolve();
    },
    manualRange: (kind, from, to) => {
      calls.ranges.push([kind, from, to]);
      return Promise.resolve();
    },
    decideSession: (id, confirm) => {
      calls.decisions.push([id, confirm]);
      return Promise.resolve();
    },
    currentNetwork: () =>
      Promise.resolve({
        fingerprint: 'gw=aa:bb:cc:dd:ee:ff',
        ssid: null,
        bssid: null,
        wired: true,
      }),
    getProfile: () => Promise.resolve(profile),
    setProfile: (p) => {
      profile = p;
      return Promise.resolve();
    },
    finishSetup: vi.fn(() => {
      fake.state = { ...fake.state, setupDone: true };
      return Promise.resolve();
    }),
    syncNow: () => Promise.resolve(),
    setTrayStatus: vi.fn(() => Promise.resolve()),
    setTrayLabels: vi.fn(() => Promise.resolve()),
    autostart: { isEnabled: () => Promise.resolve(true), set: vi.fn(() => Promise.resolve()) },
    onChange: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
  return fake;
}

export const clock = (iso: string) => () => Date.parse(iso);
