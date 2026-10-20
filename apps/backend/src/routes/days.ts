import {
  type Absence,
  GERMAN_STATES,
  type PresenceSpan,
  type RulesConfig,
  type TargetSchedule,
  type TimeEvent,
  type WorkDay,
  addDays,
  computeBalance,
  computeDays,
  localDate,
  resolveConfig,
} from '@timelog/rules';
import {
  daysQuery,
  daysResponse,
  orgRulesConfig,
  statusResponse,
  workDaySchema,
} from '@timelog/shared';
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { App, AppContext } from '../app.js';
import { type Tx, withUser } from '../db/index.js';
import {
  absences,
  approvals,
  devices,
  events,
  organizations,
  presenceSpans,
  targetHours,
  users,
} from '../db/schema.js';
import { authOf, scopeOf } from './guard.js';
import { toStoredEvent } from './events.js';

const security = [{ bearer: [] }];
/** Vorlauf für Neustarts, Sitzungen über Mitternacht und den 24-Wochen-Durchschnitt. */
const LOOKBACK_DAYS = 24 * 7 + 2;

function buildSchedule(rows: (typeof targetHours.$inferSelect)[]): TargetSchedule[] | undefined {
  if (rows.length === 0) return undefined;
  const byDate = new Map<string, TargetSchedule>();
  for (const r of rows) {
    let s = byDate.get(r.validFrom);
    if (!s) {
      s = { validFrom: r.validFrom, minutesByWeekday: [0, 0, 0, 0, 0, 0, 0] };
      byDate.set(r.validFrom, s);
    }
    s.minutesByWeekday[r.weekday] = r.minutes;
  }
  return [...byDate.values()];
}

interface Computed {
  days: WorkDay[];
  timezone: string;
  /** Wirksames Regelwerk des Nutzers (Organisation, Bundesland, Sollzeiten) */
  config: RulesConfig;
}

type UserRow = typeof users.$inferSelect;
type OrgRow = typeof organizations.$inferSelect;

/**
 * Regelwerk-Konfiguration des Nutzers: Organisations-Parameter, Bundesland und Sollzeiten (RLS: die
 * Transaktion muss für diesen Nutzer laufen).
 */
export async function loadRulesConfig(
  tx: Tx,
  userId: string,
): Promise<{ user: UserRow; org: OrgRow | undefined; config: RulesConfig } | undefined> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) return undefined;
  const org = user.orgId
    ? (await tx.select().from(organizations).where(eq(organizations.id, user.orgId)))[0]
    : undefined;
  const targetRows = await tx.select().from(targetHours);
  const state = (GERMAN_STATES as readonly string[]).includes(user.state)
    ? (user.state as RulesConfig['state'])
    : 'BE';
  const orgConfig = orgRulesConfig.safeParse(org?.rulesConfig ?? {});
  const schedule = buildSchedule(targetRows);
  const config = resolveConfig({
    ...(orgConfig.success ? orgConfig.data : {}),
    state,
    ...(schedule ? { targetSchedule: schedule } : {}),
  });
  return { user, org, config };
}

/** Lädt alle Eingaben des Nutzers und berechnet die Arbeitstage mit dem Regelwerk. */
export async function computeUserDays(
  tx: Tx,
  userId: string,
  from: string,
  to: string,
  nowMs: number,
): Promise<Computed> {
  const loaded = await loadRulesConfig(tx, userId);
  if (!loaded) return { days: [], timezone: 'Europe/Berlin', config: resolveConfig() };
  const { user, config } = loaded;

  const loadFrom = new Date(Date.parse(`${addDays(from, -LOOKBACK_DAYS)}T00:00:00Z`));
  const loadTo = new Date(Date.parse(`${addDays(to, 2)}T00:00:00Z`));

  // Nacheinander: eine Transaktion hat nur eine Verbindung
  const eventRows = await tx
    .select()
    .from(events)
    .where(and(gte(events.ts, loadFrom), lte(events.ts, loadTo)));
  const spanRows = await tx
    .select({ span: presenceSpans, kind: devices.kind })
    .from(presenceSpans)
    .innerJoin(devices, eq(devices.id, presenceSpans.deviceId))
    .where(and(gte(presenceSpans.end, loadFrom), lte(presenceSpans.start, loadTo)));
  const absenceRows = await tx
    .select()
    .from(absences)
    .where(and(gte(absences.date, from), lte(absences.date, to)));

  const ruleEvents: TimeEvent[] = eventRows.map((r) => ({ ...toStoredEvent(r), userId }));
  const ruleSpans: PresenceSpan[] = spanRows.map(({ span, kind }) => ({
    deviceId: span.deviceId,
    deviceKind: kind,
    start: span.start.toISOString(),
    end: span.end.toISOString(),
    open: span.open,
  }));
  const ruleAbsences: Absence[] = absenceRows.map((a) => ({
    date: a.date,
    kind: a.kind,
    minutes: a.minutes,
  }));

  const days = computeDays(
    ruleEvents,
    ruleSpans,
    ruleAbsences,
    config,
    new Date(nowMs).toISOString(),
  );
  return {
    days: days.filter((d) => d.date >= from && d.date <= to),
    timezone: user.timezone,
    config,
  };
}

