//! Windows-Anbindung (Phase 3b): Einschaltzeit aus dem Ereignisprotokoll, Herunterfahren,
//! Sperren, Standby und Netzwechsel über ein verstecktes Fenster, Netz-Kennung über IP-Hilfe.
//!
//! Geprüft gegen Microsoft Learn (Stand Oktober 2026), Einzelheiten in `docs/PLATFORM.md`.
//! WLAN-Name und BSSID werden nicht gelesen: seit Windows 11 24H2 bräuchten sie die
//! Standortfreigabe. Die Kennung aus der Gateway-MAC kommt ohne sie aus.

// Win32 braucht `unsafe`; jeder Block ist auf den einen Aufruf beschränkt.
#![allow(unsafe_code)]
// Fensternachrichten tragen Bitfelder und Zahlen in `WPARAM`/`LPARAM`.
#![allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use timelog_core::network::gateway_fingerprint;
use timelog_core::shutdown::classify_windows_shutdown;
use timelog_core::{NetworkInfo, PowerOff, Signal, SignalSink, SystemEvents};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    ERROR_BUFFER_OVERFLOW, HANDLE, HWND, LPARAM, LRESULT, NO_ERROR, WPARAM,
};
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetAdaptersAddresses, GetIpForwardTable2, GetIpNetTable2,
    NotifyIpInterfaceChange, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IF_TYPE_IEEE80211, IP_ADAPTER_ADDRESSES_LH, MIB_IPFORWARD_TABLE2,
    MIB_IPINTERFACE_ROW, MIB_IPNET_TABLE2, MIB_NOTIFICATION_TYPE,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC};
use windows::Win32::System::EventLog::{
    EvtClose, EvtCreateRenderContext, EvtNext, EvtQuery, EvtQueryChannelPath,
    EvtQueryReverseDirection, EvtRender, EvtRenderContextValues, EvtRenderEventValues, EVT_HANDLE,
    EVT_VARIANT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    DEVICE_NOTIFY_WINDOW_HANDLE, ENDSESSION_LOGOFF, MSG, PBT_APMRESUMEAUTOMATIC,
    PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WINDOW_EX_STYLE, WM_ENDSESSION, WM_POWERBROADCAST,
    WM_QUERYENDSESSION, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED, WTS_SESSION_LOCK,
    WTS_SESSION_UNLOCK,
};

/// Windows beendet Programme ohne sichtbares Fenster etwa 5 s nach `WM_ENDSESSION`.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(4);
/// Netzwechsel kommen in Schüben; erst nach dieser Ruhe wird das Netz neu gelesen.
const NETWORK_SETTLE: Duration = Duration::from_secs(3);
/// Ereignis 1074 muss so frisch sein, um zum laufenden Herunterfahren zu gehören.
const REASON_MAX_AGE: TimeDelta = TimeDelta::minutes(10);
/// So viele Kernel-Boot-Ereignisse werden höchstens durchsucht.
const BOOT_SCAN: usize = 32;

/// `EVT_VARIANT_TYPE`-Werte (`winevt.h`).
const VAR_STRING: u32 = 1;
const VAR_BYTE: u32 = 4;
const VAR_UINT16: u32 = 6;
const VAR_UINT32: u32 = 8;
const VAR_UINT64: u32 = 10;
const VAR_FILETIME: u32 = 17;

pub struct WindowsSystem;

impl SystemEvents for WindowsSystem {
    fn boot_time(&self) -> DateTime<Utc> {
        let now = Utc::now();
        let kernel_start = uptime_boot_time(now);
        last_boot_from_log(kernel_start).unwrap_or(kernel_start)
    }

    fn timezone(&self) -> String {
        iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned())
    }

    fn current_network(&self) -> NetworkInfo {
        current_network()
    }

    fn watch(&mut self, sink: SignalSink) {
        watch_network(sink.clone());
        let spawned = std::thread::Builder::new()
            .name("timelog-windows-events".into())
            .spawn(move || run_window(sink));
        if spawned.is_err() {
            eprintln!("timelog: Systemereignisse nicht verfügbar");
        }
    }
}

