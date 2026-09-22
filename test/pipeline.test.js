// Tests for the cleaning pipeline. Run with: npm test
//
// The two regression suites at the bottom cover bugs that actually shipped and
// were fixed by hand (see docs/STATUS.md). They exist so those fixes cannot be
// undone silently, which is the failure mode that matters here: this code
// rewrites people's text, so a wrong regex corrupts output without erroring.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/pipeline.js";

const ALL_ON = {
  stripNoise: true, stripUnicode: true, stripMarkdown: true, bullets: true,
  joinLines: true, stripIndent: true, collapseBlank: true, wrap: false, wrapWidth: 80,
};

test("stripUnicode removes invisible formatting characters", () => {
  assert.equal(P.stripUnicode("a\u200Bb\u00ADc\uFEFFd"), "abcd");
});

test("stripUnicode removes bidi controls and variation selectors", () => {
  assert.equal(P.stripUnicode("a\u202Ab\u2066c\uFE0Fd"), "abcd");
});

test("stripUnicode preserves tab, newline and carriage return", () => {
  assert.equal(P.stripUnicode("a\tb\nc\rd"), "a\tb\nc\rd");
});

test("stripAiNoise drops thinking lines and tool markers", () => {
  const input = "Thought for 8s\n\u25CF running a tool\nreal content\n\u23BF nested";
  assert.equal(P.stripAiNoise(input), "running a tool\nreal content");
});

test("stripAiNoise removes the ctrl+o hint inline", () => {
  assert.equal(P.stripAiNoise("output (ctrl+o to expand)"), "output");
});

test("stripMarkdown unwraps headings, emphasis and links", () => {
  assert.equal(P.stripMarkdown("## Title").trim(), "Title");
  assert.equal(P.stripMarkdown("**bold** and *em*"), "bold and em");
  assert.equal(P.stripMarkdown("[text](https://example.com)"), "text");
});

test("normalizeBullets rewrites * and + to -", () => {
  assert.equal(P.normalizeBullets("* one\n+ two"), "- one\n- two");
});

test("stripIndent removes leading whitespace on every line", () => {
  assert.equal(P.stripIndent("  a\n\tb"), "a\nb");
});

test("collapseBlankLines caps runs of blank lines", () => {
  assert.equal(P.collapseBlankLines("a\n\n\n\n\nb"), "a\n\nb");
});

test("wrapText breaks at the requested width", () => {
  const out = P.wrapText("aaa bbb ccc ddd", 7);
  assert.ok(out.split("\n").every((l) => l.length <= 7), out);
});

test("wrapText indents continuation lines under a bullet", () => {
  const out = P.wrapText("- alpha beta gamma delta", 12);
  assert.ok(out.split("\n")[1].startsWith("  "), JSON.stringify(out));
});

test("maskProtected and unmaskProtected round-trip a code fence", () => {
  const input = "before\n```js\nconst x = 1;\n```\nafter";
  const { masked, blocks } = P.maskProtected(input);
  assert.equal(blocks.length, 1);
  assert.ok(!masked.includes("const x"), "fence body should be stashed");
  assert.equal(P.unmaskProtected(masked, blocks), input);
});

test("maskProtected leaves a single pipe row alone", () => {
  // One row is not a table; two or more are.
  const { blocks } = P.maskProtected("| just one |");
  assert.equal(blocks.length, 0);
});

test("clean applies nothing when no options are set", () => {
  const input = "**bold**  \n  indented";
  assert.equal(P.clean(input, {}), input.trim());
});

test("clean honours the documented pass order", () => {
  // strip-markdown runs before join-lines, so a heading loses its # and only
  // then gets considered for reflow.
  const out = P.clean("# Title\nbody text here.", { stripMarkdown: true, joinLines: true });
  assert.ok(!out.includes("#"), out);
  assert.ok(out.includes("Title"), out);
});

test("cleanToMarkdown keeps markdown, since markdown is the renderer's input", () => {
  const out = P.cleanToMarkdown("**bold**", ALL_ON);
  assert.ok(out.includes("**bold**"), out);
});

