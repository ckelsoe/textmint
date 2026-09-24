// Public because it is the library's actual surface. Phase 2 ports the passes
// against it and the JS side is retired in Phase 3; until then `re` and
// `replace_all` have no in-crate caller, and a private module would have clippy
// call them dead code rather than unfinished.
pub mod textmint_core;

// Markdown -> HTML for the Preview and Copy HTML. Ships in every build, and is
// public so the textmint-render binary (src/bin/textmint-render.rs, used by the
// CLI) renders through the same engine. See src-tauri/src/engine.rs.
pub mod engine;

// Pasted HTML: clean it keeping its formatting, or convert it to markdown. Public
// so textmint-render (the CLI's engine) reaches the same code. See
// src-tauri/src/html.rs and docs/plans/html-input.md.
pub mod html;

// One-shot startup handoff for the CLI's `textmint open`. Ships in every build,
// opt-in via TEXTMINT_OPEN. See src-tauri/src/startup.rs.
mod startup;

// Reports whether this install can self-update ("auto") or should only link to
// the download ("download"). Drives the About box's update control. See
// src-tauri/src/update.rs and docs/plans/self-update.md.
mod update;

// Dev-only automation bridge. Compiled out of release builds entirely, and
// inert even in a debug build unless launched with TEXTMINT_BRIDGE set. See
// src-tauri/src/bridge.rs and docs/AUTOMATION.md.
#[cfg(debug_assertions)]
mod bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_clipboard_manager::init());

    // The updater and process plugins power in-app updates and the relaunch after
    // one installs. Desktop only: the updater has no mobile support, and this app
    // ships desktop targets exclusively.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init());

    // clean_text is registered in Phase 1 so the invoke path is live before any
    // pass depends on it; the frontend does not call it yet. render_markdown is
    // the live converter behind the Preview and Copy HTML. startup_open feeds
    // the CLI's `open` handoff. update_channel tells the UI whether this install
    // may self-update. The bridge commands are added only in a debug build.
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        textmint_core::clean_text,
        engine::render_markdown,
        html::html_clean,
        html::html_markdown,
        startup::startup_open,
        update::update_channel,
        bridge::bridge_status,
        bridge::bridge_poll,
        bridge::bridge_result
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        textmint_core::clean_text,
        engine::render_markdown,
        html::html_clean,
        html::html_markdown,
        startup::startup_open,
        update::update_channel
    ]);

    // Dev-only MCP bridge for AI-driven UI testing: the `mcp` feature (off by
    // default, so release builds never compile it) and a debug build, both.
    // Bound to 127.0.0.1, not the plugin's default of every interface, since it
    // has no authentication. See docs/AUTOMATION.md.
    //
    // Its permission is granted at runtime from a capability file outside
    // capabilities/ (which every build reads). The grant runs in a small plugin
    // of its own rather than Builder::setup, which holds a single hook that a
    // later setup() would silently replace, or be replaced by.
    #[cfg(all(debug_assertions, feature = "mcp"))]
    let builder = builder
        .plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("textmint-mcp-acl")
                .setup(|app, _api| {
                    use tauri::Manager;
                    app.add_capability(include_str!("../dev-capabilities/mcp.json"))?;
                    Ok(())
                })
                .build(),
        );

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
