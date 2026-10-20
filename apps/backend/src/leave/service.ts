// Urlaubs- und Überstundenkonto: Daten laden und an das Regelwerk geben. Fachlich rechnet nur
// @timelog/rules (leaveDays, vacationAccounts, overtimeHistory).
import {
  type Absence,
  type LeaveDay,
  type RulesConfig,
  type VacationEntry,
  type VacationYearInput,
  absenceFraction,
  addDays,
  computeBalance,
  leaveDays,
  localDate,
  overtimeHistory,
  sumDays,
  targetMinutes,
  vacationAccounts,
  vacationEntitlement,
} from '@timelog/rules';
import {
  type LeaveOverview,
  type LeaveRequest,
  type LeaveSettings,
  type OvertimeView,
  type leaveProfileUpdate,
  leaveProfileSchema,
  leaveSettingsSchema,
} from '@timelog/shared';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { z } from 'zod';
import { HttpError } from '../app.js';
import { type Db, type Tx, asSystem } from '../db/index.js';
import {
  absences,
  approvals,
  leaveAdjustments,
  leaveProfiles,
  leaveRequestEvents,
  leaveRequests,
  organizations,
  overtimeBookings,
  users,
} from '../db/schema.js';
import { audit } from '../routes/org/access.js';
import { loadDays, loadRulesConfig } from '../routes/days.js';

export type RequestRow = typeof leaveRequests.$inferSelect;
type UserRow = typeof users.$inferSelect;
type OrgRow = typeof organizations.$inferSelect;

/** So viele Vorjahre fließen in Übertrag und Überstunden-Anfangsstand ein. */
const HISTORY_YEARS = 5;

export interface LeaveContext {
  user: UserRow;
  org: OrgRow | undefined;
  config: RulesConfig;
  settings: LeaveSettings;
  /** Firmenkonto: Anspruch pflegt der Admin, Anträge brauchen eine Genehmigung. */
  managed: boolean;
  today: string;
}

export function parseLeaveSettings(raw: unknown): LeaveSettings {
  const parsed = leaveSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : leaveSettingsSchema.parse({});
}

/** Lädt Nutzer, Regelwerk-Konfiguration und Urlaubsregeln (Transaktion für diesen Nutzer). */
export async function leaveContext(tx: Tx, userId: string, nowMs: number): Promise<LeaveContext> {
  const loaded = await loadRulesConfig(tx, userId);
  if (!loaded) throw new HttpError(404, 'not_found');
  const { user, org, config } = loaded;
  let settings: LeaveSettings;
  if (org) settings = parseLeaveSettings(org.leaveConfig);
  else {
    const [profile] = await tx.select().from(leaveProfiles).where(eq(leaveProfiles.userId, userId));
    settings = parseLeaveSettings(profile?.settings);
  }
  return {
    user,
    org,
    config,
    settings,
    managed: org !== undefined,
    today: localDate(nowMs, user.timezone),
  };
}

const yearOf = (date: string): number => Number(date.slice(0, 4));

/** Namen weniger Personen (nur Name, für „genehmigt von …“); liest ohne RLS, nur lesend. */
export async function namesOf(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await asSystem(db, (tx) =>
    tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique)),
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

type EventRow = typeof leaveRequestEvents.$inferSelect;

