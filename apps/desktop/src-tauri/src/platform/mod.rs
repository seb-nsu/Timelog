//! Plattform-Anbindung hinter [`SystemEvents`]: Windows (Phase 3b) und macOS (Phase 3c) haben
//! eigene Implementierungen; andere Systeme nutzen [`GenericSystem`] mit Startzeit und Zeitzone.

#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use chrono::{DateTime, Utc};
use timelog_core::SystemEvents;
#[cfg(not(windows))]
use timelog_core::{NetworkInfo, SignalSink};

#[cfg(windows)]
pub fn system() -> Box<dyn SystemEvents> {
    Box::new(windows::WindowsSystem)
}

#[cfg(not(windows))]
pub fn system() -> Box<dyn SystemEvents> {
    Box::new(GenericSystem)
}

/// Gerätebeschreibung für die Anmeldung.
pub fn device_os() -> String {
    sysinfo::System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_owned())
}

pub fn device_name() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "Computer".to_owned())
}

/// Plattformunabhängige Grundversion ohne Systemereignisse.
#[cfg(not(windows))]
struct GenericSystem;

#[cfg(not(windows))]
impl SystemEvents for GenericSystem {
    fn boot_time(&self) -> DateTime<Utc> {
        let secs = i64::try_from(sysinfo::System::boot_time()).unwrap_or(0);
        DateTime::from_timestamp(secs, 0).unwrap_or_else(Utc::now)
    }

    fn timezone(&self) -> String {
        iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned())
    }

    fn current_network(&self) -> NetworkInfo {
        NetworkInfo::default()
    }

    fn watch(&mut self, _sink: SignalSink) {}
}