/** Monate (JJJJ-MM) zwischen zwei Daten, jeweils einschließlich. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const end = to.slice(0, 7);
  for (;;) {
    const month = `${String(y)}-${String(m).padStart(2, '0')}`;
    if (month > end) break;
    out.push(month);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const snapshotSchema = z.array(workDaySchema);

/**
 * Arbeitstage wie computeUserDays, aber freigegebene Monate kommen unverändert aus dem Snapshot
 * und werden nie neu berechnet.
 */
export async function loadDays(
  tx: Tx,
  userId: string,
  from: string,
  to: string,
  nowMs: number,
): Promise<Computed & { approvedMonths: string[] }> {
  const months = monthsBetween(from, to);
  const rows = await tx
    .select({ month: approvals.month, snapshot: approvals.snapshot })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.status, 'approved'),
        gte(approvals.month, months[0] ?? ''),
        lte(approvals.month, months[months.length - 1] ?? ''),
      ),
    );
  const frozen = new Map<string, WorkDay[]>();
  for (const r of rows) {
    const parsed = snapshotSchema.safeParse(r.snapshot);
    if (parsed.success) frozen.set(r.month, parsed.data);
  }
  const computed = await computeUserDays(tx, userId, from, to, nowMs);
  if (frozen.size === 0) return { ...computed, approvedMonths: [] };
  const live = computed.days.filter((d) => !frozen.has(d.date.slice(0, 7)));
  const fromSnapshots = [...frozen.values()].flat().filter((d) => d.date >= from && d.date <= to);
  const days = [...live, ...fromSnapshots].sort((a, b) => a.date.localeCompare(b.date));
  return { ...computed, days, approvedMonths: [...frozen.keys()].sort() };
}

export function daysRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/days',
    {
      schema: {
        tags: ['days'],
        security,
        description:
          'Berechnete Arbeitstage im Zeitraum (höchstens 93 Tage); freigegebene Monate als Snapshot.',
        querystring: daysQuery,
        response: { 200: daysResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { days } = await withUser(ctx.db, scopeOf(claims), (tx) =>
        loadDays(tx, claims.sub, request.query.from, request.query.to, ctx.now()),
      );
      return { days, balanceMinutes: computeBalance(days) };
    },
  );

  app.get(
    '/status',
    {
      schema: {
        tags: ['days'],
        security,
        description: 'Aktueller Zustand für Tray und Widget.',
        response: { 200: statusResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const now = ctx.now();
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [user] = await tx
          .select({ timezone: users.timezone })
          .from(users)
          .where(eq(users.id, claims.sub));
        const today = localDate(now, user?.timezone ?? 'Europe/Berlin');
        const { days } = await computeUserDays(tx, claims.sub, addDays(today, -14), today, now);
        const todayDay = days.find((d) => d.date === today);
        const open = days.flatMap((d) => d.sessions).find((s) => s.open);
        const out: z.infer<typeof statusResponse> = {
          date: today,
          running: open !== undefined,
          toReview: days.filter((d) => d.status === 'unchecked').map((d) => d.date),
        };
        if (open) out.since = open.start;
        if (todayDay) out.today = todayDay;
        return out;
      });
    },
  );
}
