//! The option set the cleaning pipeline takes.
//!
//! This mirrors `DEFAULTS` in `src/pipeline.js` exactly. The JS side sends
//! camelCase keys built by `opts()` in `src/main.js` from the checkbox ids in
//! `src/index.html`, so the rename is not cosmetic: get it wrong and the field
//! silently falls back to its default rather than failing, which is the quiet
//! failure mode `AGENTS.md` warns about for adding an option.

use serde::Deserialize;

/// Eight toggles plus the wrap width, in the same order as `clean()` applies
/// them. Adding one here is not enough on its own: see the five-edit list in
/// `AGENTS.md`, plus this struct once the port is live.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CleanOptions {
    pub strip_noise: bool,
    pub strip_unicode: bool,
    pub strip_markdown: bool,
    pub bullets: bool,
    pub join_lines: bool,
    pub strip_indent: bool,
    pub collapse_blank: bool,
    pub wrap: bool,
    pub wrap_width: usize,
}

/// `serde(default)` above makes a missing key fall back to this field by field,
/// which is what `{ ...DEFAULTS, ...options }` does on the JS side. Every toggle
/// is off and the width is 80, matching `DEFAULTS`.
impl Default for CleanOptions {
    fn default() -> Self {
        Self {
            strip_noise: false,
            strip_unicode: false,
            strip_markdown: false,
            bullets: false,
            join_lines: false,
            strip_indent: false,
            collapse_blank: false,
            wrap: false,
            wrap_width: 80,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_js_defaults() {
        let o = CleanOptions::default();
        assert!(!o.strip_noise);
        assert!(!o.strip_unicode);
        assert!(!o.strip_markdown);
        assert!(!o.bullets);
        assert!(!o.join_lines);
        assert!(!o.strip_indent);
        assert!(!o.collapse_blank);
        assert!(!o.wrap);
        assert_eq!(o.wrap_width, 80);
    }

    #[test]
    fn deserializes_the_camel_case_keys_the_frontend_sends() {
        // Exactly the object opts() in src/main.js builds.
        let json = r#"{
            "stripNoise": true, "stripUnicode": true, "stripMarkdown": true,
            "bullets": true, "joinLines": true, "stripIndent": true,
            "collapseBlank": true, "wrap": true, "wrapWidth": 72
        }"#;
        let o: CleanOptions = serde_json::from_str(json).expect("should deserialize");
        assert!(o.strip_noise && o.strip_unicode && o.strip_markdown);
        assert!(o.bullets && o.join_lines && o.strip_indent);
        assert!(o.collapse_blank && o.wrap);
        assert_eq!(o.wrap_width, 72);
    }

    #[test]
    fn a_missing_key_falls_back_rather_than_failing() {
        let o: CleanOptions = serde_json::from_str(r#"{"stripUnicode": true}"#).unwrap();
        assert!(o.strip_unicode);
        assert!(!o.strip_noise);
        assert_eq!(o.wrap_width, 80);
    }

    #[test]
    fn snake_case_keys_are_not_silently_accepted() {
        // Guards the rename: if rename_all were dropped, this would parse and
        // the real camelCase payload would start defaulting instead.
        let o: CleanOptions = serde_json::from_str(r#"{"strip_unicode": true}"#).unwrap();
        assert!(!o.strip_unicode, "snake_case must not bind to the field");
    }
}