// --- Einschaltzeit -----------------------------------------------------------------------

/// Start des Kernels. Nach Schnellstart (Fast Startup) ist das der letzte Kaltstart, daher
/// nur Rückfall und Untergrenze.
fn uptime_boot_time(now: DateTime<Utc>) -> DateTime<Utc> {
    // SAFETY: keine Parameter, keine Vorbedingungen.
    let ms = unsafe { GetTickCount64() };
    now - TimeDelta::milliseconds(i64::try_from(ms).unwrap_or(0))
}

/// Jüngstes Kernel-Boot-Ereignis 27 mit `BootType` 0 (Kaltstart) oder 1 (Schnellstart).
/// `BootType` 2 ist Fortsetzen aus dem Ruhezustand und damit kein Einschalten. Die Zuordnung
/// ist von Microsoft nicht dokumentiert, nur beobachtet; Prüfung siehe `docs/PLATFORM.md`.
fn last_boot_from_log(kernel_start: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let mut found = None;
    let mut seen = 0;
    query_events(
        w!("*[System[Provider[@Name='Microsoft-Windows-Kernel-Boot'] and (EventID=27)]]"),
        &[
            w!("Event/System/TimeCreated/@SystemTime"),
            w!("Event/EventData/Data[@Name='BootType']"),
        ],
        |values| {
            seen += 1;
            let time = values.first().and_then(var_time);
            let boot_type = values.get(1).and_then(var_u64);
            if let (Some(time), Some(0 | 1)) = (time, boot_type) {
                // Älter als der Kernel-Start kann ein Einschalten dieses Laufs nicht sein.
                if time >= kernel_start - TimeDelta::minutes(2) {
                    found = Some(time);
                }
                return false;
            }
            seen < BOOT_SCAN
        },
    );
    found
}

// --- Herunterfahren ------------------------------------------------------------------------

/// Art des laufenden Herunterfahrens aus dem jüngsten Ereignis 1074.
fn shutdown_kind() -> PowerOff {
    let now = Utc::now();
    let mut kind = PowerOff::Shutdown;
    query_events(
        w!("*[System[(EventID=1074)]]"),
        &[
            w!("Event/System/TimeCreated/@SystemTime"),
            w!("Event/EventData/Data[@Name='param1']"),
            w!("Event/EventData/Data[@Name='param4']"),
            w!("Event/EventData/Data[@Name='param5']"),
        ],
        |values| {
            let fresh = values
                .first()
                .and_then(var_time)
                .is_some_and(|t| now - t <= REASON_MAX_AGE);
            if fresh {
                let text = |i: usize| values.get(i).and_then(var_string).unwrap_or_default();
                kind = classify_windows_shutdown(&text(1), &text(2), &text(3));
            }
            false
        },
    );
    kind
}

// --- Ereignisprotokoll ---------------------------------------------------------------------

struct EvtGuard(EVT_HANDLE);

impl Drop for EvtGuard {
    fn drop(&mut self) {
        // SAFETY: der Handle stammt aus einem erfolgreichen Evt*-Aufruf und wird nur hier geschlossen.
        let _ = unsafe { EvtClose(self.0) };
    }
}

/// Durchläuft passende Ereignisse im Protokoll „System“ vom neuesten an, bis `f` `false`
/// liefert. `f` bekommt die Werte zu `paths`.
fn query_events(query: PCWSTR, paths: &[PCWSTR], mut f: impl FnMut(&[EVT_VARIANT]) -> bool) {
    // SAFETY: `paths` sind gültige, nullterminierte Zeichenketten aus `w!`.
    let Ok(context) = (unsafe { EvtCreateRenderContext(Some(paths), EvtRenderContextValues.0) })
    else {
        return;
    };
    let context = EvtGuard(context);
    let flags = EvtQueryChannelPath.0 | EvtQueryReverseDirection.0;
    // SAFETY: Kanal und Abfrage sind gültige Zeichenketten.
    let Ok(results) = (unsafe { EvtQuery(None, w!("System"), query, flags) }) else {
        return;
    };
    let results = EvtGuard(results);
    loop {
        let mut handles = [0isize; 8];
        let mut returned = 0u32;
        // SAFETY: `handles` bietet Platz für `handles.len()` Einträge.
        if unsafe { EvtNext(results.0, &mut handles, 1000, 0, &raw mut returned) }.is_err() {
            return;
        }
        let events: Vec<EvtGuard> = handles[..returned as usize]
            .iter()
            .map(|h| EvtGuard(EVT_HANDLE(*h)))
            .collect();
        for event in &events {
            if !render(context.0, event.0, &mut f) {
                return;
            }
        }
    }
}

