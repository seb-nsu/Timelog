// Schnittstelle zum Rust-Kern. Tests ersetzen sie durch eine Attrappe.
import type { LocalData, Profile } from '@timelog/app-core';
import { ABSENCE_KINDS, GERMAN_STATES } from '@timelog/rules';
import { type ApiClient, createApiClient } from '@timelog/shared';
import { z } from 'zod';

export type SyncState =
  | { state: 'idle' }
  | { state: 'ok'; at: string }
  | { state: 'offline'; failures: number; retryAt: string }
  | { state: 'needsLogin' };

export interface TrackerStatus {
  bootTime: string;
  bootReported: boolean;
  active: boolean;
  networkId: string | null;
  timezone: string;
}

export interface AppState {
  loggedIn: boolean;
  baseUrl: string | null;
  setupDone: boolean;
  sync: SyncState;
  pending: number;
  tracker: TrackerStatus;
}

export interface LoginInput {
  baseUrl: string;
  email: string;
  password: string;
  totp?: string;
}

export interface CurrentNetwork {
  fingerprint: string | null;
  ssid: string | null;
  bssid: string | null;
  wired: boolean;
}

/** Beschriftungen des Tray-Menüs. */
export interface TrayLabels {
  open: string;
  start: string;
  stop: string;
  quit: string;
}

export interface DesktopBackend {
  api: ApiClient;
  getState: () => Promise<AppState>;
  login: (input: LoginInput) => Promise<{ totpSetupRequired: boolean }>;
  logout: () => Promise<void>;
  localData: (from: string, to: string) => Promise<LocalData>;
  manual: (kind: 'manual_start' | 'manual_end') => Promise<void>;
  manualRange: (kind: 'manual_work' | 'manual_break', from: string, to: string) => Promise<void>;
  decideSession: (sessionId: string, confirm: boolean) => Promise<void>;
  currentNetwork: () => Promise<CurrentNetwork>;
  getProfile: () => Promise<Profile | undefined>;
  setProfile: (profile: Profile) => Promise<void>;
  finishSetup: () => Promise<void>;
  syncNow: () => Promise<void>;
  setTrayStatus: (text: string) => Promise<void>;
  /** Beschriftet das Tray-Menü in der Sprache der Oberfläche. */
  setTrayLabels: (labels: TrayLabels) => Promise<void>;
  autostart: { isEnabled: () => Promise<boolean>; set: (enabled: boolean) => Promise<void> };
  /** Systembenachrichtigung; fragt beim ersten Mal nach der Erlaubnis. */
  notify: (title: string, body: string) => Promise<void>;
  /** Kleiner Zwischenspeicher je Gerät (z. B. gesendete Erinnerungen). */
  storage: { get: (key: string) => string | null; set: (key: string, value: string) => void };
  /** Meldet Änderungen aus dem Rust-Kern; liefert eine Abmeldefunktion. */
  onChange: (listener: () => void) => () => void;
}

const weekMinutes = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

/** Gespeichertes Profil prüfen; ein ungültiges wird ignoriert. */
export const profileSchema = z.object({
  state: z.enum(GERMAN_STATES),
  timezone: z.string(),
  targetSchedule: z
    .array(z.object({ validFrom: z.iso.date(), minutesByWeekday: weekMinutes }))
    .optional(),
  absences: z
    .array(
      z.object({
        date: z.iso.date(),
        kind: z.enum(ABSENCE_KINDS),
        minutes: z.number(),
      }),
    )
    .optional(),
  reminders: z
    .object({
      enabled: z.object({
        end_forgotten: z.boolean(),
        over_10h: z.boolean(),
        break_missing: z.boolean(),
      }),
      confirmEnd: z.boolean().optional(),
      weekReview: z
        .object({ enabled: z.boolean(), weekday: z.number().int(), time: z.string() })
        .optional(),
      quietFrom: z.string(),
      quietTo: z.string(),
    })
    .optional(),
});

/** `localStorage` des Webviews; ohne Zugriff (z. B. gesperrt) bleibt nichts gespeichert. */
export const webStorage: DesktopBackend['storage'] = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // nicht speicherbar: Erinnerung kommt höchstens erneut
    }
  },
};

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** fetch für den API-Client: läuft über den Rust-Kern, der die Tokens hält. */
export function invokeFetch(invoke: Invoke): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const res = await invoke<{ status: number; body: string }>('api_fetch', {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body,
    });
    const empty = res.status === 204 || res.status === 304;
    return new Response(empty ? null : res.body, {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

export async function createTauriBackend(): Promise<DesktopBackend> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const autostart = await import('@tauri-apps/plugin-autostart');
  const notification = await import('@tauri-apps/plugin-notification');
  const call: Invoke = (cmd, args) => invoke(cmd, args);
  const done = async (p: Promise<unknown>) => {
    await p;
  };
  return {
    // Die Adresse ist nur ein Platzhalter; der Rust-Kern kennt den echten Server.
    api: createApiClient({ baseUrl: 'https://server.invalid', fetch: invokeFetch(call) }),
    getState: () => call('get_state'),
    login: (input) => call('login', { input }),
    logout: () => call('logout'),
    localData: (from, to) => call('local_data', { from, to }),
    manual: (kind) => done(call('manual', { kind })),
    manualRange: (kind, from, to) => done(call('manual_range', { kind, from, to })),
    decideSession: (sessionId, confirm) => done(call('decide_session', { sessionId, confirm })),
    currentNetwork: () => call('current_network'),
    getProfile: async () => {
      const parsed = profileSchema.safeParse(await call('get_profile'));
      return parsed.success ? parsed.data : undefined;
    },
    setProfile: (profile) => call('set_profile', { profile }),
    finishSetup: () => call('finish_setup'),
    syncNow: () => done(call('sync_now')),
    setTrayStatus: (text) => call('set_tray_status', { text }),
    setTrayLabels: (labels) => call('set_tray_labels', { labels }),
    autostart: {
      isEnabled: () => autostart.isEnabled(),
      set: (enabled) => (enabled ? autostart.enable() : autostart.disable()),
    },
    notify: async (title, body) => {
      let granted = await notification.isPermissionGranted();
      if (!granted) granted = (await notification.requestPermission()) === 'granted';
      if (granted) notification.sendNotification({ title, body });
    },
    storage: webStorage,
    onChange: (listener) => {
      const unlisten = listen('timelog://changed', () => {
        listener();
      });
      return () => {
        void unlisten.then((f) => {
          f();
        });
      };
    },
  };
}
