// Anmeldung im Web-Admin. Access-Token nur im Speicher; Refresh-Token und Geräte-ID im
// sessionStorage (gilt nur für diesen Tab und endet mit ihm).
import { type ApiClient, ApiError, type TokenResponse, createApiClient } from '@timelog/shared';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Ein Browser-Tab zählt als eigenes „Gerät“ (Tokens sind gerätegebunden). */
export const WEB_DEVICE = { kind: 'desktop', os: 'web', name: 'Web-Admin' } as const;

const REFRESH_KEY = 'timelog.admin.refresh';
const DEVICE_KEY = 'timelog.admin.device';

export class Session {
  readonly client: ApiClient;
  /** Ohne Token: Anmeldung, Einladung, SSO. */
  readonly anon: ApiClient;
  private access: string | undefined;
  private expiresAt = 0;
  private refreshing: Promise<void> | undefined;

  constructor(
    readonly baseUrl: string,
    private readonly store: KeyValueStore,
    fetchImpl?: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {
    const common = { baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
    this.anon = createApiClient(common);
    this.client = createApiClient({ ...common, getAccessToken: () => this.token() });
  }

  hasRefreshToken(): boolean {
    return this.read(REFRESH_KEY) !== undefined;
  }

  private read(key: string): string | undefined {
    try {
      return this.store.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: string | undefined): void {
    try {
      if (value === undefined) this.store.removeItem(key);
      else this.store.setItem(key, value);
    } catch {
      // Speicher gesperrt (privater Modus): Sitzung gilt dann nur bis zum Neuladen.
    }
  }

  private accept(t: TokenResponse): TokenResponse {
    this.access = t.accessToken;
    this.expiresAt = this.now() + t.expiresIn * 1000;
    this.write(REFRESH_KEY, t.refreshToken);
    this.write(DEVICE_KEY, t.deviceId);
    return t;
  }

  private clear(): void {
    this.access = undefined;
    this.expiresAt = 0;
    this.write(REFRESH_KEY, undefined);
  }

  private async token(): Promise<string | undefined> {
    if (!this.access || this.now() > this.expiresAt - 60_000) await this.refresh();
    return this.access;
  }

  /** Erneuert die Tokens (z. B. nach Rollenwechsel oder TOTP-Einrichtung). */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const refreshToken = this.read(REFRESH_KEY);
      if (!refreshToken) throw new ApiError(401, 'unauthorized');
      try {
        this.accept(await this.anon.auth.refresh(refreshToken));
      } catch (err) {
        this.clear();
        throw err;
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async login(email: string, password: string, totp?: string): Promise<TokenResponse> {
    const deviceId = this.read(DEVICE_KEY);
    return this.accept(
      await this.anon.auth.login({
        email,
        password,
        device: WEB_DEVICE,
        ...(totp ? { totp } : {}),
        ...(deviceId ? { deviceId } : {}),
      }),
    );
  }

  async exchange(code: string): Promise<TokenResponse> {
    const deviceId = this.read(DEVICE_KEY);
    return this.accept(
      await this.anon.sso.exchange({ code, device: WEB_DEVICE, ...(deviceId ? { deviceId } : {}) }),
    );
  }

  async logout(): Promise<void> {
    const refreshToken = this.read(REFRESH_KEY);
    this.clear();
    if (refreshToken) await this.anon.auth.logout(refreshToken).catch(() => undefined);
  }
}
