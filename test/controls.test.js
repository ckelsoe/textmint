// The Settings defaults live in two places a person edits: the controls in
// src/index.html (checked, selected) and the constants in src/controls.js that
// the CLI sends. These tests fail the moment the two disagree, so `textmint
// html` cannot drift from a fresh app.
//
// ASCII only, same rule as src/pipeline.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HTML_DEFAULTS, HTML_OPTION_IDS, MD_PRESETS, SETTING_IDS } from "../src/controls.js";

const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");

// The default of a control in index.html: a checkbox's checked attribute, or
// the value of the option marked selected (else the first option).
function defaultOf(id) {
  const box = HTML.match(new RegExp('<input type="checkbox" id="' + id + '"([^>]*)>'));
  if (box) return /\bchecked\b/.test(box[1]);
  const sel = HTML.match(new RegExp('<select id="' + id + '">([\\s\\S]*?)</select>'));
  assert.ok(sel, "no control " + id + " in index.html");
  const selected = sel[1].match(/<option value="([^"]*)" selected>/);
  return selected ? selected[1] : sel[1].match(/<option value="([^"]*)"/)[1];
}

test("HTML_DEFAULTS match the Settings controls", () => {
  for (const [id, key] of Object.entries(HTML_OPTION_IDS)) {
    assert.equal(defaultOf(id), HTML_DEFAULTS[key], id + " default drifted from HTML_DEFAULTS." + key);
  }
  assert.deepEqual(Object.keys(HTML_DEFAULTS).sort(), Object.values(HTML_OPTION_IDS).sort());
});

test("the default flavor's preset matches the Markdown controls", () => {
  const preset = MD_PRESETS[defaultOf("md-flavor")];
  assert.ok(preset, "the default flavor has no preset");
  for (const [id, value] of Object.entries(preset)) {
    assert.equal(defaultOf(id), value, id + " default disagrees with the preset");
  }
});

test("every setting id has a control, and every preset key is a setting", () => {
  for (const id of SETTING_IDS) defaultOf(id);
  for (const preset of Object.values(MD_PRESETS)) {
    for (const id of Object.keys(preset)) assert.ok(SETTING_IDS.includes(id), id);
  }
});
