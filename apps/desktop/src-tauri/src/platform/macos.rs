//! macOS-Anbindung (Phase 3c): Einschaltzeit über `kern.boottime`, Herunterfahren über das
//! Quit-AppleEvent mit Grund und `willPowerOffNotification` als Rückfall, Sperren und Standby
//! über Benachrichtigungen, Netzwechsel und Netz-Kennung über `SystemConfiguration`.
//!
//! Geprüft gegen Apple Developer (Stand Oktober 2026), Einzelheiten in `docs/PLATFORM.md`.
//! WLAN-Name und BSSID werden nicht gelesen: seit macOS 14 bräuchten sie Ortungsdienste.

// Objective-C und `sysctl` brauchen `unsafe`; jeder Block ist auf den einen Aufruf beschränkt.
#![allow(unsafe_code)]

use std::ptr::NonNull;
use std::time::Duration;

use block2::RcBlock;
use chrono::{DateTime, Utc};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSWorkspace, NSWorkspaceDidWakeNotification,
    NSWorkspaceWillPowerOffNotification, NSWorkspaceWillSleepNotification,
};
use objc2_core_foundation::{CFArray, CFDictionary, CFRetained, CFString, CFType};
use objc2_foundation::{
    NSAppleEventDescriptor, NSAppleEventManager, NSDistributedNotificationCenter, NSNotification,
    NSNotificationCenter, NSObject, NSObjectProtocol, NSString,
};
use objc2_system_configuration::{
    kSCNetworkInterfaceTypeIEEE80211, SCDynamicStore, SCNetworkInterface,
};
use timelog_core::network::{gateway_fingerprint, parse_arp_mac};
use timelog_core::{NetworkInfo, PowerOff, Signal, SignalSink, SystemEvents};

/// Wartezeit auf den SQLite-Eintrag, bevor die App sich beenden lässt.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(4);
/// Abstand der Netzprüfung (Router und Schnittstelle, ohne Netzwerkverkehr).
const NETWORK_POLL: Duration = Duration::from_secs(10);

/// Vier-Zeichen-Codes aus `AppleEvents.h` / `AERegistry.h`.
const fn four_cc(code: [u8; 4]) -> u32 {
    u32::from_be_bytes(code)
}
const K_CORE_EVENT_CLASS: u32 = four_cc(*b"aevt");
const K_AE_QUIT_APPLICATION: u32 = four_cc(*b"quit");
const K_AE_QUIT_REASON: u32 = four_cc(*b"why?");
const K_AE_SHUT_DOWN: u32 = four_cc(*b"shut");
const K_AE_RESTART: u32 = four_cc(*b"rest");

pub struct MacSystem;

impl SystemEvents for MacSystem {
    fn boot_time(&self) -> DateTime<Utc> {
        boot_time().unwrap_or_else(super::fallback_boot_time)
    }

    fn timezone(&self) -> String {
        iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned())
    }

    fn current_network(&self) -> NetworkInfo {
        current_network()
    }

    fn watch(&mut self, sink: SignalSink) {
        watch_network(sink.clone());
        // Benachrichtigungen und AppleEvents laufen über die Hauptschleife von AppKit.
        match MainThreadMarker::new() {
            Some(mtm) => {
                observe_notifications(&sink);
                install_quit_handler(mtm, sink);
            }
            None => eprintln!("timelog: Systemereignisse nur im Hauptthread verfügbar"),
        }
    }
}

// --- Einschaltzeit -----------------------------------------------------------------------

/// `kern.boottime`: Einschaltzeit bezogen auf die aktuelle Uhr. Verschiebt sich bei
/// Uhrkorrekturen um Sekunden; der Tracker vergleicht mit Toleranz.
fn boot_time() -> Option<DateTime<Utc>> {
    let mut tv = libc::timeval {
        tv_sec: 0,
        tv_usec: 0,
    };
    let mut size = std::mem::size_of::<libc::timeval>();
    // SAFETY: `tv` und `size` passen zum erwarteten Wert `struct timeval`.
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.boottime".as_ptr(),
            (&raw mut tv).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || tv.tv_sec <= 0 {
        return None;
    }
    let nanos = u32::try_from(tv.tv_usec).ok()? * 1000;
    DateTime::from_timestamp(tv.tv_sec, nanos)
}

