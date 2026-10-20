//! Kern des Desktop-Clients ohne Tauri- und Betriebssystem-Abhängigkeiten.
//!
//! Der Kern erzeugt nur Ereignisse und Aktiv-Spannen; die Arbeitszeit berechnet ausschließlich
//! `@timelog/rules` (in der Oberfläche und im Backend).

pub mod http;
pub mod model;
pub mod network;
pub mod shutdown;
pub mod store;
pub mod sync;
pub mod system;
pub mod tracker;

pub use model::{Event, EventType, NetworkConfig, Source, Span};
pub use store::Store;
pub use sync::{Api, ApiError, SyncState, Syncer};
pub use system::{Envelope, FakeSystem, NetworkInfo, PowerOff, Signal, SignalSink, SystemEvents};
pub use tracker::{Tracker, TrackerConfig, TrackerError, TrackerStatus};
