// User-initiated handoff for the CLI's `textmint open`. When the app is launched
// with TEXTMINT_OPEN pointing at a file, its text is loaded into the input pane
// on start (src/main.js calls startup_open once). One-shot and opt-in: nothing
// happens without the variable, so unlike the dev bridge this is not an
// always-listening channel. Ships in every build.

use std::path::Path;

/// Only the CLI's own one-shot handoff file is safe to delete after reading. A
/// path a user pointed TEXTMINT_OPEN at directly (a real file of theirs) is read
/// but never removed, or the app would destroy it. The CLI writes its temp files
/// as `textmint-open-<pid>.txt` in the temp dir, so both the name and the
/// directory must match; nothing else is touched.
fn is_our_handoff(path: &Path, temp_dir: &Path) -> bool {
    let named = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("textmint-open-") && n.ends_with(".txt"));
    named && path.parent() == Some(temp_dir)
}

/// Return the handoff text once. Deletes the file only if it is the CLI's own
/// temp handoff. None when no handoff was set or the file is unreadable.
#[tauri::command]
pub fn startup_open() -> Option<String> {
    let path = std::path::PathBuf::from(std::env::var_os("TEXTMINT_OPEN")?);
    let text = std::fs::read_to_string(&path).ok()?;
    if is_our_handoff(&path, &std::env::temp_dir()) {
        let _ = std::fs::remove_file(&path);
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::is_our_handoff;
    use std::path::Path;

    #[test]
    fn only_the_cli_handoff_in_the_temp_dir_is_deletable() {
        let tmp = Path::new("/tmp");
        assert!(is_our_handoff(Path::new("/tmp/textmint-open-123.txt"), tmp));
        // Right name, wrong directory: not ours, leave it.
        assert!(!is_our_handoff(
            Path::new("/Users/me/textmint-open-1.txt"),
            tmp
        ));
        // A real file a user pointed the variable at must never be deleted.
        assert!(!is_our_handoff(Path::new("/tmp/notes.md"), tmp));
        assert!(!is_our_handoff(Path::new("/tmp/textmint-open-123.md"), tmp));
    }
}
