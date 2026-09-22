// Pins the exact output of every corpus input under every option set.
//
// This is the spec the Rust port must reproduce. A failure here means the
// cleaning output changed: either you meant it, and you rerun
// `node scripts/regen-snapshots.js` and review the diff, or you did not, and you
// just caught a regression that would have silently corrupted user text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CORPUS, OPTION_SETS } from "./corpus.js";
import { clean, cleanToMarkdown } from "../src/pipeline.js";

const snapshots = JSON.parse(
  readFileSync(new URL("./snapshots.json", import.meta.url), "utf8"));

for (const [name, text] of Object.entries(CORPUS)) {
  test(`snapshot: ${name}`, () => {
    const expected = snapshots[name];
    assert.ok(expected, `no snapshot for "${name}"; run node scripts/regen-snapshots.js`);
    for (const [setName, opts] of Object.entries(OPTION_SETS)) {
      assert.equal(clean(text, opts), expected[setName].clean,
                   `clean() drifted for "${name}" / "${setName}"`);
      assert.equal(cleanToMarkdown(text, opts), expected[setName].markdown,
                   `cleanToMarkdown() drifted for "${name}" / "${setName}"`);
    }
  });
}
