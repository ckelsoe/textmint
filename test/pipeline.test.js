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

// --- Markdown style, Obsidian, frontmatter (docs/plans/html-input.md) --------

const MD_BASE = { joinLines: true, stripIndent: true, collapseBlank: true };

test("restyle leaves markdown alone when no style is set", () => {
  const md = "* a\n\n__b__ and _c_\n\n```\nx\n```";
  assert.equal(P.cleanToMarkdown(md, MD_BASE), md);
});

test("bullet marker restyles list items, not rules or bold", () => {
  const out = P.cleanToMarkdown("* one\n  + two\n\n* * *\n\n**bold** start", { ...MD_BASE, mdBullet: "-" });
  assert.equal(out, "- one\n  - two\n\n* * *\n\n**bold** start");
});

test("emphasis restyle skips words, URLs, link targets and code", () => {
  const md = "a **b** *c* snake_case https://x.com/a_b_c/ [l](https://y.com/p_q_r) `_k_`";
  assert.equal(P.cleanToMarkdown(md, { ...MD_BASE, mdEmphasis: "underscore" }),
    "a __b__ _c_ snake_case https://x.com/a_b_c/ [l](https://y.com/p_q_r) `_k_`");
  assert.equal(P.cleanToMarkdown("__b__ and _c_ and a_b_c", { ...MD_BASE, mdEmphasis: "asterisk" }),
    "**b** and *c* and a_b_c");
});

test("heading style converts between # and underlined", () => {
  assert.equal(P.cleanToMarkdown("# One\n\n## Two\n\n### Three", { ...MD_BASE, mdHeading: "setext" }),
    "One\n===\n\nTwo\n---\n\n### Three");
  assert.equal(P.cleanToMarkdown("One\n===\n\nTwo\n---", { ...MD_BASE, mdHeading: "atx" }),
    "# One\n\n## Two");
});

test("fence style switches code fences to tildes", () => {
  assert.equal(P.cleanToMarkdown("```js\nconst a = 1;\n```", { ...MD_BASE, mdFence: "tilde" }),
    "~~~js\nconst a = 1;\n~~~");
});

test("links convert to reference style and back", () => {
  const inline = "See [a](https://a.com \"A\") and [b](https://b.com) and [a2](https://a.com \"A\").";
  const ref = P.cleanToMarkdown(inline, { ...MD_BASE, mdLinks: "reference" });
  assert.equal(ref, "See [a][1] and [b][2] and [a2][1].\n\n[1]: https://a.com \"A\"\n[2]: https://b.com");
  assert.equal(P.cleanToMarkdown(ref, { ...MD_BASE, mdLinks: "inline" }),
    "See [a](https://a.com \"A\") and [b](https://b.com) and [a2](https://a.com \"A\").");
});

test("highlight can be dropped to plain text", () => {
  assert.equal(P.cleanToMarkdown("==hi== and a == b", { ...MD_BASE, mdHighlight: "plain" }), "hi and a == b");
  assert.equal(P.cleanToMarkdown("==hi==", { ...MD_BASE, mdHighlight: "equals" }), "==hi==");
});

test("callouts are opt-in and turn Note: quotes into [!note]", () => {
  const md = "> **Note:** read this\n> more";
  assert.equal(P.cleanToMarkdown(md, MD_BASE), md);
  assert.equal(P.cleanToMarkdown(md, { ...MD_BASE, mdCallouts: true }), "> [!note]\n> read this\n> more");
});

test("markdown wrap wraps paragraphs and items, not headings or tables", () => {
  const long = "word ".repeat(30).trim();
  const out = P.cleanToMarkdown("# " + long + "\n\n" + long + "\n\n- " + long, { mdWrap: true, wrapWidth: 40 });
  const lines = out.split("\n");
  assert.equal(lines[0], "# " + long, "headings are not wrapped");
  assert.ok(lines.slice(1).every((l) => l.length <= 40), out);
  assert.ok(out.includes("\n  word"), "list continuation is indented: " + out);
});

test("nested lists keep their nesting on the markdown path", () => {
  const md = "- First\n  - Nested\n    - Deeper\n- Second\n\n1. One\n2. Two";
  assert.equal(P.cleanToMarkdown(md, MD_BASE), md);
  assert.equal(P.cleanToMarkdown("  - a\n    - b\n  - c", MD_BASE), "- a\n  - b\n- c");
});