// --- Herunterfahren ------------------------------------------------------------------------

pub struct QuitIvars {
    sink: SignalSink,
}

define_class!(
    // SAFETY: NSObject hat keine besonderen Anforderungen an Unterklassen; `Drop` ist nicht
    // implementiert.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TimeLogQuitHandler"]
    #[ivars = QuitIvars]
    struct QuitHandler;

    impl QuitHandler {
        /// Ersetzt die Quit-Behandlung von AppKit: Grund lesen, bei Herunterfahren oder
        /// Neustart synchron schreiben, dann wie gewohnt beenden.
        #[unsafe(method(handleQuit:withReply:))]
        fn handle_quit(&self, event: &NSAppleEventDescriptor, _reply: &NSAppleEventDescriptor) {
            let signal = match quit_reason(event) {
                K_AE_SHUT_DOWN => Some(PowerOff::Shutdown),
                K_AE_RESTART => Some(PowerOff::Restart),
                // Abmelden (`rlgo`/`logo`) oder Beenden durch den Nutzer: kein Ereignis.
                _ => None,
            };
            if let Some(kind) = signal {
                self.ivars()
                    .sink
                    .send_and_wait(Signal::PowerOff(kind), SHUTDOWN_WAIT);
            }
            NSApplication::sharedApplication(self.mtm()).terminate(None);
        }
    }
);

impl QuitHandler {
    fn new(mtm: MainThreadMarker, sink: SignalSink) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(QuitIvars { sink });
        // SAFETY: `init` von NSObject.
        unsafe { msg_send![super(this), init] }
    }
}

/// Grund aus dem Quit-AppleEvent (`kAEQuitReason`), als Attribut oder Parameter.
fn quit_reason(event: &NSAppleEventDescriptor) -> u32 {
    let code = |d: Option<Retained<NSAppleEventDescriptor>>| {
        d.map_or(0, |d| match d.typeCodeValue() {
            0 => d.enumCodeValue(),
            c => c,
        })
    };
    // SAFETY: beide Methoden nehmen einen Vier-Zeichen-Code und liefern einen Deskriptor oder nil.
    let attribute: Option<Retained<NSAppleEventDescriptor>> =
        unsafe { msg_send![event, attributeDescriptorForKeyword: K_AE_QUIT_REASON] };
    match code(attribute) {
        0 => {
            // SAFETY: wie oben.
            let param: Option<Retained<NSAppleEventDescriptor>> =
                unsafe { msg_send![event, paramDescriptorForKeyword: K_AE_QUIT_REASON] };
            code(param)
        }
        c => c,
    }
}

/// Muss nach dem Start von `AppKit` laufen, sonst überschreibt `AppKit` den Handler wieder.
fn install_quit_handler(mtm: MainThreadMarker, sink: SignalSink) {
    let handler = QuitHandler::new(mtm, sink);
    let manager = NSAppleEventManager::sharedAppleEventManager();
    let target: &AnyObject = &handler;
    // SAFETY: `handler` implementiert `handleQuit:withReply:` und bleibt dauerhaft erhalten.
    unsafe {
        let () = msg_send![
            &manager,
            setEventHandler: target,
            andSelector: sel!(handleQuit:withReply:),
            forEventClass: K_CORE_EVENT_CLASS,
            andEventID: K_AE_QUIT_APPLICATION
        ];
    }
    std::mem::forget(handler);
}

// --- Benachrichtigungen ------------------------------------------------------------------------

fn observe(center: &NSNotificationCenter, name: &NSString, sink: &SignalSink, signal: Signal) {
    let sink = sink.clone();
    let block = RcBlock::new(move |_: NonNull<NSNotification>| {
        if signal == Signal::PowerOffPending {
            // Vor einem möglichen Beenden sicher speichern.
            sink.send_and_wait(signal.clone(), SHUTDOWN_WAIT);
        } else {
            sink.send(signal.clone());
        }
    });
    // SAFETY: ohne Objekt-Filter und Warteschlange; der Block ist `'static`.
    let token: Retained<ProtocolObject<dyn NSObjectProtocol>> = unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
    };
    // Beobachter bleiben bis zum Programmende angemeldet.
    std::mem::forget(token);
}

