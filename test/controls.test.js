// The Settings defaults live in two places a person edits: the controls in
// src/index.html (checked, selected) and the constants in src/controls.js that
// the CLI sends. These tests fail the moment the two disagree, so `textmint
// html` cannot drift from a fresh app.
//
// ASCII only, same rule as src/pipeline.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HTML_DEFAULTS, HTML_OPTION_IDS, MD_PRESETS, SETTING_IDS, CHECK_IDS, CLEAN_IDS,
  SETTING_SECTIONS, SECTION_FOR_VIEW, knownPrefs, knownPins,
} from "../src/controls.js";

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

// The body of one drawer section in index.html.
function sectionHtml(key) {
  const m = HTML.match(new RegExp('<section[^>]*data-section="' + key + '"[^>]*>([\\s\\S]*?)</section>'));
  assert.ok(m, "no drawer section " + key);
  return m[1];
}

test("every setting sits in its drawer section, and every row is listed", () => {
  const listed = Object.values(SETTING_SECTIONS).flat();
  for (const [key, ids] of Object.entries(SETTING_SECTIONS)) {
    const body = sectionHtml(key);
    for (const id of ids) {
      assert.ok(body.includes('data-setting="' + id + '"'), id + " is not a row in section " + key);
    }
  }
  const rows = [...HTML.matchAll(/data-setting="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows.slice().sort(), listed.slice().sort(), "index.html rows and SETTING_SECTIONS differ");
  for (const id of CHECK_IDS.concat(SETTING_IDS)) {
    assert.ok(listed.includes(id), id + " has no drawer row");
  }
  // And the reverse: every row is saved, so none resets on relaunch.
  const saved = new Set(CHECK_IDS.concat(SETTING_IDS));
  for (const id of listed) assert.ok(saved.has(id), id + " is in a section but not saved");
});

test("strip markdown and Clean are gone from the app", () => {
  assert.ok(!HTML.includes("opt-strip-markdown"));
  assert.ok(!HTML.includes('id="btn-clean"'));
  assert.ok(!CHECK_IDS.includes("opt-strip-markdown"));
  for (const id of ["btn-copy", "btn-copy-md", "btn-copy-html"]) assert.ok(HTML.includes('id="' + id + '"'), id);
});

test("the cleaning chip counts the five cleaning passes", () => {
  assert.deepEqual(SETTING_SECTIONS.cleaning, CLEAN_IDS);
  assert.equal(CLEAN_IDS.length, 5);
  for (const view of ["text", "markdown", "html", "rendered"]) assert.ok(SETTING_SECTIONS[SECTION_FOR_VIEW[view]], view);
});

test("prefs from 0.5.0 lose the settings that no longer exist", () => {
  const saved = { "opt-strip-markdown": false, "opt-bullets": false, "md-flavor": "obsidian", "opt-wrap-width": "30", junk: 1 };
  assert.deepEqual(knownPrefs(saved), { "opt-bullets": false, "md-flavor": "obsidian", "opt-wrap-width": "30" });
  assert.deepEqual(knownPrefs(null), {});
});

test("pins keep only real settings, once each, in pin order", () => {
  assert.deepEqual(knownPins(["md-flavor", "opt-strip-markdown", "md-flavor", "opt-wrap", "opt-wrap-width"]), ["md-flavor", "opt-wrap"]);
  assert.deepEqual(knownPins("nope"), []);
});
