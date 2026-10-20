//! Anmeldedaten im Schlüsselbund des Systems: Windows-Anmeldeinformationsverwaltung bzw.
//! macOS-Schlüsselbund. Auf anderen Systemen oder wenn der Schlüsselbund fehlt, bleiben sie in
//! der lokalen Datenbank (`Runtime` entscheidet).

/// Ergebnis des Lesens aus dem Schlüsselbund.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub enum Loaded {
    Found(String),
    Empty,
    /// Kein Schlüsselbund auf diesem System oder Zugriff verweigert.
    Unavailable,
}

#[cfg(any(windows, target_os = "macos"))]
mod native {
    use std::sync::OnceLock;

    use keyring_core::{Entry, Error};

    const SERVICE: &str = "de.timelog.desktop";
    const ACCOUNT: &str = "auth";

    fn entry() -> Option<Entry> {
        static READY: OnceLock<bool> = OnceLock::new();
        let ready = *READY.get_or_init(|| {
            #[cfg(windows)]
            let store = windows_native_keyring_store::Store::new();
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new();
            match store {
                Ok(store) => {
                    keyring_core::set_default_store(store);
                    true
                }
                Err(_) => false,
            }
        });
        if ready {
            Entry::new(SERVICE, ACCOUNT).ok()
        } else {
            None
        }
    }

    pub fn load() -> super::Loaded {
        let Some(entry) = entry() else {
            return super::Loaded::Unavailable;
        };
        match entry.get_password() {
            Ok(value) => super::Loaded::Found(value),
            Err(Error::NoEntry) => super::Loaded::Empty,
            Err(_) => super::Loaded::Unavailable,
        }
    }

    pub fn save(value: &str) -> bool {
        entry().is_some_and(|e| e.set_password(value).is_ok())
    }

    pub fn delete() {
        if let Some(e) = entry() {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod native {
    pub fn load() -> super::Loaded {
        super::Loaded::Unavailable
    }

    pub fn save(_value: &str) -> bool {
        false
    }

    pub fn delete() {}
}

pub use native::{delete, load, save};
