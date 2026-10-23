//! Abgleich der aktuellen Netzwerk-Merkmale mit hinterlegten Arbeitsnetzen über HMAC.
//! Entspricht `networkHmac` im Backend.

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::model::{NetworkConfig, NetworkScope, Source, WorkNetwork};
use crate::system::NetworkInfo;

type HmacSha256 = Hmac<Sha256>;

/// Gleiche Normalisierung wie im Backend: trimmen, Kleinbuchstaben, `-` → `:`.
pub fn normalize(value: &str) -> String {
    value.trim().to_lowercase().replace('-', ":")
}

pub fn hmac_hex(key: &[u8], value: &str) -> String {
    // HMAC akzeptiert Schlüssel jeder Länge.
    let Ok(mut mac) = HmacSha256::new_from_slice(key) else {
        return String::new();
    };
    mac.update(normalize(value).as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .fold(String::with_capacity(64), |mut out, b| {
            use std::fmt::Write;
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// Netzwerk-Kennung aus der MAC-Adresse des Standard-Gateways (`gw=aa:bb:cc:dd:ee:ff`).
/// Gleich für LAN und WLAN desselben Routers und auf allen Plattformen; braucht keine
/// Standortberechtigung. `None` bei fehlender oder ungültiger Adresse.
pub fn gateway_fingerprint(mac: &[u8]) -> Option<String> {
    if mac.len() != 6 || mac.iter().all(|b| *b == 0) || mac.iter().all(|b| *b == 0xff) {
        return None;
    }
    let hex: Vec<String> = mac.iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("gw={}", hex.join(":")))
}

/// MAC-Adresse aus der Ausgabe von `arp -n <IP>` (macOS schreibt Bytes ohne führende Null,
/// z. B. `? (192.168.1.1) at 0:1a:2b:3c:4d:5e on en0 ifscope [ethernet]`).
pub fn parse_arp_mac(output: &str) -> Option<Vec<u8>> {
    let rest = output.split(" at ").nth(1)?;
    let token = rest.split_whitespace().next()?;
    let bytes: Vec<u8> = token
        .split(':')
        .map(|part| u8::from_str_radix(part, 16))
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    (bytes.len() == 6).then_some(bytes)
}

/// Treffer: ID des Arbeitsnetzes und Quelle für das Ereignis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkMatch {
    pub network_id: String,
    pub source: Source,
}

pub fn match_network(config: &NetworkConfig, info: &NetworkInfo) -> Option<NetworkMatch> {
    let decode = |k: &str| base64::engine::general_purpose::STANDARD.decode(k).ok();
    let user_key = decode(&config.keys.user);
    let org_key = config.keys.org.as_deref().and_then(decode);
    let key_for = |n: &WorkNetwork| match n.scope {
        NetworkScope::User => user_key.as_deref(),
        NetworkScope::Org => org_key.as_deref(),
    };

    // Kennung zuerst: braucht keine Standortberechtigung und deckt LAN und Dock ab.
    if let Some(fp) = &info.fingerprint {
        for n in &config.networks {
            if let (Some(want), Some(key)) = (&n.fingerprint_hmac, key_for(n)) {
                if hmac_hex(key, fp) == *want {
                    let source = if info.wired {
                        Source::Lan
                    } else {
                        Source::Wifi
                    };
                    return Some(NetworkMatch {
                        network_id: n.id.clone(),
                        source,
                    });
                }
            }
        }
    }
    if let Some(ssid) = &info.ssid {
        for n in &config.networks {
            if n.ssid.as_deref() != Some(ssid.as_str()) {
                continue;
            }
            let bssid_ok = match (&n.bssid_hmac, &info.bssid, key_for(n)) {
                (None, _, _) => true,
                (Some(want), Some(bssid), Some(key)) => hmac_hex(key, bssid) == *want,
                _ => false,
            };
            if bssid_ok {
                return Some(NetworkMatch {
                    network_id: n.id.clone(),
                    source: Source::Wifi,
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NetworkKeys;

    fn key() -> (Vec<u8>, String) {
        let raw = vec![7u8; 32];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&raw);
        (raw, b64)
    }

    fn net(id: &str, scope: NetworkScope) -> WorkNetwork {
        WorkNetwork {
            id: id.into(),
            scope,
            kind: "fingerprint".into(),
            label: id.into(),
            ssid: None,
            bssid_hmac: None,
            fingerprint_hmac: None,
        }
    }

    #[test]
    fn kennung_aus_gateway_mac() {
        assert_eq!(
            gateway_fingerprint(&[0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]).as_deref(),
            Some("gw=aa:bb:cc:dd:ee:ff")
        );
        assert_eq!(gateway_fingerprint(&[0; 6]), None);
        assert_eq!(gateway_fingerprint(&[0xff; 6]), None);
        assert_eq!(gateway_fingerprint(&[1, 2, 3]), None);
    }

    #[test]
    fn mac_aus_arp_ausgabe() {
        let out = "? (192.168.1.1) at 0:1a:2b:3c:4d:5e on en0 ifscope [ethernet]\n";
        assert_eq!(
            parse_arp_mac(out)
                .and_then(|m| gateway_fingerprint(&m))
                .as_deref(),
            Some("gw=00:1a:2b:3c:4d:5e")
        );
        assert_eq!(
            parse_arp_mac("? (192.168.1.1) at (incomplete) on en0 ifscope [ethernet]"),
            None
        );
        assert_eq!(parse_arp_mac("192.168.1.1 (192.168.1.1) -- no entry"), None);
    }

    #[test]
    fn hmac_wie_im_backend() {
        // Referenzwert: createHmac('sha256', Buffer.alloc(32, 7)).update('aa:bb:cc:dd:ee:ff').digest('hex')
        let (raw, _) = key();
        assert_eq!(
            hmac_hex(&raw, " AA-BB-CC-DD-EE-FF "),
            hmac_hex(&raw, "aa:bb:cc:dd:ee:ff")
        );
        assert_eq!(
            hmac_hex(&raw, "aa:bb:cc:dd:ee:ff"),
            "f95add76ac958697fe5b1c17d1f8161f351a9f1a92ae6eaaef29381ad211ab98"
        );
    }

    #[test]
    fn erkennt_kennung_und_wlan() {
        let (raw, b64) = key();
        let mut lan = net("lan", NetworkScope::User);
        lan.fingerprint_hmac = Some(hmac_hex(&raw, "gw=aa:bb:cc:dd:ee:ff"));
        let mut wifi = net("wifi", NetworkScope::User);
        wifi.kind = "ssid".into();
        wifi.ssid = Some("Firma".into());
        wifi.bssid_hmac = Some(hmac_hex(&raw, "11:22:33:44:55:66"));
        let config = NetworkConfig {
            networks: vec![lan, wifi],
            keys: NetworkKeys {
                user: b64,
                org: None,
            },
        };

        let docked = NetworkInfo {
            fingerprint: Some("GW=AA-BB-CC-DD-EE-FF".into()),
            wired: true,
            ..Default::default()
        };
        assert_eq!(
            match_network(&config, &docked),
            Some(NetworkMatch {
                network_id: "lan".into(),
                source: Source::Lan
            })
        );

        let office = NetworkInfo {
            fingerprint: Some("gw=00:00:00:00:00:00".into()),
            ssid: Some("Firma".into()),
            bssid: Some("11:22:33:44:55:66".into()),
            wired: false,
        };
        assert_eq!(
            match_network(&config, &office),
            Some(NetworkMatch {
                network_id: "wifi".into(),
                source: Source::Wifi
            })
        );

        // Gleiche SSID, fremder Access Point
        let fake = NetworkInfo {
            bssid: Some("99:99:99:99:99:99".into()),
            ..office
        };
        assert_eq!(match_network(&config, &fake), None);
        assert_eq!(match_network(&config, &NetworkInfo::default()), None);
    }

    #[test]
    fn firmennetz_nutzt_firmenschluessel() {
        let (_, user) = key();
        let org_raw = vec![9u8; 32];
        let org = base64::engine::general_purpose::STANDARD.encode(&org_raw);
        let mut n = net("org", NetworkScope::Org);
        n.fingerprint_hmac = Some(hmac_hex(&org_raw, "gw=1"));
        let info = NetworkInfo {
            fingerprint: Some("gw=1".into()),
            ..Default::default()
        };
        let with_org = NetworkConfig {
            networks: vec![n.clone()],
            keys: NetworkKeys {
                user: user.clone(),
                org: Some(org),
            },
        };
        assert!(match_network(&with_org, &info).is_some());
        let without = NetworkConfig {
            networks: vec![n],
            keys: NetworkKeys { user, org: None },
        };
        assert_eq!(match_network(&without, &info), None);
    }
}
