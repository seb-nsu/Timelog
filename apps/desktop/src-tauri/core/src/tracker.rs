//! Erzeugt Ereignisse und Aktiv-Spannen aus Systemsignalen und schreibt sie sofort in `SQLite`.
//! Rechnet keine Arbeitszeit – das macht ausschließlich `@timelog/rules`.

use chrono::{DateTime, Duration, SubsecRound, Utc};
use serde::{Deserialize, Serialize};

use crate::model::{Event, EventFlag, EventType, NetworkConfig, Source, Span};
use crate::network::{match_network, NetworkMatch};
use crate::store::{Result, Store};
use crate::system::{PowerOff, Signal, SystemEvents};

const KEY_BOOT_REPORTED: &str = "boot.reported";
const KEY_NETWORK: &str = "network.current";
const KEY_NETWORKS: &str = "network.config";

#[derive(Debug, Clone, Copy)]
pub struct TrackerConfig {
    /// `boot` wird erst nach dieser Laufzeit gemeldet (Startpuffer).
    pub boot_confirm: Duration,
    /// Takt, in dem die offene Spanne verlängert wird.
    pub tick: Duration,
    /// Größere Lücke zwischen zwei Takten = verpasster Standby; die Spanne wird geteilt.
    pub missed_tick_gap: Duration,
    /// Zwei Einschaltzeiten mit kleinerem Abstand gelten als derselbe Start.
    pub boot_tolerance: Duration,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            boot_confirm: Duration::minutes(5),
            tick: Duration::minutes(2),
            missed_tick_gap: Duration::minutes(5),
            boot_tolerance: Duration::minutes(2),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredNetwork {
    network_id: String,
    source: Source,
}

/// Zustand für Tray und Oberfläche.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub boot_time: DateTime<Utc>,
    pub boot_reported: bool,
    pub active: bool,
    pub network_id: Option<String>,
    pub timezone: String,
}

pub struct Tracker {
    store: Store,
    sys: Box<dyn SystemEvents>,
    cfg: TrackerConfig,
    boot_time: DateTime<Utc>,
    asleep: bool,
    locked: bool,
    powered_off: bool,
    open_span: Option<Span>,
    last_tick: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
    #[error("Das Ende muss nach dem Beginn liegen")]
    InvalidRange,
}

