// Textmint cleaning pipeline. Pure string-to-string functions, no DOM.
//
// Source is intentionally ASCII-only: every special codepoint is a \u escape
// so the cleaning regexes can never be corrupted by copy/paste. Enforced by
// scripts/check.sh.
//
// Every function takes text and returns text. Options arrive as a plain object
// so the pipeline runs under `node --test` with no browser.

// Checkbox ids in index.html map to these keys.
export const DEFAULTS = {
  stripNoise: false,
  stripUnicode: false,
  stripMarkdown: false,
  bullets: false,
  joinLines: false,
  stripIndent: false,
  collapseBlank: false,
  wrap: false,
  wrapWidth: 80,
  // Markdown style (the Markdown tab, and so the HTML rendered from it). null
  // leaves the markdown as written; see restyleMarkdown.
  mdBullet: null,      // "-" | "*" | "+"
  mdEmphasis: null,    // "asterisk" | "underscore"
  mdHeading: null,     // "atx" | "setext"
  mdFence: null,       // "backtick" | "tilde"
  mdLinks: null,       // "inline" | "reference"
  mdHighlight: null,   // "equals" keeps ==x==; "plain" drops the markers
  mdCallouts: false,   // > Note: ... becomes > [!note]
  mdWrap: false,       // wrap markdown paragraphs and list items at wrapWidth
};

// --- Cleaning pipeline ----------------------------------------------------
export function stripUnicode(text) {
  // Zero-width & invisible formatting: soft hyphen, ZWSP, ZWNJ, ZWJ, LRM, RLM, BOM
  text = text.replace(/[\u00AD\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, "");
  // Variation Selectors U+FE00-FE0F
  text = text.replace(/[\uFE00-\uFE0F]/g, "");
  // Variation Selectors Supplement U+E0100-E01EF (surrogate-pair encoded)
  text = text.replace(/\uDB40[\uDD00-\uDDEF]/g, "");
  // Bidi embedding/override controls U+202A-202E and isolates U+2066-2069
  text = text.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  // Control characters (TAB, LF and CR are preserved)
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  // Emoji / pictographs (ES2018+ property escapes, with a BMP fallback)
  try {
    text = text.replace(/\p{Extended_Pictographic}/gu, "");
  } catch (e) {
    text = text.replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
    text = text.replace(/[\u{2600}-\u{27BF}]/gu, "");
  }
  // Mathematical Operators U+2200-22FF and Supplemental U+2A00-2AFF
  text = text.replace(/[\u2200-\u22FF\u2A00-\u2AFF]/g, "");
  // Currency Symbols block U+20A0-20CF
  text = text.replace(/[\u20A0-\u20CF]/g, "");
  // Cent, pound, yen (outside the block)
  text = text.replace(/[\u00A2\u00A3\u00A5]/g, "");
  return text;
}

export function stripAiNoise(text) {
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (/^Thought for \d+/.test(t)) return null;          // "Thought for 8s"
    if (/^\u23BF/.test(t)) return null;                // U+23BF nested output marker
    let out = line.replace(/\s*\(ctrl\+o to expand\)/gi, "");
    out = out.replace(/^(\s*)[\u25CF\u23FA]\s+/, "$1");         // U+25CF / U+23FA tool markers
    return out;
  }).filter((l) => l !== null).join("\n");
}

export function stripMarkdown(text) {
  text = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_, code) => code.trimEnd());
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, title) => title + "\n");
  text = text.replace(/(\*{1,3})(.+?)\1/gs, "$2");                       // *em* **strong**
  text = text.replace(/(?<!\w)(_{1,3})(\S(?:[^\n]*?\S)?)\1(?!\w)/g, "$2"); // _em_ only at word boundaries
  text = text.replace(/~~(.+?)~~/gs, "$1");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  // Images first. The link pattern also matches the bracket pair inside
  // ![alt](src), which consumes it and strands the leading "!".
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/<[^>]+>/g, "");
  // Obsidian: callout markers read as a label, wikilinks and embeds as their
  // display text, ==highlight== as plain text, %%comments%% not at all.
  text = text.replace(/^\[!(\w[\w-]*)\][+-]?[ \t]*(.*)$/gm, (_, kind, title) =>
    (title || kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase()) + ":");
  text = text.replace(/!?\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target, alias) =>
    (alias || target).trim());
  text = text.replace(/(^|[^=])==(?=\S)([^=\n]*?\S)==(?!=)/g, "$1$2");
  text = text.replace(/%%[\s\S]*?%%/g, "");
  return text;
}

