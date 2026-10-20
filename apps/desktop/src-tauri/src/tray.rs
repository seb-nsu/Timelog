//! Tray-Symbol mit Menü. Das Fenster wird nur bei Bedarf gezeigt.

use std::sync::Arc;

use chrono::Utc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use timelog_core::EventType;

use crate::runtime::Runtime;

const TRAY_ID: &str = "main";

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn set_tooltip(app: &AppHandle, text: &str) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(text))?;
    }
    Ok(())
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "TimeLog öffnen", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Arbeit beginnen", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Arbeit beenden", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "TimeLog beenden", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("TimeLog")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "start" | "stop" => {
                let kind = if event.id.as_ref() == "start" {
                    EventType::ManualStart
                } else {
                    EventType::ManualEnd
                };
                if let Some(rt) = app.try_state::<Arc<Runtime>>() {
                    let _ = rt.tracker().manual(kind, Utc::now());
                }
                crate::notify_changed(app);
            }
            "quit" => {
                if let Some(rt) = app.try_state::<Arc<Runtime>>() {
                    let _ = rt.tracker().stop(Utc::now());
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
