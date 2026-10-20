//! Tracker-Szenarien mit der Test-Attrappe, ohne echte Betriebssystem-Ereignisse.
#![allow(clippy::many_single_char_names)]

use base64::Engine;
use chrono::{DateTime, Duration, TimeZone, Utc};
use timelog_core::model::{EventFlag, NetworkKeys, NetworkScope, WorkNetwork};
use timelog_core::network::hmac_hex;
use timelog_core::{
    EventType, FakeSystem, NetworkConfig, NetworkInfo, PowerOff, Signal, Source, Store, SystemEvents, Tracker,
    TrackerConfig,
};

const TZ: &str = "Europe/Berlin";

fn at(h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, h, m, 0).unwrap()
}

fn day() -> (DateTime<Utc>, DateTime<Utc>) {
    (at(0, 0), at(23, 59))
}

fn kinds(tracker: &Tracker) -> Vec<EventType> {
    let (from, to) = day();
    tracker.local_data(from, to).unwrap().0.iter().map(|e| e.kind).collect()
}

fn start(boot: DateTime<Utc>, now: DateTime<Utc>) -> (Tracker, timelog_core::system::FakeHandle) {
    let (sys, handle) = FakeSystem::new(boot, TZ);
    let tracker = Tracker::start(Store::in_memory().unwrap(), Box::new(sys), TrackerConfig::default(), now).unwrap();
    (tracker, handle)
}

#[test]
fn startpuffer_boot_erst_nach_5_minuten_mit_echter_einschaltzeit() {
    let (mut t, _) = start(at(6, 0), at(6, 1));
    assert!(kinds(&t).is_empty());
    t.tick(at(6, 3)).unwrap();
    assert!(kinds(&t).is_empty());
    t.tick(at(6, 5)).unwrap();
    let (from, to) = day();
    let events = t.local_data(from, to).unwrap().0;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventType::Boot);
    assert_eq!(events[0].source, Source::System);
    assert_eq!(events[0].ts, at(6, 0));
    assert_eq!(events[0].created_at, at(6, 5));
    assert_eq!(events[0].tz, TZ);
    t.tick(at(6, 7)).unwrap();
    assert_eq!(kinds(&t), vec![EventType::Boot]);
    assert!(t.status().unwrap().boot_reported);
}

#[test]
fn programmneustart_meldet_denselben_boot_nicht_erneut() {
    let (sys, _) = FakeSystem::new(at(6, 0), TZ);
    let store = Store::in_memory().unwrap();
    let t = Tracker::start(store, Box::new(sys), TrackerConfig::default(), at(6, 10)).unwrap();
    assert_eq!(kinds(&t), vec![EventType::Boot]);
    // Gleiche Datenbank, Einschaltzeit um 1 s abweichend (Rundung des Systems)
    let (sys2, _) = FakeSystem::new(at(6, 0) + Duration::seconds(1), TZ);
    let store = into_store(&t);
    let t2 = Tracker::start(store, Box::new(sys2), TrackerConfig::default(), at(9, 0)).unwrap();
    assert_eq!(kinds(&t2), vec![EventType::Boot]);
}

/// Hilfsweg: Store aus einem Tracker zurückholen, indem eine Datei-Datenbank genutzt wird.
fn into_store(t: &Tracker) -> Store {
    let (from, to) = (at(0, 0), at(23, 59));
    let (events, spans) = t.local_data(from, to).unwrap();
    let boot_reported: Option<DateTime<Utc>> = t.store().get("boot.reported").unwrap();
    let store = Store::in_memory().unwrap();
    for e in &events {
        store.insert_event(e).unwrap();
    }
    for s in &spans {
        store.upsert_span(s).unwrap();
    }
    if let Some(b) = boot_reported {
        store.set("boot.reported", &b).unwrap();
    }
    store
}

#[test]
fn aufwachen_ist_kein_boot_und_teilt_die_spanne() {
    let (mut t, _) = start(at(6, 0), at(6, 10));
    t.handle(&Signal::Suspend, at(10, 0)).unwrap();
    t.handle(&Signal::Resume, at(10, 45)).unwrap();
    t.tick(at(10, 47)).unwrap();
    assert_eq!(kinds(&t), vec![EventType::Boot]);
    let (from, to) = day();
    let spans = t.local_data(from, to).unwrap().1;
    assert_eq!(spans.len(), 2);
    assert_eq!((spans[0].start, spans[0].end, spans[0].open), (at(6, 10), at(10, 0), false));
    assert_eq!((spans[1].start, spans[1].end, spans[1].open), (at(10, 45), at(10, 47), true));
}

