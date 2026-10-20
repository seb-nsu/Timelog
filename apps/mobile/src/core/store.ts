// Lokale Warteschlange und Zwischenspeicher (SQLite). Ereignisse werden nur eingefügt, nie
// geändert – außer ihrem Übertragungsstatus. Eigene Ereignisse haben device_id NULL (= dieses Gerät).
import type { DeviceData, LocalEvent } from '@timelog/app-core';
import type { DeviceKind, EventFlag, EventSource, EventType } from '@timelog/rules';

export type SqlValue = string | number | null;

/** Teilmenge von expo-sqlite (SQLiteDatabase), in Tests über node:sqlite nachgebildet. */
export interface SqlDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: SqlValue[]): Promise<unknown>;
  getAllAsync<T>(sql: string, params: SqlValue[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export type EventStatus = 'pending' | 'synced' | 'rejected';

export interface QueuedEvent extends LocalEvent {
  status: EventStatus;
}

export interface RemoteEvent extends LocalEvent {
  deviceId: string;
}

export interface SpanRecord {
  id: string;
  start: string;
  end: string;
  open: boolean;
}

export interface RemoteSpan extends SpanRecord {
  deviceId: string;
  deviceKind: DeviceKind;
}

/** Ungesendete Spanne mit Stand, damit eine zwischenzeitliche Verlängerung nicht verloren geht. */
export interface DirtySpan extends SpanRecord {
  rev: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  end_ts TEXT,
  tz TEXT NOT NULL,
  network_id TEXT,
  ref_event_id TEXT,
  created_at TEXT NOT NULL,
  flags TEXT,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts_ms);
CREATE INDEX IF NOT EXISTS events_status ON events (status);
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  device_kind TEXT NOT NULL,
  start TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  "end" TEXT NOT NULL,
  end_ms INTEGER NOT NULL,
  open INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  synced_rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS spans_end ON spans (end_ms);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

interface EventRow {
  id: string;
  device_id: string | null;
  type: EventType;
  source: EventSource;
  ts: string;
  end_ts: string | null;
  tz: string;
  network_id: string | null;
  ref_event_id: string | null;
  created_at: string;
  flags: string | null;
  status: EventStatus;
}

interface SpanRow {
  id: string;
  device_id: string | null;
  device_kind: DeviceKind;
  start: string;
  end: string;
  open: number;
  rev: number;
}

function toEvent(r: EventRow): QueuedEvent {
  const e: QueuedEvent = {
    id: r.id,
    type: r.type,
    source: r.source,
    ts: r.ts,
    tz: r.tz,
    createdAt: r.created_at,
    status: r.status,
  };
  if (r.end_ts) e.endTs = r.end_ts;
  if (r.network_id) e.networkId = r.network_id;
  if (r.ref_event_id) e.refEventId = r.ref_event_id;
  if (r.flags) e.flags = JSON.parse(r.flags) as EventFlag[];
  return e;
}

/** Ereignis ohne lokalen Übertragungsstatus, z. B. zum Senden. */
export function withoutStatus(e: QueuedEvent): LocalEvent {
  const copy: Partial<QueuedEvent> = { ...e };
  delete copy.status;
  return copy as LocalEvent;
}

const ms = (iso: string) => Date.parse(iso);
const iso = (value: string) => new Date(value).toISOString();

export class Store {
  private constructor(private readonly db: SqlDatabase) {}

  static async open(db: SqlDatabase): Promise<Store> {
    await db.execAsync(SCHEMA);
    return new Store(db);
  }

  // ── Ereignisse ──────────────────────────────────────────────────────────────

  /** Eigenes Ereignis anlegen; eine schon bekannte ID wird ignoriert (idempotent). */
  async addEvent(e: LocalEvent): Promise<boolean> {
    const before = await this.db.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM events WHERE id = ?',
      [e.id],
    );
    if ((before[0]?.n ?? 0) > 0) return false;
    await this.insert(e, null, 'pending');
    return true;
  }

  private async insert(e: LocalEvent, deviceId: string | null, status: EventStatus) {
    await this.db.runAsync(
      `INSERT OR IGNORE INTO events
        (id, device_id, type, source, ts, ts_ms, end_ts, tz, network_id, ref_event_id, created_at, flags, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id,
        deviceId,
        e.type,
        e.source,
        iso(e.ts),
        ms(e.ts),
        e.endTs ? iso(e.endTs) : null,
        e.tz,
        e.networkId ?? null,
        e.refEventId ?? null,
        iso(e.createdAt),
        e.flags && e.flags.length > 0 ? JSON.stringify(e.flags) : null,
        status,
      ],
    );
  }

  /** Eigenes Ereignis, das der Server bereits angelegt hat (z. B. Korrektur per PATCH). */
  async addSyncedEvent(e: LocalEvent): Promise<void> {
    await this.insert(e, null, 'synced');
  }

  /** Ereignisse vom Server (alle Geräte). Eigene, schon bekannte bleiben unverändert. */
  async addRemoteEvents(events: RemoteEvent[], ownDeviceId: string | null): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const e of events) {
        const own = e.deviceId === ownDeviceId;
        await this.insert(e, own ? null : e.deviceId, 'synced');
        if (own) {
          await this.db.runAsync(
            "UPDATE events SET status = 'synced' WHERE id = ? AND status = 'pending'",
            [e.id],
          );
        }
      }
    });
  }

  async pendingEvents(limit: number): Promise<QueuedEvent[]> {
    const rows = await this.db.getAllAsync<EventRow>(
      "SELECT * FROM events WHERE status = 'pending' ORDER BY ts_ms, id LIMIT ?",
      [limit],
    );
    return rows.map(toEvent);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.db.getAllAsync<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM events WHERE status = 'pending') +
              (SELECT COUNT(*) FROM spans WHERE device_id IS NULL AND rev > synced_rev) AS n`,
      [],
    );
    return rows[0]?.n ?? 0;
  }

  async markEvents(ids: string[], status: EventStatus): Promise<void> {
    if (ids.length === 0) return;
    await this.db.runAsync(
      `UPDATE events SET status = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      [status, ...ids],
    );
  }

  async rejectedEvents(): Promise<QueuedEvent[]> {
    const rows = await this.db.getAllAsync<EventRow>(
      "SELECT * FROM events WHERE status = 'rejected' ORDER BY ts_ms",
      [],
    );
    return rows.map(toEvent);
  }

  // ── Aktiv-Spannen ───────────────────────────────────────────────────────────

  /** Eigene Spanne anlegen oder verlängern; markiert sie zum Senden. */
  async upsertOwnSpan(span: SpanRecord): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO spans (id, device_id, device_kind, start, start_ms, "end", end_ms, open, rev, synced_rev)
       VALUES (?, NULL, 'mobile', ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         "end" = excluded."end", end_ms = excluded.end_ms, open = excluded.open, rev = spans.rev + 1
       WHERE spans."end" <> excluded."end" OR spans.open <> excluded.open`,
      [span.id, iso(span.start), ms(span.start), iso(span.end), ms(span.end), span.open ? 1 : 0],
    );
  }

  async addRemoteSpans(spans: RemoteSpan[], ownDeviceId: string | null): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const s of spans) {
        if (s.deviceId === ownDeviceId) continue; // eigene Spannen sind lokal maßgeblich
        await this.db.runAsync(
          `INSERT INTO spans (id, device_id, device_kind, start, start_ms, "end", end_ms, open, rev, synced_rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
           ON CONFLICT(id) DO UPDATE SET "end" = excluded."end", end_ms = excluded.end_ms, open = excluded.open`,
          [
            s.id,
            s.deviceId,
            s.deviceKind,
            iso(s.start),
            ms(s.start),
            iso(s.end),
            ms(s.end),
            s.open ? 1 : 0,
          ],
        );
      }
    });
  }

  async dirtySpans(limit: number): Promise<DirtySpan[]> {
    const rows = await this.db.getAllAsync<SpanRow>(
      'SELECT * FROM spans WHERE device_id IS NULL AND rev > synced_rev ORDER BY start_ms LIMIT ?',
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      start: r.start,
      end: r.end,
      open: r.open === 1,
      rev: r.rev,
    }));
  }

  async markSpansSynced(spans: DirtySpan[]): Promise<void> {
    for (const s of spans) {
      await this.db.runAsync('UPDATE spans SET synced_rev = MAX(synced_rev, ?) WHERE id = ?', [
        s.rev,
        s.id,
      ]);
    }
  }

  /** Offene eigene Spanne (höchstens eine). */
  async openOwnSpan(): Promise<SpanRecord | undefined> {
    const rows = await this.db.getAllAsync<SpanRow>(
      'SELECT * FROM spans WHERE device_id IS NULL AND open = 1 ORDER BY start_ms DESC LIMIT 1',
      [],
    );
    const r = rows[0];
    return r ? { id: r.id, start: r.start, end: r.end, open: true } : undefined;
  }

  // ── Abfrage für das Regelwerk ───────────────────────────────────────────────

  /** Alle Ereignisse und Spannen im Zeitraum, eigene mit `ownDeviceId`. Abgelehnte fehlen. */
  async deviceData(fromIso: string, toIso: string, ownDeviceId: string): Promise<DeviceData> {
    const [events, spans] = await Promise.all([
      this.db.getAllAsync<EventRow>(
        "SELECT * FROM events WHERE ts_ms >= ? AND ts_ms < ? AND status <> 'rejected' ORDER BY ts_ms",
        [ms(fromIso), ms(toIso)],
      ),
      this.db.getAllAsync<SpanRow>(
        'SELECT * FROM spans WHERE end_ms >= ? AND start_ms < ? ORDER BY start_ms',
        [ms(fromIso), ms(toIso)],
      ),
    ]);
    return {
      events: events.map((r) => ({
        ...withoutStatus(toEvent(r)),
        deviceId: r.device_id ?? ownDeviceId,
      })),
      spans: spans.map((r) => ({
        id: r.id,
        deviceId: r.device_id ?? ownDeviceId,
        deviceKind: r.device_kind,
        start: r.start,
        end: r.end,
        open: r.open === 1,
      })),
    };
  }

  // ── Schlüssel/Wert ──────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | undefined> {
    const rows = await this.db.getAllAsync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      [key],
    );
    const row = rows[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(value)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.runAsync('DELETE FROM kv WHERE key = ?', [key]);
  }

  /** Daten anderer Geräte entfernen (Abmelden); eigene ungesendete bleiben erhalten. */
  async clearRemote(): Promise<void> {
    await this.db.execAsync(
      "DELETE FROM events WHERE device_id IS NOT NULL; DELETE FROM spans WHERE device_id IS NOT NULL; DELETE FROM kv WHERE key LIKE 'cursor.%';",
    );
  }

  /** Alles löschen (Konto gelöscht). */
  async wipe(): Promise<void> {
    await this.db.execAsync('DELETE FROM events; DELETE FROM spans; DELETE FROM kv;');
  }
}
