// Abruf und Speicherung von Kalenderterminen. Gespeichert werden nur Beginn, Ende, Art
// (beschäftigt/abwesend, ganztägig) und das per Stichwort erkannte Projekt. Titel bleiben im Speicher
// dieses Abrufs und werden weder gespeichert noch protokolliert.
import { addDays, localDate, matchProject } from '@timelog/rules';
import type { CalendarProviderId } from '@timelog/shared';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { asSystem, withUser } from '../db/index.js';
import { calendarConnections, calendarEntries, projects, users } from '../db/schema.js';
import { featuresOf } from '../features.js';
import { decrypt, encrypt } from '../security/crypto.js';
import {
  CalendarError,
  type CalendarProvider,
  type ClientCredentials,
  googleProvider,
  microsoftProvider,
} from './providers.js';

export interface CalendarOptions {
  google?: ClientCredentials;
  microsoft?: ClientCredentials & { tenant: string };
  /** fetch für Anbieter-Aufrufe (Tests: gefakte Anbieter-APIs) */
  fetch?: typeof fetch;
  /** Rückblick und Vorschau des Abrufs in Tagen */
  pastDays?: number;
  futureDays?: number;
}

const MAX_ENTRIES = 5000;

export class CalendarService {
  private readonly providers = new Map<CalendarProviderId, CalendarProvider>();
  readonly pastDays: number;
  readonly futureDays: number;

  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    options: CalendarOptions = {},
  ) {
    const f = options.fetch ?? fetch;
    if (options.google) this.providers.set('google', googleProvider(options.google, f));
    if (options.microsoft) this.providers.set('microsoft', microsoftProvider(options.microsoft, f));
    this.pastDays = options.pastDays ?? 35;
    this.futureDays = options.futureDays ?? 60;
  }

  provider(id: CalendarProviderId): CalendarProvider | undefined {
    return this.providers.get(id);
  }

  sealToken(token: string): string {
    return encrypt(token, this.key);
  }

  openToken(sealed: string): string {
    return decrypt(sealed, this.key);
  }

  /** Ruft die Termine einer Verbindung ab und ersetzt die gespeicherten im Abruf-Zeitraum. */
  async sync(userId: string, providerId: CalendarProviderId, nowMs: number): Promise<number> {
    const provider = this.provider(providerId);
    if (!provider) throw new CalendarError('not_configured');
    const [user] = await asSystem(this.db, (tx) =>
      tx.select().from(users).where(eq(users.id, userId)),
    );
    if (!user || user.deletedAt) throw new CalendarError('not_found');
    const scope = { userId, orgId: user.orgId };

    const loaded = await withUser(this.db, scope, async (tx) => {
      const [conn] = await tx
        .select()
        .from(calendarConnections)
        .where(
          and(eq(calendarConnections.userId, userId), eq(calendarConnections.provider, providerId)),
        );
      if (!conn) return undefined;
      const features = await featuresOf(tx, user);
      const visible = features.projects
        ? await tx
            .select({ id: projects.id, keywords: projects.keywords, teamId: projects.teamId })
            .from(projects)
            .where(
              and(
                isNull(projects.archivedAt),
                user.orgId
                  ? or(eq(projects.userId, userId), eq(projects.orgId, user.orgId))
                  : eq(projects.userId, userId),
              ),
            )
        : [];
      const kw = visible.filter(
        (p) => p.keywords.length > 0 && (p.teamId === null || p.teamId === user.teamId),
      );
      return { conn, kw };
    });
    if (!loaded) throw new CalendarError('not_found');
    const { conn, kw } = loaded;

    const today = localDate(nowMs, user.timezone);
    const from = new Date(`${addDays(today, -this.pastDays)}T00:00:00Z`);
    const to = new Date(`${addDays(today, this.futureDays)}T00:00:00Z`);
    let tokens;
    let raw;
    try {
      tokens = await provider.refresh(this.openToken(conn.refreshToken));
      raw = await provider.list(tokens.accessToken, from, to, user.timezone);
    } catch (err) {
      const code = err instanceof CalendarError ? err.code : 'sync_failed';
      await withUser(this.db, scope, (tx) =>
        tx
          .update(calendarConnections)
          .set({ status: 'error', lastError: code })
          .where(eq(calendarConnections.id, conn.id)),
      );
      throw err instanceof CalendarError ? err : new CalendarError(code);
    }

    const rows = raw
      .filter((e) => Date.parse(e.end) > Date.parse(e.start))
      .slice(0, MAX_ENTRIES)
      .map((e) => ({
        userId,
        connectionId: conn.id,
        startAt: new Date(e.start),
        endAt: new Date(e.end),
        allDay: e.allDay,
        startDate: e.startDate ?? null,
        endDate: e.endDate ?? null,
        kind: e.kind,
        // Titel nur flüchtig für den Abgleich; gespeichert wird höchstens die Projekt-ID
        projectId: e.kind === 'busy' && kw.length > 0 ? matchProject(e.title, kw) : null,
      }));

    await withUser(this.db, scope, async (tx) => {
      await tx.delete(calendarEntries).where(
        and(
          eq(calendarEntries.connectionId, conn.id),
          // überlappend wie die Abfrage beim Anbieter, sonst doppelte mehrtägige Einträge
          gt(calendarEntries.endAt, from),
          lt(calendarEntries.startAt, to),
        ),
      );
      if (rows.length > 0) await tx.insert(calendarEntries).values(rows);
      await tx
        .update(calendarConnections)
        .set({
          status: 'active',
          lastError: null,
          lastSyncAt: new Date(nowMs),
          ...(tokens.refreshToken ? { refreshToken: this.sealToken(tokens.refreshToken) } : {}),
        })
        .where(eq(calendarConnections.id, conn.id));
    });
    return rows.length;
  }

  /** Alle aktiven Verbindungen abrufen (periodischer Job). Fehler einzelner Verbindungen zählen nur. */
  async syncAll(nowMs: number): Promise<{ ok: number; failed: number }> {
    const conns = await asSystem(this.db, (tx) =>
      tx
        .select({ userId: calendarConnections.userId, provider: calendarConnections.provider })
        .from(calendarConnections)
        .where(eq(calendarConnections.status, 'active')),
    );
    const result = { ok: 0, failed: 0 };
    for (const c of conns) {
      try {
        await this.sync(c.userId, c.provider, nowMs);
        result.ok += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }
}

/** Startet den periodischen Abruf; liefert eine Stopp-Funktion. */
export function scheduleCalendarSync(
  service: CalendarService,
  intervalMin: number,
  log: (msg: string) => void,
): () => void {
  const timer = setInterval(
    () => {
      service.syncAll(Date.now()).then(
        (r) => {
          log(`calendar sync: ${String(r.ok)} ok, ${String(r.failed)} fehlgeschlagen`);
        },
        () => {
          log('calendar sync fehlgeschlagen');
        },
      );
    },
    Math.max(5, intervalMin) * 60_000,
  );
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