export function toLeaveRequest(
  r: RequestRow,
  events: readonly EventRow[],
  names: ReadonlyMap<string, string>,
): LeaveRequest {
  const name = names.get(r.userId);
  return {
    id: r.id,
    userId: r.userId,
    ...(name ? { name } : {}),
    kind: r.kind,
    from: r.fromDate,
    to: r.toDate,
    halfDayStart: r.halfDayStart,
    halfDayEnd: r.halfDayEnd,
    days: r.days,
    minutes: r.minutes,
    ...(r.note ? { note: r.note } : {}),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    ...(r.decidedAt ? { decidedAt: r.decidedAt.toISOString() } : {}),
    ...(r.decisionComment ? { decisionComment: r.decisionComment } : {}),
    ...(r.cancelledAt ? { cancelledAt: r.cancelledAt.toISOString() } : {}),
    history: events
      .filter((e) => e.requestId === r.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((e) => {
        const actorName = names.get(e.actorId);
        return {
          action: e.action,
          at: e.createdAt.toISOString(),
          ...(actorName ? { actorName } : {}),
          ...(e.comment ? { comment: e.comment } : {}),
        };
      }),
  };
}

/** Anträge samt Protokoll und Namen. */
export async function hydrateRequests(
  db: Db,
  tx: Tx,
  rows: readonly RequestRow[],
): Promise<LeaveRequest[]> {
  if (rows.length === 0) return [];
  const events = await tx
    .select()
    .from(leaveRequestEvents)
    .where(
      inArray(
        leaveRequestEvents.requestId,
        rows.map((r) => r.id),
      ),
    );
  const names = await namesOf(db, [...rows.map((r) => r.userId), ...events.map((e) => e.actorId)]);
  return rows.map((r) => toLeaveRequest(r, events, names));
}

/** Freigegebene Monate des Nutzers unter den gegebenen Monaten. */
export async function approvedMonths(
  tx: Tx,
  userId: string,
  months: readonly string[],
): Promise<string[]> {
  if (months.length === 0) return [];
  const rows = await tx
    .select({ month: approvals.month })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.status, 'approved'),
        inArray(approvals.month, [...months]),
      ),
    );
  return rows.map((r) => r.month);
}

export const monthsOf = (days: readonly { date: string }[]): string[] =>
  [...new Set(days.map((d) => d.date.slice(0, 7)))].sort();

/**
 * Setzt die Freigabe eines Monats zurück (nur Admin, wenn sich Abwesenheiten in einem freigegebenen
 * Monat ändern). Der Snapshot wird verworfen, der Monat muss neu freigegeben werden.
 */
export async function reopenApproval(
  tx: Tx,
  actor: { id: string; orgId: string },
  userId: string,
  month: string,
  reason: string,
): Promise<void> {
  await tx
    .update(approvals)
    .set({
      status: 'submitted',
      snapshot: null,
      absencesSnapshot: null,
      rulesConfigVersion: null,
      approverId: null,
      decidedAt: null,
      comment: null,
    })
    .where(and(eq(approvals.userId, userId), eq(approvals.month, month)));
  await audit(tx, actor, 'approval.reopen', `${userId}:${month}`, { reason });
}

/** Arbeitstage eines Antrags mit der Konfiguration der Person; ohne Arbeitstag → 400. */
export function requestDays(
  cfg: RulesConfig,
  r: { from: string; to: string; halfDayStart: boolean; halfDayEnd: boolean },
): LeaveDay[] {
  const days = leaveDays(r, cfg);
  if (days.length === 0) throw new HttpError(400, 'no_workdays');
  return days;
}

/** Prüft Überschneidungen mit eigenen offenen/genehmigten Anträgen und Urlaubs-Abwesenheiten. */
export async function assertNoOverlap(
  tx: Tx,
  userId: string,
  from: string,
  to: string,
  exceptId?: string,
): Promise<void> {
  const overlapping = await tx
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.userId, userId),
        inArray(leaveRequests.status, ['pending', 'approved']),
        lte(leaveRequests.fromDate, to),
        gte(leaveRequests.toDate, from),
      ),
    );
  if (overlapping.some((r) => r.id !== exceptId)) throw new HttpError(409, 'overlapping_request');
  const free = await tx
    .select({ id: absences.id })
    .from(absences)
    .where(
      and(
        eq(absences.userId, userId),
        gte(absences.date, from),
        lte(absences.date, to),
        inArray(absences.kind, ['vacation', 'overtime']),
      ),
    );
  if (free.length > 0) throw new HttpError(409, 'overlapping_request');
}

