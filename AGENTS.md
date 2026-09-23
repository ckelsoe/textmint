<!-- bmad:context -->
<!-- Public mirror of the maintainer's agent instructions. Internal tooling and planning paths are removed. -->

## textmint

Tauri v2 desktop app that cleans and converts AI/LLM text on-device. The frontend is static
HTML/CSS/JS served as native ES modules with no bundler, and the Rust shell registers plugins
and one command. `src/pipeline.js` holds the cleaning passes as pure string-to-string functions
with no DOM access; `src/main.js` is UI wiring. macOS aarch64 is the only target built so far.

## Policy

- Never commit to main. Branch, then open a PR.

## Where things are

- Cleaning passes: `src/pipeline.js`, pure string-to-string functions, no DOM
- UI wiring, clipboard, prefs, theme: `src/main.js`
- Tests: `test/pipeline.test.js`; snapshot spec: `test/snapshots.json`, regenerated with
  `node scripts/regen-snapshots.js`
- Colors and themes: `src/styles.css`; `docs/DESIGN.md` is the source of truth for tokens
- Plugin registration: `src-tauri/src/lib.rs`; permission grants: `src-tauri/capabilities/default.json`

## Running and verifying

- Run `scripts/check.sh` before pushing. The hooks and CI run the same script, so green here is
  green there. Install the hooks once with `git config core.hooksPath .githooks`.
- `scripts/check.sh` covers the ASCII invariant on every file in `src/` and `test/`,
  `node --check`, the test suite, JSON validity, version agreement across the four files, raw
  hex in `styles.css`, `cargo fmt --check`, `cargo check` and `cargo clippy -D warnings`.
- `npm test` runs the pipeline tests directly. There is no JS linter; clippy covers the Rust
  side. The tests cover the cleaning passes, not the UI, so a UI change still needs: build,
  launch, paste sample text, confirm the output. Say so plainly when that is all you did.
- Run `cargo check` from `src-tauri/`. There is no workspace manifest at the repo root, so a bare
  `cargo check` fails.
- Regenerate icons with `npm run tauri -- icon src-tauri/icon-source.svg`. Without the `--`, npm
  swallows the arguments.
- To test one cleaning pass, import it in `test/pipeline.test.js` and run `npm test`.
  `src/pipeline.js` is plain ES modules with no DOM access, so Node imports it directly.
  `src/main.js` is UI wiring and touches the DOM, so it is not importable.

## Conventions that differ from defaults

- `src/main.js`, `src/pipeline.js` and the files in `test/` are ASCII only. Write every
  non-ASCII codepoint as a `\u` escape; literal invisible characters get mangled by editors and
  copy/paste, and the Unicode-stripping regexes are the core of the app. `check.sh` enforces it.
- There is no build step and no frontend packages. Reach Tauri APIs through `window.__TAURI__`
  (see `clip()` at `src/main.js:22`), never `@tauri-apps/api`.
- Colors are `--clr-*` custom properties. Never write a raw hex outside the `:root` and
  `[data-theme="light"]` token blocks, and never change a token without rechecking its contrast
  pair in `docs/DESIGN.md`.
- Commit messages are lowercase conventional with a scope: `fix(clean):`, `ui(header):`.

## Known pitfalls

- Adding a cleaning option takes five edits and fails quietly if you miss one: a checkbox with an
  `id`, a `data-tip` and a `data-setting` row in its section of the Settings drawer in
  `src/index.html`, the id in `SETTING_SECTIONS` (`src/controls.js`), the id in `CHECK_IDS` (`src/controls.js`), a key in `opts()` in `src/main.js`, a key in `DEFAULTS` in
  `src/pipeline.js`, and a branch at the correct position in `clean()`, plus the same branch in
  `cleanToHtml()` if the pass should affect Copy HTML. Preferences persist to `localStorage`
  under `textmint-prefs`, theme under `textmint-theme`.
- `clean()` (`src/pipeline.js:348`) and `cleanToHtml()` (`:371`) are separate paths. The
  only remaining difference is that `cleanToHtml()` skips strip-markdown. Both now wrap their
  pass run in `maskProtected` / `unmaskProtected` and both detect blocks with the one
  `scanProtected()` (`:166`), so they agree on what is protected **and** on not mutating
  it. Those were two separate bugs on 2026-09-20: three fence patterns meant Copy HTML shredded
  indented and unclosed fences, and then running the passes before protection meant it flattened
  code indentation under the shipped defaults. Editing one path still does not change the other,
  so change both or say why not.
- Protected-block detection belongs in `scanProtected()` and nowhere else, and any new pass
  runs inside the mask. Adding a kind or a pass to one path only is how both of those bugs
  happened.
- Pass order in `clean()` is load-bearing, and the run is wrapped in `maskProtected` /
  `unmaskProtected` (`src/pipeline.js:201`), which is what keeps table columns aligned and code
  indented. `cleanToHtml()` has the same wrapper. To protect new content, extend `scanProtected`;
  never teach an individual pass to skip tables.
- A new plugin or command needs a matching entry in `src-tauri/capabilities/default.json`. Without
  it the app builds fine and then fails at runtime with a permission error.
- A version bump touches four files: `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, and the `.footer-version` span in `src/index.html`, which carries
  the full version (`v0.2.0`). The running app overwrites the span from Tauri at startup.

<!-- /bmad:context -->
