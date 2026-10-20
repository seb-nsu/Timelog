//! `TimeLog` Desktop: Tray-App mit Autostart. Der Rust-Kern (`timelog-core`) schreibt Ereignisse und
//! Aktiv-Spannen in `SQLite`; die Oberfläche berechnet Arbeitstage mit `@timelog/rules`.

mod commands;
mod platform;
mod runtime;
mod secrets;
mod tray;
mod updates;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use crate::runtime::Runtime;

/// Meldet der Oberfläche, dass sich lokale Daten geändert haben.
pub(crate) fn notify_changed(app: &AppHandle) {
    let _ = app.emit("timelog://changed", ());
}

/// Startet die App.
///
/// # Panics
///
/// Wenn Tauri nicht starten kann (z. B. fehlende Webview).
pub fn run() {
    let context = tauri::generate_context!();
    let with_updater = updates::configured(context.config());
    let mut builder = tauri::Builder::default();
    if with_updater {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let (tx, rx) = timelog_core::SignalSink::channel();
            let rt = Arc::new(Runtime::open(&dir.join("timelog.sqlite"), tx)?);
            app.manage(Arc::clone(&rt));

            // Autostart bei Anmeldung: beim ersten Start einschalten, danach entscheidet der Nutzer.
            if rt.kv_get("autostart.initialized")?.is_none() {
                let _ = app.autolaunch().enable();
                rt.kv_set("autostart.initialized", &serde_json::Value::Bool(true))?;
            }

            tray::create(app.handle())?;

            // Ersteinrichtung offen: Fenster zeigen, sonst nur Tray.
            let setup_done = rt
                .kv_get("setup.done")?
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !setup_done {
                tray::show_main(app.handle());
            }

            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("timelog-runtime".into())
                .spawn({
                    let rt = Arc::clone(&rt);
                    move || {
                        rt.sync(true, None);
                        rt.run(&rx, &|| notify_changed(&handle));
                    }
                })?;
            if with_updater {
                updates::spawn(app.handle().clone(), rt);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Schließen versteckt nur das Fenster; die Erfassung läuft im Tray weiter.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::login,
            commands::logout,
            commands::api_fetch,
            commands::local_data,
            commands::manual,
            commands::manual_range,
            commands::decide_session,
            commands::current_network,
            commands::get_profile,
            commands::set_profile,
            commands::finish_setup,
            commands::sync_now,
            commands::set_tray_status,
        ])
        .run(context)
        .expect("TimeLog konnte nicht gestartet werden");
}
