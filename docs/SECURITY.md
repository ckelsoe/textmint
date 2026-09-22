# Textmint — Security notes

Record of security advisories and how they were handled.

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