impl Tracker {
    /// Startet die Erfassung beim Programmstart (nach Anmeldung am System).
    pub fn start(store: Store, sys: Box<dyn SystemEvents>, cfg: TrackerConfig, now: DateTime<Utc>) -> Result<Self> {
        let now = now.trunc_subsecs(3);
        let boot_time = sys.boot_time().trunc_subsecs(3);
        let mut tracker = Self {
            store,
            sys,
            cfg,
            boot_time,
            asleep: false,
            locked: false,
            powered_off: false,
            open_span: None,
            last_tick: now,
        };

        // Reste eines Absturzes oder Logouts: offene Spannen enden bei ihrer letzten Verlängerung.
        let mut last_activity: Option<DateTime<Utc>> = None;
        for mut span in tracker.store.open_spans()? {
            span.open = false;
            last_activity = Some(last_activity.map_or(span.end, |t| t.max(span.end)));
            tracker.store.upsert_span(&span)?;
        }
        // Ein noch als verbunden gemerktes Arbeitsnetz endet bei der letzten Aktivität.
        if let Some(prev) = tracker.store.get::<StoredNetwork>(KEY_NETWORK)? {
            let ts = last_activity.unwrap_or(now).min(now);
            tracker.write_net_lost(&prev, ts, now)?;
        }

        tracker.open_span_at(now)?;
        tracker.report_boot_if_due(now)?;
        tracker.check_network(now)?;
        Ok(tracker)
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn timezone(&self) -> String {
        self.sys.timezone()
    }

    pub fn status(&self) -> Result<TrackerStatus> {
        Ok(TrackerStatus {
            boot_time: self.boot_time,
            boot_reported: self.boot_reported()?,
            active: self.open_span.is_some(),
            network_id: self.store.get::<StoredNetwork>(KEY_NETWORK)?.map(|n| n.network_id),
            timezone: self.sys.timezone(),
        })
    }

    /// Regelmäßiger Takt: offene Spanne verlängern, Startpuffer und Netz prüfen.
    pub fn tick(&mut self, now: DateTime<Utc>) -> Result<()> {
        let now = now.trunc_subsecs(3);
        if self.powered_off {
            return Ok(());
        }
        if let Some(mut span) = self.open_span.take() {
            if now - self.last_tick > self.cfg.missed_tick_gap {
                // Standby ohne Signal: die Lücke ist Inaktivität, nicht Arbeit.
                span.open = false;
                span.end = self.last_tick.max(span.start);
                self.store.upsert_span(&span)?;
                self.open_span_at(now)?;
            } else {
                span.end = now.max(span.start);
                self.store.upsert_span(&span)?;
                self.open_span = Some(span);
            }
        }
        self.last_tick = now;
        self.report_boot_if_due(now)?;
        self.check_network(now)
    }

    pub fn handle(&mut self, signal: &Signal, now: DateTime<Utc>) -> Result<()> {
        let now = now.trunc_subsecs(3);
        if self.powered_off {
            return Ok(());
        }
        match signal {
            Signal::Suspend => {
                self.asleep = true;
                self.close_span(now)?;
                // Im Standby ist das Gerät nicht im Arbeitsnetz.
                self.leave_network(now)?;
            }
            Signal::Resume => {
                self.asleep = false;
                self.update_activity(now)?;
                self.check_network(now)?;
            }
            Signal::Lock => {
                self.locked = true;
                self.close_span(now)?;
            }
            Signal::Unlock => {
                self.locked = false;
                self.update_activity(now)?;
            }
            Signal::NetworkChanged => self.check_network(now)?,
            Signal::PowerOff(kind) => self.power_off(*kind, now)?,
        }
        self.last_tick = now;
        Ok(())
    }

    // ── Manuelle Ereignisse aus der Oberfläche ──────────────────────────────

    pub fn manual(&mut self, kind: EventType, now: DateTime<Utc>) -> Result<Event> {
        self.insert(Event::new(kind, Source::User, now, &self.sys.timezone(), now))
    }

    /// `manual_work` („War Arbeit“) oder `manual_break` mit Zeitraum.
    pub fn manual_range(
        &mut self,
        kind: EventType,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> std::result::Result<Event, TrackerError> {
        if to <= from {
            return Err(TrackerError::InvalidRange);
        }
        let mut e = Event::new(kind, Source::User, from, &self.sys.timezone(), now);
        e.end_ts = Some(to.trunc_subsecs(3));
        Ok(self.insert(e)?)
    }

    /// `session_confirm` bzw. `session_reject` für die Sitzung mit Start-Ereignis `session_id`.
    pub fn decide_session(&mut self, session_id: &str, confirm: bool, now: DateTime<Utc>) -> Result<Event> {
        let kind = if confirm { EventType::SessionConfirm } else { EventType::SessionReject };
        let mut e = Event::new(kind, Source::User, now, &self.sys.timezone(), now);
        e.ref_event_id = Some(session_id.to_owned());
        self.insert(e)
    }

    /// Neue Arbeitsnetz-Liste vom Server; danach sofort abgleichen.
    pub fn set_networks(&mut self, config: &NetworkConfig, now: DateTime<Utc>) -> Result<()> {
        self.store.set(KEY_NETWORKS, config)?;
        self.check_network(now.trunc_subsecs(3))
    }

    /// Lokale Daten für die Berechnung mit `@timelog/rules` in der Oberfläche.
    pub fn local_data(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<(Vec<Event>, Vec<Span>)> {
        Ok((self.store.events_between(from, to)?, self.store.spans_between(from, to)?))
    }

    // ── intern ──────────────────────────────────────────────────────────────

    fn insert(&self, event: Event) -> Result<Event> {
        self.store.insert_event(&event)?;
        Ok(event)
    }

    fn boot_reported(&self) -> Result<bool> {
        let reported = self.store.get::<DateTime<Utc>>(KEY_BOOT_REPORTED)?;
        Ok(reported.is_some_and(|r| (r - self.boot_time).abs() < self.cfg.boot_tolerance))
    }

    /// Startpuffer: `boot` erst nach 5 min Laufzeit, mit der echten Einschaltzeit als `ts`.
    fn report_boot_if_due(&mut self, now: DateTime<Utc>) -> Result<()> {
        if self.boot_reported()? || now - self.boot_time < self.cfg.boot_confirm {
            return Ok(());
        }
        self.insert(Event::new(EventType::Boot, Source::System, self.boot_time, &self.sys.timezone(), now))?;
        self.store.set(KEY_BOOT_REPORTED, &self.boot_time)
    }

    fn open_span_at(&mut self, now: DateTime<Utc>) -> Result<()> {
        let span = Span::open_at(now);
        self.store.upsert_span(&span)?;
        self.open_span = Some(span);
        Ok(())
    }

    fn close_span(&mut self, now: DateTime<Utc>) -> Result<()> {
        if let Some(mut span) = self.open_span.take() {
            span.end = now.max(span.start);
            span.open = false;
            self.store.upsert_span(&span)?;
        }
        Ok(())
    }

    fn update_activity(&mut self, now: DateTime<Utc>) -> Result<()> {
        let active = !self.asleep && !self.locked;
        if active && self.open_span.is_none() {
            self.open_span_at(now)?;
        }
        Ok(())
    }

    fn power_off(&mut self, kind: PowerOff, now: DateTime<Utc>) -> Result<()> {
        self.close_span(now)?;
        self.leave_network(now)?;
        let tz = self.sys.timezone();
        let mut e = match kind {
            PowerOff::Shutdown => Event::new(EventType::Shutdown, Source::System, now, &tz, now),
            PowerOff::Restart | PowerOff::UpdateRestart => {
                Event::new(EventType::Restart, Source::System, now, &tz, now)
            }
        };
        if kind == PowerOff::UpdateRestart {
            e.flags.push(EventFlag::UpdateRestart);
        }
        // Synchron schreiben, bevor das System die App beendet.
        self.insert(e)?;
        self.powered_off = true;
        Ok(())
    }

    fn check_network(&mut self, now: DateTime<Utc>) -> Result<()> {
        let current = if self.asleep {
            None
        } else {
            self.store
                .get::<NetworkConfig>(KEY_NETWORKS)?
                .and_then(|config| match_network(&config, &self.sys.current_network()))
        };
        let previous = self.store.get::<StoredNetwork>(KEY_NETWORK)?;
        let same = matches!((&previous, &current), (Some(p), Some(c)) if p.network_id == c.network_id);
        if same {
            return Ok(());
        }
        if let Some(prev) = previous {
            self.write_net_lost(&prev, now, now)?;
        }
        if let Some(NetworkMatch { network_id, source }) = current {
            let mut e = Event::new(EventType::NetConnected, source, now, &self.sys.timezone(), now);
            e.network_id = Some(network_id.clone());
            self.insert(e)?;
            self.store.set(KEY_NETWORK, &StoredNetwork { network_id, source })?;
        }
        Ok(())
    }

    fn leave_network(&mut self, now: DateTime<Utc>) -> Result<()> {
        if let Some(prev) = self.store.get::<StoredNetwork>(KEY_NETWORK)? {
            self.write_net_lost(&prev, now, now)?;
        }
        Ok(())
    }

    fn write_net_lost(&self, prev: &StoredNetwork, ts: DateTime<Utc>, now: DateTime<Utc>) -> Result<()> {
        let mut e = Event::new(EventType::NetLost, prev.source, ts, &self.sys.timezone(), now);
        e.network_id = Some(prev.network_id.clone());
        self.insert(e)?;
        self.store.remove(KEY_NETWORK)
    }
}
