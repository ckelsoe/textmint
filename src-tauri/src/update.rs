// Which update path this install supports. The Tauri updater and its manifest can
// only hand a Windows install one artifact, and self-installing the NSIS per-user
// build over a per-machine MSI would drop a second, orphaned copy. So the MSI is
// told to notify only. See docs/plans/self-update.md.
//
// - "auto": the frontend may run the in-app updater (check, download, install,
//   relaunch). macOS and the Windows NSIS per-user install.
// - "download": show the banner and an About box that links to the releases page,
//   never the in-app installer. The Windows per-machine MSI.

/// Returns "auto" or "download". macOS always self-updates. On Windows the choice
/// turns on where the running executable lives: a per-machine MSI lands under
/// Program Files, the per-user NSIS build does not.
#[tauri::command]
pub fn update_channel() -> String {
    channel().to_string()
}

#[cfg(target_os = "macos")]
fn channel() -> &'static str {
    "auto"
}

#[cfg(target_os = "windows")]
fn channel() -> &'static str {
    if installed_per_machine() {
        "download"
    } else {
        "auto"
    }
}

// Anything that is neither macOS nor Windows is not a shipped target; default to
// the safe path that installs nothing.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn channel() -> &'static str {
    "download"
}

// A per-machine install is one whose executable sits under a Program Files root.
// This side gathers the real environment and hands the decision to the pure
// function below, which is where the load-bearing rule is tested.
#[cfg(target_os = "windows")]
fn installed_per_machine() -> bool {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_lowercase(),
        Err(_) => return false,
    };
    let roots: Vec<String> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .into_iter()
        .filter_map(|v| std::env::var(v).ok())
        .filter(|d| !d.is_empty())
        .collect();
    path_is_per_machine(&exe, &roots)
}

// Pure, so it is testable off Windows. `exe` is already lowercased; `roots` are
// the Program Files directories from the environment (possibly empty). Falls back
// to a literal match so an install under Program Files is still caught when the
// environment is bare, erring toward "notify only" rather than self-installing.
#[cfg(any(target_os = "windows", test))]
fn path_is_per_machine(exe: &str, roots: &[String]) -> bool {
    if roots.iter().any(|r| exe.starts_with(&r.to_lowercase())) {
        return true;
    }
    exe.contains("\\program files")
}

#[cfg(test)]
mod tests {
    use super::path_is_per_machine;

    #[test]
    fn under_program_files_is_per_machine() {
        let roots = vec!["C:\\Program Files".to_string()];
        assert!(path_is_per_machine(
            "c:\\program files\\textmint\\textmint.exe",
            &roots
        ));
    }

    #[test]
    fn under_local_appdata_is_per_user() {
        let roots = vec!["C:\\Program Files".to_string()];
        assert!(!path_is_per_machine(
            "c:\\users\\me\\appdata\\local\\textmint\\textmint.exe",
            &roots
        ));
    }

    #[test]
    fn literal_fallback_catches_program_files_without_env() {
        let roots: Vec<String> = vec![];
        assert!(path_is_per_machine(
            "c:\\program files (x86)\\textmint\\textmint.exe",
            &roots
        ));
    }
}
