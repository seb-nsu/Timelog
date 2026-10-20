// Rückfragen per Push: „Feierabend um 17:12 erkannt, stimmt das?“, „Arbeitsende fehlt“ und der
// Wochenrückblick. Was eine Sitzung ist, wann sie endet und welche Warnungen gelten, entscheidet
// allein @timelog/rules; hier wird nur gelesen, ob und wann gefragt wird.
import {
  type WorkDay,
  addDays,
  isoWeekOf,
  localDate,
  localTime,
  summarizeWeek,
  zonedToUtc,
} from '@timelog/rules';
import {
  type EndPromptPayload,
  PUSH_CATEGORIES,
  type PromptKind,
  type PushData,
  type Settings,
  type WeekPromptPayload,
  settingsSchema,
} from '@timelog/shared';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { type Db, type Scope, asSystem, withUser } from '../db/index.js';
import { devices, pushPrompts, users } from '../db/schema.js';
import { loadDays } from '../routes/days.js';
import { type PushNotification, type PushSender, pushPlatform } from './sender.js';
import { type PushLocale, endConfirmText, endMissingText, weekText } from './texts.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface PromptTiming {
  /** Karenz nach dem erkannten Ende, bevor gefragt wird (länger als die Netz-Karenz von 10 min). */
  graceMin: number;
  /** Ältere Enden werden nicht mehr erfragt. */
  maxAgeH: number;
}

export const DEFAULT_TIMING: PromptTiming = { graceMin: 20, maxAgeH: 24 };

/** Automatisch erkannte Enden, nach denen gefragt wird; ein Ende per Stopp-Knopf nicht. */
const ASKED_END_SOURCES: readonly string[] = ['shutdown', 'net_lost'];

export interface EndCandidate {
  kind: 'end_confirm' | 'end_missing';
  ref: string;
  payload: EndPromptPayload;
}

/**
 * Sitzungen, nach deren Ende gefragt wird:
 * - `end_missing`: Warnung `no_end` oder `gap_end`, Sitzung nicht mehr offen.
 * - `end_confirm`: Ende aus Herunterfahren oder Netzverlust, Karenz abgelaufen, noch nicht bestätigt.
 * Bereits bestätigte oder verworfene Sitzungen und Sitzungen in `skipMonths` (freigegeben) nie.
 */
export function endCandidates(
  days: readonly WorkDay[],
  nowMs: number,
  timing: PromptTiming = DEFAULT_TIMING,
  skipMonths: readonly string[] = [],
): EndCandidate[] {
  const seen = new Set<string>();
  const out: EndCandidate[] = [];
  for (const day of days) {
    if (skipMonths.includes(day.date.slice(0, 7))) continue;
    for (const s of day.sessions) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      if (s.open || s.confirmed !== undefined) continue;
      const last = Date.parse(s.end ?? s.start);
      const payload: EndPromptPayload = {
        sessionId: s.id,
        date: localDate(last, s.tz),
        tz: s.tz,
        ...(s.end ? { end: s.end } : {}),
        ...(s.endSource ? { endSource: s.endSource } : {}),
      };
      if (s.warnings.includes('no_end') || s.warnings.includes('gap_end')) {
        if (nowMs - last <= (timing.maxAgeH + 12) * HOUR) {
          out.push({ kind: 'end_missing', ref: s.id, payload });
        }
        continue;
      }
      if (!s.end || !s.endSource || !ASKED_END_SOURCES.includes(s.endSource)) continue;
      const since = nowMs - last;
      if (since >= timing.graceMin * MIN && since <= timing.maxAgeH * HOUR) {
        out.push({ kind: 'end_confirm', ref: s.id, payload });
      }
    }
  }
  return out;
}

/** Liegt `nowMs` in der Ruhezeit (Ortszeit, auch über Mitternacht)? */
export function inQuietHours(
  nowMs: number,
  tz: string,
  quiet: { from: string; to: string },
): boolean {
  if (quiet.from === quiet.to) return false;
  const t = localTime(nowMs, tz);
  return quiet.from < quiet.to ? t >= quiet.from && t < quiet.to : t >= quiet.from || t < quiet.to;
}

