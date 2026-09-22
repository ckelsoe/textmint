// Inputs that exercise the cleaning passes, kept as the shared spec.
//
// test/snapshot.test.js pins the current output for every entry under every
// option set. When the pipeline moves to Rust, the port is correct when it
// reproduces test/snapshots.json exactly. Regenerate deliberately with:
//   node scripts/regen-snapshots.js
//
// ASCII only, same rule as src/pipeline.js.

export const CORPUS = {
  "ai-noise": "Thought for 8s\n\u25CF running a tool\n\u23FA another\nreal content (ctrl+o to expand)",
  "invisibles": "a\u200Bb\u00ADc\uFEFFd and bidi \u202Ae\u2066f plus vs \uFE0F",
  "pipe-table": "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table.",
  "box-diagram": "\u250C\u2500\u2500\u2500\u2510\n\u2502 a \u2502\n\u2514\u2500\u2500\u2500\u2518\n\nAfter box.",
  "code-fence": "```js\nconst x = 1;\n    indented;\n```\n\nAfter fence.",
  // The two fence shapes that used to survive Copy but not Copy HTML: one
  // indented under a list item, one truncated mid-paste with no closing line.
  "indented-fence": "- item:\n\n  ```js\n  const y = snake_case_x;\n  ```\n\nAfter.",
  "unclosed-fence": "```js\nconst x = _a_;\nmore code here",
  "underscores": "Keep snake_case and Textmint_0.1.0_aarch64 but strip _italic_ here.",
  "bullets": "* one\n+ two\n-  three",
  "long-line": "A line that is quite long and should wrap when the width is small enough to matter.",
  "headings": "# Heading\n\nPara one.\nPara two continues here.\n\n\n\n\nAfter many blanks.",
  "indented": "    indented line\n\ttabbed line",
  "inline-md": "[link](https://x.com) and ![img](y.png) and `code` and ~~strike~~",
  "blockquote": "> quoted\n> more\n\n---\n\n***bold em***",
  "strong-em": "__strong__ and _em_ and a__b__c should differ",
  "empty": "",
  "whitespace-only": "   \n\n  \n",
};

// Option sets: nothing on, each pass alone, everything on.
const KEYS = ["stripNoise", "stripUnicode", "stripMarkdown", "bullets",
              "joinLines", "stripIndent", "collapseBlank", "wrap"];

export const OPTION_SETS = (() => {
  const sets = { none: { wrapWidth: 40 } };
  for (const k of KEYS) sets[k] = { [k]: true, wrapWidth: 40 };
  sets.all = Object.fromEntries(KEYS.map((k) => [k, true]));
  sets.all.wrapWidth = 40;
  return sets;
})();
