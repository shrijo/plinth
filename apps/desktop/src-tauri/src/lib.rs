use std::fs;

/// Reads a project file the user picked through the native open dialog.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
  fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

/// Writes a project file to a path the user picked through the native save dialog.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
  fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Writes binary data (an exported model) to a path the user picked through the
/// native save dialog. The bytes arrive as the raw request body and the path,
/// percent-encoded, in the `path` header.
#[tauri::command]
fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
  let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
    return Err("Expected the file's contents as bytes".into());
  };
  let encoded = request
    .headers()
    .get("path")
    .and_then(|value| value.to_str().ok())
    .ok_or("Missing the file path")?;
  let path = percent_encoding::percent_decode_str(encoded)
    .decode_utf8()
    .map_err(|e| format!("Invalid file path: {e}"))?;
  fs::write(path.as_ref(), data).map_err(|e| format!("Could not write {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![read_text_file, write_text_file, write_binary_file])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
