<!-- bmad:context -->
<!-- Public mirror of the maintainer's agent instructions. Internal tooling and planning paths are removed. -->

## textmint

Tauri v2 desktop app that cleans and converts AI/LLM text on-device. The frontend is static
HTML/CSS/JS with no bundler, the Rust shell only registers plugins, and all cleaning logic lives
in `src/main.js`. macOS aarch64 is the only target built so far.

## Policy

- Never commit to main. Branch, then open a PR.

## Where things are

- All app behavior: `src/main.js`, a single IIFE
- Colors and themes: `src/styles.css`; `docs/DESIGN.md` is the source of truth for tokens
- Plugin registration: `src-tauri/src/lib.rs`; permission grants: `src-tauri/capabilities/default.json`

## Running and verifying

- Run `scripts/check.sh` before pushing. The hooks and CI run the same script, so green here is
  green there. Install the hooks once with `git config core.hooksPath .githooks`.
- `scripts/check.sh` covers the ASCII invariant, `node --check`, JSON validity, version agreement
  across the four files, raw hex in `styles.css`, and `cargo check`. Nothing else is automated.
- There is no test framework and no linter. Verification is: build, launch, paste sample text,
  confirm the output. Say so plainly when that is all you did.
- Run `cargo check` from `src-tauri/`. There is no workspace manifest at the repo root, so a bare
  `cargo check` fails.
- Regenerate icons with `npm run tauri -- icon src-tauri/icon-source.svg`. Without the `--`, npm
  swallows the arguments.
- To test one cleaning pass, copy the function into a scratch harness. `src/main.js` is one IIFE
  that calls `getElementById` at the top, so Node cannot import it. That is how the `_italic_` and
  box-table bugs were verified.

## Conventions that differ from defaults

- `src/main.js` is ASCII only. Write every non-ASCII codepoint as a `\u` escape; literal invisible
  characters get mangled by editors and copy/paste, and the Unicode-stripping regexes are the
  core of the app.
- There is no build step and no frontend packages. Reach Tauri APIs through `window.__TAURI__`
  (see `clip()` at `src/main.js:20`), never `@tauri-apps/api`.
- Colors are `--clr-*` custom properties. Never write a raw hex outside the `:root` and
  `[data-theme="light"]` token blocks, and never change a token without rechecking its contrast
  pair in `docs/DESIGN.md`.
- Commit messages are lowercase conventional with a scope: `fix(clean):`, `ui(header):`.

## Known pitfalls

- Adding a cleaning option takes four edits and fails quietly if you miss one: a checkbox with an
  `id` and a `data-tip` inside `.controls` in `src/index.html`, the id in `PREF_CHECKS`
  (`src/main.js:52`), an `opt()` branch at the correct position in `clean()`, and the same branch
  in `cleanToHtml()` if the pass should affect Copy HTML. Preferences persist to `localStorage`
  under `textmint-prefs`, theme under `textmint-theme`.
- `clean()` (`src/main.js:287`) and `cleanToHtml()` (`:278`) are separate paths, and
  `cleanToHtml()` skips strip-markdown and does not mask protected blocks. Editing one does not
  change the other; the drift between them is the usual cause of "Copy and Copy HTML disagree".
- Pass order in `clean()` is load-bearing, and the run is wrapped in `maskProtected` /
  `unmaskProtected` (`src/main.js:198`), which is what keeps table columns aligned. To protect new
  content, extend the masking; never teach an individual pass to skip tables.
- A new plugin or command needs a matching entry in `src-tauri/capabilities/default.json`. Without
  it the app builds fine and then fails at runtime with a permission error.
- A version bump touches four files: `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, and the `.footer-version` span in `src/index.html`, which carries
  only major.minor (`v0.2`).

<!-- /bmad:context -->
