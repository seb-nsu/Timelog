//! Schnittstelle zu den Betriebssystem-Ereignissen. Windows und macOS implementieren sie in
//! Phase 3b/3c; Tests nutzen [`FakeSystem`].

use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};

/// Signal des Betriebssystems an den Tracker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// Standby, Ruhezustand oder Deckel zu.
    Suspend,
    /// Aufwachen aus Standby oder Ruhezustand – **kein** `boot`.
    Resume,
    /// Bildschirm gesperrt.
    Lock,
    /// Bildschirm entsperrt.
    Unlock,
    /// Echtes Herunterfahren bzw. Neustart. Logout erzeugt kein Signal.
    PowerOff(PowerOff),
    /// Netzwerk hat gewechselt; der Tracker fragt [`SystemEvents::current_network`] ab.
    NetworkChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerOff {
    Shutdown,
    Restart,
    /// Neustart durch ein Betriebssystem-Update (längeres Neustart-Fenster).
    UpdateRestart,
}

/// Aktuelle Netzwerk-Merkmale. Bleiben auf dem Gerät; gesendet wird nur die ID eines
/// hinterlegten Arbeitsnetzes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkInfo {
    /// Netzwerk-Kennung (`gw=<MAC des Gateways>`, siehe [`crate::network::gateway_fingerprint`]),
    /// ohne Standortberechtigung.
    pub fingerprint: Option<String>,
    /// WLAN-Name, nur mit Freigabe des Nutzers.
    pub ssid: Option<String>,
    pub bssid: Option<String>,
    /// Verbindung per Kabel (Quelle `lan`) statt WLAN (`wifi`).
    pub wired: bool,
}

/// Ein Signal mit optionaler Quittung: der Empfänger meldet, sobald es verarbeitet ist.
pub type Envelope = (Signal, Option<SyncSender<()>>);

/// Ausgang für Signale an die Laufzeit.
#[derive(Debug, Clone)]
pub struct SignalSink {
    tx: Sender<Envelope>,
}

impl SignalSink {
    pub fn channel() -> (Self, Receiver<Envelope>) {
        let (tx, rx) = mpsc::channel();
        (Self { tx }, rx)
    }

    /// Sendet ohne zu warten. `false`, wenn die Laufzeit beendet ist.
    pub fn send(&self, signal: Signal) -> bool {
        self.tx.send((signal, None)).is_ok()
    }

    /// Sendet und wartet höchstens `timeout`, bis das Signal verarbeitet ist. Für das
    /// Herunterfahren: das System darf die App erst danach beenden.
    pub fn send_and_wait(&self, signal: Signal, timeout: Duration) -> bool {
        let (ack_tx, ack_rx) = mpsc::sync_channel(1);
        self.tx.send((signal, Some(ack_tx))).is_ok() && ack_rx.recv_timeout(timeout).is_ok()
    }
}

pub trait SystemEvents: Send {
    /// Echte Einschaltzeit des Rechners (nicht die Aufwachzeit).
    fn boot_time(&self) -> DateTime<Utc>;
    /// Aktuelle IANA-Zeitzone des Systems.
    fn timezone(&self) -> String;
    fn current_network(&self) -> NetworkInfo;
    /// Startet die Überwachung; Signale gehen an `sink`.
    fn watch(&mut self, sink: SignalSink);
}

/// Test-Attrappe: Werte werden von außen gesetzt, Signale per [`FakeHandle::emit`] ausgelöst.
pub struct FakeSystem {
    state: Arc<Mutex<FakeState>>,
}

#[derive(Debug, Clone)]
struct FakeState {
    boot_time: DateTime<Utc>,
    timezone: String,
    network: NetworkInfo,
    sink: Option<SignalSink>,
}

#[derive(Clone)]
pub struct FakeHandle {
    state: Arc<Mutex<FakeState>>,
}

impl FakeSystem {
    pub fn new(boot_time: DateTime<Utc>, timezone: &str) -> (Self, FakeHandle) {
        let state = Arc::new(Mutex::new(FakeState {
            boot_time,
            timezone: timezone.to_owned(),
            network: NetworkInfo::default(),
            sink: None,
        }));
        (
            Self {
                state: Arc::clone(&state),
            },
            FakeHandle { state },
        )
    }

    fn read<T>(&self, f: impl FnOnce(&FakeState) -> T) -> T {
        f(&self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl FakeHandle {
    fn write(&self, f: impl FnOnce(&mut FakeState)) {
        f(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner));
    }

    pub fn set_boot_time(&self, t: DateTime<Utc>) {
        self.write(|s| s.boot_time = t);
    }

    pub fn set_timezone(&self, tz: &str) {
        self.write(|s| tz.clone_into(&mut s.timezone));
    }

    pub fn set_network(&self, network: NetworkInfo) {
        self.write(|s| s.network = network);
    }

    /// Sendet ein Signal an den mit `watch` registrierten Empfänger.
    pub fn emit(&self, signal: Signal) -> bool {
        let sink = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sink
            .clone();
        sink.is_some_and(|s| s.send(signal))
    }
}

impl SystemEvents for FakeSystem {
    fn boot_time(&self) -> DateTime<Utc> {
        self.read(|s| s.boot_time)
    }

    fn timezone(&self) -> String {
        self.read(|s| s.timezone.clone())
    }

    fn current_network(&self) -> NetworkInfo {
        self.read(|s| s.network.clone())
    }

    fn watch(&mut self, sink: SignalSink) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sink = Some(sink);
    }
}
