//! Laufzeit: Tracker, Sync und Anmeldung, geteilt zwischen Hintergrund-Thread und Befehlen.

use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use timelog_core::http::{HttpApi, Tokens};
use timelog_core::{Signal, Store, SyncState, Syncer, Tracker, TrackerConfig};

const KEY_AUTH: &str = "auth";
/// Zeitgrenze für normale Anfragen und für den Sende-Versuch beim Herunterfahren.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// Alle 2 min: Spanne verlängern und synchronisieren.
pub const TICK: Duration = Duration::from_mins(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAuth {
    base_url: String,
    tokens: Tokens,
}

pub struct Runtime {
    pub tracker: Mutex<Tracker>,
    /// Eigene Verbindung zur selben Datenbank, damit Netzwerkzugriffe den Tracker nicht blockieren.
    sync_store: Mutex<Store>,
    syncer: Mutex<Syncer>,
    api: Mutex<Option<HttpApi>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Runtime {
    pub fn open(db: &Path, signals: Sender<Signal>) -> Result<Self, String> {
        let store = Store::open(db).map_err(|e| e.to_string())?;
        let auth: Option<StoredAuth> = store.get(KEY_AUTH).map_err(|e| e.to_string())?;
        let api = auth.map(|a| HttpApi::new(&a.base_url, a.tokens, REQUEST_TIMEOUT));
        let mut system = crate::platform::system();
        system.watch(signals);
        let tracker = Tracker::start(store, system, TrackerConfig::default(), Utc::now())
            .map_err(|e| e.to_string())?;
        Ok(Self {
            tracker: Mutex::new(tracker),
            sync_store: Mutex::new(Store::open(db).map_err(|e| e.to_string())?),
            syncer: Mutex::new(Syncer::new()),
            api: Mutex::new(api),
        })
    }

    pub fn tracker(&self) -> MutexGuard<'_, Tracker> {
        lock(&self.tracker)
    }

    pub fn api(&self) -> Option<HttpApi> {
        lock(&self.api).clone()
    }

    pub fn sync_state(&self) -> SyncState {
        lock(&self.syncer).state().clone()
    }

    pub fn set_api(&self, api: Option<HttpApi>) -> Result<(), String> {
        let store = lock(&self.sync_store);
        match &api {
            Some(a) => store
                .set(
                    KEY_AUTH,
                    &StoredAuth {
                        base_url: a.base_url().to_owned(),
                        tokens: a.tokens(),
                    },
                )
                .map_err(|e| e.to_string())?,
            None => store.remove(KEY_AUTH).map_err(|e| e.to_string())?,
        }
        drop(store);
        *lock(&self.api) = api;
        lock(&self.syncer).reset();
        Ok(())
    }

    /// Speichert erneuerte Tokens, damit sie einen Neustart überleben.
    pub fn persist_tokens(&self) {
        if let Some(api) = self.api() {
            let store = lock(&self.sync_store);
            let stored: Option<StoredAuth> = store.get(KEY_AUTH).ok().flatten();
            if stored.as_ref().map(|s| &s.tokens) != Some(&api.tokens()) {
                let _ = store.set(
                    KEY_AUTH,
                    &StoredAuth {
                        base_url: api.base_url().to_owned(),
                        tokens: api.tokens(),
                    },
                );
            }
        }
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        lock(&self.sync_store).get(key).map_err(|e| e.to_string())
    }

    pub fn kv_set(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        lock(&self.sync_store)
            .set(key, value)
            .map_err(|e| e.to_string())
    }

    pub fn pending(&self) -> u64 {
        let store = lock(&self.sync_store);
        store.pending_event_count().unwrap_or(0) + store.dirty_span_count().unwrap_or(0)
    }

    /// Ein Sync-Durchlauf, falls angemeldet und fällig. `force` ignoriert den Backoff.
    pub fn sync(&self, force: bool, timeout: Option<Duration>) {
        let Some(api) = self.api() else { return };
        let api = timeout.map_or_else(|| api.clone(), |t| api.with_timeout(t));
        let now = Utc::now();
        let networks = {
            let mut syncer = lock(&self.syncer);
            if force {
                syncer.reset();
            }
            let store = lock(&self.sync_store);
            syncer.run(&store, &api, now).ok().flatten()
        };
        if let Some(networks) = networks {
            let _ = self.tracker().set_networks(&networks, now);
        }
        self.persist_tokens();
    }

    /// Hintergrund-Schleife: Signale verarbeiten, im Takt verlängern und synchronisieren.
    pub fn run(&self, signals: &Receiver<Signal>, on_change: &dyn Fn()) {
        loop {
            match signals.recv_timeout(TICK) {
                Ok(signal) => {
                    let now = Utc::now();
                    let _ = self.tracker().handle(&signal, now);
                    match signal {
                        // Fire-and-forget: kurzer Sende-Versuch, sonst beim nächsten Start.
                        Signal::PowerOff(_) => self.sync(true, Some(SHUTDOWN_TIMEOUT)),
                        Signal::NetworkChanged | Signal::Resume => self.sync(true, None),
                        _ => {}
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    let _ = self.tracker().tick(Utc::now());
                    self.sync(false, None);
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
            on_change();
        }
    }
}
