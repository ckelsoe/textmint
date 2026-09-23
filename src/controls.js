// Control ids in src/index.html, in one place so the preferences loader
// (src/main.js) and the automation bridge (src/bridge.js) cannot drift.
//
// CHECK_IDS: the cleaning-option checkboxes, all in the Settings drawer. The
// five in CLEAN_IDS change the text and so every output; bullets and wrap only
// shape the Text output. Strip markdown is not a setting: the Text output always
// strips it (the pipeline keeps the option for the CLI).
export const CHECK_IDS = [
  "opt-strip-noise", "opt-strip-unicode", "opt-wrap",
  "opt-collapse-blank", "opt-strip-indent", "opt-bullets", "opt-join-lines",
];

// The cleaning passes the tab row's "Cleaning: n of 5" chip counts.
export const CLEAN_IDS = [
  "opt-strip-noise", "opt-strip-unicode", "opt-join-lines", "opt-strip-indent",
  "opt-collapse-blank",
];


// The drawer's sections, in order, and the setting rows in each. The drawer
// opens at the section for the active Output tab, and test/controls.test.js
// checks index.html against this. opt-wrap's row also holds opt-wrap-width.
export const SETTING_SECTIONS = {
  cleaning: CLEAN_IDS,
  paste: ["opt-rich-paste", "md-math", "md-merged"],
  text: ["opt-bullets", "opt-wrap"],
  markdown: [
    "md-flavor", "md-bullet", "md-emphasis", "md-heading", "md-fence", "md-links",
    "md-highlight", "md-gfm", "md-callouts", "md-wrap",
  ],
  html: [
    "html-mode", "html-styles", "html-images", "html-colors", "html-fonts",
    "html-table-style", "html-classes", "html-tracking", "html-tidy",
  ],
};

// Every setting the drawer holds, in section order. Each can be pinned.
export const PINNABLE = Object.values(SETTING_SECTIONS).flat();

// SETTING_IDS: the drawer's Paste, Markdown and HTML controls, checkbox or
// select, derived from SETTING_SECTIONS so there is one list to edit. Prefs and
// the bridge read each by its element type. Adding a setting adds its id to
// SETTING_SECTIONS, a row in #settings-drawer, and a read in src/main.js.
export const SETTING_IDS = PINNABLE.filter((id) => !CHECK_IDS.includes(id));

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


// The drawer section to open for an Output tab.
export const SECTION_FOR_VIEW = { text: "text", markdown: "markdown", html: "html", rendered: "html" };

// Saved preferences, keeping only controls that exist now. 0.5.0 saved
// opt-strip-markdown, which is no longer a setting; anything like it is dropped
// here instead of reaching a control that is not there.
export function knownPrefs(saved) {
  const keep = new Set(CHECK_IDS.concat(SETTING_IDS, ["opt-wrap-width"]));
  const out = {};
  if (!saved || typeof saved !== "object") return out;
  Object.keys(saved).forEach((id) => { if (keep.has(id)) out[id] = saved[id]; });
  return out;
}

// Pinned settings: a list of setting ids, kept only while each is still a
// pinnable setting, in the order the user pinned them.
export function knownPins(saved) {
  if (!Array.isArray(saved)) return [];
  return saved.filter((id, i) => PINNABLE.includes(id) && saved.indexOf(id) === i);
}

