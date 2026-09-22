//! Rust port of the cleaning pipeline in `src/pipeline.js`.
//!
//! **Scaffold only.** Phase 1 of the plan in `docs/WORKPLAN.md` section 3 builds
//! the machinery and proves the premise of the port. No cleaning pass is ported
//! yet, the frontend still calls the JS pipeline, and nothing here is wired into
//! the UI until Phase 3.
//!
//! `test/snapshots.json` is the spec. Every pass ported in Phase 2 has to
//! reproduce it byte for byte, so passes land one at a time and are diffed
//! against it rather than written from the description.

mod options;
pub use options::CleanOptions;

use fancy_regex::{Error as FancyError, Regex, RegexBuilder, RuntimeError};
use std::borrow::Cow;
use std::fmt;

/// Ceiling on backtracking steps for one match attempt.
///
/// fancy-regex defaults to this same value, but it is set explicitly because
/// the number is a product decision, not a library default to inherit silently:
/// it is the boundary between "this paste is slow" and "this paste is refused".
/// This is strictly better than the JS side, where a pathological input has no
/// limit at all and freezes the window.
pub const BACKTRACK_LIMIT: usize = 1_000_000;

/// Anything that can stop a clean, in a form the frontend can show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanError {
    /// The regex engine gave up on this input. Surfaced to the user rather than
    /// left to hang.
    TooComplex,
    /// Backtracking blew the stack. Same treatment as the limit.
    StackOverflow,
    /// A pattern in this crate failed to compile. A bug here, never user input.
    BadPattern(String),
    /// A pass the caller asked for has not been ported yet. Refused rather than
    /// skipped: silently returning text with a requested pass missing would
    /// look like a clean that worked.
    NotPorted(String),
}

impl fmt::Display for CleanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CleanError::TooComplex => write!(
                f,
                "This text is too complex to clean. Try a smaller selection."
            ),
            CleanError::StackOverflow => write!(
                f,
                "This text is too deeply nested to clean. Try a smaller selection."
            ),
            CleanError::BadPattern(p) => write!(f, "Internal pattern error: {p}"),
            CleanError::NotPorted(p) => write!(f, "Not ported to the Rust core yet: {p}"),
        }
    }
}

impl std::error::Error for CleanError {}

/// Tauri needs the error side of a command's Result to serialize. The frontend
/// only ever shows the message, so it goes over as a string.
impl serde::Serialize for CleanError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl From<FancyError> for CleanError {
    fn from(e: FancyError) -> Self {
        match e {
            FancyError::RuntimeError(RuntimeError::BacktrackLimitExceeded) => {
                CleanError::TooComplex
            }
            FancyError::RuntimeError(RuntimeError::StackOverflow) => CleanError::StackOverflow,
            other => CleanError::BadPattern(other.to_string()),
        }
    }
}

/// Compile a pattern with the backtrack limit applied.
///
/// Every regex in this crate goes through here. Using `Regex::new` directly
/// would take the library default instead of the limit above, and the point of
/// the limit is that it is ours.
pub fn re(pattern: &str) -> Result<Regex, CleanError> {
    RegexBuilder::new(pattern)
        .backtrack_limit(BACKTRACK_LIMIT)
        .build()
        .map_err(CleanError::from)
}

/// Replace every match, propagating a runtime error instead of panicking.
///
/// This wrapper is not a convenience. `Regex::replace_all` is
/// `try_replacen(..).unwrap()`, so on a backtrack-limit hit it panics, which in
/// a Tauri command takes the process down. `try_replacen` with a limit of 0 is
/// the same operation with the error returned. Nothing in this crate may call
/// `replace_all` directly.
pub fn replace_all<'t>(
    pattern: &Regex,
    text: &'t str,
    replacement: &str,
) -> Result<Cow<'t, str>, CleanError> {
    pattern
        .try_replacen(text, 0, replacement)
        .map_err(CleanError::from)
}

