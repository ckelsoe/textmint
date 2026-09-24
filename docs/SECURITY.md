# Textmint — Security notes

Record of security advisories and how they were handled.

## Network activity

Textmint's promise is that document text never leaves the machine, and it does not. The one
outbound call the app makes is the update check: on launch (unless turned off in the About box)
it fetches `releases/latest/download/latest.json` from GitHub and compares version numbers. That
request carries no document text and no identifiers beyond a normal HTTPS request to GitHub. The
check runs in the Rust process through the updater plugin, not in the webview, so it is not
governed by the page CSP. It can be turned off with the "Check for updates when Textmint starts"
toggle, and the About box states plainly what the check sends. When a user installs an update,
the download is verified against the updater public key baked into the app before it is applied.
See `docs/plans/self-update.md`.

Pasted HTML is untrusted input and never reaches the page as written. It passes through
`ammonia`, an allowlist sanitizer, before anything else reads it (`src-tauri/src/html.rs`):
scripts, event handlers, `javascript:` and `data:` links, iframes, forms and embeds are removed
in every mode, whatever the HTML settings say, and styles that can overlay the page or load
content (`position`, `url(...)`, `image-set()`, CSS escapes) are dropped even under "All"
(`html::can_fetch`). Raw HTML inside markdown is
dropped inline and sanitized with a stricter allowlist as a block (`engine::render_with`). The
CSP (`img-src 'self' data:`, `font-src 'self' data:`) stops the Preview fetching a paste's
remote images or fonts, so viewing a paste sends nothing; Copy HTML keeps those references for
the document they are pasted into.

Development builds can include an MCP bridge for AI-driven UI testing
(`tauri-plugin-mcp-bridge`). It is an optional Cargo feature that release builds never
compile, is registered only in debug builds, and is bound to `127.0.0.1`. It has no
authentication, so a local page could reach it during such a session. See
`docs/AUTOMATION.md`.

The About box also has links to the GitHub repo and the new-issue page. Clicking one launches
the default browser at that page through the opener plugin, which is scoped in
`capabilities/default.json` to those repo URLs alone. That is a user-initiated browser launch,
not the app transmitting anything.

## Dependency advisories

### glib `VariantStrIter` unsoundness — GHSA-wrw7-89jp-8q8g (dismissed 2026-08-24)

- **Package:** `glib` 0.18.5 (Rust) · **Severity:** medium · **Patched in:** 0.20.0
- **Where:** transitive dependency `src-tauri/Cargo.lock`.
- **Dependency chain:** `glib 0.18.5` ← `gtk 0.18.2` (`glib = "^0.18"`) ← `tauri 2.11.5`
  (`gtk = "^0.18"`) ← `textmint`.

**Why it was dismissed as "not used":**
- `glib` is part of the **GTK / WebKitGTK** stack, which is compiled **only for Linux**
  targets. Textmint currently ships **macOS only** (WKWebView) — the macOS build never
  compiles or links `glib`, so the vulnerable `VariantStrIter` code is **not present in the
  shipped artifact**.
- The fix requires `glib` 0.20, which needs a newer gtk-rs stack. **Tauri 2.11 pins
  `gtk = "^0.18"`**, so `cargo update` cannot reach 0.20, and a `[patch]` override would break
  the build (0.18 → 0.20 is a breaking API change). The upgrade is **upstream-gated** by Tauri.

**Revisit this when:**
- A Tauri release bumps its gtk-rs stack to one using `glib` 0.20+ → then `cargo update` clears it, **or**
- We add a **Linux build** target (roadmap P2) → re-evaluate before shipping Linux binaries,
  since that build *would* link `glib`.

### Update 2026-09-20 (checked while scoping Linux installers)

The upstream fix now exists, but Tauri has not taken it yet.

- `gtk` **0.19.0** was published 2026-09-08 and requires `glib ^0.22`, well past the 0.20 fix.
- `tauri` 2.11.6 (current latest, and what we now build against) still declares `gtk = "^0.18"`,
  which excludes 0.19. Nothing in our `Cargo.toml` mentions `gtk` or `glib`; the bound is Tauri's.
- Verified empirically: after a full `cargo update`, `cargo update -p glib` locks 0 packages and
  `glib` stays at 0.18.5.
- A `[patch]` override to gtk 0.19 would move glib 0.18 to 0.22 across four releases of breaking
  API change, against code written for 0.18, so it is not a workaround.

**Sharper revisit trigger:** watch for a Tauri release that relaxes `gtk = "^0.18"` to `^0.19`.
At that point `cargo update` clears the advisory with no other work.

**Decision:** Linux installers are on hold until that lands. macOS and Windows are unaffected,
since neither links `glib`, and they ship first.

**Not applicable to Apple/Windows signing or the macOS/Windows builds.**
