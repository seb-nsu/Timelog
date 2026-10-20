// Unter Windows kein Konsolenfenster im Release-Build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    timelog_desktop_lib::run();
}
