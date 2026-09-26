# Textmint — Design System

**As of:** 2026-08-24, components updated 2026-09-26 · **Status:** adopted and **applied** to `src/styles.css` (Whisper palette, mint focus rings)

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
| `--clr-raised` | `#2F3331` | The Settings drawer, raised above the chrome |
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
| focus ring | `#33C89E` | Keyboard focus outline |

### Light theme

| Token | Hex | Role |
|-------|-----|------|
| `--clr-bg` | `#EDF0EF` | Window / base surface |
| `--clr-surface` | `#F5F8F7` | Chrome / elevated |
| `--clr-raised` | `#FAFCFB` | The Settings drawer, raised above the chrome |
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

- **Primary button (Clean):** mint bg, `--clr-mint-txt`. The only mint-filled control in the
  header. The other mint fill is the status-bar update pill (below).
- **Secondary (Copy / Copy HTML):** neutral `--clr-sec`.
- **Clear (Input pane):** a text button at the right of the Input header, `--clr-dim`, shown
  only while the input has text; a `--clr-border` outline on hover. After a clear, "Cleared
  Undo" takes its place for about 5 seconds, the Undo a `.link-btn`. It replaced the header's
  ghost Clear button and its `--clr-clear*` tokens on 2026-09-26.
- **Checkboxes:** `accent-color: var(--clr-mint)`.
- **Focus:** every interactive element gets a visible mint focus ring (keyboard nav).
- **Tooltips:** inverted surface, subtle shadow.
- **Header:** an action bar since 0.6.0: Copy text, Copy markdown, Copy HTML (one look,
  `--clr-sec`, mint "Copied!" flash), and the theme toggle. No settings live there. Clear moved
  to the Input pane on 2026-09-26.
- **Icon buttons** (`.icon-btn`): round, ghost style, mint on hover. The theme toggle in the
  header; the settings gear, smaller, at the right of the Output tab row.
- **Settings drawer:** non-modal, over the input pane (440px, or 50%; full width below 800px),
  `--clr-raised` (a step above the chrome's `--clr-surface`, so it does not blend into the
  header and pane labels) with a right border and a soft shadow, so the output stays visible and live.
  A tab row shows one section at a time, in pipeline order (Cleaning, Paste, Text, Markdown,
  HTML): 12px/600 labels in `--clr-dim`, the selected one `--clr-text` with a 2px `--clr-mint`
  underline. Each section has a one-line note in `--clr-dim` on what it affects. Rows are
  label, control and pin on a `minmax(0, 1fr) / 190px / auto` grid: one select width that holds
  the longest option, so the selects line up. Less common settings sit under a "More options" disclosure (12px/600,
  `--clr-dim`, a rotating triangle); a 6px `--clr-mint` dot on its summary means a setting
  inside differs from its default. See `docs/plans/settings-redesign.md`.
- **Pin toggle:** a pushpin outline in `--clr-muted`, `--clr-mint` when pinned. Transparent
  until its row is hovered or focused, unless pinned; it stays in the Tab order.
- **Pinned row:** under the header, hidden when empty. Chips are outlined pills: a toggle chip
  fills with the primary pair when on; a select chip shows "Name: value".
- **Cleaning chip:** an outlined pill in the Output tab row, "Cleaning: n of 5", opening the
  drawer at Cleaning. It keeps the app's core job visible now that the header holds no
  checkboxes.
- **Rich paste chip:** a pill in the Input label while a paste's HTML is held. `--clr-mint`
  text, not `--clr-accent-text`, for the same 11px contrast reason as the update pill.
- **Callouts** in the Preview: a mint left rule on `--clr-surface`, with the label in bold.
- **Update pill:** sits in the status bar after the version, only while an update exists. The
  offer is a small rounded button with the primary pair (`--clr-mint` / `--clr-mint-txt`); its
  status text ("Downloading update 40%") is `--clr-mint` on `--clr-surface`, about 6.7:1 dark and
  4.7:1 light. Not `--clr-accent-text`: that reads ~3.8:1 on the light surface, too low for 11px.
  Mint, not red, because an update is news, not an error.

## Accessibility

All text/background pairs verified against WCAG AA (4.5:1 body, 3:1 large/UI). Key checks:
`--clr-text` on `--clr-bg` >12:1 both themes; white on light primary `#0B7E62` ~4.9:1; dark
`--clr-mint-txt` on `--clr-mint` ~8:1. Do not adjust a color without re-checking its pair.

`--clr-raised` (2026-09-26), the Settings drawer surface:

| Pair on `--clr-raised` | Dark | Light |
|---|---|---|
| `--clr-text` | 10.65:1 | 16.06:1 |
| `--clr-dim` (labels, notes, tabs, More options) | 5.52:1 | 6.91:1 |
| `--clr-mint` (links in the drawer, the changed dot, the tab underline) | 6.04:1 | 4.88:1 |
| `--clr-muted` (the pin icon only, a UI glyph, not text) | 3.04:1 | 3.88:1 |

`--clr-muted` is not used as text on `--clr-raised`. `--clr-accent-text` is 3.98:1 on the light
raised surface, under AA for 13px text, so links inside the drawer (Edit map) use `--clr-mint`.
Selects and the number field keep `--clr-bg`, a step darker (dark) or lighter-tinted (light)
than the drawer, so they still read as fields.

## App icon

**Clean cursor** on graphite + mint (chosen 2026-08-24): a monospace text cursor with a
"sparkle," on the same green-charcoal squircle as the app chrome. Reads as a text/editor tool
and stays legible down to a 16px favicon. Source: `src-tauri/icon-source.svg` (1024px, vector);
the full platform set is generated with `npm run tauri -- icon src-tauri/icon-source.svg`.
Marks: cursor `#33C89E`, sparkle `#CFEAE0`, tile gradient `#2B302E` → `#191D1C`.

## Related

- `ROADMAP.md` — color scheme + markdown preview are the P0 design items.
- Preview artifact: "Textmint Theme Preview" (mockups of both themes + swatches).