export function normalizeBullets(text) {
  text = text.replace(/^[ \t]*[*+]\s+/gm, "- ");
  text = text.replace(/^([ \t]*)[-]\s{2,}/gm, "$1- ");
  return text;
}

// keepListIndent is for the markdown path: list lines keep their indentation
// (nesting), where the text path flattens them.
export function joinWrappedLines(text, keepListIndent) {
  // Box-drawing glyphs (U+2500 block) mark ASCII tables/diagrams we must not reflow.
  const BOX = /[\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C\u2502]/;
  const parts = text.split(/(\n{2,})/);
  return parts.map((part) => {
    if (/^\n+$/.test(part)) return part;
    const lines = part.split("\n").filter(Boolean);
    if (lines.length <= 1) return part;
    const trimmed = lines.map((l) => l.trim());
    // Lists and quotes keep their lines: joining a quote put a stray " > "
    // mid-line and merged a > [!note] callout's title into its body.
    if (trimmed.some((l) => /^[-*+][ \t]/.test(l) || /^\d+\.[ \t]/.test(l) || l.startsWith(">"))) {
      return keepListIndent ? lines.map((l) => l.trimEnd()).join("\n") : trimmed.join("\n");
    }
    if (trimmed.some((l) => BOX.test(l)) ||
        trimmed.filter((l) => l.startsWith("|")).length > 1) return trimmed.join("\n");
    const result = [];
    let current = "";
    for (const line of trimmed) {
      if (!line) continue;
      const isTitleLike = line.length < 50 && !/[.!?:,]$/.test(line);
      if (isTitleLike) {
        if (current) { result.push(current); current = ""; }
        result.push(line);
      } else {
        current = current ? current + " " + line : line;
      }
    }
    if (current) result.push(current);
    return result.join("\n");
  }).join("");
}

export function stripIndent(text) { return text.replace(/^[ \t]+/gm, ""); }

// The markdown path's stripIndent: a list keeps its nesting. Lines in a list
// run lose only the list's own base indent, so "  - a\n    - b" becomes
// "- a\n  - b" rather than two siblings. Everything else is stripped as usual.
const LIST_ITEM = /^([-*+]|\d+[.)])[ \t]/;
export function stripIndentMarkdown(text) {
  let base = -1; // indent of the current list run, -1 when not in a list
  return text.split("\n").map((line) => {
    const t = line.replace(/^[ \t]+/, "");
    const indent = line.length - t.length;
    if (!t) return "";
    if (LIST_ITEM.test(t)) {
      if (base < 0 || indent < base) base = indent;
      return line.slice(base);
    }
    if (base >= 0 && indent > base) return line.slice(base);
    base = -1;
    return t;
  }).join("\n");
}
export function collapseBlankLines(text) { return text.replace(/(\n[ \t]*){3,}\n/g, "\n\n"); }

