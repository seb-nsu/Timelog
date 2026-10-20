//! Lokale SQLite-Datenbank. Ereignisse werden sofort und synchron geschrieben (Offline-first).

use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use crate::model::{Event, Span};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("SQLite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Sync-Zustand eines Ereignisses.
const PENDING: i64 = 0;
const SYNCED: i64 = 1;
/// Vom Server dauerhaft abgelehnt (400); bleibt lokal sichtbar, wird nicht erneut gesendet.
const REJECTED: i64 = 2;

pub struct Store {
    conn: Connection,
}

/// Offene Spanne mit Versionszähler; nur unveränderte Versionen werden als übertragen markiert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpanRev {
    pub span: Span,
    pub rev: i64,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        // WAL + FULL: ein Ereignis ist nach dem Schreiben auch bei Stromausfall sicher.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                ts TEXT NOT NULL,
                body TEXT NOT NULL,
                sync INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
            CREATE INDEX IF NOT EXISTS events_sync ON events(sync);
            CREATE TABLE IF NOT EXISTS spans (
                id TEXT PRIMARY KEY,
                start TEXT NOT NULL,
                end TEXT NOT NULL,
                open INTEGER NOT NULL,
                rev INTEGER NOT NULL DEFAULT 1,
                synced_rev INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS spans_end ON spans(end);
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;
        Ok(Self { conn })
    }

    // ── Ereignisse (nur Insert) ─────────────────────────────────────────────

    pub fn insert_event(&self, event: &Event) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO events (id, ts, body) VALUES (?1, ?2, ?3)",
            params![event.id, iso(event.ts), serde_json::to_string(event)?],
        )?;
        Ok(())
    }

    pub fn pending_events(&self, limit: usize) -> Result<Vec<Event>> {
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM events WHERE sync = ?1 ORDER BY seq LIMIT ?2")?;
        let rows = stmt.query_map(params![PENDING, limit_i64(limit)], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn pending_event_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT count(*) FROM events WHERE sync = ?1", [PENDING], |r| r.get(0))?;
        Ok(u64::try_from(n).unwrap_or(0))
    }

    pub fn mark_events_synced(&self, ids: &[String]) -> Result<()> {
        self.set_event_sync(ids, SYNCED)
    }

    pub fn mark_events_rejected(&self, ids: &[String]) -> Result<()> {
        self.set_event_sync(ids, REJECTED)
    }

    fn set_event_sync(&self, ids: &[String], state: i64) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for id in ids {
            tx.execute("UPDATE events SET sync = ?1 WHERE id = ?2", params![state, id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Ereignisse mit `from <= ts < to`, chronologisch.
    pub fn events_between(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<Event>> {
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM events WHERE ts >= ?1 AND ts < ?2 ORDER BY ts, seq")?;
        let rows = stmt.query_map(params![iso(from), iso(to)], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    /// Zuletzt geschriebenes Ereignis eines Typs.
    pub fn last_event(&self, kinds: &[crate::model::EventType]) -> Result<Option<Event>> {
        let mut stmt = self.conn.prepare("SELECT body FROM events ORDER BY ts DESC, seq DESC")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let event: Event = serde_json::from_str(&row.get::<_, String>(0)?)?;
            if kinds.contains(&event.kind) {
                return Ok(Some(event));
            }
        }
        Ok(None)
    }

    // ── Aktiv-Spannen ───────────────────────────────────────────────────────

    pub fn upsert_span(&self, span: &Span) -> Result<()> {
        self.conn.execute(
            "INSERT INTO spans (id, start, end, open) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET start = ?2, end = ?3, open = ?4, rev = rev + 1",
            params![span.id, iso(span.start), iso(span.end), span.open],
        )?;
        Ok(())
    }

    pub fn open_spans(&self) -> Result<Vec<Span>> {
        self.spans_where("open = 1", &[])
    }

    pub fn spans_between(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<Span>> {
        let (from, to) = (iso(from), iso(to));
        self.spans_where("end >= ?1 AND start < ?2", &[&from, &to])
    }

    fn spans_where(&self, cond: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Span>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT id, start, end, open FROM spans WHERE {cond} ORDER BY start"))?;
        let rows = stmt.query_map(args, row_to_span)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn dirty_spans(&self, limit: usize) -> Result<Vec<SpanRev>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, start, end, open, rev FROM spans WHERE rev > synced_rev ORDER BY start LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit_i64(limit)], |r| Ok(SpanRev { span: row_to_span(r)?, rev: r.get(4)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn mark_spans_synced(&self, spans: &[SpanRev]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for s in spans {
            tx.execute(
                "UPDATE spans SET synced_rev = max(synced_rev, ?1) WHERE id = ?2",
                params![s.rev, s.span.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn dirty_span_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT count(*) FROM spans WHERE rev > synced_rev", [], |r| r.get(0))?;
        Ok(u64::try_from(n).unwrap_or(0))
    }

    /// Löscht übertragene Daten vor `before` (lokaler Speicher bleibt klein).
    pub fn prune(&self, before: DateTime<Utc>) -> Result<()> {
        let before = iso(before);
        self.conn
            .execute("DELETE FROM events WHERE sync <> ?1 AND ts < ?2", params![PENDING, before])?;
        self.conn.execute(
            "DELETE FROM spans WHERE open = 0 AND rev <= synced_rev AND end < ?1",
            params![before],
        )?;
        Ok(())
    }

    // ── Schlüssel/Wert ──────────────────────────────────────────────────────

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        raw.map(|v| serde_json::from_str(&v)).transpose().map_err(Into::into)
    }

    pub fn set<T: Serialize + ?Sized>(&self, key: &str, value: &T) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn remove(&self, key: &str) -> Result<()> {
        self.conn.execute("DELETE FROM kv WHERE key = ?1", [key])?;
        Ok(())
    }
}

/// Feste Breite (Millisekunden, `Z`), damit Textvergleich = Zeitvergleich.
fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse(s: &str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

fn row_to_span(r: &rusqlite::Row<'_>) -> rusqlite::Result<Span> {
    Ok(Span {
        id: r.get(0)?,
        start: parse(&r.get::<_, String>(1)?)?,
        end: parse(&r.get::<_, String>(2)?)?,
        open: r.get(3)?,
    })
}

fn limit_i64(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EventType, Source};
    use chrono::TimeZone;

    fn t(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 14, h, m, 0).unwrap()
    }

    #[test]
    fn ereignisse_nur_einmal_und_sync_status() {
        let store = Store::in_memory().unwrap();
        let e = Event::new(EventType::Boot, Source::System, t(6, 0), "Europe/Berlin", t(6, 5));
        store.insert_event(&e).unwrap();
        store.insert_event(&e).unwrap();
        assert_eq!(store.pending_event_count().unwrap(), 1);
        assert_eq!(store.pending_events(10).unwrap(), vec![e.clone()]);
        store.mark_events_synced(std::slice::from_ref(&e.id)).unwrap();
        assert_eq!(store.pending_event_count().unwrap(), 0);
        assert_eq!(store.events_between(t(0, 0), t(23, 0)).unwrap(), vec![e.clone()]);
        assert_eq!(store.last_event(&[EventType::Boot]).unwrap(), Some(e));
        assert_eq!(store.last_event(&[EventType::Shutdown]).unwrap(), None);
    }

    #[test]
    fn spannen_werden_nur_mit_unveraenderter_version_als_uebertragen_markiert() {
        let store = Store::in_memory().unwrap();
        let mut span = Span::open_at(t(6, 0));
        store.upsert_span(&span).unwrap();
        let dirty = store.dirty_spans(10).unwrap();
        assert_eq!(dirty.len(), 1);
        // Zwischen Lesen und Bestätigen verlängert
        span.end = t(6, 2);
        store.upsert_span(&span).unwrap();
        store.mark_spans_synced(&dirty).unwrap();
        assert_eq!(store.dirty_span_count().unwrap(), 1);
        let again = store.dirty_spans(10).unwrap();
        assert_eq!(again[0].span.end, t(6, 2));
        store.mark_spans_synced(&again).unwrap();
        assert_eq!(store.dirty_span_count().unwrap(), 0);
        assert_eq!(store.open_spans().unwrap(), vec![span.clone()]);
        assert_eq!(store.spans_between(t(6, 1), t(7, 0)).unwrap(), vec![span]);
        assert!(store.spans_between(t(7, 0), t(8, 0)).unwrap().is_empty());
    }

    #[test]
    fn prune_behaelt_offene_und_ungesendete_daten() {
        let store = Store::in_memory().unwrap();
        let old = Event::new(EventType::Boot, Source::System, t(1, 0), "UTC", t(1, 0));
        let pending = Event::new(EventType::Shutdown, Source::System, t(2, 0), "UTC", t(2, 0));
        store.insert_event(&old).unwrap();
        store.insert_event(&pending).unwrap();
        store.mark_events_synced(std::slice::from_ref(&old.id)).unwrap();
        store.prune(t(12, 0)).unwrap();
        assert_eq!(store.events_between(t(0, 0), t(23, 0)).unwrap(), vec![pending]);
    }

    #[test]
    fn schluessel_wert() {
        let store = Store::in_memory().unwrap();
        assert_eq!(store.get::<String>("x").unwrap(), None);
        store.set("x", "a").unwrap();
        store.set("x", "b").unwrap();
        assert_eq!(store.get::<String>("x").unwrap(), Some("b".into()));
        store.remove("x").unwrap();
        assert_eq!(store.get::<String>("x").unwrap(), None);
    }
}
