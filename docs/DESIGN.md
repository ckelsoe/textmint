# Textmint — Design System

**As of:** 2026-08-24 · **Status:** adopted and **applied** to `src/styles.css` (Whisper palette, mint focus rings)

The visual system for Textmint. Built with the `brand-identity` design method: a mint identity
with **deliberately quiet, near-neutral surfaces** so the accent does the talking. Live preview:
the "Textmint Theme Preview" artifact.

---

## Principles

1. **Mint is an accent, not the room.** Green appears only on the primary action, the wordmark,
   checked states, focus rings, and a faint tint on the *output* text. Everything else is
   near-neutral graphite. (We started with green-biased neutrals; they read as "a green app,"
   so the green was dialed back — see "The green dial" below.)
2. **Dark, not black.** Deepest surface is `#191C1B`; base is `#202322`. Never `#000`.
3. **Light, tinted, not bright.** No pure white anywhere; base is `#EDF0EF`, a low-glare
   near-neutral with a whisper of green.
4. **On-device, technical, calm.** Native system UI font, monospace editor, no decorative
   gradients or shadows beyond subtle elevation.
5. **WCAG AA everywhere.** 4.5:1 for body text, 3:1 for large text / UI components.

---

## Color tokens

Token names match the CSS custom properties in `src/styles.css` (`--clr-*`). "Whisper" setting.

### Dark theme (default)

| Token | Hex | Role |
|-------|-----|------|
| `--clr-bg` | `#202322` | Window / base surface |
| `--clr-surface` | `#282B2A` | Chrome: header, status bar, elevated |
| `--clr-out-bg` | `#191C1B` | Editor / output well (deepest) |
| `--clr-border` | `#363A38` | Dividers, control borders |
| `--clr-border-sub` | `#262928` | Subtle inner borders |
| `--clr-text` | `#E7EBE9` | Primary text |
| `--clr-dim` | `#A4ACA8` | Secondary text, labels |
| `--clr-muted` | `#767D79` | Tertiary / placeholder |
| `--clr-out-txt` | `#C9E5DB` | Output text (the one lingering mint) |
| `--clr-mint` | `#33C89E` | Primary button bg, checkboxes |
| `--clr-mint-h` | `#49D6AE` | Primary hover |
| `--clr-mint-txt` | `#06231B` | Text/icon on mint |
| `--clr-accent-text` | `#57D6B3` | Wordmark "mint", links |
| `--clr-sec` / `--clr-sec-h` | `#313633` / `#3C433F` | Secondary button |
| `--clr-clear-txt` | `#A4ACA8` | Ghost (Clear) button text |
| focus ring | `#33C89E` | Keyboard focus outline |

### Light theme

| Token | Hex | Role |
|-------|-----|------|
| `--clr-bg` | `#EDF0EF` | Window / base surface |
| `--clr-surface` | `#F5F8F7` | Chrome / elevated |
| `--clr-out-bg` | `#F1F6F4` | Output well |
| `--clr-border` | `#DBE1DF` | Dividers, control borders |
| `--clr-border-sub` | `#E7EBE9` | Subtle inner borders |
| `--clr-text` | `#1A201E` | Primary text |
| `--clr-dim` | `#515A57` | Secondary text |
| `--clr-muted` | `#79817D` | Tertiary / placeholder |
| `--clr-out-txt` | `#163A2E` | Output text |
| `--clr-mint` | `#0B7E62` | Primary button bg |
| `--clr-mint-h` | `#096A52` | Primary hover |
| `--clr-mint-txt` | `#FFFFFF` | Text/icon on mint |
| `--clr-accent-text` | `#0E8E6F` | Wordmark "mint", links |
| `--clr-sec` / `--clr-sec-h` | `#DFE6E3` / `#CFDDD7` | Secondary button |
| `--clr-clear-txt` | `#515A57` | Ghost button text |
| focus ring | `#0E8E6F` | Keyboard focus outline |

### Mint accent scale (shared reference)

| Step | Hex | Use |
|------|-----|-----|
| mint-300 | `#5FE0BE` | glow / hover highlights |
| mint-400 | `#33C89E` | dark-theme accent |
| mint-500 | `#12A98A` | mid |
| mint-600 | `#0E8E6F` | light-theme accent (text) |
| mint-700 | `#0B7E62` | light-theme primary button |

---

## The green dial

The amount of green in the **neutrals** is a single lever. Current setting is **Whisper**.

| Setting | Neutrals | When to use |
|---------|----------|-------------|
| Whisper *(current)* | Near-graphite, trace of green | Related to mint, not "a green app" |
| Neutral | True gray, zero green | Mint is the only color anywhere |
| Cool-slate | Faint blue bias | Colder, more "developer tool," clearly not green |

To change: shift the neutral tokens' hue; the mint accent tokens stay put.

---

## Typography

- **UI:** `-apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif` — native on
  macOS by design (a native app should use the system face).
- **Editor / panes:** `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`.
- **Scale:** wordmark 15/700 · buttons & controls 11.5–13 · pane labels 11 uppercase +0.08em ·
  editor 13 mono / 1.6 · status bar 11. No sizes outside this scale.

## Spacing, radius, elevation

- **Spacing scale:** 4 · 6 · 8 · 12 · 16 · 24 px. Layout uses flex/grid `gap`, not per-element margins.
- **Radius:** 6px controls/buttons · 10–12px windows/cards · 50% theme dot.
- **Elevation:** flat by default; 1px token borders separate surfaces. Reserve shadows for
  floating elements (tooltips).

## Component notes

- **Primary button (Clean):** mint bg, `--clr-mint-txt`. The only mint-filled control.
- **Secondary (Copy / Copy HTML):** neutral `--clr-sec`.
- **Ghost (Clear):** transparent, bordered.
- **Checkboxes:** `accent-color: var(--clr-mint)`.
- **Focus:** every interactive element gets a visible mint focus ring (keyboard nav).
- **Tooltips:** inverted surface, subtle shadow.

## Accessibility

All text/background pairs verified against WCAG AA (4.5:1 body, 3:1 large/UI). Key checks:
`--clr-text` on `--clr-bg` >12:1 both themes; white on light primary `#0B7E62` ~4.9:1; dark
`--clr-mint-txt` on `--clr-mint` ~8:1. Do not adjust a color without re-checking its pair.

## App icon

**Clean cursor** on graphite + mint (chosen 2026-08-24): a monospace text cursor with a
"sparkle," on the same green-charcoal squircle as the app chrome. Reads as a text/editor tool
and stays legible down to a 16px favicon. Source: `src-tauri/icon-source.svg` (1024px, vector);
the full platform set is generated with `npm run tauri -- icon src-tauri/icon-source.svg`.
Marks: cursor `#33C89E`, sparkle `#CFEAE0`, tile gradient `#2B302E` → `#191D1C`.

## Related

- `ROADMAP.md` — color scheme + markdown preview are the P0 design items.
- Preview artifact: "Textmint Theme Preview" (mockups of both themes + swatches).