export function wrapLine(line, width) {
  if (line.length <= width) return line;
  let prefix = "";
  const bm = line.match(/^([ \t]*[-*+]\s+)/);
  const nm = line.match(/^([ \t]*\d+\.\s+)/);
  if (bm) prefix = " ".repeat(bm[1].length);
  else if (nm) prefix = " ".repeat(nm[1].length);
  const words = line.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? current + " " + word : word;
    if (test.length > width && current) { lines.push(current); current = prefix + word; }
    else current = test;
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

export function wrapText(text, width) {
  return text.split("\n").map((line) => wrapLine(line, width)).join("\n");
}

// --- Protected blocks -----------------------------------------------------
// Code fences and ASCII tables/box diagrams are swapped for sentinel tokens
// (private-use chars that no cleaning pass touches) so they pass through the
// whole pipeline verbatim, then restored. Keeps table columns aligned and
// stops markdown/underscore rules from mangling code.
// maskProtected uses E000/E001 to stand in for a protected block while the
// passes run. The whole range stays reserved and is stripped from the input
// first, so a paste carrying one -- U+E000 onwards is where Nerd Font glyphs
// live in terminal prompts -- cannot be read back as a block index and swap a
// chunk of the user's text for one of ours.
export const SENTINEL_RANGE = /[\uE000-\uE005]/g;

/// One definition of a protected block, used by both paths.
//
// This exists because there were three. maskProtected treated any line matching
// /^\s*```/ as a fence and ran to EOF when unclosed; markdownToHtml required the
// backticks at column 0 and a bare closing line. So a fence indented under a
// list item, or one truncated mid-paste, was protected on the text path and
// shredded on the HTML path: backticks rendered as body text and emphasis rules
// run over code. Both paths now scan with this, so they cannot drift again.
//
// Returns ranges over `lines`, in order, non-overlapping:
//   { from, to, kind: "fence" | "box" | "table" | "frontmatter", closed }
// `closed` is meaningful for a fence only, and says whether `to - 1` is the
// closing delimiter or the fence simply ran out of input.
export function scanProtected(lines) {
  const fence = /^\s*```/;
  const box = /[\u2500-\u257F]/;      // Box Drawing block
  const pipeRow = /^\s*\|.*\|\s*$/;   // | a | b |
  const ranges = [];
  let i = 0;
  // YAML frontmatter (Obsidian, Jekyll, Hugo): only at the very top, closed by
  // --- or ..., with at least one key: line. Passes would otherwise join its
  // lines and flatten its nesting.
  if (lines.length > 2 && lines[0].trim() === "---") {
    let j = 1;
    while (j < lines.length && j < 200 && !/^(---|\.\.\.)\s*$/.test(lines[j])) j++;
    if (j < lines.length && j < 200 && lines.slice(1, j).some((l) => /^[\w-]+:/.test(l))) {
      ranges.push({ from: 0, to: j + 1, kind: "frontmatter", closed: true });
      i = j + 1;
    }
  }
  while (i < lines.length) {
    if (fence.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !fence.test(lines[j])) j++;
      const closed = j < lines.length;
      const to = closed ? j + 1 : lines.length;
      ranges.push({ from: i, to, kind: "fence", closed });
      i = to; continue;
    }
    if (box.test(lines[i])) {
      let j = i;
      while (j < lines.length && box.test(lines[j])) j++;
      ranges.push({ from: i, to: j, kind: "box", closed: true });
      i = j; continue;
    }
    if (pipeRow.test(lines[i])) {
      let j = i;
      while (j < lines.length && pipeRow.test(lines[j])) j++;
      // One pipe row is a sentence, not a table.
      if (j - i >= 2) {
        ranges.push({ from: i, to: j, kind: "table", closed: true });
        i = j; continue;
      }
    }
    i++;
  }
  return ranges;
}

export function maskProtected(text) {
  const OPEN = "\uE000", CLOSE = "\uE001";
  const src = text.split("\n");
  const blocks = [];
  const kinds = [];
  const out = [];
  let i = 0;
  for (const r of scanProtected(src)) {
    while (i < r.from) { out.push(src[i]); i++; }
    out.push(OPEN + blocks.length + CLOSE);
    blocks.push(src.slice(r.from, r.to).join("\n"));
    kinds.push(r.kind);
    i = r.to;
  }
  while (i < src.length) { out.push(src[i]); i++; }
  return { masked: out.join("\n"), blocks, kinds };
}

export function unmaskProtected(text, blocks) {
  // `?? match` keeps the restore total. An index we never issued used to yield
  // undefined, which String.replace stringifies, so text carrying a private-use
  // character came back with the literal word "undefined" in place of it.
  return text.replace(/\uE000(\d+)\uE001/g,
    (match, n) => blocks[Number(n)] ?? match);
}

// --- Entry points -----------------------------------------------------------
// Pass order is load-bearing. The whole run is wrapped in maskProtected /
// unmaskProtected, which is what keeps table columns aligned. To protect new
// content, extend the masking; never teach an individual pass to skip tables.
export function clean(text, options) {
  const o = { ...DEFAULTS, ...options };
  // Our own bookkeeping characters are removed before masking. Otherwise a
  // paste carrying one, which happens for real because U+E000 onwards is where
  // Nerd Font glyphs live in terminal prompts, could be read back as a block
  // index and swap a chunk of the user's text for one of ours.
  text = text.replace(SENTINEL_RANGE, "");
  const prot = maskProtected(text);
  let out = prot.masked;
  if (o.stripNoise)    out = stripAiNoise(out);
  if (o.stripUnicode)  out = stripUnicode(out);
  if (o.stripMarkdown) out = stripMarkdown(out);
  if (o.bullets)       out = normalizeBullets(out);
  if (o.joinLines)     out = joinWrappedLines(out);
  if (o.stripIndent)   out = stripIndent(out);
  if (o.collapseBlank) out = collapseBlankLines(out);
  if (o.wrap)          out = wrapText(out, o.wrapWidth);
  // Plain text has no use for a note's YAML header: with markdown stripped,
  // frontmatter goes too.
  const blocks = o.stripMarkdown
    ? prot.blocks.map((b, n) => (prot.kinds[n] === "frontmatter" ? "" : b))
    : prot.blocks;
  return unmaskProtected(out.trim(), blocks).trim();
}

// Cells in a pipe-table row: | a | b | -> 2. Outer pipes are optional, and a
// `\|` is a literal pipe inside a cell, not a separator, so split on unescaped
// pipes only. Miscounting an escaped pipe would call a good table ragged, or a
// ragged one good, and either fences a real table or truncates a row.
function cellCount(row) {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).length;
}

// A pipe block the renderer will turn into a real <table> without dropping a
// cell: a delimiter row of dashes (colons optional) as line 2, and every row
// the same cell count, so it neither pads nor truncates. A ragged table is not
// this; it must be fenced instead, or a row with extra cells loses them.
function isGfmTable(lines) {
  if (lines.length < 2) return false;
  let sep = lines[1].trim();
  if (sep.startsWith("|")) sep = sep.slice(1);
  if (sep.endsWith("|")) sep = sep.slice(0, -1);
  const cols = sep.split("|");
  if (cols.length === 0 || !cols.every((c) => /^\s*:?-+:?\s*$/.test(c))) return false;
  const n = cellCount(lines[1]);
  return lines.every((l) => cellCount(l) === n);
}

// Strip the common leading indentation from a block so it sits at column 0,
// where its parse is guaranteed. Relative indentation inside the block is kept.
function dedent(block) {
  const lines = block.split("\n");
  let min = Infinity;
  for (const l of lines) {
    if (l.trim()) min = Math.min(min, l.match(/^[ \t]*/)[0].length);
  }
  if (min === Infinity || min === 0) return block;
  return lines.map((l) => l.slice(min)).join("\n");
}

// Shape a protected block so the renderer's parse of it is guaranteed, rather
// than hoping it reads the indentation the mask preserved. A code fence has up
// to its opening indent stripped from every line, so a fence indented four or
// more spaces is not misread as an indented code block with its ``` leaking as
// text, and the code inside keeps its relative indentation. A well-formed GFM
// table is dedented and left, to render as <table>. Anything else -- a box
// diagram, or a ragged or delimiter-less pipe block -- is dedented and wrapped
// in a code fence, to render as <pre> and keep every column and cell. This
// carries the 2026-09-20 alignment fix across the move of rendering into Rust.
function fenceForHtml(block, tilde) {
  const lines = block.split("\n");
  // Frontmatter goes to the renderer as written; it parses it as metadata.
  if (/^---\s*$/.test(lines[0]) && /^(---|\.\.\.)\s*$/.test(lines[lines.length - 1])) return block;
  if (/^\s*```/.test(lines[0])) {
    const n = lines[0].match(/^[ \t]*/)[0].length;
    const strip = new RegExp("^[ \\t]{0," + n + "}");
    const out = n === 0 ? lines : lines.map((l) => l.replace(strip, ""));
    return (tilde ? retildeFence(out) : out).join("\n");
  }
  const d = dedent(block);
  const dlines = d.split("\n");
  if (dlines.every((l) => /^\|.*\|$/.test(l.trim())) && isGfmTable(dlines)) return d;
  const f = tilde ? "~~~" : "```";
  return f + "\n" + d + "\n" + f;
}

// ``` fences to ~~~, the opening line and a closing line of bare backticks.
function retildeFence(lines) {
  const out = lines.slice();
  out[0] = out[0].replace(/^(\s*)```/, "$1~~~");
  const last = out.length - 1;
  if (last > 0 && /^\s*```\s*$/.test(out[last])) out[last] = out[last].replace("```", "~~~");
  return out;
}

// The input to the Preview and Copy HTML. It cleans the text but keeps the
// markdown, since markdown is what the HTML renderer (Rust
// engine::render_markdown) turns into tags. So it runs the non-destructive
// passes and skips the three that would remove markup: strip-markdown, bullets
// (normalizing markers is a text nicety, not markdown), and wrap (the renderer
// reflows). The result is cleaned markdown; the Rust side renders it, so the
// preview and the rich paste are the same bytes.
//
// The same mask/unmask wrapper clean() uses, and for the same reason:
// scanProtected settles where a protected block is, but does not stop the
// passes mutating one. Run over raw text, stripIndent (on by default) flattened
// the indentation of everything inside a code fence -- `def f():` / `    return
// 1` arrived as `def f():` / `return 1`, wrong for Python or YAML -- and
// joinLines reflowed it. Mask first, run the passes, then restore each block,
// fencing the ones the renderer would otherwise flatten (fenceForHtml).
export function cleanToMarkdown(text, options) {
  const o = { ...DEFAULTS, ...options };
  text = text.replace(SENTINEL_RANGE, "");
  const prot = maskProtected(text);
  let out = prot.masked;
  if (o.stripNoise)    out = stripAiNoise(out);
  if (o.stripUnicode)  out = stripUnicode(out);
  if (o.joinLines)     out = joinWrappedLines(out, true);
  if (o.stripIndent)   out = stripIndentMarkdown(out);
  if (o.collapseBlank) out = collapseBlankLines(out);
  out = restyleMarkdown(out, o);
  const src = out.trim();
  return src.replace(/\uE000(\d+)\uE001/g, (match, n, offset) => {
    const block = prot.blocks[Number(n)];
    if (block === undefined) return match;
    // A restored block must be its own block for the renderer: a GFM table on
    // the line right after a paragraph is otherwise swallowed into it. Add a
    // blank line before and after, but only when there is not one already, so
    // this never reaches inside the block to collapse its own blank lines. The
    // sentinel is always alone on its line, so offset-1 is the newline before it.
    const end = offset + match.length;
    const before = offset >= 2 && src[offset - 2] !== "\n" ? "\n" : "";
    const after = src[end] === "\n" && src[end + 1] !== "\n" ? "\n" : "";
    return before + fenceForHtml(block, o.mdFence === "tilde") + after;
  });
}

// --- Markdown style -----------------------------------------------------------
// The Markdown settings, applied to the cleaned markdown inside the protection
// mask, so code, tables and frontmatter are never touched. Each setting left
// null keeps the markdown as written.
//
// Inline code, link targets and bare URLs are masked too while the inline
// rules run, so a URL like /a_b_c/ is not read as emphasis.
export function restyleMarkdown(text, options) {
  const o = { ...DEFAULTS, ...options };
  if (!o.mdBullet && !o.mdEmphasis && !o.mdHeading && !o.mdLinks &&
      o.mdHighlight !== "plain" && !o.mdCallouts && !o.mdWrap) return text;

  const held = [];
  const hold = (m) => "\uE002" + (held.push(m) - 1) + "\uE003";
  const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

  // Inline code first, before any rule, so markdown that documents link or
  // emphasis syntax inside backticks is never rewritten. Link targets are held
  // after the link converters, which need to read them.
  text = text.replace(/`[^`\n]+`/g, hold);
  if (o.mdLinks === "reference") text = linksToReference(text);
  if (o.mdLinks === "inline") text = linksToInline(text);
  text = text.replace(/\]\([^)\n]*\)/g, hold);
  text = text.replace(/^\[[^\]\n]+\]:.*$/gm, hold);
  text = text.replace(/<[a-z][a-z0-9+.-]*:[^>\s]+>/gi, hold);
  text = text.replace(/\bhttps?:\/\/[^\s)\]]+/g, hold);

  if (o.mdBullet) {
    text = text.replace(/^([ \t]*)[-*+]([ \t]+)/gm, (m, ind, sp, off, all) => {
      const line = all.slice(off, all.indexOf("\n", off) < 0 ? all.length : all.indexOf("\n", off));
      return HR.test(line) ? m : ind + o.mdBullet + sp;
    });
  }
  if (o.mdEmphasis === "underscore") {
    text = text.replace(/(^|[^\w*])\*\*(?=\S)([^\n]*?\S)\*\*(?![\w*])/g, "$1__$2__");
    text = text.replace(/(^|[^\w*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\w*])/g, "$1_$2_");
  } else if (o.mdEmphasis === "asterisk") {
    text = text.replace(/(^|[^\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, "$1**$2**");
    text = text.replace(/(^|[^\w_])_(?=[^\s_])([^\n_]*?[^\s_])_(?![\w_])/g, "$1*$2*");
  }
  if (o.mdHighlight === "plain") {
    text = text.replace(/(^|[^=])==(?=\S)([^=\n]*?\S)==(?!=)/g, "$1$2");
  }
  if (o.mdHeading === "setext") {
    text = text.replace(/^(#{1,2})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, h, title) =>
      title + "\n" + (h === "#" ? "=" : "-").repeat(Math.max(3, title.length)));
  } else if (o.mdHeading === "atx") {
    text = text.replace(/^([^\n\s#>|\-*+][^\n]*)\n(=+|-+)[ \t]*$/gm, (m, title, bar) =>
      HR.test(title) || /^\d+[.)]\s/.test(title) ? m : (bar[0] === "=" ? "# " : "## ") + title);
  }
  if (o.mdCallouts) {
    text = text.replace(/(^|\n)>[ \t]*(?:\*\*|__)?(Note|Tip|Important|Warning|Caution)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*/gi,
      (_, lead, kind) => lead + "> [!" + kind.toLowerCase() + "]\n> ");
    text = text.replace(/\n> \n/g, "\n>\n");
  }
  if (o.mdWrap) text = wrapMarkdown(text, o.wrapWidth || 80);

  return text.replace(/\uE002(\d+)\uE003/g, (m, n) => held[Number(n)] ?? m);
}

// Wrap paragraph lines and list items; leave headings, quotes, tables, rules
// and anything holding a protected block as they are.
function wrapMarkdown(text, width) {
  return text.split("\n").map((line) => {
    if (line.length <= width || /^\s*(#|>|\||\[\^?[^\]]+\]:)/.test(line) ||
        /[\uE000\uE001]/.test(line) || /^\s*([-*_=])(\s*\1){2,}\s*$/.test(line)) return line;
    return wrapLine(line, width);
  }).join("\n");
}

// [text](url "title") -> [text][n] with the definitions gathered at the end.
function linksToReference(text) {
  const defs = [];
  const index = new Map();
  const out = text.replace(/(!?)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)/g, (m, bang, label, url, title) => {
    const key = url + "\u0000" + (title || "");
    if (!index.has(key)) {
      index.set(key, defs.length + 1);
      defs.push("[" + (defs.length + 1) + "]: " + url + (title ? ' "' + title + '"' : ""));
    }
    return bang + "[" + label + "][" + index.get(key) + "]";
  });
  return defs.length ? out.replace(/\s*$/, "") + "\n\n" + defs.join("\n") : out;
}

// [text][id], [id][] and their definitions -> [text](url "title").
function linksToInline(text) {
  const defs = new Map();
  const body = text.replace(/^[ ]{0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+"([^"\n]*)")?[ \t]*$\n?/gm, (m, id, url, title) => {
    defs.set(id.toLowerCase(), { url, title });
    return "";
  });
  if (!defs.size) return text;
  const to = (label, id) => {
    const d = defs.get(id.toLowerCase());
    return d ? "[" + label + "](" + d.url + (d.title ? ' "' + d.title + '"' : "") + ")" : null;
  };
  return body
    .replace(/(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g, (m, bang, label, id) => {
      const r = to(label, id || label);
      return r ? bang + r : m;
    })
    .replace(/\n{3,}$/, "\n");
}

// Whether text pasted or piped as plain text is really HTML source: it opens
// with a tag, and a block-level or document tag appears near the top. Prose
// that merely mentions <b> or a < b does not qualify.
export function looksLikeHtml(text) {
  const t = String(text || "").trimStart();
  if (!t.startsWith("<")) return false;
  const head = t.slice(0, 4096).toLowerCase();
  return /<(!doctype|html|body|head|meta|p|div|table|ul|ol|h[1-6]|blockquote|pre|span|br)[\s>\/]/.test(head);
}

// Editors and terminals (VS Code, JetBrains, Xcode) copy code as HTML: styled
// monospace spans under white-space: pre, with no document structure. As
// markdown it would lose its indentation, so the plain text is the better paste.
export function prefersPlainPaste(html) {
  return /white-space:\s*pre/i.test(html) &&
    !/<(p|h[1-6]|ul|ol|li|table|blockquote)[\s>]/i.test(html);
}
