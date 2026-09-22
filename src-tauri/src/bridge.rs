// Dev-only automation bridge.
//
// This exists so a local process (a test script, or an AI agent driving the
// app) can set the input, flip every option, and press any button without
// clicking at screen coordinates. The last hand-driven attempt typed Cmd+V
// into the wrong window; a file channel the frontend polls removes that whole
// class of error.
//
// Two independent guards keep this out of a shipped Textmint:
//   1. The whole module is `#[cfg(debug_assertions)]`, so `cargo build
//      --release` and `tauri build` compile it out entirely. A release binary
//      has none of these commands and no polling loop.
//   2. Even in a debug build it is inert unless the app is launched with
//      TEXTMINT_BRIDGE set to a directory. No path is baked in: the directory
//      comes only from the environment at launch, and without it every command
//      reports "not active" and touches no files.
//
// Protocol: the driver writes <dir>/command.json; the frontend polls it, runs
// the command, and writes <dir>/result.json back. Both files are plain JSON.

use std::path::PathBuf;

/// The bridge directory, or None when TEXTMINT_BRIDGE is unset (the default,
/// including every release build since this module is not compiled there).
fn bridge_dir() -> Option<PathBuf> {
    std::env::var_os("TEXTMINT_BRIDGE").map(PathBuf::from)
}

#[derive(serde::Serialize)]
pub struct BridgeStatus {
    active: bool,
    dir: Option<String>,
}

/// Reports whether the bridge is active and, if so, which directory it uses.
/// The frontend calls this once on startup and only starts polling when
/// `active` is true, so a normal launch pays nothing for the bridge existing.
#[tauri::command]
pub fn bridge_status() -> BridgeStatus {
    match bridge_dir() {
        Some(d) => BridgeStatus {
            active: true,
            dir: Some(d.to_string_lossy().into_owned()),
        },
        None => BridgeStatus {
            active: false,
            dir: None,
        },
    }
}

/// Returns the current command file's contents, or None when the bridge is
/// inactive or no command has been written yet. The frontend parses the JSON
/// and ignores a sequence number it has already handled.
#[tauri::command]
pub fn bridge_poll() -> Option<String> {
    let dir = bridge_dir()?;
    std::fs::read_to_string(dir.join("command.json")).ok()
}

/// Writes the result of the last command back for the driver to read. The
/// write is atomic (a temp file renamed into place) so a driver polling at any
/// interval reads either the previous result or the whole new one, never a
/// half-written file. Errors surface to the frontend rather than being
/// swallowed, so a broken bridge is visible instead of silently doing nothing.
#[tauri::command]
pub fn bridge_result(json: String) -> Result<(), String> {
    let dir = bridge_dir().ok_or("TEXTMINT_BRIDGE is not set")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("result.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("result.json")).map_err(|e| e.to_string())
}
