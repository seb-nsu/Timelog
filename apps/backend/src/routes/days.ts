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
import { daysQuery, daysResponse, statusResponse } from '@timelog/shared';
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { App, AppContext } from '../app.js';
import { type Tx, withUser } from '../db/index.js';
import {
  absences,
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

/** Regelwerk-Parameter der Organisation; nur bekannte Zahlenwerte werden übernommen. */
const orgRulesConfig = z
  .object({
    shutdownBonusMin: z.number().int().min(0).max(30),
    restartWindowMin: z.number().int().min(0).max(120),
    updateRestartWindowMin: z.number().int().min(0).max(240),
    netGraceMin: z.number().int().min(0).max(60),
    standbyBreakMin: z.number().int().min(1).max(120),
    maxStandbyMin: z.number().int().min(15).max(720),
    maxBreakMin: z.number().int().min(15).max(720),
    maxSessionH: z.number().int().min(1).max(24),
  })
  .partial();

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
}

/** Lädt alle Eingaben des Nutzers und berechnet die Arbeitstage mit dem Regelwerk. */
export async function computeUserDays(
  tx: Tx,
  userId: string,
  from: string,
  to: string,
  nowMs: number,
): Promise<Computed> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) return { days: [], timezone: 'Europe/Berlin' };
  const org = user.orgId
    ? (await tx.select().from(organizations).where(eq(organizations.id, user.orgId)))[0]
    : undefined;

  const loadFrom = new Date(Date.parse(`${addDays(from, -LOOKBACK_DAYS)}T00:00:00Z`));
  const loadTo = new Date(Date.parse(`${addDays(to, 2)}T00:00:00Z`));

  const [eventRows, spanRows, targetRows, absenceRows] = await Promise.all([
    tx
      .select()
      .from(events)
      .where(and(gte(events.ts, loadFrom), lte(events.ts, loadTo))),
    tx
      .select({ span: presenceSpans, kind: devices.kind })
      .from(presenceSpans)
      .innerJoin(devices, eq(devices.id, presenceSpans.deviceId))
      .where(and(gte(presenceSpans.end, loadFrom), lte(presenceSpans.start, loadTo))),
    tx.select().from(targetHours),
    tx
      .select()
      .from(absences)
      .where(and(gte(absences.date, from), lte(absences.date, to))),
  ]);

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

  const days = computeDays(
    ruleEvents,
    ruleSpans,
    ruleAbsences,
    config,
    new Date(nowMs).toISOString(),
  );
  return { days: days.filter((d) => d.date >= from && d.date <= to), timezone: user.timezone };
}

export function daysRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/days',
    {
      schema: {
        tags: ['days'],
        security,
        description: 'Berechnete Arbeitstage im Zeitraum (höchstens 93 Tage).',
        querystring: daysQuery,
        response: { 200: daysResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { days } = await withUser(ctx.db, scopeOf(claims), (tx) =>
        computeUserDays(tx, claims.sub, request.query.from, request.query.to, ctx.now()),
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