/** Legt die Abwesenheiten eines genehmigten Antrags an und aktualisiert Tage/Minuten. */
export async function applyApproved(tx: Tx, row: RequestRow, days: readonly LeaveDay[]) {
  await tx.insert(absences).values(
    days.map((d) => ({
      userId: row.userId,
      date: d.date,
      kind: row.kind,
      minutes: d.minutes,
      requestId: row.id,
      note: null,
    })),
  );
}

export async function removeRequestAbsences(tx: Tx, row: RequestRow): Promise<void> {
  await tx
    .delete(absences)
    .where(and(eq(absences.userId, row.userId), eq(absences.requestId, row.id)));
}

export async function logRequestEvent(
  tx: Tx,
  row: { id: string; userId: string },
  action: 'request' | 'approve' | 'reject' | 'cancel',
  actorId: string,
  comment?: string | null,
) {
  await tx.insert(leaveRequestEvents).values({
    requestId: row.id,
    userId: row.userId,
    action,
    actorId,
    comment: comment ?? null,
  });
}

// ── Urlaubskonto ──────────────────────────────────────────────────────────────

/** Urlaubskonto, Anträge und Buchungen eines Jahres (Transaktion für diesen Nutzer). */
export async function loadLeaveOverview(
  db: Db,
  tx: Tx,
  lc: LeaveContext,
  year: number,
): Promise<LeaveOverview> {
  const userId = lc.user.id;
  const [profileRow] = await tx
    .select()
    .from(leaveProfiles)
    .where(eq(leaveProfiles.userId, userId));
  const profile = leaveProfileSchema.parse({
    ...(profileRow?.annualDays !== null && profileRow?.annualDays !== undefined
      ? { annualDays: profileRow.annualDays }
      : {}),
    ...(profileRow?.workdaysPerWeek !== null && profileRow?.workdaysPerWeek !== undefined
      ? { workdaysPerWeek: profileRow.workdaysPerWeek }
      : {}),
    ...(profileRow?.entryDate ? { entryDate: profileRow.entryDate } : {}),
    ...(profileRow?.exitDate ? { exitDate: profileRow.exitDate } : {}),
  });

  const firstCandidate = year - HISTORY_YEARS;
  const createdYear = lc.user.createdAt.getUTCFullYear();
  const entryYear = profile.entryDate ? yearOf(profile.entryDate) : undefined;
  const firstYear = Math.min(
    year,
    Math.max(firstCandidate, Math.min(createdYear, entryYear ?? createdYear)),
  );
  const rangeFrom = `${String(firstYear)}-01-01`;
  const rangeTo = `${String(year)}-12-31`;

  const vacationAbsences = await tx
    .select()
    .from(absences)
    .where(
      and(
        eq(absences.userId, userId),
        eq(absences.kind, 'vacation'),
        gte(absences.date, rangeFrom),
        lte(absences.date, rangeTo),
      ),
    );
  const requestRows = await tx
    .select()
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.userId, userId),
        lte(leaveRequests.fromDate, rangeTo),
        gte(leaveRequests.toDate, rangeFrom),
      ),
    )
    .orderBy(desc(leaveRequests.fromDate));
  const adjustmentRows = await tx
    .select()
    .from(leaveAdjustments)
    .where(
      and(
        eq(leaveAdjustments.userId, userId),
        gte(leaveAdjustments.year, firstYear),
        lte(leaveAdjustments.year, year),
      ),
    )
    .orderBy(asc(leaveAdjustments.createdAt));

  const entries: VacationEntry[] = [
    ...vacationAbsences.map((a) => ({
      date: a.date,
      fraction: absenceFraction(a.minutes, targetMinutes(a.date, lc.config)),
      status: 'approved' as const,
    })),
    ...requestRows
      .filter((r) => r.kind === 'vacation' && r.status === 'pending')
      .flatMap((r) =>
        leaveDays(
          {
            from: r.fromDate,
            to: r.toDate,
            halfDayStart: r.halfDayStart,
            halfDayEnd: r.halfDayEnd,
          },
          lc.config,
        ).map((d) => ({ date: d.date, fraction: d.fraction, status: 'pending' as const })),
      ),
  ].filter((e) => e.fraction > 0);

  const years: VacationYearInput[] = [];
  for (let y = firstYear; y <= year; y += 1) {
    const adj = adjustmentRows.filter((a) => a.year === y);
    // Manuelle Werte überschreiben die Automatik: der jüngste gesetzte Übertrag gilt.
    const carry = adj.filter((a) => a.kind === 'carry_over').at(-1);
    const correction = adj.filter((a) => a.kind === 'correction').reduce((s, a) => s + a.days, 0);
    years.push({
      year: y,
      entitlement: vacationEntitlement({
        year: y,
        annualDays: profile.annualDays ?? lc.settings.defaultAnnualDays,
        ...(profile.workdaysPerWeek !== undefined
          ? { workdaysPerWeek: profile.workdaysPerWeek }
          : {}),
        standardWorkdaysPerWeek: lc.settings.standardWorkdaysPerWeek,
        ...(profile.entryDate ? { entryDate: profile.entryDate } : {}),
        ...(profile.exitDate ? { exitDate: profile.exitDate } : {}),
      }),
      correction,
      ...(carry ? { manualCarryOver: carry.days } : {}),
    });
  }
  const accounts = vacationAccounts(
    years,
    entries,
    { expiry: lc.settings.carryOverExpiry, expires: lc.settings.carryOverExpires },
    lc.today,
  );
  const account = accounts.at(-1);
  if (!account) throw new HttpError(500, 'account_failed');

  const prefix = String(year);
  const inYear = requestRows.filter(
    (r) => r.fromDate.startsWith(prefix) || r.toDate.startsWith(prefix),
  );
  const adjustNames = await namesOf(
    db,
    adjustmentRows.map((a) => a.authorId),
  );
  return {
    year,
    account,
    requests: await hydrateRequests(db, tx, inYear),
    profile,
    adjustments: adjustmentRows
      .filter((a) => a.year === year)
      .map((a) => {
        const authorName = adjustNames.get(a.authorId);
        return {
          id: a.id,
          year: a.year,
          kind: a.kind,
          days: a.days,
          comment: a.comment,
          createdAt: a.createdAt.toISOString(),
          ...(authorName ? { authorName } : {}),
        };
      }),
    settings: lc.settings,
    managed: lc.managed,
  };
}