function localInstant(date: string, time: string, tz: string): number {
  try {
    return zonedToUtc(date, time, tz);
  } catch {
    // Uhrzeit fällt in die Lücke der Zeitumstellung: eine Stunde später
    const hour = String((Number(time.slice(0, 2)) + 1) % 24).padStart(2, '0');
    return zonedToUtc(date, `${hour}${time.slice(2)}`, tz);
  }
}

/**
 * Fälliger Wochenrückblick: ab dem eingestellten Wochentag und der Uhrzeit (Ortszeit) der
 * laufenden Woche, höchstens 24 h später (z. B. nach der Ruhezeit).
 */
export function weekReviewDue(
  nowMs: number,
  tz: string,
  setting: Settings['notifications']['weekReview'],
): string | undefined {
  if (!setting.enabled) return undefined;
  const week = isoWeekOf(localDate(nowMs, tz));
  const target = addDays(week.from, (setting.weekday + 6) % 7);
  const at = localInstant(target, setting.time, tz);
  return nowMs >= at && nowMs < at + 24 * HOUR ? week.id : undefined;
}

export function weekPayload(
  days: readonly WorkDay[],
  config: Parameters<typeof summarizeWeek>[1],
  today: string,
): WeekPromptPayload | undefined {
  const s = summarizeWeek(days, config, today, today);
  const recorded = days.some(
    (d) =>
      d.date >= s.week.from &&
      d.date <= s.week.to &&
      (d.sessions.length > 0 || d.absenceMinutes > 0),
  );
  if (!recorded) return undefined;
  return {
    week: s.week.id,
    from: s.week.from,
    to: s.week.to,
    netMinutes: s.netMinutes,
    balanceMinutes: s.balanceMinutes,
    openDays: s.openDays.length,
    legalHints: s.legalHints.length,
  };
}

interface NewPrompt {
  kind: PromptKind;
  ref: string;
  payload: EndPromptPayload | WeekPromptPayload;
}

export function notificationFor(p: NewPrompt, locale: PushLocale, today: string): PushNotification {
  if (p.kind === 'week_review') {
    const payload = p.payload as WeekPromptPayload;
    const data: PushData = { kind: 'week_review', week: payload.week, date: payload.from };
    return {
      ...weekText(payload, locale),
      category: PUSH_CATEGORIES.week_review,
      data,
      collapseId: `week-${payload.week}`,
      urgent: false,
    };
  }
  const payload = p.payload as EndPromptPayload;
  const data: PushData =
    p.kind === 'end_confirm'
      ? { kind: 'end_confirm', sessionId: payload.sessionId, date: payload.date }
      : {
          kind: 'end_missing',
          sessionId: payload.sessionId,
          date: payload.date,
          ...(payload.end ? { end: payload.end } : {}),
        };
  return {
    ...(p.kind === 'end_confirm'
      ? endConfirmText(payload, locale, today)
      : endMissingText(payload, locale)),
    category: PUSH_CATEGORIES[p.kind],
    data,
    collapseId: `end-${payload.date}`,
    urgent: true,
  };
}

export interface PromptJobResult {
  users: number;
  prompts: number;
  pushed: number;
  removedTokens: number;
}

export interface PromptJobOptions {
  db: Db;
  sender: PushSender;
  timing?: PromptTiming;
}

interface Target {
  deviceId: string;
  token: string;
  os: string;
  locale: string | null;
}

/**
 * Ein Durchlauf: prüft alle aktiven Nutzer mit Ereignissen in den letzten 8 Tagen, legt fällige
 * Rückfragen an (idempotent je Nutzer, Art und Sitzung bzw. Woche) und sendet sie an die Handys.
 * In der Ruhezeit entsteht nichts; der nächste Durchlauf danach holt es nach.
 */
