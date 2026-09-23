// Control ids in src/index.html, in one place so the preferences loader
// (src/main.js) and the automation bridge (src/bridge.js) cannot drift.
//
// CHECK_IDS: the eight cleaning-option checkboxes. Five sit in the header and
// apply to every output; strip-markdown, bullets and wrap sit in the Settings
// panel's Text section, since they only shape the Text output.
export const CHECK_IDS = [
  "opt-strip-noise", "opt-strip-unicode", "opt-strip-markdown", "opt-wrap",
  "opt-collapse-blank", "opt-strip-indent", "opt-bullets", "opt-join-lines",
];

// SETTING_IDS: the Settings panel's Markdown and HTML controls, checkbox or
// select. Prefs and the bridge read each by its element type. Adding a setting
// adds its id here, a control in #settings-modal, and a read in src/main.js.
export const SETTING_IDS = [
  "md-flavor", "md-bullet", "md-emphasis", "md-heading", "md-fence", "md-links",
  "md-merged", "md-math", "md-highlight", "md-gfm", "md-callouts", "md-wrap",
  "opt-rich-paste", "html-mode", "html-styles", "html-images", "html-colors",
  "html-fonts", "html-table-style", "html-classes", "html-tracking", "html-tidy",
];

// What each markdown flavor sets. Only the settings a flavor decides: the style
// choices (bullets, emphasis, headings, fences, links) stay as the user left
// them, so picking a flavor never restyles markdown the user did not ask about.
export const MD_PRESETS = {
  commonmark: { "md-gfm": false, "md-math": "text", "md-highlight": "plain" },
  github: { "md-gfm": true, "md-math": "dollar", "md-highlight": "plain" },
  obsidian: { "md-gfm": true, "md-math": "dollar", "md-highlight": "equals" },
};

// The HTML settings' defaults, keyed as the Rust HtmlOptions expects
// (src-tauri/src/html.rs). Keep it a flat object of plain literals with no
// comments inside: a Rust test (html/tests.rs) reads it as JSON-like text. The Settings controls in src/index.html start at
// these values, which test/controls.test.js checks, and the CLI sends them, so
// `textmint html` matches a fresh app.
export const HTML_DEFAULTS = {
  styles: "safe", images: "keep", colors: true, fonts: false,
  tableStyle: true, classes: false, stripTracking: true, tidy: true,
};

// Settings control id -> HtmlOptions key. The one mapping main.js reads.
export const HTML_OPTION_IDS = {
  "html-styles": "styles", "html-images": "images", "html-colors": "colors",
  "html-fonts": "fonts", "html-table-style": "tableStyle", "html-classes": "classes",
  "html-tracking": "stripTracking", "html-tidy": "tidy",
};

// The renderer flavor (engine::Flavor) for a markdown flavor and the GitHub
// extensions setting: with the extensions off it is CommonMark, whatever the
// flavor. The app and the CLI both call this, so they cannot disagree.
export function renderFlavorFor(flavor, gfm) {
  if (!gfm) return "commonmark";
  return flavor === "obsidian" ? "obsidian" : "github";
}
