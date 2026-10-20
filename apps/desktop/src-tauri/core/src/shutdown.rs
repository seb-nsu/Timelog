//! Art des Herunterfahrens aus den Angaben, die das Betriebssystem protokolliert.
//!
//! Windows schreibt beim Einleiten des Herunterfahrens Ereignis 1074 (Quelle `User32`) mit
//! auslösendem Prozess (`param1`), Grund-Code (`param4`, z. B. `0x80020010`) und Art
//! (`param5`). Die Art ist übersetzter Text, daher entscheiden bekannte Wörter; Unbekanntes
//! gilt als Herunterfahren.

use crate::system::PowerOff;

/// `SHTDN_REASON_MAJOR_OPERATINGSYSTEM`
const MAJOR_OS: u32 = 0x0002_0000;
const MAJOR_MASK: u32 = 0x00ff_0000;
const MINOR_MASK: u32 = 0x0000_00ff;
/// Installation, Upgrade, Service Pack, Hotfix, Sicherheitsupdate und deren Deinstallation.
const UPDATE_MINORS: [u32; 7] = [0x02, 0x03, 0x10, 0x11, 0x12, 0x17, 0x18];

/// Wortstämme für „Neustart“ in den gängigen Sprachen von Windows.
const RESTART_WORDS: [&str; 9] = [
    "restart",
    "neustart",
    "neu starten",
    "redémarr",
    "reinici",
    "riavvi",
    "opnieuw opstarten",
    "ponownie",
    "herstart",
];

/// Prozesse von Windows Update, die einen Neustart auslösen.
const UPDATE_PROCESSES: [&str; 4] = [
    "trustedinstaller",
    "mousocoreworker",
    "usoclient",
    "wuauclt",
];

/// Liest einen Grund-Code wie `0x80020010` (auch ohne `0x`).
pub fn parse_reason_code(value: &str) -> Option<u32> {
    let v = value.trim();
    let hex = v
        .strip_prefix("0x")
        .or_else(|| v.strip_prefix("0X"))
        .unwrap_or(v);
    u32::from_str_radix(hex, 16).ok()
}

/// Ordnet ein Windows-Ereignis 1074 ein.
pub fn classify_windows_shutdown(process: &str, reason_code: &str, kind: &str) -> PowerOff {
    let kind = kind.to_lowercase();
    if !RESTART_WORDS.iter().any(|w| kind.contains(w)) {
        return PowerOff::Shutdown;
    }
    let process = process.to_lowercase();
    let by_update_process = UPDATE_PROCESSES.iter().any(|p| process.contains(p));
    let by_reason = parse_reason_code(reason_code).is_some_and(|code| {
        code & MAJOR_MASK == MAJOR_OS && UPDATE_MINORS.contains(&(code & MINOR_MASK))
    });
    if by_update_process || by_reason {
        PowerOff::UpdateRestart
    } else {
        PowerOff::Restart
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grund_code() {
        assert_eq!(parse_reason_code("0x80020010"), Some(0x8002_0010));
        assert_eq!(parse_reason_code(" 500ff "), Some(0x500ff));
        assert_eq!(parse_reason_code("kein Code"), None);
    }

    #[test]
    fn ordnet_ein() {
        let explorer = r"C:\Windows\explorer.exe (PC)";
        assert_eq!(
            classify_windows_shutdown(explorer, "0x500ff", "power off"),
            PowerOff::Shutdown
        );
        assert_eq!(
            classify_windows_shutdown(explorer, "0x500ff", "Ausschalten"),
            PowerOff::Shutdown
        );
        assert_eq!(
            classify_windows_shutdown(explorer, "0x500ff", "restart"),
            PowerOff::Restart
        );
        assert_eq!(
            classify_windows_shutdown(explorer, "0x500ff", "Neu starten"),
            PowerOff::Restart
        );
        assert_eq!(
            classify_windows_shutdown(
                r"C:\Windows\System32\MoUsoCoreWorker.exe (PC)",
                "0x80020010",
                "Neustart"
            ),
            PowerOff::UpdateRestart
        );
        // Update-Grund auch bei anderem Prozess
        assert_eq!(
            classify_windows_shutdown(explorer, "0x80020012", "restart"),
            PowerOff::UpdateRestart
        );
        // Update-Grund, aber Ausschalten bleibt Herunterfahren
        assert_eq!(
            classify_windows_shutdown(explorer, "0x80020010", "power off"),
            PowerOff::Shutdown
        );
        assert_eq!(classify_windows_shutdown("", "", ""), PowerOff::Shutdown);
    }
}
