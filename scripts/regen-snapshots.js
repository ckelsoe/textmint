// Regenerate test/snapshots.json. Run deliberately, and review the diff:
// a change here means the cleaning output changed for real users.
//
//   node scripts/regen-snapshots.js
//
// It lives in scripts/ and not test/ on purpose. It writes at module scope,
// so importing it is enough to rewrite the snapshots. npm test runs
// `node --test test/`, and Node's documented test-file patterns have
// included `**/test/**/*.?(c|m)js`. On a Node that matched it, npm test
// would regenerate the snapshots and then compare them against themselves:
// a suite that passes and checks nothing, with no signal that it happened.
import { writeFileSync } from "node:fs";
import { CORPUS, OPTION_SETS } from "../test/corpus.js";
import { clean, cleanToMarkdown } from "../src/pipeline.js";

const snap = {};
for (const [name, text] of Object.entries(CORPUS)) {
  snap[name] = {};
  for (const [setName, opts] of Object.entries(OPTION_SETS)) {
    snap[name][setName] = { clean: clean(text, opts), markdown: cleanToMarkdown(text, opts) };
  }
}
writeFileSync(new URL("../test/snapshots.json", import.meta.url),
              JSON.stringify(snap, null, 2) + "\n");
console.log(`wrote ${Object.keys(snap).length} inputs x ${Object.keys(OPTION_SETS).length} option sets`);
