// Public because it is the library's actual surface. Phase 2 ports the passes
// against it and the JS side is retired in Phase 3; until then `re` and
// `replace_all` have no in-crate caller, and a private module would have clippy
// call them dead code rather than unfinished.
pub mod textmint_core;

// Markdown -> HTML for the Preview and Copy HTML. Ships in every build, and is
// public so the textmint-render binary (src/bin/textmint-render.rs, used by the
// CLI) renders through the same engine. See src-tauri/src/engine.rs.
pub mod engine;

// One-shot startup handoff for the CLI's `textmint open`. Ships in every build,
// opt-in via TEXTMINT_OPEN. See src-tauri/src/startup.rs.
mod startup;

// Dev-only automation bridge. Compiled out of release builds entirely, and
// inert even in a debug build unless launched with TEXTMINT_BRIDGE set. See
// src-tauri/src/bridge.rs and docs/AUTOMATION.md.
#[cfg(debug_assertions)]
mod bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_clipboard_manager::init());

    // clean_text is registered in Phase 1 so the invoke path is live before any
    // pass depends on it; the frontend does not call it yet. render_markdown is
    // the live converter behind the Preview and Copy HTML. startup_open feeds
    // the CLI's `open` handoff. The bridge commands are added only in a debug
    // build.
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        textmint_core::clean_text,
        engine::render_markdown,
        startup::startup_open,
        bridge::bridge_status,
        bridge::bridge_poll,
        bridge::bridge_result
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        textmint_core::clean_text,
        engine::render_markdown,
        startup::startup_open
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