fn observe_notifications(sink: &SignalSink) {
    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: Namenskonstanten aus AppKit.
    let (sleep, wake, power_off) = unsafe {
        (
            NSWorkspaceWillSleepNotification,
            NSWorkspaceDidWakeNotification,
            NSWorkspaceWillPowerOffNotification,
        )
    };
    // Schlaf-Benachrichtigungen kommen nur über das Center von NSWorkspace.
    observe(&workspace, sleep, sink, Signal::Suspend);
    observe(&workspace, wake, sink, Signal::Resume);
    // Abmelden oder Herunterfahren; entschieden wird beim nächsten Start.
    observe(&workspace, power_off, sink, Signal::PowerOffPending);

    // Bildschirmsperre: nicht dokumentiert, aber verbreitet; am Gerät prüfen.
    let distributed = NSDistributedNotificationCenter::defaultCenter();
    observe(
        &distributed,
        &NSString::from_str("com.apple.screenIsLocked"),
        sink,
        Signal::Lock,
    );
    observe(
        &distributed,
        &NSString::from_str("com.apple.screenIsUnlocked"),
        sink,
        Signal::Unlock,
    );
}

// --- Netzwerk ------------------------------------------------------------------------------

/// Router-Adresse und Schnittstelle des primären IPv4-Dienstes.
fn primary_ipv4() -> Option<(String, String)> {
    let key = CFString::from_static_str("State:/Network/Global/IPv4");
    let value = SCDynamicStore::value(None, &key)?;
    let dict = value.downcast::<CFDictionary>().ok()?;
    // SAFETY: Schlüssel des Dienstes sind Zeichenketten.
    let dict: CFRetained<CFDictionary<CFString, CFType>> =
        unsafe { CFRetained::cast_unchecked(dict) };
    let text = |k: &'static str| {
        dict.get(&CFString::from_static_str(k))
            .and_then(|v| v.downcast::<CFString>().ok())
            .map(|s| s.to_string())
    };
    Some((text("Router")?, text("PrimaryInterface")?))
}

/// Meldet Änderungen von Router oder Schnittstelle. Abfragen statt Rückruf: liest nur den
/// lokalen Zustand und braucht keine eigene Run-Loop.
fn watch_network(sink: SignalSink) {
    let spawned = std::thread::Builder::new()
        .name("timelog-network".into())
        .spawn(move || {
            let mut last = primary_ipv4();
            loop {
                std::thread::sleep(NETWORK_POLL);
                let now = primary_ipv4();
                if now != last {
                    last = now;
                    if !sink.send(Signal::NetworkChanged) {
                        return;
                    }
                }
            }
        });
    if spawned.is_err() {
        eprintln!("timelog: Netzwechsel werden nicht gemeldet");
    }
}

fn is_wifi(bsd_name: &str) -> bool {
    // SAFETY: Konstante aus SystemConfiguration.
    let wifi = unsafe { kSCNetworkInterfaceTypeIEEE80211 }.to_string();
    let all = SCNetworkInterface::all();
    // SAFETY: SCNetworkInterfaceCopyAll liefert eine Liste von SCNetworkInterface.
    let all: CFRetained<CFArray<SCNetworkInterface>> = unsafe { CFRetained::cast_unchecked(all) };
    all.iter().any(|i| {
        i.bsd_name().is_some_and(|n| n.to_string() == bsd_name)
            && i.interface_type().is_some_and(|t| t.to_string() == wifi)
    })
}

/// MAC des Routers aus dem ARP-Cache (`arp -n` liest nur, sendet nichts).
fn router_mac(router: &str) -> Option<Vec<u8>> {
    let output = std::process::Command::new("/usr/sbin/arp")
        .args(["-n", router])
        .output()
        .ok()?;
    parse_arp_mac(&String::from_utf8_lossy(&output.stdout))
}

fn current_network() -> NetworkInfo {
    let Some((router, interface)) = primary_ipv4() else {
        return NetworkInfo::default();
    };
    NetworkInfo {
        fingerprint: router_mac(&router).and_then(|mac| gateway_fingerprint(&mac)),
        ssid: None,
        bssid: None,
        wired: !is_wifi(&interface),
    }
}
