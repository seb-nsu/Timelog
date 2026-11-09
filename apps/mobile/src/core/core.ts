// Kern der Handy-App: Warteschlange, Tokens, Sync mit Backoff und Anbindung des nativen Moduls.
// Arbeitszeit berechnet nur @timelog/rules (über @timelog/app-core); hier entstehen nur Ereignisse.
import { type LocalEvent, type Profile, computeDeviceDays } from '@timelog/app-core';
import type { Absence, EventType, WorkDay } from '@timelog/rules';
import {
  type ApiClient,
  ApiError,
  type DeviceResponse,
  type NetworksResponse,
  type PushData,
  type Settings,
  createApiClient,
  settingsSchema,
} from '@timelog/shared';
import type {
  Capabilities,
  DetectionStatus,
  NativeConfig,
  TimelogNativeApi,
  WidgetState,
} from '../../modules/timelog-native';
import { isWeakFingerprint, normalizeForHmac } from '../../modules/timelog-native/src/fingerprint';
import { type Sha256, bytesToBase64, hmacHex } from './hmac';
import { type DirtySpan, type QueuedEvent, Store, withoutStatus } from './store';
import {
  MAX_BATCH_EVENTS,
  MAX_BATCH_SPANS,
  PAGE_SIZE,
  type SyncState,
  backoffMs,
  classify,
} from './sync';

export interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface CoreDeps {
  store: Store;
  secure: SecureStorage;
  native: TimelogNativeApi;
  fetch?: typeof fetch;
  clock?: () => number;
  uuid: () => string;
  /** IANA-Zeitzone des Geräts (jetzt) */
  timezone: () => string;
  device: { os: string; name: string };
  /** Sprache der Oberfläche; der Server erzeugt Exporte und E-Mails darin. */
  locale?: 'de' | 'en';
  /** Für Arbeitsnetze im Modus „Nur lokal“ (HMAC ohne Server). */
  crypto?: { sha256: Sha256; randomBytes: (n: number) => Uint8Array };
}

export type Account = 'none' | 'localOnly' | 'loggedIn';

export interface MobileState {
  account: Account;
  baseUrl: string | null;
  deviceId: string | null;
  setupDone: boolean;
  sync: SyncState;
  pending: number;
  rejected: number;
  detection: DetectionStatus;
  capabilities: Capabilities;
  settings: Settings;
  profile: Profile;
  timezone: string;
  ssidEnabled: boolean;
  totpSetupRequired: boolean;
}

export interface LoginInput {
  baseUrl: string;
  email: string;
  password: string;
  totp?: string;
}

export type Correction =
  { field: 'start' | 'end'; time: string } | { field: 'break' | 'work'; from: string; to: string };

/** Rückblick für Hinweise wie den 24-Wochen-Durchschnitt (wie Desktop). */
export const LOOKBACK_DAYS = 175;

export type AddNetworkResult =
  | { status: 'none' }
  | {
      status: 'added';
      id: string;
      /** typische Router-Werkseinstellung, leicht verwechselbar */ weak: boolean;
    };

function weakOf(fingerprint: string | null, ssid: boolean): boolean {
  return !ssid && fingerprint !== null && isWeakFingerprint(fingerprint);
}
const DAY_MS = 86_400_000;
const PROFILE_MAX_AGE_MS = 60 * 60_000;
const REFRESH_KEY = 'timelog.refreshToken';