fn render(
    context: EVT_HANDLE,
    event: EVT_HANDLE,
    f: &mut impl FnMut(&[EVT_VARIANT]) -> bool,
) -> bool {
    let mut used = 0u32;
    let mut count = 0u32;
    // SAFETY: Größenabfrage ohne Puffer; schlägt mit ERROR_INSUFFICIENT_BUFFER fehl.
    let _ = unsafe {
        EvtRender(
            Some(context),
            event,
            EvtRenderEventValues.0,
            0,
            None,
            &raw mut used,
            &raw mut count,
        )
    };
    if used == 0 {
        return true;
    }
    // `u64` sorgt für die Ausrichtung von `EVT_VARIANT`.
    let mut buffer = vec![0u64; (used as usize).div_ceil(8)];
    let size = u32::try_from(buffer.len() * 8).unwrap_or(u32::MAX);
    // SAFETY: `buffer` ist `size` Bytes groß und lebt, solange die Werte gelesen werden.
    let ok = unsafe {
        EvtRender(
            Some(context),
            event,
            EvtRenderEventValues.0,
            size,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            &raw mut used,
            &raw mut count,
        )
    }
    .is_ok();
    if !ok {
        return true;
    }
    // SAFETY: EvtRender hat `count` Werte am Anfang des Puffers abgelegt.
    let values = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().cast::<EVT_VARIANT>(), count as usize)
    };
    f(values)
}

fn var_u64(v: &EVT_VARIANT) -> Option<u64> {
    // SAFETY: das gelesene Feld passt zum angegebenen Typ.
    unsafe {
        match v.Type {
            VAR_BYTE => Some(u64::from(v.Anonymous.ByteVal)),
            VAR_UINT16 => Some(u64::from(v.Anonymous.UInt16Val)),
            VAR_UINT32 => Some(u64::from(v.Anonymous.UInt32Val)),
            VAR_UINT64 => Some(v.Anonymous.UInt64Val),
            _ => None,
        }
    }
}

fn var_time(v: &EVT_VARIANT) -> Option<DateTime<Utc>> {
    if v.Type != VAR_FILETIME {
        return None;
    }
    // SAFETY: Typ ist FILETIME.
    let ticks = unsafe { v.Anonymous.FileTimeVal };
    // FILETIME zählt 100 ns seit 1601-01-01.
    let secs = i64::try_from(ticks / 10_000_000).ok()? - 11_644_473_600;
    let nanos = u32::try_from(ticks % 10_000_000).ok()? * 100;
    DateTime::from_timestamp(secs, nanos)
}

fn var_string(v: &EVT_VARIANT) -> Option<String> {
    if v.Type != VAR_STRING {
        return None;
    }
    // SAFETY: Typ ist String; der Zeiger zeigt in den Render-Puffer.
    unsafe {
        let s = v.Anonymous.StringVal;
        if s.is_null() {
            None
        } else {
            s.to_string().ok()
        }
    }
}

// --- Fenster für Sitzungs- und Energie-Nachrichten -------------------------------------------

thread_local! {
    static SINK: RefCell<Option<SignalSink>> = const { RefCell::new(None) };
    static SUSPENDED: Cell<bool> = const { Cell::new(false) };
}

fn emit(signal: Signal) {
    SINK.with_borrow(|s| {
        if let Some(sink) = s {
            sink.send(signal);
        }
    });
}

