//! Plattform-Anbindung hinter [`SystemEvents`]: Windows (Phase 3b) und macOS (Phase 3c) haben
//! eigene Implementierungen; andere Systeme nutzen `GenericSystem` mit Startzeit und Zeitzone.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use chrono::{DateTime, Utc};
use timelog_core::SystemEvents;

#[cfg(windows)]
pub fn system() -> Box<dyn SystemEvents> {
    Box::new(windows::WindowsSystem)
}

#[cfg(target_os = "macos")]
pub fn system() -> Box<dyn SystemEvents> {
    Box::new(macos::MacSystem)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn system() -> Box<dyn SystemEvents> {
    Box::new(generic::GenericSystem)
}

/// Gerätebeschreibung für die Anmeldung.
pub fn device_os() -> String {
    sysinfo::System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_owned())
}

pub fn device_name() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "Computer".to_owned())
}

/// Einschaltzeit laut `sysinfo`, wenn die Plattform keine genauere liefert.
#[cfg_attr(windows, allow(dead_code))]
fn fallback_boot_time() -> DateTime<Utc> {
    let secs = i64::try_from(sysinfo::System::boot_time()).unwrap_or(0);
    DateTime::from_timestamp(secs, 0).unwrap_or_else(Utc::now)
}

#[cfg(not(any(windows, target_os = "macos")))]
mod generic {
    use chrono::{DateTime, Utc};
    use timelog_core::{NetworkInfo, SignalSink, SystemEvents};

    /// Plattformunabhängige Grundversion ohne Systemereignisse.
    pub struct GenericSystem;

    impl SystemEvents for GenericSystem {
        fn boot_time(&self) -> DateTime<Utc> {
            super::fallback_boot_time()
        }

        fn timezone(&self) -> String {
            iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned())
        }

        fn current_network(&self) -> NetworkInfo {
            NetworkInfo::default()
        }

        fn watch(&mut self, _sink: SignalSink) {}
    }
}
