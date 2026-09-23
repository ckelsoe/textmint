// Settings drawer, the cleaning chip, and pinned settings. ASCII only, same rule
// as the rest of src/.
//
// The drawer (#settings-drawer) is the one place settings are defined. It is
// non-modal: it slides over the input pane and leaves the output live, so a
// change shows as it is made. See docs/plans/settings-drawer.md.
//
// A pinned setting is a mirror, not a copy: its chip in #pinned-row reads the
// drawer control and, when changed, sets that control and fires its change
// event. So saving, presets and re-rendering all run through the drawer's one
// change handler (src/main.js), whichever of the two the user touched.

import { CLEAN_IDS, SECTION_FOR_VIEW, knownPins } from "./controls.js";

const PIN_KEY = "textmint-pins";

// A pushpin outline, drawn in the text color.
const PIN_SVG =
  '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M9.5 1.5l5 5-2 .5-2.5 2.5.5 3.5-1.5 1.5L6 11l-4 4-.5-.5 4-4L2.5 7.5 4 6l3.5.5L10 4z" ' +
  'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

function el(id) { return document.getElementById(id); }

function loadPins() {
  try { return knownPins(JSON.parse(localStorage.getItem(PIN_KEY))); } catch (e) { return []; }
}
function savePins(pins) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch (e) { /* storage unavailable */ }
}

// A setting's row in the drawer.
function rowOf(id) { return document.querySelector('#settings-drawer [data-setting="' + id + '"]'); }

// The words a setting is called by: the row's data-short, else its label.
function labelOf(id) {
  const r = rowOf(id);
  if (r && r.dataset.short) return r.dataset.short;
  const label = document.querySelector('#settings-drawer label[for="' + id + '"]');
  return label ? label.textContent.trim() : id;
}

// ctx.activeView() names the active Output tab; ctx.onChange(event) is the
// drawer's change handler in main.js.
export function initDrawer(ctx) {
  const drawer = el("settings-drawer");
  const gear = el("btn-settings");
  const chip = el("cleaning-chip");
  const row = el("pinned-row");
  let pins = loadPins();

  function isOpen() { return !drawer.hidden; }

  function open(section) {
    drawer.hidden = false;
    gear.setAttribute("aria-expanded", "true");
    const head = el("section-" + section + "-title") || el("settings-title");
    head.scrollIntoView({ block: "start" });
    head.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    drawer.hidden = true;
    gear.setAttribute("aria-expanded", "false");
    gear.focus();
  }

  gear.addEventListener("click", () => {
    if (isOpen()) close();
    else open(SECTION_FOR_VIEW[ctx.activeView()] || "cleaning");
  });
  chip.addEventListener("click", () => open("cleaning"));
  el("settings-close").addEventListener("click", close);
  // Capture phase, so this runs before any bubbling Escape handler whatever the
  // init order; preventDefault marks it handled, and update.js skips handled
  // events, so closing the drawer never also defers a downloaded update.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    e.preventDefault();
    close();
  }, true);

  // --- Pins -------------------------------------------------------------------
  function setPinned(id, on) {
    pins = on ? pins.concat([id]) : pins.filter((p) => p !== id);
    pins = knownPins(pins);
    savePins(pins);
    refresh();
  }

  // One pin toggle per setting row.
  drawer.querySelectorAll("[data-setting]").forEach((settingRow) => {
    const id = settingRow.dataset.setting;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pin";
    b.innerHTML = PIN_SVG;
    b.dataset.pin = id;
    b.addEventListener("click", (e) => {
      e.preventDefault(); // inside a label row: do not toggle the checkbox
      setPinned(id, !pins.includes(id));
    });
    settingRow.appendChild(b);
  });

  // Set a drawer control from a chip, as a click in the drawer would.
  function drive(control, value) {
    if (control.type === "checkbox") control.checked = value;
    else control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Each chip reports how to repaint itself from its drawer control, so a value
  // change updates chips in place and the one in use keeps focus.
  const chipSync = new Map();

  function chipShell(id, name) {
    const c = document.createElement("span");
    c.className = "pin-chip";
    c.dataset.tip = name + ". Pinned from Settings; right-click to unpin.";
    c.addEventListener("contextmenu", (e) => { e.preventDefault(); setPinned(id, false); });
    return c;
  }

  // A checkbox: a toggle, plus the row's companion field (wrap width) if any.
  function checkboxChip(id, control, name) {
    const c = chipShell(id, name);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pin-toggle";
    b.textContent = name;
    b.addEventListener("click", () => drive(control, !control.checked));
    c.appendChild(b);
    const companion = el(rowOf(id).dataset.companion || "");
    let n = null;
    if (companion) {
      n = document.createElement("input");
      n.type = "number";
      n.min = companion.min;
      n.max = companion.max;
      n.setAttribute("aria-label", labelOf(id) + " value");
      n.addEventListener("change", () => drive(companion, n.value));
      c.appendChild(n);
    }
    chipSync.set(id, () => {
      b.setAttribute("aria-pressed", control.checked ? "true" : "false");
      if (n && document.activeElement !== n) n.value = companion.value;
    });
    return c;
  }

  // A select: its name, then a compact copy of the select showing its value.
  function selectChip(id, control, name) {
    const c = chipShell(id, name);
    const label = document.createElement("span");
    label.className = "pin-label";
    label.textContent = name + ":";
    const s = document.createElement("select");
    s.setAttribute("aria-label", name);
    Array.from(control.options).forEach((o) => s.appendChild(new Option(o.text, o.value)));
    s.addEventListener("change", () => drive(control, s.value));
    c.appendChild(label);
    c.appendChild(s);
    chipSync.set(id, () => { s.value = control.value; });
    return c;
  }

  function chipFor(id) {
    const control = el(id);
    const name = labelOf(id);
    return control.type === "checkbox" ? checkboxChip(id, control, name) : selectChip(id, control, name);
  }

  // Rebuild the row only when the pin list itself changes.
  let builtFor = null;
  function buildRow() {
    const key = pins.join(",");
    if (key === builtFor) return;
    builtFor = key;
    chipSync.clear();
    row.innerHTML = "";
    pins.forEach((id) => { if (el(id)) row.appendChild(chipFor(id)); });
    row.hidden = pins.length === 0;
  }

  // Repaint the chip, the pin toggles and the pinned row from the controls.
  function refresh() {
    const on = CLEAN_IDS.filter((id) => el(id) && el(id).checked).length;
    chip.textContent = "Cleaning: " + on + " of " + CLEAN_IDS.length;

    drawer.querySelectorAll("button.pin").forEach((b) => {
      const pinned = pins.includes(b.dataset.pin);
      b.setAttribute("aria-pressed", pinned ? "true" : "false");
      b.setAttribute("aria-label", (pinned ? "Unpin " : "Pin ") + labelOf(b.dataset.pin));
      b.dataset.tip = pinned ? "Pinned to the bar under the header. Click to unpin." : "Pin to the bar under the header.";
    });

    buildRow();
    chipSync.forEach((sync) => sync());
  }

  drawer.addEventListener("change", async (e) => {
    await ctx.onChange(e);
    refresh();
  });

  refresh();
  return { open, close, isOpen, refresh, pins: () => pins.slice(), setPinned };
}

