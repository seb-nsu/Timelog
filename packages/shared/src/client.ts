// Typisierter API-Client für Desktop, Mobile und Web-Admin. Antworten werden mit Zod geprüft.
import type { z } from 'zod';
import {
  type DaysQuery,
  type DeviceInfo,
  type EventInput,
  type LoginRequest,
  type PresenceRequest,
  type RegisterRequest,
  daysResponse,
  deviceResponse,
  errorResponse,
  eventBatchResponse,
  eventPage,
  okResponse,
  presencePage,
  statusResponse,
  tokenResponse,
  totpSetupResponse,
} from './schemas.js';

export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Liefert das aktuelle Access-Token; fehlt es, gehen Anfragen ohne Authorization raus. */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;

  async function call<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    body?: unknown,
    query?: Record<string, string | number>,
  ): Promise<z.infer<S>> {
    const url = new URL(API_PREFIX + path, options.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {};
    const token = await options.getAccessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await doFetch(url, init);
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = errorResponse.safeParse(json);
      throw new ApiError(
        res.status,
        err.success ? err.data.error : 'http_error',
        err.success ? err.data.message : undefined,
      );
    }
    return schema.parse(json);
  }

  return {
    auth: {
      register: (body: RegisterRequest) => call('POST', '/auth/register', okResponse, body),
      verify: (token: string) => call('POST', '/auth/verify', okResponse, { token }),
      login: (body: LoginRequest) => call('POST', '/auth/login', tokenResponse, body),
      refresh: (refreshToken: string) =>
        call('POST', '/auth/refresh', tokenResponse, { refreshToken }),
      logout: (refreshToken: string) => call('POST', '/auth/logout', okResponse, { refreshToken }),
      requestPasswordReset: (email: string) =>
        call('POST', '/auth/password-reset', okResponse, { email }),
      confirmPasswordReset: (token: string, password: string) =>
        call('POST', '/auth/password-reset/confirm', okResponse, { token, password }),
      totpSetup: () => call('POST', '/auth/totp/setup', totpSetupResponse, {}),
      totpVerify: (code: string) => call('POST', '/auth/totp/verify', okResponse, { code }),
    },
    devices: {
      update: (body: Partial<Omit<DeviceInfo, 'kind'>> & { pushToken?: string }) =>
        call('POST', '/devices', deviceResponse, body),
      revoke: (id: string) => call('DELETE', `/devices/${encodeURIComponent(id)}`, okResponse),
    },
    events: {
      batch: (events: EventInput[]) =>
        call('POST', '/events/batch', eventBatchResponse, { events }),
      list: (since = 0, limit = 500) =>
        call('GET', '/events', eventPage, undefined, { since, limit }),
    },
    presence: {
      put: (body: PresenceRequest) => call('PUT', '/presence', okResponse, body),
      list: (since = 0, limit = 500) =>
        call('GET', '/presence', presencePage, undefined, { since, limit }),
    },
    days: (q: DaysQuery) =>
      call('GET', '/days', daysResponse, undefined, { from: q.from, to: q.to }),
    status: () => call('GET', '/status', statusResponse),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
