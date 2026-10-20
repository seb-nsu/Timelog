//! Datenmodell, deckungsgleich mit `eventInput`/`presenceInput` aus `@timelog/shared`.

use chrono::{DateTime, SubsecRound, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    Boot,
    Shutdown,
    Restart,
    NetConnected,
    NetLost,
    ManualStart,
    ManualEnd,
    ManualBreak,
    ManualWork,
    SessionConfirm,
    SessionReject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    System,
    Wifi,
    Lan,
    Geofence,
    Shortcut,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventFlag {
    UpdateRestart,
}

/// Ereignis, wie es lokal gespeichert und an `/events/batch` gesendet wird.
/// `userId`/`deviceId` setzt der Server aus dem Token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: EventType,
    pub source: Source,
    pub ts: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ts: Option<DateTime<Utc>>,
    pub tz: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_event_id: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<EventFlag>,
}

impl Event {
    /// Neues Ereignis mit zufälliger ID; Zeiten auf Millisekunden gerundet.
    pub fn new(kind: EventType, source: Source, ts: DateTime<Utc>, tz: &str, now: DateTime<Utc>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            source,
            ts: ts.trunc_subsecs(3),
            end_ts: None,
            tz: tz.to_owned(),
            network_id: None,
            ref_event_id: None,
            created_at: now.trunc_subsecs(3),
            flags: Vec::new(),
        }
    }
}

/// Aktiv-Spanne: Gerät wach und Bildschirm entsperrt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub id: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub open: bool,
}

impl Span {
    pub fn open_at(now: DateTime<Utc>) -> Self {
        let now = now.trunc_subsecs(3);
        Self { id: uuid::Uuid::new_v4().to_string(), start: now, end: now, open: true }
    }
}

/// Hinterlegtes Arbeitsnetz, wie es `GET /networks` liefert (nur HMACs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkNetwork {
    pub id: String,
    pub scope: NetworkScope,
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bssid_hmac: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint_hmac: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkScope {
    User,
    Org,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkKeys {
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkConfig {
    pub networks: Vec<WorkNetwork>,
    pub keys: NetworkKeys,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialisiert_wie_die_api() {
        let ts = DateTime::parse_from_rfc3339("2026-10-14T06:00:00.123456Z").unwrap().with_timezone(&Utc);
        let mut e = Event::new(EventType::NetConnected, Source::Lan, ts, "Europe/Berlin", ts);
        e.id = "0b7a1c4e-2f43-4d4f-9d7e-6f1a2b3c4d5e".into();
        e.network_id = Some("n1".into());
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "0b7a1c4e-2f43-4d4f-9d7e-6f1a2b3c4d5e",
                "type": "net_connected",
                "source": "lan",
                "ts": "2026-10-14T06:00:00.123Z",
                "tz": "Europe/Berlin",
                "networkId": "n1",
                "createdAt": "2026-10-14T06:00:00.123Z"
            })
        );
        let back: Event = serde_json::from_value(json).unwrap();
        assert_eq!(back, e);
    }
}