test("cleanToMarkdown skips strip-markdown, bullets and wrap", () => {
  // The three passes clean() runs that cleanToMarkdown must not, or the markup
  // the renderer needs would be gone. wrap is forced on with a narrow width so
  // a skipped wrap is the only reason the long line comes back whole; the bullet
  // stays `*`, not normalized to `-`.
  const longLine =
    "This paragraph is comfortably longer than forty characters so a wrap pass would split it.";
  const opts = { stripMarkdown: true, bullets: true, wrap: true, wrapWidth: 40 };
  const out = P.cleanToMarkdown("# Title\n\n* a\n* b\n\n" + longLine, opts);
  assert.ok(out.includes("# Title"), "heading markup must survive:\n" + out);
  assert.ok(out.includes("* a"), "bullet markers must not be normalized:\n" + out);
  assert.ok(out.includes(longLine), "the long line must not be wrapped:\n" + out);
});

// --- Regressions ------------------------------------------------------------
// Both of these shipped, were found by hand, and were fixed 2026-08-23.

test("regression: box-drawing diagrams keep their alignment", () => {
  const box = "\u250C\u2500\u2500\u2500\u2510\n\u2502 a \u2502\n\u2514\u2500\u2500\u2500\u2518";
  const out = P.clean("before\n" + box + "\nafter", ALL_ON);
  assert.ok(out.includes(box), "box diagram must survive verbatim:\n" + out);
});

test("regression: pipe tables of two or more rows keep their columns", () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const out = P.clean(table, ALL_ON);
  assert.ok(out.includes(table), "table must survive verbatim:\n" + out);
});

test("regression: underscores inside words survive strip-markdown", () => {
  // snake_case and filenames must not be treated as emphasis.
  assert.equal(P.stripMarkdown("snake_case_name"), "snake_case_name");
  assert.equal(P.stripMarkdown("Textmint_0.1.0_aarch64"), "Textmint_0.1.0_aarch64");
});

test("regression: real _italic_ is still stripped", () => {
  assert.equal(P.stripMarkdown("an _italic_ word"), "an italic word");
});

test("regression: code fence contents are never reflowed or unindented", () => {
  const fence = "```python\ndef f():\n    return 1\n```";
  const out = P.clean(fence, ALL_ON);
  assert.ok(out.includes("    return 1"), "indentation inside a fence must survive:\n" + out);
});

test("regression: image syntax is not shredded by the link rule", () => {
  // The link pattern also matches the bracket pair inside ![alt](src), so it
  // used to consume the image and strand the "!". Found 2026-09-20.
  assert.equal(P.stripMarkdown("see ![a cat](cat.png) here"), "see a cat here");
});

test("stripMarkdown drops an image with no alt", () => {
  assert.equal(P.stripMarkdown("![](cat.png)"), "");
});

test("stripMarkdown reduces an image and a link to their text", () => {
  assert.equal(P.stripMarkdown("![a cat](cat.png) and [link](x.com)"), "a cat and link");
  assert.equal(P.stripMarkdown("[![badge](b.svg)](https://ci.example)"), "badge");
});

test("stripMarkdown flattens emphasis inside alt text", () => {
  assert.equal(P.stripMarkdown("![alt *em*](a.png)"), "alt em");
});

test("stripMarkdown leaves unclosed image syntax alone", () => {
  assert.equal(P.stripMarkdown("not an image ![unclosed(x.png)"),
    "not an image ![unclosed(x.png)");
});

test("cleanToMarkdown keeps a GFM table as a table and fences a box diagram", () => {
  // A protected block reaches the renderer verbatim; only the shapes the
  // renderer would flatten get a fence so they still paste aligned (the
  // 2026-09-20 alignment fix). A GFM table has its delimiter row, so it stays a
  // table; a box diagram is not markdown, so it is fenced to render as <pre>.
  const o = { stripNoise: true, collapseBlank: true };
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const tableMd = P.cleanToMarkdown(table, o);
  assert.ok(tableMd.includes(table), "the table text must survive:\n" + tableMd);
  assert.ok(!tableMd.includes("```"), "a real table must not be fenced:\n" + tableMd);

  const box = "\u250C\u2500\u2500\u2500\u2510\n\u2502 a \u2502\n\u2514\u2500\u2500\u2500\u2518";
  const boxMd = P.cleanToMarkdown(box, o);
  assert.ok(boxMd.includes(box), "the diagram text must survive:\n" + boxMd);
  assert.ok(boxMd.includes("```"), "a box diagram must be fenced:\n" + boxMd);
});

test("cleanToMarkdown fences a pipe block with no delimiter row", () => {
  // Two pipe rows with no |---| separator are not a GFM table, so the renderer
  // would flatten them; fence them to keep their columns.
  const o = { stripNoise: true, collapseBlank: true };
  const block = "| a | b |\n| 1 | 2 |";
  const md = P.cleanToMarkdown(block, o);
  assert.ok(md.includes(block), "the rows must survive:\n" + md);
  assert.ok(md.includes("```"), "a delimiter-less pipe block must be fenced:\n" + md);
});

