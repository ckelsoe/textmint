// Real terminal copies from CleanCopy's fixture corpus (test/fixtures/cleancopy,
// MIT). See the README there for why the inputs are used and not the outputs.
//
// The failure these guard against is silent: a prose pass reflowing a stack
// trace or flattening a function body returns text, not an error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as P from "../src/pipeline.js";

const DIR = new URL("./fixtures/cleancopy/", import.meta.url);
const ALL_ON = {
  stripNoise: true, stripUnicode: true, stripMarkdown: true, bullets: true,
  joinLines: true, stripIndent: true, collapseBlank: true,
};

// CleanCopy keeps these verbatim, but they are markdown, and textmint's
// strip-markdown and strip-indent are meant to change them.
const MARKDOWN = new Set(["14-blockquote", "16-wrapped-heading", "30-separated-nested-list"]);
// CleanCopy reflows part of these, and the rest is real code.
const MIXED = new Set(["05-mixed-content"]);

const read = (name, file) =>
  readFileSync(new URL(name + "/" + file, DIR), "utf8").replace(/\r\n?/g, "\n");

// Compare without trailing whitespace, outer blank lines or a shared margin,
// all of which the passes may legitimately remove.
function norm(s) {
  const lines = s.split("\n").map((l) => l.replace(/\s+$/, ""));
  const margin = Math.min(...lines.filter((l) => l).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(margin)).join("\n").trim();
}

const fixtures = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

test("the CleanCopy corpus is present", () => {
  assert.ok(fixtures.length >= 60, "expected the vendored fixtures, found " + fixtures.length);
});

for (const name of fixtures) {
  const input = read(name, "input.txt");
  const verbatim = norm(input) === norm(read(name, "expected.txt"));

  if (verbatim && !MARKDOWN.has(name)) {
    test(`verbatim: ${name} survives every pass`, () => {
      assert.equal(norm(P.clean(input, ALL_ON)), norm(input));
    });
  } else if (!verbatim && !MIXED.has(name)) {
    test(`prose: ${name} is not mistaken for code`, () => {
      const code = P.scanProtected(input.split("\n")).filter((r) => r.kind === "code");
      assert.deepEqual(code, [], "prose classified as code");
    });
  }

  test(`idempotent: ${name}`, () => {
    const once = P.clean(input, ALL_ON);
    assert.equal(P.clean(once, ALL_ON), once);
    const md = P.cleanToMarkdown(input, ALL_ON);
    assert.equal(P.cleanToMarkdown(md, ALL_ON), md);
  });
}

test("unfenced code reaches the markdown path as a fence, lines intact", () => {
  const input = read("56-function-body-not-flattened", "input.txt");
  const md = P.cleanToMarkdown(input, ALL_ON);
  assert.match(md, /^```\n/);
  for (const line of input.split("\n").filter((l) => l.trim())) {
    assert.ok(md.includes(line), "lost: " + line + "\n" + md);
  }
});
