//! Sync-Warteschlange mit einer Test-API.

use std::cell::RefCell;

use chrono::{DateTime, Duration, TimeZone, Utc};
use timelog_core::model::NetworkKeys;
use timelog_core::sync::MAX_BATCH_EVENTS;
use timelog_core::{Api, ApiError, Event, EventType, NetworkConfig, Source, Span, Store, SyncState, Syncer};

fn at(h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, h, m, 0).unwrap()
}

#[derive(Default)]
struct FakeApi {
    batches: RefCell<Vec<usize>>,
    spans: RefCell<Vec<Span>>,
    fail_with: RefCell<Option<ApiError>>,
    reject_id: RefCell<Option<String>>,
}

impl Api for FakeApi {
    fn post_events(&self, events: &[Event]) -> Result<(), ApiError> {
        if let Some(e) = self.fail_with.borrow().clone() {
            return Err(e);
        }
        if let Some(bad) = self.reject_id.borrow().as_ref() {
            if events.iter().any(|e| &e.id == bad) {
                return Err(ApiError::Rejected { status: 400, code: "invalid_request".into() });
            }
        }
        self.batches.borrow_mut().push(events.len());
        Ok(())
    }

    fn put_presence(&self, spans: &[Span]) -> Result<(), ApiError> {
        self.spans.borrow_mut().extend_from_slice(spans);
        Ok(())
    }

    fn get_networks(&self) -> Result<NetworkConfig, ApiError> {
        Ok(NetworkConfig { networks: vec![], keys: NetworkKeys { user: "a2V5".into(), org: None } })
    }
}

fn event(i: u32) -> Event {
    Event::new(EventType::ManualWork, Source::User, at(6, 0) + Duration::seconds(i.into()), "UTC", at(6, 0))
}

#[test]
fn sendet_in_paketen_und_markiert_als_uebertragen() {
    let store = Store::in_memory().unwrap();
    for i in 0..(u32::try_from(MAX_BATCH_EVENTS).unwrap() + 20) {
        store.insert_event(&event(i)).unwrap();
    }
    let span = Span::open_at(at(6, 0));
    store.upsert_span(&span).unwrap();
    let api = FakeApi::default();
    let mut sync = Syncer::new();
    let networks = sync.run(&store, &api, at(7, 0)).unwrap();
    assert!(networks.is_some());
    assert_eq!(*api.batches.borrow(), vec![MAX_BATCH_EVENTS, 20]);
    assert_eq!(*api.spans.borrow(), vec![span]);
    assert_eq!(store.pending_event_count().unwrap(), 0);
    assert_eq!(store.dirty_span_count().unwrap(), 0);
    assert_eq!(sync.state(), &SyncState::Ok { at: at(7, 0) });
}

#[test]
fn offline_mit_exponentiellem_backoff() {
    let store = Store::in_memory().unwrap();
    store.insert_event(&event(1)).unwrap();
    let api = FakeApi::default();
    *api.fail_with.borrow_mut() = Some(ApiError::Unavailable("timeout".into()));
    let mut sync = Syncer::new();
    sync.run(&store, &api, at(7, 0)).unwrap();
    assert_eq!(sync.state(), &SyncState::Offline { failures: 1, retry_at: at(7, 0) + Duration::seconds(30) });
    assert!(!sync.is_due(at(7, 0) + Duration::seconds(10)));
    sync.run(&store, &api, at(7, 1)).unwrap();
    assert_eq!(sync.state(), &SyncState::Offline { failures: 2, retry_at: at(7, 2) });
    // Netzwechsel: sofort neu versuchen
    *api.fail_with.borrow_mut() = None;
    sync.reset();
    sync.run(&store, &api, at(7, 1)).unwrap();
    assert_eq!(store.pending_event_count().unwrap(), 0);
}

#[test]
fn abgelaufene_anmeldung_wartet_auf_neue_anmeldung() {
    let store = Store::in_memory().unwrap();
    store.insert_event(&event(1)).unwrap();
    let api = FakeApi::default();
    *api.fail_with.borrow_mut() = Some(ApiError::Unauthorized);
    let mut sync = Syncer::new();
    sync.run(&store, &api, at(7, 0)).unwrap();
    assert_eq!(sync.state(), &SyncState::NeedsLogin);
    assert!(!sync.is_due(at(9, 0)));
    sync.reset();
    assert!(sync.is_due(at(9, 0)));
}

#[test]
fn ein_abgelehntes_ereignis_blockiert_die_warteschlange_nicht() {
    let store = Store::in_memory().unwrap();
    let bad = event(2);
    for e in [event(1), bad.clone(), event(3)] {
        store.insert_event(&e).unwrap();
    }
    let api = FakeApi::default();
    *api.reject_id.borrow_mut() = Some(bad.id.clone());
    let mut sync = Syncer::new();
    sync.run(&store, &api, at(7, 0)).unwrap();
    assert_eq!(*api.batches.borrow(), vec![1, 1]);
    assert_eq!(store.pending_event_count().unwrap(), 0);
    // Lokal weiterhin sichtbar
    assert_eq!(store.events_between(at(0, 0), at(23, 0)).unwrap().len(), 3);
}