/// Verstecktes Top-Level-Fenster (kein Message-Only-Fenster: das bekäme die rundgesendeten
/// `WM_QUERYENDSESSION`/`WM_POWERBROADCAST` nicht) mit eigener Nachrichtenschleife.
fn run_window(sink: SignalSink) {
    SINK.with_borrow_mut(|s| *s = Some(sink));
    // SAFETY: Klassenname und Fensterprozedur leben für die Dauer des Programms.
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else {
            return;
        };
        let class = w!("TimeLogSystemEvents");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: module.into(),
            lpszClassName: class,
            ..Default::default()
        };
        if RegisterClassW(&raw const wc) == 0 {
            return;
        }
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("TimeLog"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(module.into()),
            None,
        ) else {
            return;
        };
        register_session_notification(hwnd);
        // Moderner Standbymodus meldet PBT_APMSUSPEND nur angemeldeten Programmen.
        let _ = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE);

        let mut msg = MSG::default();
        while GetMessageW(&raw mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&raw const msg);
        }
    }
}

/// Kurz nach der Anmeldung kann der Sitzungsdienst noch fehlen (`RPC_S_INVALID_BINDING`).
fn register_session_notification(hwnd: HWND) {
    for _ in 0..30 {
        // SAFETY: `hwnd` ist ein gültiges Fenster dieses Threads.
        if unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) }.is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        // Sofort zustimmen; geschrieben wird erst in WM_ENDSESSION.
        WM_QUERYENDSESSION => return LRESULT(1),
        WM_ENDSESSION => {
            let ending = wparam.0 != 0;
            // Abmelden ist kein Arbeitsende.
            let logoff = (lparam.0 as u32) & ENDSESSION_LOGOFF != 0;
            if ending && !logoff {
                let kind = shutdown_kind();
                SINK.with_borrow(|s| {
                    if let Some(sink) = s {
                        sink.send_and_wait(Signal::PowerOff(kind), SHUTDOWN_WAIT);
                    }
                });
            }
            return LRESULT(0);
        }
        WM_WTSSESSION_CHANGE => match wparam.0 as u32 {
            WTS_SESSION_LOCK => emit(Signal::Lock),
            WTS_SESSION_UNLOCK => emit(Signal::Unlock),
            _ => {}
        },
        WM_POWERBROADCAST => {
            // Ältere Geräte senden die Nachricht rund und zusätzlich an die Anmeldung; nur
            // Zustandswechsel weitergeben.
            match wparam.0 as u32 {
                PBT_APMSUSPEND if !SUSPENDED.replace(true) => emit(Signal::Suspend),
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND if SUSPENDED.replace(false) => {
                    emit(Signal::Resume);
                }
                _ => {}
            }
            return LRESULT(1);
        }
        _ => {}
    }
    // SAFETY: Standardbehandlung mit unveränderten Parametern.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

// --- Netzwerk ------------------------------------------------------------------------------

/// Meldet Netzwechsel gebündelt: nach jeder Änderung `NETWORK_SETTLE` Ruhe abwarten.
fn watch_network(sink: SignalSink) {
    let (tx, rx) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new()
        .name("timelog-network".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                while rx.recv_timeout(NETWORK_SETTLE).is_ok() {}
                if !sink.send(Signal::NetworkChanged) {
                    return;
                }
            }
        });
    if spawned.is_err() {
        return;
    }
    // Der Sender lebt bis zum Programmende; Windows ruft den Rückruf aus eigenen Threads.
    let context: *const Sender<()> = Box::into_raw(Box::new(tx));
    let mut handle = HANDLE::default();
    // SAFETY: Rückruf und Kontext bleiben für die gesamte Laufzeit gültig.
    let result = unsafe {
        NotifyIpInterfaceChange(
            AF_UNSPEC,
            Some(interface_changed),
            Some(context.cast::<c_void>()),
            false,
            &raw mut handle,
        )
    };
    if result != NO_ERROR {
        eprintln!("timelog: Netzwechsel werden nicht gemeldet");
    }
}

unsafe extern "system" fn interface_changed(
    context: *const c_void,
    _row: *const MIB_IPINTERFACE_ROW,
    _kind: MIB_NOTIFICATION_TYPE,
) {
    // SAFETY: `context` ist der in `watch_network` dauerhaft angelegte Sender.
    let tx = unsafe { &*context.cast::<Sender<()>>() };
    let _ = tx.send(());
}