/// The passes `clean` would run, in the order `clean()` in `src/pipeline.js`
/// runs them. Order is load-bearing, so it is recorded here before any pass
/// exists to be run.
///
/// Name and flag live in the same row on purpose. The first version kept the
/// names here and read the flags from a separate positional array zipped by
/// index, with nothing enforcing that the two agreed: inserting a pass in the
/// middle and appending its flag would have made the error name the wrong pass.
type PassFlag = fn(&CleanOptions) -> bool;
const PASSES: [(&str, PassFlag); 8] = [
    ("stripNoise", |o| o.strip_noise),
    ("stripUnicode", |o| o.strip_unicode),
    ("stripMarkdown", |o| o.strip_markdown),
    ("bullets", |o| o.bullets),
    ("joinLines", |o| o.join_lines),
    ("stripIndent", |o| o.strip_indent),
    ("collapseBlank", |o| o.collapse_blank),
    ("wrap", |o| o.wrap),
];

impl CleanOptions {
    /// Which requested passes have no Rust implementation yet, in pass order.
    ///
    /// Phase 1 ports none of them, so any enabled toggle lands here. Phase 2
    /// shrinks this list one pass at a time.
    fn unported(&self) -> Vec<&'static str> {
        PASSES
            .iter()
            .filter(|(_, flag)| flag(self))
            .map(|(name, _)| *name)
            .collect()
    }
}

/// Clean `text` according to `opts`.
///
/// Phase 1 ports no passes, so this refuses any enabled toggle rather than
/// returning text that looks cleaned and is not. With every toggle off it
/// matches the JS, which also returns the input trimmed.
///
/// Note for Phase 2: a pass cannot simply be dropped in here. `clean()` in
/// `src/pipeline.js` wraps the whole run in `maskProtected`/`unmaskProtected`,
/// which is what keeps code fences and table columns intact, so that has to
/// land before or with the first pass or the first port will corrupt fences.
pub fn clean(text: &str, opts: &CleanOptions) -> Result<String, CleanError> {
    let unported = opts.unported();
    if !unported.is_empty() {
        return Err(CleanError::NotPorted(unported.join(", ")));
    }
    Ok(text.trim().to_string())
}