#[test]
fn sperre_beendet_spanne_erst_entsperren_startet_neue() {
    let (mut t, _) = start(at(6, 0), at(6, 10));
    t.handle(&Signal::Lock, at(9, 0)).unwrap();
    t.handle(&Signal::Suspend, at(9, 5)).unwrap();
    t.handle(&Signal::Resume, at(9, 30)).unwrap();
    // Noch gesperrt: keine Aktivität
    assert!(!t.status().unwrap().active);
    t.handle(&Signal::Unlock, at(9, 32)).unwrap();
    assert!(t.status().unwrap().active);
    let (from, to) = day();
    let spans = t.local_data(from, to).unwrap().1;
    assert_eq!(spans.iter().map(|s| (s.start, s.end)).collect::<Vec<_>>(), vec![
        (at(6, 10), at(9, 0)),
        (at(9, 32), at(9, 32))
    ]);
}

#[test]
fn verpasster_standby_wird_als_luecke_erkannt() {
    let (mut t, _) = start(at(6, 0), at(6, 10));
    t.tick(at(6, 12)).unwrap();
    t.tick(at(7, 30)).unwrap();
    let (from, to) = day();
    let spans = t.local_data(from, to).unwrap().1;
    assert_eq!(spans.iter().map(|s| (s.start, s.end, s.open)).collect::<Vec<_>>(), vec![
        (at(6, 10), at(6, 12), false),
        (at(7, 30), at(7, 30), true)
    ]);
}

#[test]
fn herunterfahren_schreibt_shutdown_synchron_und_beendet_die_erfassung() {
    let (mut t, _) = start(at(6, 0), at(6, 10));
    t.handle(&Signal::PowerOff(PowerOff::Shutdown), at(15, 0)).unwrap();
    t.tick(at(15, 2)).unwrap();
    t.handle(&Signal::Unlock, at(15, 3)).unwrap();
    assert_eq!(kinds(&t), vec![EventType::Boot, EventType::Shutdown]);
    let (from, to) = day();
    let spans = t.local_data(from, to).unwrap().1;
    assert_eq!((spans[0].end, spans[0].open), (at(15, 0), false));
    assert_eq!(t.store().pending_event_count().unwrap(), 2);
}

#[test]
fn neustart_und_update_neustart() {
    let (mut t, _) = start(at(6, 0), at(6, 10));
    t.handle(&Signal::PowerOff(PowerOff::UpdateRestart), at(12, 0)).unwrap();
    let (from, to) = day();
    let events = t.local_data(from, to).unwrap().0;
    assert_eq!(events[1].kind, EventType::Restart);
    assert_eq!(events[1].flags, vec![EventFlag::UpdateRestart]);
    let (mut t2, _) = start(at(6, 0), at(6, 10));
    t2.handle(&Signal::PowerOff(PowerOff::Restart), at(12, 0)).unwrap();
    let events = t2.local_data(from, to).unwrap().0;
    assert!(events[1].flags.is_empty());
}

fn networks() -> (NetworkConfig, String) {
    let raw = vec![3u8; 32];
    let config = NetworkConfig {
        networks: vec![
            WorkNetwork {
                id: "11111111-1111-4111-8111-111111111111".into(),
                scope: NetworkScope::User,
                kind: "fingerprint".into(),
                label: "Dock".into(),
                ssid: None,
                bssid_hmac: None,
                fingerprint_hmac: Some(hmac_hex(&raw, "gw=aa:bb:cc:dd:ee:ff")),
            },
            WorkNetwork {
                id: "22222222-2222-4222-8222-222222222222".into(),
                scope: NetworkScope::User,
                kind: "ssid".into(),
                label: "Büro".into(),
                ssid: Some("Firma".into()),
                bssid_hmac: None,
                fingerprint_hmac: None,
            },
        ],
        keys: NetworkKeys { user: base64::engine::general_purpose::STANDARD.encode(&raw), org: None },
    };
    (config, "11111111-1111-4111-8111-111111111111".into())
}

#[test]
fn arbeitsnetz_verbinden_wechseln_und_standby() {
    let (mut t, fake) = start(at(6, 0), at(6, 10));
    let (config, dock) = networks();
    fake.set_network(NetworkInfo { fingerprint: Some("gw=AA-BB-CC-DD-EE-FF".into()), wired: true, ..Default::default() });
    t.set_networks(&config, at(7, 0)).unwrap();
    assert_eq!(t.status().unwrap().network_id.as_deref(), Some(dock.as_str()));

    // Gleiches Netz erneut gemeldet: kein weiteres Ereignis
    t.handle(&Signal::NetworkChanged, at(7, 5)).unwrap();
    // Wechsel ins WLAN „Firma“
    fake.set_network(NetworkInfo { ssid: Some("Firma".into()), ..Default::default() });
    t.handle(&Signal::NetworkChanged, at(8, 0)).unwrap();
    // Standby: Netz weg; nach dem Aufwachen wieder da
    t.handle(&Signal::Suspend, at(12, 0)).unwrap();
    t.handle(&Signal::Resume, at(12, 30)).unwrap();
    // Fremdes Netz
    fake.set_network(NetworkInfo { ssid: Some("Café".into()), ..Default::default() });
    t.tick(at(13, 0)).unwrap();

    let (from, to) = day();
    let net: Vec<_> = t
        .local_data(from, to)
        .unwrap()
        .0
        .into_iter()
        .filter(|e| matches!(e.kind, EventType::NetConnected | EventType::NetLost))
        .map(|e| (e.kind, e.source, e.ts, e.network_id.unwrap_or_default()))
        .collect();
    let wifi = "22222222-2222-4222-8222-222222222222".to_string();
    assert_eq!(net, vec![
        (EventType::NetConnected, Source::Lan, at(7, 0), dock.clone()),
        (EventType::NetLost, Source::Lan, at(8, 0), dock),
        (EventType::NetConnected, Source::Wifi, at(8, 0), wifi.clone()),
        (EventType::NetLost, Source::Wifi, at(12, 0), wifi.clone()),
        (EventType::NetConnected, Source::Wifi, at(12, 30), wifi.clone()),
        (EventType::NetLost, Source::Wifi, at(13, 0), wifi),
    ]);
    // Keine Netzwerk-Merkmale in den Ereignissen
    let json = serde_json::to_string(&t.local_data(from, to).unwrap().0).unwrap();
    assert!(!json.contains("Firma") && !json.contains("Café") && !json.to_lowercase().contains("aa:bb"));
}

