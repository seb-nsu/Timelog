// Nächtlicher Lösch-Job: Aufbewahrungsfristen nach Plan und abgelaufene Tokens.
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { type Db, asOwner } from '../db/index.js';
import {
  absences,
  approvals,
  authTokens,
  corrections,
  events,
  organizations,
  presenceSpans,
  refreshTokens,
  users,
  workDays,
} from '../db/schema.js';
import { deleteUserData } from '../routes/privacy.js';

export interface PurgeResult {
  deletedUsers: number;
  deletedEvents: number;
  deletedTokens: number;
}

const DAY_MS = 86_400_000;

function yearsBefore(nowMs: number, years: number): Date {
  const d = new Date(nowMs);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

export async function purgeExpired(db: Db, nowMs: number): Promise<PurgeResult> {
  return asOwner(db, async (tx) => {
    const result: PurgeResult = { deletedUsers: 0, deletedEvents: 0, deletedTokens: 0 };

    // Firmenkonten: Daten älter als die Aufbewahrungsfrist löschen
    const orgs = await tx.select().from(organizations).where(eq(organizations.plan, 'company'));
    for (const org of orgs) {
      const cutoff = yearsBefore(nowMs, org.retentionYears);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const members = await tx
        .select({ id: users.id, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.orgId, org.id));
      const ids = members.map((m) => m.id);
      if (ids.length === 0) continue;

      const removed = await tx
        .delete(events)
        .where(and(inArray(events.userId, ids), lt(events.ts, cutoff)))
        .returning({ id: events.id });
      result.deletedEvents += removed.length;
      await tx
        .delete(presenceSpans)
        .where(and(inArray(presenceSpans.userId, ids), lt(presenceSpans.end, cutoff)));
      await tx
        .delete(workDays)
        .where(and(inArray(workDays.userId, ids), lt(workDays.date, cutoffDate)));
      await tx
        .delete(corrections)
        .where(and(inArray(corrections.userId, ids), lt(corrections.date, cutoffDate)));
      await tx
        .delete(absences)
        .where(and(inArray(absences.userId, ids), lt(absences.date, cutoffDate)));
      await tx
        .delete(approvals)
        .where(and(inArray(approvals.userId, ids), lt(approvals.month, cutoffDate.slice(0, 7))));

      // Anonymisierte Konten nach Ablauf der Frist vollständig löschen
      for (const m of members) {
        if (m.deletedAt && m.deletedAt < cutoff) {
          await deleteUserData(tx, m.id, true);
          result.deletedUsers += 1;
        }
      }
    }

    // Gelöschte Privatkonten, die (z. B. nach Abbruch) noch Reste haben
    const leftovers = await tx
      .select({ id: users.id })
      .from(users)
      .leftJoin(organizations, eq(organizations.id, users.orgId))
      .where(
        and(
          isNotNull(users.deletedAt),
          sql`coalesce(${organizations.plan}, 'private') = 'private'`,
        ),
      );
    for (const u of leftovers) {
      await deleteUserData(tx, u.id, true);
      result.deletedUsers += 1;
    }

    // Abgelaufene Tokens
    const old = new Date(nowMs - 7 * DAY_MS);
    const rt = await tx
      .delete(refreshTokens)
      .where(lt(refreshTokens.expiresAt, old))
      .returning({ id: refreshTokens.id });
    const at = await tx
      .delete(authTokens)
      .where(lt(authTokens.expiresAt, old))
      .returning({ id: authTokens.id });
    result.deletedTokens = rt.length + at.length;
    return result;
  });
}

/** Startet den Job täglich um 03:00 UTC. */
export function schedulePurge(db: Db, log: (msg: string) => void): () => void {
  let timer: NodeJS.Timeout;
  const run = () => {
    purgeExpired(db, Date.now()).then(
      (r) => {
        log(
          `purge: ${String(r.deletedUsers)} Konten, ${String(r.deletedEvents)} Ereignisse, ${String(r.deletedTokens)} Tokens`,
        );
      },
      (err: unknown) => {
        log(`purge fehlgeschlagen: ${err instanceof Error ? err.message : 'unbekannt'}`);
      },
    );
  };
  const arm = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    timer = setTimeout(() => {
      run();
      arm();
    }, next.getTime() - now.getTime());
    timer.unref();
  };
  arm();
  return () => {
    clearTimeout(timer);
  };
}