fn current_network() -> NetworkInfo {
    let Some((if_index, gateway)) = default_gateway() else {
        return NetworkInfo::default();
    };
    let wired = adapter_type(if_index).is_some_and(|t| t != IF_TYPE_IEEE80211);
    NetworkInfo {
        fingerprint: gateway_mac(if_index, gateway).and_then(|mac| gateway_fingerprint(&mac)),
        ssid: None,
        bssid: None,
        wired,
    }
}

/// Schnittstelle und IPv4-Adresse des Standard-Gateways mit der kleinsten Metrik.
fn default_gateway() -> Option<(u32, u32)> {
    let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
    // SAFETY: bei Erfolg gehört die Tabelle uns und wird unten freigegeben.
    if unsafe { GetIpForwardTable2(AF_INET, &raw mut table) } != NO_ERROR || table.is_null() {
        return None;
    }
    // SAFETY: Windows legt `NumEntries` Zeilen hintereinander ab.
    let best = unsafe {
        let rows =
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        rows.iter()
            .filter(|r| r.DestinationPrefix.PrefixLength == 0 && !r.Loopback)
            .map(|r| {
                (
                    r.Metric,
                    r.InterfaceIndex,
                    r.NextHop.Ipv4.sin_addr.S_un.S_addr,
                )
            })
            .filter(|(_, _, gw)| *gw != 0)
            .min()
    };
    // SAFETY: von GetIpForwardTable2 angelegt.
    unsafe { FreeMibTable(table.cast::<c_void>()) };
    best.map(|(_, index, gw)| (index, gw))
}

/// MAC-Adresse des Gateways aus dem Nachbar-Cache. Liest nur; `ResolveIpNetEntry2` würde den
/// Eintrag verwerfen und ARP-Verkehr erzeugen.
fn gateway_mac(if_index: u32, gateway: u32) -> Option<Vec<u8>> {
    let mut table: *mut MIB_IPNET_TABLE2 = std::ptr::null_mut();
    // SAFETY: bei Erfolg gehört die Tabelle uns und wird unten freigegeben.
    if unsafe { GetIpNetTable2(AF_INET, &raw mut table) } != NO_ERROR || table.is_null() {
        return None;
    }
    // SAFETY: Windows legt `NumEntries` Zeilen hintereinander ab.
    let mac = unsafe {
        let rows =
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        rows.iter()
            .find(|r| {
                r.InterfaceIndex == if_index
                    && r.Address.Ipv4.sin_addr.S_un.S_addr == gateway
                    && r.PhysicalAddressLength == 6
            })
            .map(|r| r.PhysicalAddress[..6].to_vec())
    };
    // SAFETY: von GetIpNetTable2 angelegt.
    unsafe { FreeMibTable(table.cast::<c_void>()) };
    mac
}

/// Schnittstellentyp (z. B. `IF_TYPE_IEEE80211` für WLAN).
fn adapter_type(if_index: u32) -> Option<u32> {
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let family = u32::from(AF_INET.0);
    let mut size = 0u32;
    // SAFETY: Größenabfrage ohne Puffer.
    let first = unsafe { GetAdaptersAddresses(family, flags, None, None, &raw mut size) };
    if first != ERROR_BUFFER_OVERFLOW.0 || size == 0 {
        return None;
    }
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    let list = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    // SAFETY: `buffer` ist mindestens `size` Bytes groß und passend ausgerichtet.
    if unsafe { GetAdaptersAddresses(family, flags, None, Some(list), &raw mut size) } != 0 {
        return None;
    }
    let mut current = list.cast_const();
    while !current.is_null() {
        // SAFETY: verkettete Liste im Puffer, gültig solange `buffer` lebt.
        let adapter = unsafe { &*current };
        // SAFETY: `IfIndex` ist in jeder Variante der Vereinigung belegt.
        if unsafe { adapter.Anonymous1.Anonymous.IfIndex } == if_index {
            return Some(adapter.IfType);
        }
        current = adapter.Next.cast_const();
    }
    None
}
