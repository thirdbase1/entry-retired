// Hide the console window on Windows release builds. Without this attribute
// the app spawns a blank black console window alongside the real window, and
// closing that console terminates the whole process.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    entry_desktop_lib::run();
}