test("frontmatter is protected, kept in markdown and dropped from text", () => {
  const note = "---\ntitle: Note\ntags:\n  - a\n---\n\nBody line one\nline two.";
  const md = P.cleanToMarkdown(note, MD_BASE);
  assert.ok(md.startsWith("---\ntitle: Note\ntags:\n  - a\n---"), md);
  const text = P.clean(note, { ...MD_BASE, stripMarkdown: true });
  assert.ok(!text.includes("title:"), text);
  assert.ok(text.startsWith("Body"), text);
});

test("the text path reads Obsidian syntax as plain text", () => {
  const md = "See [[Target|the note]] and ![[img.png]] and ==this== %%secret%%\n\n> [!warning] Careful\n> body";
  const out = P.clean(md, { stripMarkdown: true });
  assert.ok(out.includes("See the note and img.png and this"), out);
  assert.ok(!out.includes("secret"), out);
  assert.ok(out.includes("Careful:"), out);
});

test("looksLikeHtml tells HTML source from prose", () => {
  assert.equal(P.looksLikeHtml("<p>hello</p>"), true);
  assert.equal(P.looksLikeHtml("  <!DOCTYPE html><html>"), true);
  assert.equal(P.looksLikeHtml("<div class=\"a\">x</div>"), true);
  assert.equal(P.looksLikeHtml("a < b and <c>"), false);
  assert.equal(P.looksLikeHtml("<nope> not html"), false);
  assert.equal(P.looksLikeHtml("# Heading\n\n<p>inline</p>"), false);
});

test("stripUnicode matches the Rust twin on boundary characters", async () => {
  // src-tauri/src/html/tests.rs asserts the same fixture against strip_unicode.
  const { readFileSync } = await import("node:fs");
  const f = JSON.parse(readFileSync(new URL("./fixtures/unicode-parity.json", import.meta.url), "utf8"));
  assert.equal(P.stripUnicode(f.input), f.expected);
  assert.ok(f.expected.includes("\u2713"), "the check mark is not a pictograph and stays");
  assert.ok(!f.expected.includes("\u2714"), "the heavy check mark is one and goes");
});

test("prefersPlainPaste spots editor code but not documents", () => {
  const vscode = "<div style=\"font-family: Menlo; white-space: pre;\"><div><span>def f():</span></div></div>";
  assert.equal(P.prefersPlainPaste(vscode), true);
  assert.equal(P.prefersPlainPaste("<p>Hello <b>world</b></p>"), false);
  assert.equal(P.prefersPlainPaste("<pre style=\"white-space: pre\">x</pre><p>doc</p>"), false);
});

test("link restyle leaves inline code alone", () => {
  const md = "Use `[a](b)` syntax, and [real](https://x.com).";
  assert.equal(P.cleanToMarkdown(md, { ...MD_BASE, mdLinks: "reference" }),
    "Use `[a](b)` syntax, and [real][1].\n\n[1]: https://x.com");
  assert.equal(P.cleanToMarkdown("Write `[t][1]` for a ref.\n\n[1]: https://y.com", { ...MD_BASE, mdLinks: "inline" }),
    "Write `[t][1]` for a ref.");
});

test("join lines leaves quote lines, and so callouts, intact", () => {
  const q = "> Note: the first line of this quoted passage runs long enough\n> that it wrapped onto a second line.";
  assert.equal(P.cleanToMarkdown(q, MD_BASE), q);
  // The text path strips the quote marker first, so it joins clean prose.
  assert.equal(P.clean(q, { joinLines: true, stripMarkdown: true }),
    "Note: the first line of this quoted passage runs long enough that it wrapped onto a second line.");
  const callout = "> [!question] Why?\n> Because.";
  assert.equal(P.cleanToMarkdown(callout, MD_BASE), callout);
});

// --- Protection, 2026-09-26 -------------------------------------------------

test("tilde fences are protected like backtick fences", () => {
  const fence = "~~~\n  def f():\n      return 1\n~~~";
  assert.ok(P.clean("Intro.\n\n" + fence, ALL_ON).includes(fence));
});

test("a fence closes only on the same character, at least as long", () => {
  const input = "````md\n```js\nx *y* z\n```\n````\n\nAfter *em*.";
  const out = P.clean(input, ALL_ON);
  assert.ok(out.includes("```js\nx *y* z\n```"), out);
  assert.ok(out.endsWith("After em."), out);
});

