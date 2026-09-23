# Textmint

**Clean and convert AI text — entirely on-device.**

Textmint takes raw AI/LLM output and turns it into clean, paste-ready text. It strips
the tell-tale signs of machine-generated text (invisible Unicode, terminal noise,
markdown artifacts) and converts between formats. Everything runs locally in a native
macOS app — **your text never leaves your machine**, which is the whole point versus the
browser-based "AI text cleaner" tools that make you paste confidential text into a website.

Built with [Tauri](https://tauri.app) (Rust + system WebView), so the app is a few MB,
not a few hundred.

## Features

- **Strip AI noise** — removes `Thought for Xs` lines, nested-output markers, tool-call
  bullets, and `(ctrl+o to expand)` artifacts.
- **Strip Unicode junk** — emojis, zero-width characters, variation selectors, bidi marks,
  control characters, math and non-ASCII currency symbols.
- **Reflow & tidy** — join soft-wrapped paragraph lines, normalize bullets, collapse blank
  lines, strip leading indentation, hard-wrap at a chosen width.
- **Three outputs, three copy buttons** — **Copy text** (plain, markdown removed), **Copy
  markdown**, and **Copy HTML**, which pastes into Outlook or Word as rich text with bold,
  bullets, and headers intact.
- **Rich paste** — paste from Word, Google Docs, a web page or a chat app and the
  formatting comes with it: headings, lists, bold and tables arrive as markdown, and the
  HTML output keeps the source's formatting with the junk (Word's `mso-*` styles, fake
  bullets, tracking parameters) removed.
- **One settings drawer** beside the live output: the cleaning passes, paste handling, and
  each output's options (markdown flavor and style, what the HTML keeps). Pin the settings
  you change often to a bar under the header.
- Live output as you type or paste, saved preferences, dark/light mode, keyboard shortcuts
  (`Cmd+Shift+C` copy text, `Cmd+Shift+M` copy markdown, `Cmd+Shift+H` copy HTML).

## Develop

Requires [Rust](https://rustup.rs) (`rustup default stable`) and Node.

```bash
npm install
npm run dev      # launch the app in dev mode
npm run build    # produce a release .app / .dmg in src-tauri/target/release/bundle
scripts/check.sh # the same checks CI runs
```

Install the git hooks once with `git config core.hooksPath .githooks`.

## Project layout

```
src/                 Frontend (static HTML/CSS/JS, no bundler)
  index.html         UI markup
  styles.css         Mint-green theme (dark default + light)
  main.js            Cleaning pipeline + native clipboard (ASCII-only source)
src-tauri/           Rust shell
  src/lib.rs         App entry; registers the clipboard-manager plugin
  tauri.conf.json    Window, bundle, identifier (dev.kelsoe.textmint)
  capabilities/      Permission grants (clipboard write-text / write-html)
```

## Roadmap

- Global hotkey + menu-bar mode (clean the clipboard from anywhere)
- Markdown -> HTML, HTML -> Markdown, Markdown -> Word (.docx) conversion
- Saved cleaning profiles per target (Email / Slack / Plain)
- Optional AI-detection score (before/after)
- Move the pipeline into Rust for speed and unit tests
- App icon (mint-green)

## License

MIT. See [LICENSE](LICENSE).