const K = {
  baseUrl: 'baseUrl',
  deviceId: 'deviceId',
  setupDone: 'setupDone',
  localOnly: 'localOnly',
  profile: 'profile',
  profileAt: 'profileAt',
  settings: 'settings',
  networks: 'networks',
  ssid: 'ssidEnabled',
  cursorEvents: 'cursor.events',
  cursorSpans: 'cursor.spans',
  pushToken: 'pushToken',
  pushLocale: 'pushLocale',
  answered: 'prompts.answered',
  localKey: 'timelog.localNetworkKey',
  totp: 'totpSetupRequired',
} as const;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export class MobileCore {
  readonly store: Store;
  private readonly secure: SecureStorage;
  readonly native: TimelogNativeApi;
  private readonly doFetch: typeof fetch;
  private readonly clock: () => number;
  private readonly uuid: () => string;
  private readonly tz: () => string;
  private readonly device: { os: string; name: string };
  private readonly crypto: CoreDeps['crypto'];
  private readonly locale: CoreDeps['locale'];

  private access: string | undefined;
  private refreshing: Promise<boolean> | undefined;
  private syncing: Promise<SyncState> | undefined;
  private syncState: SyncState = { state: 'idle' };
  private failures = 0;
  private retryAt = 0;
  private capabilitiesCache: Capabilities | undefined;
  private readonly listeners = new Set<() => void>();
  private nativeSubscription: { remove: () => void } | undefined;

  constructor(deps: CoreDeps) {
    this.store = deps.store;
    this.secure = deps.secure;
    this.native = deps.native;
    this.doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.clock = deps.clock ?? Date.now;
    this.uuid = deps.uuid;
    this.tz = deps.timezone;
    this.device = deps.device;
    this.crypto = deps.crypto;
    this.locale = deps.locale;
  }

  // ── Zustand ─────────────────────────────────────────────────────────────────

  now(): string {
    return new Date(this.clock()).toISOString();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Native Meldungen abonnieren (solange die App läuft). */
  start(): void {
    void this.configureNative().catch(() => undefined);
    this.nativeSubscription ??= this.native.addChangeListener(() => {
      void this.ingestNative().then((n) => {
        if (n > 0) void this.sync();
      });
    });
  }

  stop(): void {
    this.nativeSubscription?.remove();
    this.nativeSubscription = undefined;
  }

  async capabilities(): Promise<Capabilities> {
    this.capabilitiesCache ??= await this.native.capabilities();
    return this.capabilitiesCache;
  }

  private async account(): Promise<Account> {
    if (await this.secure.getItem(REFRESH_KEY)) return 'loggedIn';
    return (await this.store.get<boolean>(K.localOnly)) ? 'localOnly' : 'none';
  }

  async settings(): Promise<Settings> {
    const raw = await this.store.get<unknown>(K.settings);
    const parsed = settingsSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async profile(): Promise<Profile> {
    return (await this.store.get<Profile>(K.profile)) ?? { state: 'BE', timezone: this.tz() };
  }

  async getState(): Promise<MobileState> {
    const account = await this.account();
    const [baseUrl, deviceId, setupDone, pending, rejected, detection, capabilities] =
      await Promise.all([
        this.store.get<string>(K.baseUrl),
        this.store.get<string>(K.deviceId),
        this.store.get<boolean>(K.setupDone),
        this.store.pendingCount(),
        this.store.rejectedEvents(),
        this.native.status(),
        this.capabilities(),
      ]);
    const sync: SyncState =
      account === 'localOnly'
        ? { state: 'localOnly' }
        : account === 'none' && this.syncState.state !== 'needsLogin'
          ? { state: 'idle' }
          : this.syncState;
    return {
      account,
      baseUrl: baseUrl ?? null,
      deviceId: deviceId ?? null,
      setupDone: setupDone ?? false,
      sync,
      pending,
      rejected: rejected.length,
      detection,
      capabilities,
      settings: await this.settings(),
      profile: await this.profile(),
      timezone: this.tz(),
      ssidEnabled: (await this.store.get<boolean>(K.ssid)) ?? false,
      totpSetupRequired: (await this.store.get<boolean>(K.totp)) ?? false,
    };
  }

  /** Arbeitstage aus allen bekannten Ereignissen (eigene + vom Server geladene). */
  async days(now = this.now()): Promise<WorkDay[]> {
    const nowMs = Date.parse(now);
    const own = (await this.store.get<string>(K.deviceId)) ?? 'local';
    const data = await this.store.deviceData(
      new Date(nowMs - LOOKBACK_DAYS * DAY_MS).toISOString(),
      new Date(nowMs + 2 * DAY_MS).toISOString(),
      own,
    );
    return computeDeviceDays(data, await this.profile(), now);
  }

  /** Ereignisse für das Tagesprotokoll. */
  async events(fromIso: string, toIso: string): Promise<LocalEvent[]> {
    const own = (await this.store.get<string>(K.deviceId)) ?? 'local';
    return (await this.store.deviceData(fromIso, toIso, own)).events;
  }

  async finishSetup(): Promise<void> {
    await this.store.set(K.setupDone, true);
    this.emit();
  }

  // ── Konto ───────────────────────────────────────────────────────────────────

  /** API-Client mit Token und automatischer Erneuerung bei 401. */
  async api(): Promise<ApiClient> {
    const baseUrl = await this.store.get<string>(K.baseUrl);
    if (!baseUrl) throw new ApiError(401, 'unauthorized');
    return this.client(baseUrl, true);
  }

  private client(baseUrl: string, authed: boolean): ApiClient {
    return createApiClient({
      baseUrl,
      getAccessToken: authed ? () => this.access : undefined,
      fetch: authed ? this.authedFetch(baseUrl) : this.doFetch,
      ...(this.locale ? { locale: this.locale } : {}),
    });
  }

  private authedFetch(baseUrl: string): typeof fetch {
    return async (input, init) => {
      if (!this.access) await this.refresh(baseUrl);
      const withToken = (): RequestInit => ({
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(this.access ? { authorization: `Bearer ${this.access}` } : {}),
        },
      });
      const res = await this.doFetch(input, withToken());
      if (res.status !== 401) return res;
      if (!(await this.refresh(baseUrl))) return res;
      return this.doFetch(input, withToken());
    };
  }

  /** Refresh-Token einlösen (rotierend). false, wenn eine neue Anmeldung nötig ist. */
  private refresh(baseUrl: string): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const token = await this.secure.getItem(REFRESH_KEY);
        if (!token) return false;
        try {
          const res = await this.client(baseUrl, false).auth.refresh(token);
          await this.secure.setItem(REFRESH_KEY, res.refreshToken);
          this.access = res.accessToken;
          return true;
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 400)) {
            this.access = undefined;
            await this.secure.deleteItem(REFRESH_KEY);
            this.syncState = { state: 'needsLogin' };
            this.emit();
            return false;
          }
          throw e;
        }
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  async login(input: LoginInput): Promise<{ totpSetupRequired: boolean }> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    const deviceId = await this.store.get<string>(K.deviceId);
    const res = await this.client(baseUrl, false).auth.login({
      email: input.email,
      password: input.password,
      ...(input.totp ? { totp: input.totp } : {}),
      ...(deviceId ? { deviceId } : {}),
      device: { kind: 'mobile', os: this.device.os, name: this.device.name },
    });
    if (deviceId && deviceId !== res.deviceId) await this.store.clearRemote();
    await this.secure.setItem(REFRESH_KEY, res.refreshToken);
    this.access = res.accessToken;
    await Promise.all([
      this.store.set(K.baseUrl, baseUrl),
      this.store.set(K.deviceId, res.deviceId),
      this.store.set(K.localOnly, false),
      this.store.set(K.totp, res.totpSetupRequired),
    ]);
    this.failures = 0;
    this.retryAt = 0;
    this.syncState = { state: 'idle' };
    const push = await this.store.get<string>(K.pushToken);
    if (push) await this.registerPushToken(push).catch(() => undefined);
    await this.refreshProfile().catch(() => undefined);
    void this.sync(true);
    this.emit();
    return { totpSetupRequired: res.totpSetupRequired };
  }

  /** Privatversion ohne Konto und ohne Synchronisation („Nur lokal“). */
  async useLocalOnly(): Promise<void> {
    await this.store.set(K.localOnly, true);
    this.emit();
  }

  async logout(): Promise<void> {
    const token = await this.secure.getItem(REFRESH_KEY);
    const baseUrl = await this.store.get<string>(K.baseUrl);
    if (token && baseUrl) {
      await this.client(baseUrl, false)
        .auth.logout(token)
        .catch(() => undefined);
    }
    await this.secure.deleteItem(REFRESH_KEY);
    this.access = undefined;
    await this.store.clearRemote();
    await this.native.configure({
      detection: false,
      ssid: false,
      networks: [],
      keys: { user: '' },
    });
    this.syncState = { state: 'idle' };
    this.emit();
  }

  /** Konto löschen (Art. 17 DSGVO); danach sind auch alle lokalen Daten weg. */
  async deleteAccount(password: string): Promise<'deleted' | 'anonymized'> {
    const { mode } = await (await this.api()).me.delete(password);
    await this.secure.deleteItem(REFRESH_KEY);
    this.access = undefined;
    await this.native.configure({
      detection: false,
      ssid: false,
      networks: [],
      keys: { user: '' },
    });
    await this.store.wipe();
    this.syncState = { state: 'idle' };
    this.emit();
    return mode;
  }

  /** Push-Token und Sprache der Push-Texte am Gerät hinterlegen. */
  async registerPushToken(token: string, locale?: 'de' | 'en'): Promise<void> {
    await this.store.set(K.pushToken, token);
    if (locale) await this.store.set(K.pushLocale, locale);
    if ((await this.account()) !== 'loggedIn') return;
    const lang = locale ?? (await this.store.get<'de' | 'en'>(K.pushLocale));
    await (
      await this.api()
    ).devices.update({ pushToken: token, ...(lang ? { locale: lang } : {}) });
  }

  /**
   * „Stimmt“ aus einer Rückfrage (Benachrichtigung oder Karte): Arbeitsende bestätigen bzw. das
   * fehlende Ende auf die letzte Aktivität setzen. Je Benachrichtigung (`key`) nur einmal.
   */
  async answerPrompt(data: PushData, key: string, reason: string): Promise<boolean> {
    const answered = (await this.store.get<string[]>(K.answered)) ?? [];
    if (answered.includes(key)) return false;
    if (data.kind === 'end_confirm') {
      await this.decideSession(data.sessionId, true);
    } else if (data.kind === 'end_missing' && data.end) {
      await this.correct(data.date, { field: 'end', time: data.end }, reason);
    } else {
      return false;
    }
    await this.store.set(K.answered, [...answered, key].slice(-50));
    return true;
  }

  /**
   * „Woche bestätigen“: unproblematische Tage per Tagesbestätigung des Servers; ohne Konto oder
   * ohne Verbindung je Sitzung als session_confirm in der Warteschlange.
   */
  async confirmDays(days: readonly WorkDay[], dates: readonly string[]): Promise<number> {
    const online = (await this.account()) === 'loggedIn';
    let viaServer = false;
    let count = 0;
    for (const date of dates) {
      if (online) {
        try {
          await (await this.api()).corrections.confirmDay(date);
          viaServer = true;
          count += 1;
          continue;
        } catch (e) {
          if (classify(e) !== 'unavailable') throw e;
        }
      }
      const day = days.find((d) => d.date === date);
      for (const s of day?.sessions ?? []) {
        if (s.confirmed === undefined && !s.open) {
          await this.record('session_confirm', { refEventId: s.id });
        }
      }
      count += 1;
    }
    // Bestätigungen des Servers abholen
    if (viaServer) await this.sync(true);
    this.emit();
    return count;
  }

  // ── Ereignisse ──────────────────────────────────────────────────────────────

  private async record(
    type: EventType,
    extra: Partial<Pick<LocalEvent, 'ts' | 'endTs' | 'refEventId'>> = {},
  ): Promise<LocalEvent> {
    const now = this.now();
    const e: LocalEvent = {
      id: this.uuid(),
      type,
      source: 'user',
      ts: extra.ts ?? now,
      tz: this.tz(),
      createdAt: now,
      ...(extra.endTs ? { endTs: extra.endTs } : {}),
      ...(extra.refEventId ? { refEventId: extra.refEventId } : {}),
    };
    await this.store.addEvent(e);
    this.changed();
    return e;
  }

  private changed(): void {
    this.emit();
    void this.sync();
  }

  /** Start/Stopp-Knopf (live, keine Korrektur). */
  manual(kind: 'manual_start' | 'manual_end'): Promise<LocalEvent> {
    return this.record(kind);
  }

  /** „War Arbeit“ bzw. Pause nachtragen, ohne Begründung (wie am Desktop). */
  manualRange(kind: 'manual_work' | 'manual_break', from: string, to: string): Promise<LocalEvent> {
    return this.record(kind, { ts: from, endTs: to });
  }

  decideSession(sessionId: string, confirm: boolean): Promise<LocalEvent> {
    return this.record(confirm ? 'session_confirm' : 'session_reject', { refEventId: sessionId });
  }

  /**
   * Korrektur: online über PATCH /days/:date (Ereignis + corrections-Zeile mit Begründung),
   * offline als normales manual_*-Ereignis in der Warteschlange.
   */
  async correct(date: string, c: Correction, reason?: string): Promise<'server' | 'queued'> {
    const type: EventType =
      c.field === 'start'
        ? 'manual_start'
        : c.field === 'end'
          ? 'manual_end'
          : c.field === 'break'
            ? 'manual_break'
            : 'manual_work';
    const ts = 'time' in c ? c.time : c.from;
    const endTs = 'time' in c ? undefined : c.to;
    if ((await this.account()) === 'loggedIn') {
      try {
        const api = await this.api();
        const res = await api.corrections.correct(date, {
          ...c,
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        });
        const profile = await this.profile();
        await this.store.addSyncedEvent({
          id: res.eventId,
          type,
          source: 'user',
          ts,
          ...(endTs ? { endTs } : {}),
          tz: profile.timezone,
          createdAt: this.now(),
        });
        this.emit();
        return 'server';
      } catch (e) {
        if (classify(e) !== 'unavailable') throw e;
      }
    }
    await this.record(type, { ts, ...(endTs ? { endTs } : {}) });
    return 'queued';
  }

  /** Vom nativen Modul erzeugte Ereignisse und Spannen übernehmen. Liefert die Anzahl. */
  async ingestNative(): Promise<number> {
    const { events, spans } = await this.native.drain();
    if (events.length === 0 && spans.length === 0) return 0;
    for (const e of events) {
      const local: LocalEvent = {
        id: e.id.toLowerCase(),
        type: e.type,
        source: e.source,
        ts: e.ts,
        tz: e.tz,
        createdAt: e.createdAt,
        ...(e.networkId ? { networkId: e.networkId } : {}),
        ...(e.refEventId ? { refEventId: e.refEventId } : {}),
      };
      await this.store.addEvent(local);
    }
    for (const s of spans) {
      await this.store.upsertOwnSpan({ ...s, id: s.id.toLowerCase() });
    }
    await this.native.acknowledge(
      events.map((e) => e.id),
      spans.map((s) => ({ id: s.id, end: s.end })),
    );
    this.emit();
    return events.length + spans.length;
  }

  // ── Synchronisation ─────────────────────────────────────────────────────────

  /** Ein Durchlauf; `force` ignoriert den Backoff (z. B. „Jetzt übertragen“). */
  sync(force = false): Promise<SyncState> {
    this.syncing ??= this.runSync(force).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async runSync(force: boolean): Promise<SyncState> {
    const account = await this.account();
    if (account !== 'loggedIn') return this.syncState;
    if (!force && this.clock() < this.retryAt) return this.syncState;
    const baseUrl = await this.store.get<string>(K.baseUrl);
    if (!baseUrl) return this.syncState;
    try {
      await this.ingestNative().catch(() => 0);
      const api = await this.api();
      await this.pushEvents(api);
      await this.pushSpans(api);
      await this.pull(api);
      await this.refreshNetworks(api);
      const profileAt = (await this.store.get<number>(K.profileAt)) ?? 0;
      if (force || this.clock() - profileAt > PROFILE_MAX_AGE_MS) await this.refreshProfile(api);
      this.failures = 0;
      this.retryAt = 0;
      this.syncState = { state: 'ok', at: this.now() };
    } catch (e) {
      const kind = classify(e);
      if (kind === 'unauthorized' || (await this.account()) !== 'loggedIn') {
        this.syncState = { state: 'needsLogin' };
      } else {
        this.failures += 1;
        this.retryAt = this.clock() + backoffMs(this.failures);
        this.syncState = {
          state: 'offline',
          failures: this.failures,
          retryAt: new Date(this.retryAt).toISOString(),
        };
      }
    }
    this.emit();
    return this.syncState;
  }

  private async pushEvents(api: ApiClient): Promise<void> {
    for (;;) {
      const batch = await this.store.pendingEvents(MAX_BATCH_EVENTS);
      if (batch.length === 0) return;
      await this.sendEvents(api, batch);
    }
  }

  /** Lehnt der Server ein Paket ab, einzeln senden; ein fehlerhaftes Ereignis blockiert nichts. */
  private async sendEvents(api: ApiClient, batch: QueuedEvent[]): Promise<void> {
    try {
      await api.events.batch(batch.map(withoutStatus));
      await this.store.markEvents(
        batch.map((e) => e.id),
        'synced',
      );
    } catch (e) {
      if (classify(e) !== 'rejected') throw e;
      if (batch.length === 1) {
        await this.store.markEvents(
          batch.map((x) => x.id),
          'rejected',
        );
        return;
      }
      for (const one of batch) await this.sendEvents(api, [one]);
    }
  }

  private async pushSpans(api: ApiClient): Promise<void> {
    for (;;) {
      const spans: DirtySpan[] = await this.store.dirtySpans(MAX_BATCH_SPANS);
      if (spans.length === 0) return;
      await api.presence.put({
        spans: spans.map(({ id, start, end, open }) => ({ id, start, end, open })),
      });
      await this.store.markSpansSynced(spans);
    }
  }

  private async pull(api: ApiClient): Promise<void> {
    const own = (await this.store.get<string>(K.deviceId)) ?? null;
    let since = (await this.store.get<number>(K.cursorEvents)) ?? 0;
    for (;;) {
      const page = await api.events.list(since, PAGE_SIZE);
      await this.store.addRemoteEvents(page.events, own);
      since = page.nextCursor;
      await this.store.set(K.cursorEvents, since);
      if (page.events.length < PAGE_SIZE) break;
    }
    let spanSince = (await this.store.get<number>(K.cursorSpans)) ?? 0;
    for (;;) {
      const page = await api.presence.list(spanSince, PAGE_SIZE);
      await this.store.addRemoteSpans(page.spans, own);
      spanSince = page.nextCursor;
      await this.store.set(K.cursorSpans, spanSince);
      if (page.spans.length < PAGE_SIZE) break;
    }
  }

  // ── Arbeitsnetze und Profil ─────────────────────────────────────────────────

  async refreshNetworks(api?: ApiClient): Promise<NetworksResponse> {
    const res = await (api ?? (await this.api())).networks.get();
    await this.store.set(K.networks, res);
    await this.configureNative(res);
    return res;
  }

  async networks(): Promise<NetworksResponse | undefined> {
    return this.store.get<NetworksResponse>(K.networks);
  }

  /** Einstellungen an das native Modul geben (Erkennung an/aus, Netze als HMAC). */
  async configureNative(networks?: NetworksResponse): Promise<void> {
    const nets = networks ?? (await this.networks());
    const settings = await this.settings();
    // iOS: Das WLAN wählt der Nutzer in der Kurzbefehl-Automation; dort gibt es keine hinterlegten Netze.
    const shortcuts = (await this.capabilities()).shortcuts;
    const config: NativeConfig = {
      detection: settings.triggers.network && (shortcuts || (nets?.networks.length ?? 0) > 0),
      ssid: (await this.store.get<boolean>(K.ssid)) ?? false,
      networks: (nets?.networks ?? []).map((n) => ({
        id: n.id,
        scope: n.scope,
        kind: n.kind,
        ...(n.ssid ? { ssid: n.ssid } : {}),
        ...(n.bssidHmac ? { bssidHmac: n.bssidHmac } : {}),
        ...(n.fingerprintHmac ? { fingerprintHmac: n.fingerprintHmac } : {}),
      })),
      keys: nets?.keys ?? { user: '' },
    };
    await this.native.configure(config);
  }

  async setSsidEnabled(enabled: boolean): Promise<void> {
    await this.store.set(K.ssid, enabled);
    await this.configureNative();
    this.emit();
  }

  /**
   * „Aktuelles Netz übernehmen“: Kennung des Netzes, in dem das Handy gerade ist. Mit Konto
   * speichert der Server nur den HMAC; „Nur lokal“ rechnet den HMAC hier mit einem eigenen
   * Schlüssel. Den WLAN-Namen nur, wenn die Option an ist und das System ihn liefert.
   */
  async addCurrentNetwork(label: string): Promise<AddNetworkResult> {
    const current = await this.native.currentNetwork();
    const ssidEnabled = (await this.store.get<boolean>(K.ssid)) ?? false;
    const useSsid = ssidEnabled && current.ssid !== null;
    if (!current.fingerprint && !useSsid) return { status: 'none' };
    const name = label.trim() || (useSsid ? (current.ssid ?? '') : 'Arbeitsnetz');
    if ((await this.account()) === 'loggedIn') {
      const api = await this.api();
      const added = await api.networks.add(
        useSsid && current.ssid
          ? {
              kind: 'ssid',
              label: name,
              ssid: current.ssid,
              ...(current.bssid ? { bssid: current.bssid } : {}),
            }
          : { kind: 'fingerprint', label: name, fingerprint: current.fingerprint ?? '' },
      );
      await this.refreshNetworks(api);
      this.emit();
      return { status: 'added', id: added.id, weak: weakOf(current.fingerprint, useSsid) };
    }
    if (!current.fingerprint) return { status: 'none' };
    const nets = await this.localNetworks();
    const fingerprintHmac = await hmacHex(
      this.requireCrypto().sha256,
      nets.keys.user,
      normalizeForHmac(current.fingerprint),
    );
    const id = this.uuid();
    nets.networks.push({
      id,
      scope: 'user',
      kind: 'fingerprint',
      label: name,
      location: 'office',
      fingerprintHmac,
    });
    await this.store.set(K.networks, nets);
    await this.configureNative(nets);
    this.emit();
    return { status: 'added', id, weak: weakOf(current.fingerprint, false) };
  }

  /** Ort und Standardprojekt eines eigenen Netzes ändern (nur mit Konto). */
  async updateNetwork(
    id: string,
    body: { location?: 'office' | 'home' | 'other'; defaultProjectId?: string | null },
  ): Promise<void> {
    const api = await this.api();
    await api.networks.update(id, body);
    await this.refreshNetworks(api);
    this.emit();
  }

  async removeNetwork(id: string): Promise<void> {
    if ((await this.account()) === 'loggedIn') {
      const api = await this.api();
      await api.networks.remove(id);
      await this.refreshNetworks(api);
    } else {
      const nets = await this.localNetworks();
      nets.networks = nets.networks.filter((n) => n.id !== id);
      await this.store.set(K.networks, nets);
      await this.configureNative(nets);
    }
    this.emit();
  }

  private requireCrypto(): NonNullable<CoreDeps['crypto']> {
    if (!this.crypto) throw new Error('crypto_unavailable');
    return this.crypto;
  }

  private async localNetworks(): Promise<NetworksResponse> {
    const stored = await this.networks();
    let key = await this.secure.getItem(K.localKey);
    if (!key) {
      key = bytesToBase64(this.requireCrypto().randomBytes(32));
      await this.secure.setItem(K.localKey, key);
    }
    return { networks: stored?.networks ?? [], keys: { user: key } };
  }

  // ── Abwesenheiten, Geräte, Export ───────────────────────────────────────────

  /** Abwesenheiten im Zeitraum ersetzen (Urlaub, Krank, …); ohne Konto nur lokal. */
  async saveAbsences(from: string, to: string, absences: Absence[]): Promise<void> {
    if ((await this.account()) === 'loggedIn') {
      const api = await this.api();
      await api.absences.put({ from, to, absences });
      await this.refreshProfile(api);
      return;
    }
    const profile = await this.profile();
    const others = (profile.absences ?? []).filter((a) => a.date < from || a.date > to);
    await this.store.set(K.profile, {
      ...profile,
      absences: [...others, ...absences].sort((a, b) => a.date.localeCompare(b.date)),
    });
    this.emit();
  }

  async devices(): Promise<DeviceResponse[]> {
    if ((await this.account()) !== 'loggedIn') return [];
    return (await (await this.api()).devices.list()).devices;
  }

  async revokeDevice(id: string): Promise<void> {
    await (await this.api()).devices.revoke(id);
  }

  /** Tag abschließen (nur mit Konto; der Server führt die Freigabe). */
  async confirmDay(date: string): Promise<number> {
    const { confirmed } = await (await this.api()).corrections.confirmDay(date);
    return confirmed;
  }

  /** CSV/PDF-Export vom Server. */
  async exportReport(from: string, to: string, format: 'csv' | 'pdf'): Promise<Blob> {
    return (await this.api()).export({ from, to, format });
  }

  /** Datenauskunft (Art. 15 DSGVO): mit Konto vom Server, sonst alle lokalen Daten. */
  async dataExport(): Promise<unknown> {
    if ((await this.account()) === 'loggedIn') return (await this.api()).me.export();
    const own = (await this.store.get<string>(K.deviceId)) ?? 'local';
    const data = await this.store.deviceData('1970-01-01T00:00:00Z', '9999-12-31T00:00:00Z', own);
    return {
      exportedAt: this.now(),
      profile: await this.profile(),
      settings: await this.settings(),
      networks: (await this.networks())?.networks ?? [],
      events: data.events,
      spans: data.spans,
    };
  }

  /** Alle lokalen Daten löschen (Modus „Nur lokal“). */
  async wipeLocal(): Promise<void> {
    await this.native.configure({
      detection: false,
      ssid: false,
      networks: [],
      keys: { user: '' },
    });
    await this.secure.deleteItem(K.localKey);
    await this.store.wipe();
    this.emit();
  }

  async refreshProfile(api?: ApiClient): Promise<Profile> {
    const client = api ?? (await this.api());
    const [settings, target] = await Promise.all([client.settings.get(), client.targetHours.get()]);
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    const shift = (days: number) =>
      new Date(Date.parse(`${today}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
    const { absences } = await client.absences.list({ from: shift(-200), to: shift(200) });
    const profile: Profile = {
      state: settings.state,
      timezone: settings.timezone,
      targetSchedule: target.schedule,
      absences: absences.map(({ date, kind, minutes }) => ({ date, kind, minutes })),
    };
    await Promise.all([
      this.store.set(K.profile, profile),
      this.store.set(K.settings, settings.settings),
      this.store.set(K.profileAt, this.clock()),
    ]);
    this.emit();
    return profile;
  }

  /** Einstellungen lokal speichern und, falls angemeldet, an den Server senden. */
  async saveSettings(settings: Settings): Promise<void> {
    await this.store.set(K.settings, settings);
    if ((await this.account()) === 'loggedIn') {
      await (await this.api()).settings.put({ settings });
    }
    await this.configureNative();
    this.emit();
  }

  /** Bundesland und Sollzeiten; ohne Konto nur lokal. */
  async saveProfile(profile: Profile): Promise<void> {
    if ((await this.account()) === 'loggedIn') {
      const api = await this.api();
      await api.settings.put({ state: profile.state });
      const latest = profile.targetSchedule?.at(-1);
      if (latest) await api.targetHours.put(latest);
      await this.refreshProfile(api);
      return;
    }
    await this.store.set(K.profile, profile);
    this.emit();
  }

  async updateWidget(state: WidgetState): Promise<void> {
    await this.native.updateWidget(state).catch(() => undefined);
  }
}

export { Store };