test("```inline``` on one line is not a fence that swallows the rest", () => {
  const out = P.clean("Use ```x``` here.\n\n**bold** after", ALL_ON);
  assert.ok(out.includes("bold after"), out);
});

test("a shell transcript keeps its > lines and indentation", () => {
  const input = "$ npm test\n> textmint@0.6.1 test\n> node --test\n  ok 1 - passes";
  assert.equal(P.clean(input, ALL_ON), input);
});

test("a Python traceback is kept whole, <module> included", () => {
  const tb = "Traceback (most recent call last):\n  File \"a.py\", line 3, in <module>\n    main()\nValueError: bad";
  assert.equal(P.clean("It failed:\n\n" + tb, ALL_ON), "It failed:\n\n" + tb);
});

test("an email address before a percent sign is not a prompt", () => {
  const code = P.scanProtected(["mail@shop.example 20 % off your next", "order, no code needed."]);
  assert.deepEqual(code, []);
});

test("strip indent removes the paste's shared margin from code, not its nesting", () => {
  const out = P.clean("  def f():\n      return 1", { stripIndent: true });
  assert.equal(out, "def f():\n    return 1");
});

test("clean keeps the first line's indentation when nothing strips it", () => {
  assert.equal(P.clean("\n\n    x = 1\n    y = 2\n\n", {}), "    x = 1\n    y = 2");
});

test("four-backtick fences restyle to four tildes", () => {
  const out = P.cleanToMarkdown("````\ncode\n````", { mdFence: "tilde" });
  assert.equal(out, "~~~~\ncode\n~~~~");
});

test("code holding ``` is fenced with a longer fence for the renderer", () => {
  const out = P.cleanToMarkdown("const s = \"```\";\nfoo();", {});
  assert.ok(out.startsWith("````\n") && out.endsWith("\n````"), out);
});

test("stripMarkdown keeps arithmetic asterisks", () => {
  assert.equal(P.stripMarkdown("a = b * c\nd = e * f"), "a = b * c\nd = e * f");
  assert.equal(P.stripMarkdown("2*3*4 and 5 * 6"), "2*3*4 and 5 * 6");
  assert.equal(P.stripMarkdown("**bold** and *em* and ***both***"), "bold and em and both");
});

test("stripMarkdown emphasis does not reach across paragraphs", () => {
  assert.equal(P.stripMarkdown("a *b\n\nc* d"), "a *b\n\nc* d");
  assert.equal(P.stripMarkdown("*wrapped\nemphasis*"), "wrapped\nemphasis");
});

test("stripMarkdown strips HTML tags but not generics or placeholders", () => {
  assert.equal(P.stripMarkdown("Promise<void> in <module>, Vec<String>"),
               "Promise<void> in <module>, Vec<String>");
  assert.equal(P.stripMarkdown("<b>bold</b> and <span class=\"x\">y</span><br/>"), "bold and y");
  assert.equal(P.stripMarkdown("see <https://example.com>"), "see https://example.com");
});

test("stripMarkdown leaves inline code contents alone", () => {
  assert.equal(P.stripMarkdown("call `f(**kwargs)` or `a_b_c` or `\\d+\\.`"),
               "call f(**kwargs) or a_b_c or \\d+\\.");
  assert.equal(P.stripMarkdown("``code with ` tick``"), "code with ` tick");
});

test("stripMarkdown unescapes markdown escapes", () => {
  assert.equal(P.stripMarkdown("5 \\* 3 and \\_not em\\_ and \\# no heading"),
               "5 * 3 and _not em_ and # no heading");
});

test("stripMarkdown strike needs flanking tildes", () => {
  assert.equal(P.stripMarkdown("~~gone~~ but ~~~ and a ~~ b ~~ c stay"),
               "gone but ~~~ and a ~~ b ~~ c stay");
});

test("stripUnicode removes whole terminal escapes, not just the ESC", () => {
  assert.equal(P.stripUnicode("a\u001b[31mred\u001b[0m b"), "ared b");
  assert.equal(P.stripUnicode("x\u001b]8;;http://a\u001b\\link\u001b]8;;\u001b\\ y"), "xlink y");
});