test("cleanToMarkdown keeps the content around a protected block", () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const md = P.cleanToMarkdown("before\n\n" + table + "\n\nafter", { collapseBlank: true });
  assert.ok(md.includes("before"), md);
  assert.ok(md.includes("after"), md);
  assert.ok(md.includes(table), md);
});

test("regression: cleanToMarkdown sentinels never reach the output", () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const md = P.cleanToMarkdown("x\n\n" + table + "\n\n```\ncode\n```", { collapseBlank: true });
  assert.ok(!/[\uE000-\uE00F]/.test(md), "sentinel leaked:\n" + md);
});

test("regression: an indented or unclosed fence survives cleanToMarkdown intact", () => {
  // The two real fence shapes the old paths disagreed on: one indented under a
  // list item, one truncated mid-paste. Both must reach the renderer verbatim,
  // backticks and code intact, never emphasised or reflowed. Found 2026-09-20.
  const o = { stripNoise: true, collapseBlank: true };

  const indented = "- item:\n\n  ```js\n  const y = snake_case_x;\n  ```";
  const im = P.cleanToMarkdown(indented, o);
  assert.ok(im.includes("```"), "fence delimiters must survive:\n" + im);
  assert.ok(im.includes("const y = snake_case_x;"), "code must survive:\n" + im);

  const unclosed = "```js\nconst x = _a_;";
  const um = P.cleanToMarkdown(unclosed, o);
  assert.ok(um.includes("const x = _a_;"), "code must survive verbatim:\n" + um);
});

test("scanProtected reports the same ranges both paths act on", () => {
  const lines = "a\n```\ncode\n```\nb\n| x | y |\n| 1 | 2 |".split("\n");
  const r = P.scanProtected(lines);
  assert.deepEqual(
    r.map((x) => [x.from, x.to, x.kind]),
    [[1, 4, "fence"], [5, 7, "table"]],
    JSON.stringify(r)
  );
});

test("an unclosed fence runs to the end of the input", () => {
  const lines = "a\n```\ncode\nmore".split("\n");
  const r = P.scanProtected(lines);
  assert.equal(r.length, 1);
  assert.equal(r[0].to, 4, "must run to EOF");
  assert.equal(r[0].closed, false);
});

test("regression: a private-use character in the input is not turned into 'undefined'", () => {
  // Shipped broken: unmaskProtected replaced \uE000<digits>\uE001 with
  // blocks[n], and an index never issued gave undefined, which String.replace
  // stringifies. U+E000 onwards is where Nerd Font glyphs live, so a pasted
  // terminal prompt could come back with the literal word "undefined" in it.
  // An app whose one promise is not corrupting text. Found 2026-09-20.
  const out = P.clean("icon \uE0005\uE001 end", {});
  assert.ok(!out.includes("undefined"), "must not stringify a missing block:\n" + out);
  assert.equal(out, "icon 5 end");
});

test("the reserved sentinel range never survives into the output", () => {
  for (const c of ["\uE000", "\uE001", "\uE002", "\uE003", "\uE004", "\uE005"]) {
    assert.ok(!P.clean("a" + c + "b", {}).includes(c), "clean leaked " + escape(c));
    assert.ok(!P.cleanToMarkdown("a" + c + "b", {}).includes(c),
      "cleanToMarkdown leaked " + escape(c));
  }
});

test("unmaskProtected leaves an index it never issued alone", () => {
  assert.equal(P.unmaskProtected("x \uE00099\uE001 y", []), "x \uE00099\uE001 y");
});

test("cleanToMarkdown blank-separates a table from a preceding line", () => {
  // A GFM table on the line right after a paragraph is swallowed into it and
  // never becomes a table; a blank line is inserted so it parses. Found
  // 2026-09-21 by the pre-push review.
  const md = P.cleanToMarkdown("See:\n| a | b |\n|---|---|\n| 1 | 2 |", { stripNoise: true });
  assert.ok(/See:\n\n\| a \| b \|/.test(md), "a blank line must separate the table:\n" + md);
});

test("cleanToMarkdown keeps a table with an escaped pipe as a table", () => {
  // A `\|` is a literal pipe in a cell, not a column break, so the table is
  // still well-formed and must not be fenced. Found 2026-09-21.
  const table = "| x \\| y | z |\n|---|---|\n| 1 | 2 |";
  const md = P.cleanToMarkdown(table, { stripNoise: true });
  assert.ok(!md.includes("```"), "a table with an escaped pipe must not be fenced:\n" + md);
  assert.ok(md.includes("x \\| y"), "the escaped pipe cell must survive:\n" + md);
});