/// The command the frontend will call in Phase 3. Registered now so the
/// capability entry and the invoke path are exercised before any pass depends
/// on them.
#[tauri::command]
pub fn clean_text(text: String, opts: CleanOptions) -> Result<String, CleanError> {
    clean(&text, &opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The premise of the whole port: the four patterns the `regex` crate cannot
    // take, copied across from src/pipeline.js unchanged, compile and behave
    // under fancy-regex. Three use lookbehind and two use a backreference.
    // If this test fails the port needs a different engine, not a workaround.

    #[test]
    fn asterisk_emphasis_with_a_backreference() {
        // JS: /(\*{1,3})(.+?)\1/gs
        let r = re(r"(?s)(\*{1,3})(.+?)\1").unwrap();
        assert_eq!(
            replace_all(&r, "**bold** and *em*", "$2").unwrap(),
            "bold and em"
        );
    }

    #[test]
    fn underscore_emphasis_with_lookbehind_and_a_backreference() {
        // JS: /(?<!\w)(_{1,3})(\S(?:[^\n]*?\S)?)\1(?!\w)/g
        let r = re(r"(?<!\w)(_{1,3})(\S(?:[^\n]*?\S)?)\1(?!\w)").unwrap();
        assert_eq!(
            replace_all(&r, "an _italic_ word", "$2").unwrap(),
            "an italic word"
        );
        // The reason the lookbehind is there at all.
        assert_eq!(
            replace_all(&r, "snake_case_name", "$2").unwrap(),
            "snake_case_name"
        );
        assert_eq!(
            replace_all(&r, "Textmint_0.1.0_aarch64", "$2").unwrap(),
            "Textmint_0.1.0_aarch64"
        );
    }

    #[test]
    fn double_underscore_strong_with_lookbehind() {
        // JS: /(?<!\w)__(\S(?:[^\n]*?\S)?)__(?!\w)/g
        let r = re(r"(?<!\w)__(\S(?:[^\n]*?\S)?)__(?!\w)").unwrap();
        assert_eq!(
            replace_all(&r, "a __strong__ word", "<strong>$1</strong>").unwrap(),
            "a <strong>strong</strong> word"
        );
    }

    #[test]
    fn single_underscore_em_with_lookbehind() {
        // JS: /(?<!\w)_(\S(?:[^\n]*?\S)?)_(?!\w)/g
        let r = re(r"(?<!\w)_(\S(?:[^\n]*?\S)?)_(?!\w)").unwrap();
        assert_eq!(
            replace_all(&r, "an _italic_ word", "<em>$1</em>").unwrap(),
            "an <em>italic</em> word"
        );
        assert!(!replace_all(&r, "snake_case_name", "<em>$1</em>")
            .unwrap()
            .contains("<em>"));
    }

    // The backtrack limit has to actually fire, and it has to come back as an
    // error rather than a panic or a hang. A limit nobody has seen trigger is
    // not a limit.

    /// Bait for the backtracking engine.
    ///
    /// The nested quantifier is the classic catastrophic case, but it is not
    /// enough on its own: fancy-regex hands any pattern without lookaround or a
    /// backreference to the linear-time `regex` engine, which never backtracks
    /// and so never trips the limit. The `(?!b)` is what forces the fancy
    /// engine to run it. Verified by probing several candidates; `(a+)+$`
    /// alone returns Ok.
    const BACKTRACK_BAIT: &str = r"(a+)+(?!b)$";

    #[test]
    fn catastrophic_backtracking_returns_an_error_rather_than_hanging() {
        let r = RegexBuilder::new(BACKTRACK_BAIT)
            .backtrack_limit(1_000)
            .build()
            .unwrap();
        let bait = "a".repeat(40) + "!";
        let err = r.try_replacen(&bait, 0, "x").map_err(CleanError::from);
        assert_eq!(err, Err(CleanError::TooComplex), "the limit must fire");
    }

    #[test]
    fn the_limit_maps_to_a_message_a_user_can_read() {
        assert_eq!(
            CleanError::TooComplex.to_string(),
            "This text is too complex to clean. Try a smaller selection."
        );
    }

    #[test]
    fn a_runtime_error_never_reaches_replace_all_and_panics() {
        // Documents why replace_all() above exists: the library's own
        // replace_all is try_replacen(..).unwrap(). Same input, caught.
        let r = RegexBuilder::new(BACKTRACK_BAIT)
            .backtrack_limit(1_000)
            .build()
            .unwrap();
        let bait = "a".repeat(40) + "!";
        assert!(replace_all(&r, &bait, "x").is_err());
    }

    // Phase 1 refuses rather than half-cleans.

    #[test]
    fn every_toggle_off_matches_the_js_which_also_trims() {
        let o = CleanOptions::default();
        assert_eq!(clean("  hello  ", &o).unwrap(), "hello");
    }

    #[test]
    fn an_unported_pass_is_refused_not_skipped() {
        let o = CleanOptions {
            strip_unicode: true,
            ..Default::default()
        };
        assert_eq!(
            clean("x", &o),
            Err(CleanError::NotPorted("stripUnicode".to_string()))
        );
    }

    #[test]
    fn unported_passes_are_reported_in_pass_order() {
        let o = CleanOptions {
            wrap: true,
            strip_noise: true,
            join_lines: true,
            ..Default::default()
        };
        assert_eq!(
            clean("x", &o),
            Err(CleanError::NotPorted(
                "stripNoise, joinLines, wrap".to_string()
            ))
        );
    }
}
