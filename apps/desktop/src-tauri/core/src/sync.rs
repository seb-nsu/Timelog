//! Sync-Warteschlange: sendet ungesendete Ereignisse und geänderte Spannen, mit exponentiellem Backoff.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::model::{Event, NetworkConfig, Span};
use crate::store::{Store, StoreError};

/// Höchstwerte aus `@timelog/shared` (`MAX_BATCH_EVENTS`, `presenceRequest`).
pub const MAX_BATCH_EVENTS: usize = 500;
pub const MAX_BATCH_SPANS: usize = 200;

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ApiError {
    /// Nicht erreichbar, Zeitüberschreitung oder 5xx: später erneut versuchen.
    #[error("Server nicht erreichbar: {0}")]
    Unavailable(String),
    /// Anmeldung abgelaufen oder Gerät gesperrt: Nutzer muss sich neu anmelden.
    #[error("Nicht angemeldet")]
    Unauthorized,
    /// Anfrage abgelehnt (4xx außer 401): Daten passen nicht zum Schema.
    #[error("Abgelehnt ({status}): {code}")]
    Rejected { status: u16, code: String },
}

pub trait Api {
    fn post_events(&self, events: &[Event]) -> Result<(), ApiError>;
    fn put_presence(&self, spans: &[Span]) -> Result<(), ApiError>;
    fn get_networks(&self) -> Result<NetworkConfig, ApiError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum SyncState {
    Idle,
    Ok {
        at: DateTime<Utc>,
    },
    Offline {
        failures: u32,
        retry_at: DateTime<Utc>,
    },
    NeedsLogin,
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Backoff: 30 s, 1, 2, 4 … min, höchstens 30 min.
pub fn backoff(failures: u32) -> Duration {
    let base = Duration::seconds(30);
    let max = Duration::minutes(30);
    let shift = failures.saturating_sub(1).min(16);
    (base * (1_i32 << shift)).min(max)
}

pub struct Syncer {
    failures: u32,
    retry_at: Option<DateTime<Utc>>,
    state: SyncState,
}

impl Default for Syncer {
    fn default() -> Self {
        Self::new()
    }
}

impl Syncer {
    pub fn new() -> Self {
        Self {
            failures: 0,
            retry_at: None,
            state: SyncState::Idle,
        }
    }

    pub fn state(&self) -> &SyncState {
        &self.state
    }

    /// Nach einer neuen Anmeldung oder einem Netzwechsel sofort wieder versuchen.
    pub fn reset(&mut self) {
        self.failures = 0;
        self.retry_at = None;
        if self.state == SyncState::NeedsLogin {
            self.state = SyncState::Idle;
        }
    }

    pub fn is_due(&self, now: DateTime<Utc>) -> bool {
        self.state != SyncState::NeedsLogin && self.retry_at.is_none_or(|t| now >= t)
    }

    /// Ein Durchlauf; liefert neue Arbeitsnetze, falls der Server sie geliefert hat.
    pub fn run(
        &mut self,
        store: &Store,
        api: &dyn Api,
        now: DateTime<Utc>,
    ) -> Result<Option<NetworkConfig>, SyncError> {
        if !self.is_due(now) {
            return Ok(None);
        }
        match Self::push(store, api).and_then(|()| api.get_networks().map(Some)) {
            Ok(networks) => {
                self.failures = 0;
                self.retry_at = None;
                self.state = SyncState::Ok { at: now };
                Ok(networks)
            }
            Err(ApiError::Unauthorized) => {
                self.state = SyncState::NeedsLogin;
                Ok(None)
            }
            Err(ApiError::Unavailable(_) | ApiError::Rejected { .. }) => {
                self.failures += 1;
                let retry_at = now + backoff(self.failures);
                self.retry_at = Some(retry_at);
                self.state = SyncState::Offline {
                    failures: self.failures,
                    retry_at,
                };
                Ok(None)
            }
        }
    }

    fn push(store: &Store, api: &dyn Api) -> Result<(), ApiError> {
        let local = |e: StoreError| ApiError::Unavailable(format!("lokal: {e}"));
        loop {
            let events = store.pending_events(MAX_BATCH_EVENTS).map_err(local)?;
            if events.is_empty() {
                break;
            }
            Self::send_events(store, api, &events)?;
        }
        loop {
            let spans = store.dirty_spans(MAX_BATCH_SPANS).map_err(local)?;
            if spans.is_empty() {
                break;
            }
            let body: Vec<Span> = spans.iter().map(|s| s.span.clone()).collect();
            api.put_presence(&body)?;
            store.mark_spans_synced(&spans).map_err(local)?;
        }
        Ok(())
    }

    /// Bei Ablehnung eines Pakets einzeln senden, damit ein fehlerhaftes Ereignis die Warteschlange
    /// nicht blockiert; dieses wird als abgelehnt markiert und bleibt lokal sichtbar.
    fn send_events(store: &Store, api: &dyn Api, events: &[Event]) -> Result<(), ApiError> {
        let local = |e: StoreError| ApiError::Unavailable(format!("lokal: {e}"));
        let ids = |es: &[Event]| es.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        match api.post_events(events) {
            Ok(()) => store.mark_events_synced(&ids(events)).map_err(local),
            Err(ApiError::Rejected { .. }) if events.len() > 1 => {
                for e in events {
                    Self::send_events(store, api, std::slice::from_ref(e))?;
                }
                Ok(())
            }
            Err(ApiError::Rejected { .. }) => {
                store.mark_events_rejected(&ids(events)).map_err(local)
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zustand_fuer_die_oberflaeche() {
        let at = DateTime::parse_from_rfc3339("2026-10-14T06:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let json = serde_json::to_value(SyncState::Offline {
            failures: 2,
            retry_at: at,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "state": "offline", "failures": 2, "retryAt": "2026-10-14T06:00:00Z" })
        );
        assert_eq!(
            serde_json::to_value(SyncState::NeedsLogin).unwrap(),
            serde_json::json!({ "state": "needsLogin" })
        );
    }

    #[test]
    fn backoff_verdoppelt_bis_30_minuten() {
        assert_eq!(backoff(1), Duration::seconds(30));
        assert_eq!(backoff(2), Duration::minutes(1));
        assert_eq!(backoff(3), Duration::minutes(2));
        assert_eq!(backoff(7), Duration::minutes(30));
        assert_eq!(backoff(100), Duration::minutes(30));
    }
}