test("cleanToMarkdown does not collapse blank lines inside a code fence", () => {
  // The block separation must never reach inside a protected block. A fence with
  // two blank lines in its body keeps them, even with collapse-blank on, since
  // the fence is masked before any pass runs. Found 2026-09-21 by the review.
  const fence = "```\nline one\n\n\nline two\n```";
  const md = P.cleanToMarkdown(fence, { collapseBlank: true, stripNoise: true });
  assert.ok(md.includes("line one\n\n\nline two"),
    "blank lines inside a fence must survive:\n" + md);
});

test("regression: cleanToMarkdown keeps code indentation under the shipped defaults", () => {
  // Shipped broken on the old HTML path: the passes ran over raw text before
  // protection, so with stripIndent on, which is how every toggle ships in
  // src/index.html, the inside of a code block was flattened. For Python or
  // YAML that makes the pasted snippet wrong. Found 2026-09-20. Mask-first fixes
  // it: scanProtected settles *where* a block is, and the mask stops the passes
  // mutating it.
  const fence = "```python\ndef f():\n    return 1\n```";
  for (const opts of [{ stripIndent: true }, { joinLines: true }, ALL_ON]) {
    const md = P.cleanToMarkdown(fence, opts);
    assert.ok(md.includes("    return 1"),
      "indentation must survive " + JSON.stringify(opts) + ":\n" + md);
  }
});

test("clean and cleanToMarkdown recover the same code from the same fence", () => {
  // The structural version of the test above. The snapshot suite cannot catch
  // this class: it pins each path against itself, so both can drift together.
  // This compares the two paths' fence bodies against each other. cleanToMarkdown
  // strips a fence's base indent so the renderer parses it (clean keeps it raw),
  // so the bodies are compared after removing common leading indent.
  const cases = [
    "```python\ndef f():\n    return 1\n```",
    "```yaml\nroot:\n  child: 1\n    deep: 2\n```",
    "- item:\n\n  ```js\n  const y = 1;\n  ```",
    "    ```js\n    const deep = 1;\n    ```",
    "```js\nconst x = 1;",
  ];
  const dedentBody = (s) => {
    const lines = s.split("\n");
    let min = Infinity;
    for (const l of lines) if (l.trim()) min = Math.min(min, l.match(/^[ \t]*/)[0].length);
    return (min === Infinity || min === 0) ? s : lines.map((l) => l.slice(min)).join("\n");
  };
  // Pull the fence body out with the same scanner the code uses, rather than a
  // second regex that could be wrong in its own way.
  const body = (src) => {
    const lines = src.split("\n");
    const r = P.scanProtected(lines).find((x) => x.kind === "fence");
    assert.ok(r, "expected a fence in:\n" + src);
    return dedentBody(lines.slice(r.from + 1, r.closed ? r.to - 1 : r.to).join("\n"));
  };
  for (const input of cases) {
    assert.equal(body(P.cleanToMarkdown(input, ALL_ON)), body(P.clean(input, ALL_ON)),
      "the two paths disagree on the code body for:\n" + input);
  }
});

test("cleanToMarkdown makes a deeply-indented fence parse as code, not text", () => {
  // A fence indented four or more spaces would be read as an indented code
  // block, its ``` leaking as literal text. Its opening indent is stripped so it
  // lands at column 0. Found 2026-09-21 by the pre-push review.
  const md = P.cleanToMarkdown("    ```js\n    const x = 1;\n    ```", { stripNoise: true });
  assert.ok(/^```js$/m.test(md), "the fence must reach column 0:\n" + md);
  assert.ok(md.includes("const x = 1;"), "the code must survive:\n" + md);
});

test("cleanToMarkdown fences a ragged table so no cell is lost", () => {
  // A row with more cells than the delimiter would be truncated by the renderer,
  // losing data; a mismatched table is fenced instead. Found 2026-09-21.
  const ragged = "| a | b | c |\n|---|---|\n| 1 | 2 | 3 | 4 |";
  const md = P.cleanToMarkdown(ragged, { stripNoise: true });
  assert.ok(md.includes("```"), "a ragged table must be fenced:\n" + md);
  assert.ok(md.includes("| 1 | 2 | 3 | 4 |"), "every cell must survive:\n" + md);
});