export async function runPromptJob(
  opts: PromptJobOptions,
  nowMs: number,
): Promise<PromptJobResult> {
  const { db, sender } = opts;
  const timing = opts.timing ?? DEFAULT_TIMING;
  const result: PromptJobResult = { users: 0, prompts: 0, pushed: 0, removedTokens: 0 };
  const since = new Date(nowMs - 8 * 24 * HOUR);
  const candidates = await asSystem(db, (tx) =>
    tx
      .select({
        id: users.id,
        orgId: users.orgId,
        timezone: users.timezone,
        settings: users.settings,
      })
      .from(users)
      .where(
        and(
          isNull(users.deletedAt),
          isNull(users.deactivatedAt),
          sql`exists (select 1 from events e where e.user_id = ${users.id} and e.ts > ${since})`,
        ),
      ),
  );

  for (const user of candidates) {
    const parsed = settingsSchema.safeParse(user.settings);
    if (!parsed.success || parsed.data.localOnly) continue;
    const n = parsed.data.notifications;
    if (inQuietHours(nowMs, user.timezone, n.quietHours)) continue;
    result.users += 1;
    const scope: Scope = { userId: user.id, orgId: user.orgId };
    const today = localDate(nowMs, user.timezone);

    const { created, targets } = await withUser(db, scope, async (tx) => {
      const { days, approvedMonths, config } = await loadDays(
        tx,
        user.id,
        addDays(today, -8),
        today,
        nowMs,
      );
      const wanted: NewPrompt[] = endCandidates(days, nowMs, timing, approvedMonths).filter((c) =>
        c.kind === 'end_confirm' ? n.confirmEnd : n.forgotEnd,
      );
      const week = weekReviewDue(nowMs, user.timezone, n.weekReview);
      if (week) {
        const payload = weekPayload(days, config, today);
        if (payload) wanted.push({ kind: 'week_review', ref: week, payload });
      }
      const fresh: NewPrompt[] = [];
      for (const p of wanted) {
        const rows = await tx
          .insert(pushPrompts)
          .values({ userId: user.id, kind: p.kind, ref: p.ref, payload: p.payload })
          .onConflictDoNothing()
          .returning({ ref: pushPrompts.ref });
        if (rows.length > 0) fresh.push(p);
      }
      const list: Target[] =
        fresh.length === 0
          ? []
          : await tx
              .select({
                deviceId: devices.id,
                token: devices.pushToken,
                os: devices.os,
                locale: devices.locale,
              })
              .from(devices)
              .where(
                and(
                  eq(devices.userId, user.id),
                  eq(devices.kind, 'mobile'),
                  isNull(devices.revokedAt),
                  isNotNull(devices.pushToken),
                ),
              )
              .then((rows) => rows.flatMap((r) => (r.token ? [{ ...r, token: r.token }] : [])));
      return { created: fresh, targets: list };
    });
    result.prompts += created.length;

    for (const p of created) {
      let sentTo = 0;
      for (const target of targets) {
        const platform = pushPlatform(target.os);
        if (!platform || !sender.platforms.has(platform)) continue;
        const locale: PushLocale = target.locale === 'en' ? 'en' : 'de';
        const outcome = await sender.send(
          platform,
          target.token,
          notificationFor(p, locale, today),
        );
        if (outcome === 'sent') sentTo += 1;
        if (outcome === 'invalid_token') {
          const removed = await withUser(db, scope, (tx) =>
            tx
              .update(devices)
              .set({ pushToken: null })
              .where(and(eq(devices.id, target.deviceId), eq(devices.pushToken, target.token)))
              .returning({ id: devices.id }),
          );
          result.removedTokens += removed.length;
          target.token = '';
        }
      }
      // Ungültige Tokens nicht für die nächste Rückfrage desselben Durchlaufs verwenden
      for (let i = targets.length - 1; i >= 0; i -= 1) {
        if (targets[i]?.token === '') targets.splice(i, 1);
      }
      result.pushed += sentTo;
      await withUser(db, scope, (tx) =>
        tx
          .update(pushPrompts)
          .set({ sentAt: sentTo > 0 ? new Date(nowMs) : null, sentTo })
          .where(
            and(
              eq(pushPrompts.userId, user.id),
              eq(pushPrompts.kind, p.kind),
              eq(pushPrompts.ref, p.ref),
            ),
          ),
      );
    }
  }
  return result;
}

/** Startet den Job alle 5 Minuten (überlappungsfrei). */
export function schedulePrompts(
  opts: PromptJobOptions,
  log: (msg: string) => void,
  intervalMs = 5 * MIN,
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runPromptJob(opts, Date.now())
      .then(
        (r) => {
          if (r.prompts > 0 || r.removedTokens > 0) {
            log(
              `prompts: ${String(r.prompts)} Rückfragen, ${String(r.pushed)} Push, ${String(r.removedTokens)} Tokens entfernt`,
            );
          }
        },
        (err: unknown) => {
          log(`prompts fehlgeschlagen: ${err instanceof Error ? err.message : 'unbekannt'}`);
        },
      )
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