test("an unterminated OSC stops at the end of its line", () => {
  assert.equal(P.stripUnicode("done\u001b]0;title\nnext line"), "done\nnext line");
});

test("stripUnicode keeps joiners that spell words, drops the rest", () => {
  const persian = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645";
  assert.equal(P.stripUnicode(persian), persian);
  assert.equal(P.stripUnicode("hel\u200dlo wor\u200cld \u200d"), "hello world ");
});

test("stripUnicode turns unusual spaces into spaces", () => {
  assert.equal(P.stripUnicode("a\u00a0b\u202fc\u2009d\u3000e"), "a b c d e");
});

// --- Reflow, 2026-09-26 -----------------------------------------------------

const J = (t) => P.joinWrappedLines(t);

test("join lines reflows text wrapped narrower than 50 columns", () => {
  const narrow = "The cleanup engine reads the copied\ntext and decides, block by block,\nwhich parts are safe to tidy and which\nmust be left exactly as they were.";
  assert.equal(J(narrow), narrow.replace(/\n/g, " "));
});

test("join lines keeps a break the next word would have fit before", () => {
  const pairs = "Fixed the importer crash when the manifest is empty and the\nqueue is already drained.\nAdded a revert hotkey that restores the original clipboard\ncontents after a clean.";
  assert.equal(J(pairs), "Fixed the importer crash when the manifest is empty and the queue is already drained.\nAdded a revert hotkey that restores the original clipboard contents after a clean.");
});

test("join lines keeps a colon lead-in, a heading and a setext underline", () => {
  assert.equal(J("Run this before the first start of the watcher:\nnpm install and then npm start"),
               "Run this before the first start of the watcher:\nnpm install and then npm start");
  assert.equal(J("# A heading line\nfollowed by body text"), "# A heading line\nfollowed by body text");
  assert.equal(J("Title\n====="), "Title\n=====");
});

test("join lines joins a wrapped list item, continuation lines included", () => {
  const item = "- [x] The first check passed on the second try after the cache was cleared\n      and the build server restarted with a clean state directory in place.\n      (verified on staging.)\n- [x] Next";
  assert.equal(J(item), "- [x] The first check passed on the second try after the cache was cleared and the build server restarted with a clean state directory in place. (verified on staging.)\n- [x] Next");
});

test("join lines runs an open bracket on to the next line", () => {
  assert.equal(J("keep the value in (or near the\nTerraform module that consumes it)."),
               "keep the value in (or near the Terraform module that consumes it).");
});

test("join lines does not join a list of short commands or names", () => {
  const list = "alpha\nbravo\ncharlie delta\necho";
  assert.equal(J(list), list);
});

test("wrap keeps a bullet with its first word, however long", () => {
  const out = P.wrapText("- https://example.com/docs/guides/clipboard-integration which explains", 40);
  assert.ok(out.startsWith("- https://example.com/"), out);
  assert.ok(!out.split("\n").some((l) => l.trim() === "-"), out);
});

test("wrap does not hang lines under a bullet when strip indent is on", () => {
  const out = P.clean("- one two three four five six seven eight nine ten", { wrap: true, wrapWidth: 20, stripIndent: true });
  assert.ok(out.split("\n").slice(1).every((l) => !/^\s/.test(l)), out);
});

test("strip unicode takes a symbol's space with it, but never glues words", () => {
  assert.equal(P.stripUnicode("\u2705 Done, x \u2264 y, costs \u20AC5, done \uD83D\uDE80."), "Done, x y, costs 5, done.");
});

test("shell command runs are protected; English that starts like one is not", () => {
  assert.equal(P.scanProtected(["git checkout main", "npm ci", "npm test"])[0].kind, "code");
  assert.deepEqual(P.scanProtected(["find the file you need and", "make sure it opens cleanly"]), []);
});

test("stripAiNoise removes terminal escapes on its own", () => {
  assert.equal(P.stripAiNoise("\u001b[32mok\u001b[0m 1 - passes"), "ok 1 - passes");
});

test("escapes and invisibles are removed inside protected blocks too", () => {
  const input = "$ npm test\n\u001b[32mok\u001b[0m 1\n\n```\nlet a\u200B = 1; // \u202Eevil\n```";
  const out = P.clean(input, { stripUnicode: true });
  assert.equal(out, "$ npm test\nok 1\n\n```\nlet a = 1; // evil\n```");
  assert.ok(P.cleanToMarkdown(input, { stripNoise: true }).includes("ok 1"));
  assert.ok(P.clean("```\n\u{1F680} x\n```", { stripUnicode: true }).includes("\u{1F680}"), "emoji in code stays");
});

