#[tauri::command]
fn native_status() -> String {
    "Rust native core online".to_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_status])
        .run(tauri::generate_context!())
        .expect("error while running Entry Desktop");
}