// ── Überstundenkonto ──────────────────────────────────────────────────────────

function monthList(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to;) {
    out.push(m);
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    m = mo === 12 ? `${String(y + 1)}-01` : `${String(y)}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

/**
 * Saldo-Verlauf je Monat bis heute. Freigegebene Monate kommen aus dem Snapshot. Anfangsstand =
 * Salden und Buchungen der Vorjahre (höchstens fünf, ab Kontoanlage).
 */
export async function loadOvertime(
  db: Db,
  tx: Tx,
  lc: LeaveContext,
  year: number,
  nowMs: number,
): Promise<OvertimeView> {
  const userId = lc.user.id;
  const yearStart = `${String(year)}-01-01`;
  const yearEnd = `${String(year)}-12-31`;
  const until = lc.today < yearEnd ? lc.today : yearEnd;
  const firstYear = Math.max(year - HISTORY_YEARS, lc.user.createdAt.getUTCFullYear());

  const bookingRows = await tx
    .select()
    .from(overtimeBookings)
    .where(
      and(eq(overtimeBookings.userId, userId), lte(overtimeBookings.month, `${String(year)}-12`)),
    )
    .orderBy(asc(overtimeBookings.createdAt));

  let startBalance = bookingRows
    .filter((b) => b.month < `${String(year)}-01`)
    .reduce((s, b) => s + b.minutes, 0);
  if (firstYear < year) {
    const prev = await loadDays(
      tx,
      userId,
      `${String(firstYear)}-01-01`,
      addDays(yearStart, -1),
      nowMs,
    );
    startBalance += computeBalance(prev.days);
  }

  const months = until >= yearStart ? monthList(`${String(year)}-01`, until.slice(0, 7)) : [];
  const loaded =
    until >= yearStart
      ? await loadDays(tx, userId, yearStart, until, nowMs)
      : { days: [], approvedMonths: [] as string[] };
  const overtimeAbsences = await tx
    .select()
    .from(absences)
    .where(
      and(
        eq(absences.userId, userId),
        eq(absences.kind, 'overtime'),
        gte(absences.date, yearStart),
        lte(absences.date, until),
      ),
    );
  const inYear = bookingRows.filter((b) => b.month.startsWith(String(year)));
  const max = lc.settings.maxOvertimeMinutes;
  const history = overtimeHistory(
    months,
    loaded.days,
    overtimeAbsences.map((a): Absence => ({ date: a.date, kind: a.kind, minutes: a.minutes })),
    inYear.map((b) => ({ month: b.month, minutes: b.minutes })),
    max,
    startBalance,
  );
  const balance = history.at(-1)?.balanceMinutes ?? startBalance;
  const names = await namesOf(
    db,
    inYear.map((b) => b.authorId),
  );
  return {
    year,
    startBalanceMinutes: startBalance,
    months: history.map((m) => ({ ...m, approved: loaded.approvedMonths.includes(m.month) })),
    balanceMinutes: balance,
    ...(max !== undefined ? { maxBalanceMinutes: max } : {}),
    overMax: max !== undefined && balance > max,
    bookings: inYear.map((b) => {
      const authorName = names.get(b.authorId);
      return {
        id: b.id,
        month: b.month,
        minutes: b.minutes,
        kind: b.kind,
        comment: b.comment,
        createdAt: b.createdAt.toISOString(),
        ...(authorName ? { authorName } : {}),
      };
    }),
  };
}

export const daysTotal = (days: readonly LeaveDay[]): number => sumDays(days);
export const minutesTotal = (days: readonly LeaveDay[]): number =>
  days.reduce((s, d) => s + d.minutes, 0);

/** Antrag des Nutzers (oder sichtbaren Mitglieds) laden. */
export async function loadRequest(tx: Tx, id: string): Promise<RequestRow> {
  const [row] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, id));
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

export type ProfileUpdate = z.infer<typeof leaveProfileUpdate>;

/** Anspruch speichern (Upsert); null entfernt einen Wert. */
export async function saveProfile(tx: Tx, userId: string, body: ProfileUpdate, nowMs: number) {
  const values = {
    ...(body.annualDays !== undefined ? { annualDays: body.annualDays } : {}),
    ...(body.workdaysPerWeek !== undefined ? { workdaysPerWeek: body.workdaysPerWeek } : {}),
    ...(body.entryDate !== undefined ? { entryDate: body.entryDate } : {}),
    ...(body.exitDate !== undefined ? { exitDate: body.exitDate } : {}),
    updatedAt: new Date(nowMs),
  };
  await tx
    .insert(leaveProfiles)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: leaveProfiles.userId, set: values });
}

/** Anträge mehrerer Personen im Zeitraum (RLS: app_can_view). */
export async function requestsOf(
  tx: Tx,
  userIds: readonly string[],
  filter: { status?: RequestRow['status']; from?: string; to?: string },
): Promise<RequestRow[]> {
  if (userIds.length === 0) return [];
  return tx
    .select()
    .from(leaveRequests)
    .where(
      and(
        inArray(leaveRequests.userId, [...userIds]),
        filter.status ? eq(leaveRequests.status, filter.status) : undefined,
        filter.to ? lte(leaveRequests.fromDate, filter.to) : undefined,
        filter.from ? gte(leaveRequests.toDate, filter.from) : undefined,
      ),
    )
    .orderBy(asc(leaveRequests.fromDate));
}