test("a long paragraph and a large paste clean in linear time", () => {
  // Each input here once took 25 s or more (quadratic backtracking or
  // rescanning); linear, each takes well under half a second. The 5 s bound
  // leaves room for a loaded CI runner running the other test files in
  // parallel, and still fails loudly on a return to quadratic.
  const LIMIT = 5000;
  const all = { ...ALL_ON, wrap: true, wrapWidth: 80 };
  const timed = (label, fn) => {
    const t = Date.now();
    fn();
    const ms = Date.now() - t;
    assert.ok(ms < LIMIT, label + " took " + ms + " ms");
  };
  // Join lines once rescanned the paragraph for every line it added.
  const para = Array.from({ length: 20000 }, (_, i) => "word " + i + " continues (the wrapped paragraph here and").join("\n");
  timed("long paragraph", () => { P.clean(para, all); P.cleanToMarkdown(para, all); });
  timed("large code block", () => P.clean(Array.from({ length: 20000 }, (_, i) => "  const x" + i + " = f(" + i + ");").join("\n"), all));
  // Unclosed markers and bracket-heavy lines once made the emphasis, strike
  // and code-line regexes backtrack.
  for (const bad of ["*a b ".repeat(80000), "~~a b ".repeat(100000), "_a b ".repeat(80000),
                     "(a ".repeat(120000), Array.from({ length: 30000 }, () => "*a b c").join("\n")]) {
    timed(JSON.stringify(bad.slice(0, 12)), () => { P.clean(bad, all); P.cleanToMarkdown(bad, all); });
  }
  // The emoji scanner once re-read the output line on every symbol.
  const emo = { ...all, emojiMap: P.DEFAULT_EMOJI_MAP };
  for (const bad of ["ok \u2705 ".repeat(100000), Array.from({ length: 150000 }, () => "- \u2705 done \u274C").join("\n")]) {
    timed("emoji input", () => P.clean(bad, emo));
  }
});

// --- Emoji to text, 2026-09-26 ------------------------------------------------

test("mapEmoji matches the Rust twin on the parity fixture", async () => {
  // src-tauri/src/html/tests.rs asserts the same cases against map_emoji.
  const { readFileSync } = await import("node:fs");
  const f = JSON.parse(readFileSync(new URL("./fixtures/emoji-parity.json", import.meta.url), "utf8"));
  assert.deepEqual(f.map, P.DEFAULT_EMOJI_MAP, "fixture map drifted from DEFAULT_EMOJI_MAP; regenerate it");
  for (const set of [f, f.custom]) {
    for (const c of set.cases) assert.equal(P.stripUnicode(c.input, set.map), c.expected, JSON.stringify(c.input));
  }
});

test("convert mode turns checklists into task lists and spaces replacements", () => {
  const map = P.DEFAULT_EMOJI_MAP;
  assert.equal(P.stripUnicode("- \u2705 Done\n- \u274C Todo", map), "- [x] Done\n- [ ] Todo");
  assert.equal(P.stripUnicode("done\u2705.", map), "done (yes).");
  assert.equal(P.stripUnicode("\uD83D\uDE80 Launch", map), "Launch", "unmapped emoji are removed");
});

test("remove mode is unchanged when no map is given", () => {
  assert.equal(P.stripUnicode("\u2705 Done \u2192 next"), "Done \u2192 next");
});

test("a malformed map is ignored, not thrown on", () => {
  assert.equal(P.mapEmoji("\u2705 x", [null, 5, { symbols: 7 }, { start: "[x]" }]), "\u2705 x");
  assert.equal(P.mapEmoji("\u2705 x", "not a list"), "\u2705 x");
});

test("convert mode reaches both outputs and the markdown renders a task list", () => {
  const o = { stripUnicode: true, emojiMap: P.DEFAULT_EMOJI_MAP };
  assert.equal(P.clean("\u2705 Tests pass", o), "[x] Tests pass");
  assert.equal(P.cleanToMarkdown("- \u2705 Tests pass", o), "- [x] Tests pass");
});
