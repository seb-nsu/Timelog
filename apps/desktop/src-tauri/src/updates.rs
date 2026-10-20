//! Automatische Updates über den Tauri-Updater mit signierten Paketen. Aktiv nur, wenn die
//! Konfiguration `plugins.updater` enthält (öffentlicher Schlüssel und Adresse kommen beim
//! Release-Build dazu, siehe `docs/RELEASE.md`).

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::runtime::Runtime;

/// Erste Prüfung kurz nach dem Start, danach täglich.
const FIRST_CHECK: Duration = Duration::from_mins(1);
const INTERVAL: Duration = Duration::from_hours(24);

pub fn configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

pub fn spawn(app: AppHandle, rt: Arc<Runtime>) {
    let _ = std::thread::Builder::new()
        .name("timelog-updates".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                if tauri::async_runtime::block_on(install(&app)) {
                    // Spanne sauber abschließen; das Programmende ist kein Arbeitsende.
                    let _ = rt.tracker().stop(Utc::now());
                    app.restart();
                }
                std::thread::sleep(INTERVAL);
            }
        });
}

/// `true`, wenn ein Update installiert wurde und ein Neustart nötig ist.
async fn install(app: &AppHandle) -> bool {
    let Ok(updater) = app.updater() else {
        return false;
    };
    match updater.check().await {
        Ok(Some(update)) => update.download_and_install(|_, _| {}, || {}).await.is_ok(),
        _ => false,
    }
}
