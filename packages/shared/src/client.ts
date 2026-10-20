// Typisierter API-Client für Desktop, Mobile und Web-Admin. Antworten werden mit Zod geprüft.
import type { z } from 'zod';
import {
  type DaysQuery,
  type DeviceInfo,
  type EventInput,
  type LoginRequest,
  type PresenceRequest,
  type RegisterRequest,
  type absencesUpdate,
  type correctionRequest,
  type networkInput,
  type networksUpdate,
  type settingsUpdate,
  type targetHoursUpdate,
  absencesResponse,
  confirmResponse,
  correctionResponse,
  daysResponse,
  deleteAccountResponse,
  deviceResponse,
  devicesResponse,
  errorResponse,
  eventBatchResponse,
  eventPage,
  holidaysResponse,
  networkResponse,
  networksResponse,
  okResponse,
  promptsResponse,
  presencePage,
  settingsResponse,
  statusResponse,
  targetHoursResponse,
  tokenResponse,
  totpSetupResponse,
} from './schemas.js';
import {
  type InviteAcceptRequest,
  type InviteRequest,
  type MemberUpdate,
  type OrgConfigUpdate,
  type SsoExchangeRequest,
  type teamInput,
  type teamUpdate,
  approvalDetailResponse,
  approvalSchema,
  approvalsResponse,
  auditResponse,
  createOrgResponse,
  invitationSchema,
  invitationsResponse,
  inviteInfoResponse,
  memberDaysResponse,
  memberSchema,
  membersResponse,
  orgConfigResponse,
  orgMeResponse,
  ownApprovalSchema,
  ownApprovalsResponse,
  ssoInfoResponse,
  teamSchema,
  teamsResponse,
} from './org.js';
import {
  type LeaveRequestInput,
  type OvertimeBookingInput,
  type leaveAdjustmentInput,
  type leaveProfileUpdate,
  type leaveSettingsUpdate,
  type payrollConfigUpdate,
  type payrollMemberUpdate,
  calendarResponse,
  leaveAdjustmentSchema,
  leaveOverviewResponse,
  leaveRequestSchema,
  leaveSettingsSchema,
  memberLeaveResponse,
  orgLeaveRequestsResponse,
  overtimeBookingSchema,
  overtimeResponse,
  payrollConfigSchema,
  payrollMemberSchema,
  payrollMembersResponse,
  personioStatusResponse,
  transferSchema,
  transfersResponse,
} from './leave.js';

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

  async function send(
    method: Method,
    path: string,
    body?: unknown,
    query?: Record<string, string | number>,
  ): Promise<Response> {
    const url = new URL(API_PREFIX + path, options.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {};
    const token = await options.getAccessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await doFetch(url, init);
    if (!res.ok) {
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const err = errorResponse.safeParse(json);
      throw new ApiError(
        res.status,
        err.success ? err.data.error : 'http_error',
        err.success ? err.data.message : undefined,
      );
    }
    return res;
  }

  async function call<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    body?: unknown,
    query?: Record<string, string | number>,
  ): Promise<z.infer<S>> {
    const text = await (await send(method, path, body, query)).text();
    return schema.parse(text ? JSON.parse(text) : undefined);
  }

  const range = (q: { from: string; to: string }) => ({ from: q.from, to: q.to });
  const enc = encodeURIComponent;

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
      list: () => call('GET', '/devices', devicesResponse),
      update: (
        body: Partial<Omit<DeviceInfo, 'kind'>> & { pushToken?: string; locale?: 'de' | 'en' },
      ) => call('POST', '/devices', deviceResponse, body),
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
    corrections: {
      correct: (date: string, body: z.input<typeof correctionRequest>) =>
        call('PATCH', `/days/${date}`, correctionResponse, body),
      confirmDay: (date: string) => call('POST', `/days/${date}/confirm`, confirmResponse, {}),
      confirmSession: (id: string) =>
        call('POST', `/sessions/${encodeURIComponent(id)}/confirm`, confirmResponse, {}),
      rejectSession: (id: string) =>
        call('POST', `/sessions/${encodeURIComponent(id)}/reject`, confirmResponse, {}),
    },
    /** Offene Rückfragen (Arbeitsende, Wochenrückblick) für Geräte ohne Push, z. B. den Desktop. */
    prompts: {
      list: () => call('GET', '/prompts', promptsResponse),
      dismiss: (kind: 'end_confirm' | 'end_missing' | 'week_review', ref: string) =>
        call('POST', '/prompts/dismiss', okResponse, { kind, ref }),
    },
    settings: {
      get: () => call('GET', '/settings', settingsResponse),
      put: (body: z.input<typeof settingsUpdate>) =>
        call('PUT', '/settings', settingsResponse, body),
    },
    networks: {
      get: () => call('GET', '/networks', networksResponse),
      put: (body: z.input<typeof networksUpdate>) => call('PUT', '/networks', okResponse, body),
      add: (body: z.input<typeof networkInput>) => call('POST', '/networks', networkResponse, body),
      remove: (id: string) => call('DELETE', `/networks/${encodeURIComponent(id)}`, okResponse),
    },
    targetHours: {
      get: () => call('GET', '/target-hours', targetHoursResponse),
      put: (body: z.input<typeof targetHoursUpdate>) =>
        call('PUT', '/target-hours', okResponse, body),
    },
    absences: {
      list: (q: { from: string; to: string }) =>
        call('GET', '/absences', absencesResponse, undefined, range(q)),
      put: (body: z.input<typeof absencesUpdate>) => call('PUT', '/absences', okResponse, body),
    },
    holidays: (year: number) => call('GET', '/holidays', holidaysResponse, undefined, { year }),
    /** CSV oder PDF als Blob. */
    export: async (q: { from: string; to: string; format: 'csv' | 'pdf' }) =>
      (await send('GET', '/export', undefined, { ...range(q), format: q.format })).blob(),
    me: {
      export: async (): Promise<unknown> => (await send('GET', '/me/export')).json(),
      delete: (password: string) => call('DELETE', '/me', deleteAccountResponse, { password }),
    },
    /** Eigene Monatsfreigaben (Firmenkonto). */
    approvals: {
      list: () => call('GET', '/approvals', ownApprovalsResponse),
      submit: (month: string) => call('POST', `/approvals/${month}`, ownApprovalSchema, {}),
    },
    /** Urlaubskonto und Anträge (Urlaub, Überstundenabbau). */
    leave: {
      get: (year: number) => call('GET', '/leave', leaveOverviewResponse, undefined, { year }),
      request: (body: LeaveRequestInput) =>
        call('POST', '/leave/requests', leaveRequestSchema, body),
      cancel: (id: string, comment?: string) =>
        call(
          'POST',
          `/leave/requests/${enc(id)}/cancel`,
          leaveRequestSchema,
          comment ? { comment } : {},
        ),
      /** Nur Privatkonto; in Firmen pflegt der Admin den Anspruch. */
      setProfile: (body: z.input<typeof leaveProfileUpdate>) =>
        call('PUT', '/leave/profile', okResponse, body),
      setSettings: (body: z.input<typeof leaveSettingsUpdate>) =>
        call('PUT', '/leave/settings', leaveSettingsSchema, body),
      adjust: (body: z.input<typeof leaveAdjustmentInput>) =>
        call('POST', '/leave/adjustments', leaveAdjustmentSchema, body),
    },
    overtime: {
      get: (year: number) => call('GET', '/overtime', overtimeResponse, undefined, { year }),
      /** Nur Privatkonto; in Firmen bucht der Admin. */
      book: (body: OvertimeBookingInput) =>
        call('POST', '/overtime/bookings', overtimeBookingSchema, body),
    },
    invitations: {
      info: (token: string) =>
        call('GET', '/auth/invite', inviteInfoResponse, undefined, { token }),
      accept: (body: InviteAcceptRequest) => call('POST', '/auth/invite/accept', okResponse, body),
    },
    sso: {
      info: (slug: string) => call('GET', `/auth/sso/${enc(slug)}`, ssoInfoResponse),
      /** Adresse, zu der der Browser für die SSO-Anmeldung navigiert. */
      startUrl: (slug: string, method: 'oidc' | 'saml', redirect: string): string => {
        const url = new URL(`${API_PREFIX}/auth/sso/${enc(slug)}/start`, options.baseUrl);
        url.searchParams.set('method', method);
        url.searchParams.set('redirect', redirect);
        return url.toString();
      },
      exchange: (body: SsoExchangeRequest) =>
        call('POST', '/auth/sso/exchange', tokenResponse, body),
    },
    /** Firmenversion: Verwaltung (Manager und Admins). */
    org: {
      create: (name: string, slug: string) =>
        call('POST', '/orgs', createOrgResponse, { name, slug }),
      me: () => call('GET', '/org/me', orgMeResponse),
      config: {
        get: () => call('GET', '/org/config', orgConfigResponse),
        put: (body: OrgConfigUpdate) => call('PUT', '/org/config', orgConfigResponse, body),
      },
      members: {
        list: () => call('GET', '/org/members', membersResponse),
        update: (id: string, body: MemberUpdate) =>
          call('PATCH', `/org/members/${enc(id)}`, memberSchema, body),
        deactivate: (id: string) =>
          call('POST', `/org/members/${enc(id)}/deactivate`, okResponse, {}),
        days: (id: string, q: { from: string; to: string }) =>
          call('GET', `/org/members/${enc(id)}/days`, memberDaysResponse, undefined, range(q)),
        targetHours: (id: string) =>
          call('GET', `/org/members/${enc(id)}/target-hours`, targetHoursResponse),
        setTargetHours: (id: string, body: z.input<typeof targetHoursUpdate>) =>
          call('PUT', `/org/members/${enc(id)}/target-hours`, okResponse, body),
        correct: (id: string, date: string, body: z.input<typeof correctionRequest>) =>
          call('PATCH', `/org/members/${enc(id)}/days/${date}`, correctionResponse, body),
      },
      teams: {
        list: () => call('GET', '/org/teams', teamsResponse),
        create: (body: z.input<typeof teamInput>) => call('POST', '/org/teams', teamSchema, body),
        update: (id: string, body: z.input<typeof teamUpdate>) =>
          call('PATCH', `/org/teams/${enc(id)}`, teamSchema, body),
        remove: (id: string) => call('DELETE', `/org/teams/${enc(id)}`, okResponse),
      },
      invite: (body: InviteRequest) => call('POST', '/org/invite', invitationSchema, body),
      invitations: {
        list: () => call('GET', '/org/invitations', invitationsResponse),
        revoke: (id: string) => call('DELETE', `/org/invitations/${enc(id)}`, okResponse),
      },
      networks: {
        list: () => call('GET', '/org/networks', networksResponse),
        add: (body: z.input<typeof networkInput>) =>
          call('POST', '/org/networks', networkResponse, body),
        remove: (id: string) => call('DELETE', `/org/networks/${enc(id)}`, okResponse),
      },
      approvals: {
        list: (month: string, status?: 'none' | 'submitted' | 'approved' | 'rejected') =>
          call('GET', '/org/approvals', approvalsResponse, undefined, {
            month,
            ...(status ? { status } : {}),
          }),
        get: (userId: string, month: string) =>
          call('GET', `/org/approvals/${enc(userId)}/${month}`, approvalDetailResponse),
        approve: (userId: string, month: string, comment?: string) =>
          call(
            'POST',
            `/org/approvals/${enc(userId)}/${month}/approve`,
            approvalSchema,
            comment ? { comment } : {},
          ),
        reject: (userId: string, month: string, comment: string) =>
          call('POST', `/org/approvals/${enc(userId)}/${month}/reject`, approvalSchema, {
            comment,
          }),
      },
      /** Monatsexport als CSV oder PDF (Blob). */
      export: async (q: { month: string; format: 'csv' | 'pdf'; teamId?: string }) =>
        (
          await send('GET', '/org/export', undefined, {
            month: q.month,
            format: q.format,
            ...(q.teamId ? { teamId: q.teamId } : {}),
          })
        ).blob(),
      leave: {
        requests: (q: { status?: string; from?: string; to?: string } = {}) =>
          call('GET', '/org/leave/requests', orgLeaveRequestsResponse, undefined, {
            ...(q.status ? { status: q.status } : {}),
            ...(q.from ? { from: q.from } : {}),
            ...(q.to ? { to: q.to } : {}),
          }),
        approve: (id: string, comment?: string) =>
          call(
            'POST',
            `/org/leave/requests/${enc(id)}/approve`,
            leaveRequestSchema,
            comment ? { comment } : {},
          ),
        reject: (id: string, comment: string) =>
          call('POST', `/org/leave/requests/${enc(id)}/reject`, leaveRequestSchema, { comment }),
        cancel: (id: string, comment: string) =>
          call('POST', `/org/leave/requests/${enc(id)}/cancel`, leaveRequestSchema, { comment }),
        calendar: (q: { from: string; to: string; teamId?: string }) =>
          call('GET', '/org/leave/calendar', calendarResponse, undefined, {
            from: q.from,
            to: q.to,
            ...(q.teamId ? { teamId: q.teamId } : {}),
          }),
        settings: () => call('GET', '/org/leave/settings', leaveSettingsSchema),
        setSettings: (body: z.input<typeof leaveSettingsUpdate>) =>
          call('PUT', '/org/leave/settings', leaveSettingsSchema, body),
        member: (id: string, year: number) =>
          call('GET', `/org/members/${enc(id)}/leave`, memberLeaveResponse, undefined, { year }),
        setProfile: (id: string, body: z.input<typeof leaveProfileUpdate>) =>
          call('PUT', `/org/members/${enc(id)}/leave-profile`, okResponse, body),
        adjust: (id: string, body: z.input<typeof leaveAdjustmentInput>) =>
          call('POST', `/org/members/${enc(id)}/leave-adjustments`, leaveAdjustmentSchema, body),
        overtime: (id: string, year: number) =>
          call('GET', `/org/members/${enc(id)}/overtime`, overtimeResponse, undefined, { year }),
        book: (id: string, body: OvertimeBookingInput) =>
          call('POST', `/org/members/${enc(id)}/overtime-bookings`, overtimeBookingSchema, body),
      },
      payroll: {
        config: () => call('GET', '/org/payroll/config', payrollConfigSchema),
        setConfig: (body: z.input<typeof payrollConfigUpdate>) =>
          call('PUT', '/org/payroll/config', payrollConfigSchema, body),
        members: () => call('GET', '/org/payroll/members', payrollMembersResponse),
        setMember: (id: string, body: z.input<typeof payrollMemberUpdate>) =>
          call('PUT', `/org/payroll/members/${enc(id)}`, payrollMemberSchema, body),
        /** Lohn-Export (nur freigegebene Monate) als Datei. */
        export: async (q: { month: string; format: string; teamId?: string }) =>
          (
            await send('GET', '/org/payroll/export', undefined, {
              month: q.month,
              format: q.format,
              ...(q.teamId ? { teamId: q.teamId } : {}),
            })
          ).blob(),
        personio: {
          status: () => call('GET', '/org/payroll/personio', personioStatusResponse),
          set: (body: { clientId: string; clientSecret: string }) =>
            call('PUT', '/org/payroll/personio', personioStatusResponse, body),
          remove: () => call('DELETE', '/org/payroll/personio', okResponse),
          transfer: (month: string) =>
            call('POST', '/org/payroll/personio/transfer', transferSchema, { month }),
          transfers: () => call('GET', '/org/payroll/transfers', transfersResponse),
        },
      },
      audit: (q: { limit?: number; before?: string } = {}) =>
        call('GET', '/org/audit', auditResponse, undefined, {
          limit: q.limit ?? 50,
          ...(q.before ? { before: q.before } : {}),
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