#[test]
fn absturz_reste_werden_beim_start_abgeschlossen() {
    let (mut t, fake) = start(at(6, 0), at(6, 10));
    let (config, _) = networks();
    fake.set_network(NetworkInfo { fingerprint: Some("gw=aa:bb:cc:dd:ee:ff".into()), wired: true, ..Default::default() });
    t.set_networks(&config, at(6, 10)).unwrap();
    for m in (12..=40).step_by(2) {
        t.tick(at(11, m)).unwrap();
    }
    // Absturz um ca. 11:41: kein Shutdown. Neustart des Rechners um 11:50.
    let (events, spans) = t.local_data(day().0, day().1).unwrap();
    let networks: Option<NetworkConfig> = t.store().get("network.config").unwrap();
    let current: Option<serde_json::Value> = t.store().get("network.current").unwrap();
    let store = Store::in_memory().unwrap();
    for e in &events {
        store.insert_event(e).unwrap();
    }
    for s in &spans {
        store.upsert_span(s).unwrap();
    }
    store.set("network.config", &networks.unwrap()).unwrap();
    store.set("network.current", &current.unwrap()).unwrap();
    store.set("boot.reported", &at(6, 0)).unwrap();

    let (sys, fake2) = FakeSystem::new(at(11, 50), TZ);
    fake2.set_network(NetworkInfo::default());
    let t2 = Tracker::start(store, Box::new(sys), TrackerConfig::default(), at(11, 51)).unwrap();
    let (events, spans) = t2.local_data(day().0, day().1).unwrap();
    assert!(spans.iter().filter(|s| s.start < at(11, 51)).all(|s| !s.open));
    let lost = events.iter().find(|e| e.kind == EventType::NetLost).unwrap();
    assert_eq!(lost.ts, at(11, 40));
    // Neuer Boot erst nach dem Startpuffer
    assert_eq!(events.iter().filter(|e| e.kind == EventType::Boot).count(), 1);
}

#[test]
fn manuelle_ereignisse_und_bestaetigung() {
    let (mut t, _) = start(at(6, 0), at(6, 1));
    let s = t.manual(EventType::ManualStart, at(6, 2)).unwrap();
    assert_eq!((s.kind, s.source), (EventType::ManualStart, Source::User));
    let w = t.manual_range(EventType::ManualWork, at(10, 0), at(10, 45), at(11, 0)).unwrap();
    assert_eq!(w.end_ts, Some(at(10, 45)));
    assert!(t.manual_range(EventType::ManualBreak, at(10, 0), at(10, 0), at(11, 0)).is_err());
    let c = t.decide_session("session-1", true, at(12, 0)).unwrap();
    assert_eq!((c.kind, c.ref_event_id.as_deref()), (EventType::SessionConfirm, Some("session-1")));
    let r = t.decide_session("session-2", false, at(12, 0)).unwrap();
    assert_eq!(r.kind, EventType::SessionReject);
    t.manual(EventType::ManualEnd, at(15, 0)).unwrap();
    assert_eq!(kinds(&t), vec![
        EventType::ManualStart,
        EventType::ManualWork,
        EventType::SessionConfirm,
        EventType::SessionReject,
        EventType::ManualEnd
    ]);
}

#[test]
fn attrappe_liefert_signale_ueber_watch() {
    let (mut sys, fake) = FakeSystem::new(at(6, 0), TZ);
    let (tx, rx) = std::sync::mpsc::channel();
    assert!(!fake.emit(Signal::Lock));
    sys.watch(tx);
    assert!(fake.emit(Signal::Lock));
    assert_eq!(rx.recv().unwrap(), Signal::Lock);
    fake.set_timezone("America/New_York");
    fake.set_boot_time(at(7, 0));
    assert_eq!(sys.timezone(), "America/New_York");
    assert_eq!(sys.boot_time(), at(7, 0));
}
