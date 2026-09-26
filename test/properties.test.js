// Properties that hold for every input under every combination of the eight
// passes (256 option sets), over the shared corpus, the CleanCopy fixtures, and
// a few inputs built to break things.
//
// A snapshot pins what one input produces; these pin what must be true of any
// output, which is how a pass added later gets checked against cases nobody
// wrote a snapshot for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as P from "../src/pipeline.js";
import { CORPUS } from "./corpus.js";

const KEYS = ["stripNoise", "stripUnicode", "stripMarkdown", "bullets",
              "joinLines", "stripIndent", "collapseBlank", "wrap"];
const COMBOS = [];
for (let m = 0; m < 1 << KEYS.length; m++) {
  const o = { wrapWidth: 40 };
  KEYS.forEach((k, i) => { o[k] = !!(m & (1 << i)); });
  COMBOS.push(o);
}
const label = (o) => KEYS.filter((k) => o[k]).join("+") || "none";

const DIR = new URL("./fixtures/cleancopy/", import.meta.url);
const INPUTS = { ...CORPUS };
for (const d of readdirSync(DIR, { withFileTypes: true })) {
  if (d.isDirectory()) INPUTS["cleancopy/" + d.name] = readFileSync(new URL(d.name + "/input.txt", DIR), "utf8");
}
Object.assign(INPUTS, {
  "crlf": "# Title\r\n\r\nLine one\r\nline two.\r\n\r\n```\r\ncode  \r\n```\r\n| a | b |\r\n| 1 | 2 |\r\n",
  "sentinels": "keep \uE000 0 \uE001 and \uE002 1 \uE003 and \uE004 2 \uE005 out",
  "nerd-prompt": "\uE0B0 ~/src \uE0B1 main $ ls\nREADME.md  src",
  "fence-in-list": "1. Step:\n\n   ```sh\n   npm   install\n   ```\n2. Done",
  "mixed": "Intro *text* with `a_b`.\n\n    def f():\n        return 1\n\nAfter **that** and <b>tag</b>.",
});

// Fences, tables and box diagrams: kept byte for byte by clean(), whatever
// the options. (Code blocks may lose the paste's shared margin, and
// frontmatter goes with strip markdown, so they are not in this check.)
function verbatimBlocks(text) {
  const lines = P.normalizeInput(text).split("\n");
  return P.scanProtected(lines)
    .filter((r) => r.kind === "fence" || r.kind === "table" || r.kind === "box")
    .map((r) => lines.slice(r.from, r.to).join("\n"));
}

for (const [name, text] of Object.entries(INPUTS)) {
  test(`properties: ${name}`, () => {
    const keep = verbatimBlocks(text);
    for (const o of COMBOS) {
      const at = `${name} / ${label(o)}`;
      const once = P.clean(text, o);
      assert.equal(P.clean(once, o), once, "clean() is not idempotent: " + at);
      assert.ok(!/[\uE000-\uE005]/.test(once), "a sentinel leaked from clean(): " + at);
      for (const b of keep) assert.ok(once.includes(b), "protected block changed: " + at + "\n" + b);

      const md = P.cleanToMarkdown(text, o);
      assert.equal(P.cleanToMarkdown(md, o), md, "cleanToMarkdown() is not idempotent: " + at);
      assert.ok(!/[\uE000-\uE005]/.test(md), "a sentinel leaked from cleanToMarkdown(): " + at);
    }
  });
}

test("with every pass off, clean() changes nothing but line endings and outer blank lines", () => {
  for (const [name, text] of Object.entries(INPUTS)) {
    const expected = P.normalizeInput(text).replace(/^(?:[ \t]*\n)+/, "").trimEnd();
    assert.equal(P.clean(text, {}), expected, name);
  }
});
