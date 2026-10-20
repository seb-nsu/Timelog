// Kleiner In-Memory-Server für die UI-Tests: beantwortet die Aufrufe des API-Clients.
import type {
  Approval,
  Member,
  OrgLeaveRequest,
  PayrollTransfer,
  Role,
  Team,
} from '@timelog/shared';
import { API_PREFIX } from '@timelog/shared';
import { Session } from '../src/session.js';

export const ID = {
  admin: '11111111-1111-4111-8111-111111111111',
  anna: '22222222-2222-4222-8222-222222222222',
  ben: '33333333-3333-4333-8333-333333333333',
  org: '44444444-4444-4444-8444-444444444444',
  team: '55555555-5555-4555-8555-555555555555',
  device: '66666666-6666-4666-8666-666666666666',
  invitation: '77777777-7777-4777-8777-777777777777',
  audit: '88888888-8888-4888-8888-888888888888',
  request: '99999999-9999-4999-8999-999999999999',
  transfer: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

const ACCOUNT = {
  year: 2026,
  entitlement: 30,
  correction: 0,
  carryOver: 3,
  carryOverManual: false,
  carryOverUsed: 3,
  carryOverForfeited: 0,
  carryOverExpiry: '2026-03-31',
  taken: 20,
  planned: 0,
  pending: 5,
  remaining: 13,
  remainingAfterPending: 8,
};
const LEAVE_SETTINGS = {
  defaultAnnualDays: 30,
  standardWorkdaysPerWeek: 5,
  carryOverExpiry: '03-31',
  carryOverExpires: true,
};
const OVERTIME = {
  year: 2026,
  startBalanceMinutes: 0,
  months: [
    {
      month: '2026-10',
      workMinutes: 300,
      bookedMinutes: 0,
      reducedMinutes: 0,
      balanceMinutes: 300,
      overMax: false,
      approved: false,
    },
  ],
  balanceMinutes: 300,
  overMax: false,
  bookings: [],
};

export const NOW = Date.parse('2026-10-20T10:00:00Z');

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface FakeState {
  role: Role;
  hasOrg: boolean;
  totpEnabled: boolean;
  loginNeedsTotp: boolean;
  members: Member[];
  teams: Team[];
  approvals: Approval[];
  invitations: { id: string; email: string; role: Role; expiresAt: string; createdAt: string }[];
  config: {
    name: string;
    slug?: string;
    retentionYears: number;
    rules: Record<string, number>;
  };
  leaveRequests: OrgLeaveRequest[];
  personio: { configured: boolean; clientId?: string; updatedAt?: string };
  transfers: PayrollTransfer[];
}

const token = (name: string) => ({
  accessToken: `access-${name}`,
  refreshToken: `refresh-token-${name}-0123456789`,
  expiresIn: 900,
  deviceId: ID.device,
  totpSetupRequired: false,
});

export function fakeServer(over: Partial<FakeState> = {}) {
  const state: FakeState = {
    role: 'admin',
    hasOrg: true,
    totpEnabled: true,
    loginNeedsTotp: false,
    members: [
      {
        id: ID.admin,
        name: 'Alex Admin',
        email: 'alex@firma.de',
        role: 'admin',
        active: true,
        totpEnabled: true,
      },
      {
        id: ID.anna,
        name: 'Anna Arbeit',
        email: 'anna@firma.de',
        role: 'user',
        teamId: ID.team,
        active: true,
        totpEnabled: false,
      },
    ],
    teams: [{ id: ID.team, name: 'Vertrieb', managerId: ID.admin, memberCount: 1 }],
    approvals: [
      {
        userId: ID.anna,
        name: 'Anna Arbeit',
        teamId: ID.team,
        month: '2026-09',
        status: 'submitted',
        submittedAt: '2026-10-01T08:00:00Z',
      },
    ],
    invitations: [],
    config: { name: 'Firma GmbH', slug: 'firma', retentionYears: 2, rules: {} },
    leaveRequests: [
      {
        id: ID.request,
        userId: ID.anna,
        name: 'Anna Arbeit',
        kind: 'vacation',
        from: '2026-11-02',
        to: '2026-11-06',
        halfDayStart: false,
        halfDayEnd: false,
        days: 5,
        minutes: 2400,
        note: 'Familienbesuch',
        status: 'pending',
        createdAt: '2026-10-19T08:00:00Z',
        history: [],
        overlaps: [{ name: 'Ben Büro', from: '2026-11-04', to: '2026-11-05' }],
      },
    ],
    personio: { configured: false },
    transfers: [],
    ...over,
  };
  const calls: Call[] = [];

  const me = () => ({
    user: { id: ID.admin, name: 'Alex Admin', email: 'alex@firma.de', role: state.role },
    org: { id: ID.org, name: state.config.name, slug: state.config.slug, plan: 'company' as const },
    managedTeamIds: state.role === 'manager' ? [ID.team] : [],
  });

  const configResponse = () => ({
    ...state.config,
    ruleDefaults: { shutdownBonusMin: 5, netGraceMin: 10 },
    rulesConfigVersion: 1,
    sso: { enforced: false, autoProvision: false, allowedDomains: [] },
  });

  const route = (c: Call): [number, unknown] => {
    const err = (status: number, error: string): [number, unknown] => [status, { error }];
    const m = `${c.method} ${c.path}`;
    const decide = /^POST \/org\/approvals\/([^/]+)\/([^/]+)\/(approve|reject)$/.exec(m);
    if (decide) {
      const a = state.approvals.find((x) => x.userId === decide[1] && x.month === decide[2]);
      if (!a) return err(404, 'not_found');
      a.status = decide[3] === 'approve' ? 'approved' : 'rejected';
      const comment = (c.body as { comment?: string }).comment;
      if (comment) a.comment = comment;
      return [200, a];
    }
    const detail = /^GET \/org\/approvals\/([^/]+)\/([^/]+)$/.exec(m);
    if (detail) {
      const a = state.approvals.find((x) => x.userId === detail[1] && x.month === detail[2]);
      if (!a) return err(404, 'not_found');
      return [
        200,
        {
          approval: a,
          snapshot: a.status === 'approved',
          days: [
            {
              date: '2026-09-01',
              start: '2026-09-01T06:00:00Z',
              end: '2026-09-01T16:00:00Z',
              breakMinutes: 15,
              breakTopUpMin: 30,
              netMinutes: 555,
              status: 'auto',
              warnings: ['break_violation'],
            },
          ],
          totals: { netMinutes: 555, breakTopUpMin: 30, uncheckedDays: 0, openDays: 0 },
        },
      ];
    }
    const leaveDecision = /^POST \/org\/leave\/requests\/([^/]+)\/(approve|reject|cancel)$/.exec(m);
    if (leaveDecision) {
      const r = state.leaveRequests.find((x) => x.id === leaveDecision[1]);
      if (!r) return err(404, 'not_found');
      const status = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[
        leaveDecision[2] as 'approve' | 'reject' | 'cancel'
      ];
      state.leaveRequests = state.leaveRequests.filter((x) => x.id !== r.id);
      const comment = (c.body as { comment?: string }).comment;
      return [200, { ...r, status, ...(comment ? { decisionComment: comment } : {}) }];
    }
    const memberLeave = /^GET \/org\/members\/([^/]+)\/leave$/.exec(m);
    if (memberLeave) {
      const who = state.members.find((x) => x.id === memberLeave[1]);
      return [
        200,
        {
          year: 2026,
          name: who?.name ?? '?',
          account: ACCOUNT,
          requests: [],
          profile: {},
          adjustments: [],
          settings: LEAVE_SETTINGS,
          managed: true,
        },
      ];
    }
    if (/^GET \/org\/members\/[^/]+\/overtime$/.test(m)) return [200, OVERTIME];
    if (/^PUT \/org\/members\/[^/]+\/leave-profile$/.test(m)) return [200, { ok: true }];
    if (/^POST \/org\/members\/[^/]+\/overtime-bookings$/.test(m)) {
      return [200, { ...(c.body as object), id: ID.audit, createdAt: '2026-10-20T10:00:00Z' }];
    }
    const payrollMember = /^PUT \/org\/payroll\/members\/([^/]+)$/.exec(m);
    if (payrollMember) {
      const body = c.body as { personnelNumber?: string | null };
      const who = state.members.find((x) => x.id === payrollMember[1]);
      return [
        200,
        {
          userId: payrollMember[1],
          name: who?.name ?? '?',
          ...(body.personnelNumber ? { personnelNumber: body.personnelNumber } : {}),
        },
      ];
    }
    switch (m) {
      case 'GET /org/leave/requests':
        return [200, { requests: state.leaveRequests }];
      case 'GET /org/leave/calendar':
        return [
          200,
          {
            entries: [
              {
                userId: ID.anna,
                name: 'Anna Arbeit',
                from: '2026-10-05',
                to: '2026-10-06',
                kind: 'absent',
                pending: false,
              },
            ],
          },
        ];
      case 'GET /org/leave/settings':
      case 'PUT /org/leave/settings':
        return [200, LEAVE_SETTINGS];
      case 'GET /leave':
        return [
          200,
          {
            year: 2026,
            account: ACCOUNT,
            requests: [],
            profile: {},
            adjustments: [],
            settings: LEAVE_SETTINGS,
            managed: true,
          },
        ];
      case 'GET /org/payroll/config':
      case 'PUT /org/payroll/config':
        return [
          200,
          {
            datev: { wageTypes: {}, absenceCodes: {} },
            lexware: { wageTypes: {} },
            personio: { skipApproval: true, matchBy: 'email' },
            ...(c.method === 'PUT' && typeof c.body === 'object' ? c.body : {}),
          },
        ];
      case 'GET /org/payroll/members':
        return [
          200,
          {
            members: state.members.map((x) => ({
              userId: x.id,
              name: x.name,
              ...(x.email ? { email: x.email } : {}),
            })),
          },
        ];
      case 'GET /org/payroll/export':
        return [200, 'Jahr;Monat;Personalnummer;Lohnartnummer;Wert'];
      case 'GET /org/payroll/personio':
        return [200, state.personio];
      case 'PUT /org/payroll/personio':
        state.personio = {
          configured: true,
          clientId: (c.body as { clientId: string }).clientId,
          updatedAt: '2026-10-20T10:00:00Z',
        };
        return [200, state.personio];
      case 'GET /org/payroll/transfers':
        return [200, { transfers: state.transfers }];
      case 'POST /org/payroll/personio/transfer': {
        const t = {
          id: ID.transfer,
          month: (c.body as { month: string }).month,
          createdAt: '2026-10-20T10:00:00Z',
          actorName: 'Alex Admin',
          status: 'partial' as const,
          members: [
            { userId: ID.anna, name: 'Anna Arbeit', status: 'transferred' as const, periods: 40 },
            {
              userId: ID.admin,
              name: 'Alex Admin',
              status: 'skipped' as const,
              periods: 0,
              message: 'Monat nicht freigegeben',
            },
          ],
        };
        state.transfers = [t];
        return [200, t];
      }
      case 'POST /auth/login': {
        const body = c.body as { totp?: string };
        if (state.loginNeedsTotp && !body.totp) return err(401, 'totp_required');
        return [200, token('login')];
      }
      case 'POST /auth/refresh':
        return [200, token('refresh')];
      case 'POST /auth/logout':
        return [200, { ok: true }];
      case 'POST /auth/sso/exchange':
        return [200, token('sso')];
      case 'POST /auth/totp/setup':
        return [
          200,
          {
            secret: 'JBSWY3DPEHPK3PXP',
            otpauthUrl: 'otpauth://totp/TimeLog:alex?secret=JBSWY3DPEHPK3PXP',
          },
        ];
      case 'POST /auth/totp/verify':
        state.totpEnabled = true;
        return [200, { ok: true }];
      case 'GET /auth/invite':
        return [200, { orgName: 'Firma GmbH', email: 'neu@firma.de', role: 'user' }];
      case 'POST /auth/invite/accept':
        return [200, { ok: true }];
      case 'POST /orgs':
        state.hasOrg = true;
        state.role = 'admin';
        state.totpEnabled = false;
        return [200, { orgId: ID.org }];
      case 'GET /org/me':
        if (!state.hasOrg) return err(403, 'no_organization');
        if (state.role !== 'user' && !state.totpEnabled) return err(403, 'totp_setup_required');
        return [200, me()];
      case 'GET /org/approvals':
        return [200, { approvals: state.approvals.filter((a) => a.month === c.query.month) }];
      case 'GET /org/members':
        return [
          200,
          {
            members:
              state.role === 'admin'
                ? state.members
                : state.members
                    .filter((x) => x.teamId === ID.team)
                    .map((x) => ({ id: x.id, name: x.name, teamId: x.teamId })),
          },
        ];
      case 'GET /org/teams':
        return [200, { teams: state.teams }];
      case 'GET /org/invitations':
        return [200, { invitations: state.invitations }];
      case 'POST /org/invite': {
        const body = c.body as { email: string; role: Role };
        const inv = {
          id: ID.invitation,
          email: body.email,
          role: body.role,
          expiresAt: '2026-10-27T10:00:00Z',
          createdAt: '2026-10-20T10:00:00Z',
        };
        state.invitations.push(inv);
        return [200, inv];
      }
      case 'GET /org/config':
        return [200, configResponse()];
      case 'PUT /org/config': {
        const body = c.body as Partial<FakeState['config']>;
        state.config = { ...state.config, ...body };
        return [200, configResponse()];
      }
      case 'GET /org/export':
        return [200, 'Name;Datum'];
      case 'GET /org/networks':
        return [200, { networks: [], keys: { user: 'dXNlcg==', org: 'b3Jn' } }];
      case 'GET /org/audit':
        return [
          200,
          {
            entries: [
              {
                id: ID.audit,
                actorId: ID.admin,
                actorName: 'Alex Admin',
                action: 'approval.approve',
                target: `${ID.anna}/2026-09`,
                createdAt: '2026-10-02T09:00:00Z',
              },
            ],
          },
        ];
      default:
        return err(404, 'not_found');
    }
  };

  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.slice(API_PREFIX.length);
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      query: Object.fromEntries(url.searchParams),
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
    };
    calls.push(call);
    const [status, body] = route(call);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return { state, calls, fetch: fetchImpl };
}

export function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

/** Sitzung mit gespeichertem Refresh-Token (bereits angemeldet). */
export function signedIn(server: ReturnType<typeof fakeServer>, loggedIn = true): Session {
  const store = memoryStore(
    loggedIn ? { 'timelog.admin.refresh': 'refresh-token-stored-0123456789' } : {},
  );
  return new Session('http://admin.test', store, server.fetch, () => NOW);
}
