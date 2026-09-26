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
  // With strip Unicode on: null removes every emoji; an array of map rows
  // (DEFAULT_EMOJI_MAP's shape) converts the mapped ones to text first.
  emojiMap: null,
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
// Terminal escape sequences, from CleanCopy (MIT): CSI (colours, ESC [ ...
// final), OSC (titles and hyperlinks, ESC ] ... BEL or ESC \), the short
// escapes, and a bare ESC. An unterminated OSC stops at the end of its line and
// needs an OSC-shaped payload, so a stray ESC ] cannot delete the rest of the
// paste. Removing the whole sequence matters: the control-character rule alone
// took the ESC and left "[31m" in the text.
const ANSI = new RegExp("\u001B(?:" +
  "\\[[0-9;?]*[ -\\/]*[@-~]" +
  "|\\][0-9;][^\u0007\u001B\\r\\n]*(?:\u0007|\u001B\\\\)?" +
  "|\\][^\u0007\u001B\\r\\n]*(?:\u0007|\u001B\\\\)" +
  "|[ -\\/]*[0-~]" +
  "|)|\u009B[0-9;?]*[ -\\/]*[@-~]", "g");
export function stripTerminalEscapes(text) { return text.replace(ANSI, ""); }

// --- Emoji to text ----------------------------------------------------------
// The default map for strip Unicode's "To text" emoji mode. Each row lists
// its symbols (space separated; a variation selector on one is ignored), the
// text used at the start of a line or list item, and the text used mid-line.
// An empty start uses the mid-line text; an empty mid-line text removes the
// symbol there. At the start of a list item the start text makes a markdown
// task: "- \u2705 Done" becomes "- [x] Done". Symbols not in the map are
// removed, as in Remove mode. The Settings editor starts from this list, and
// the Rust twin (html::map_emoji) takes the same rows.
export const DEFAULT_EMOJI_MAP = [
  { symbols: "\u2705 \u2714 \u2713 \u2611", start: "[x]", inline: "(yes)" },
  { symbols: "\u274C \u2717 \u2718 \u2716 \u274E", start: "[ ]", inline: "(no)" },
  { symbols: "\u26A0", start: "Warning:", inline: "(!)" },
  { symbols: "\u2139", start: "Note:", inline: "(note)" },
  { symbols: "\u2753 \u2754", start: "(?)", inline: "(?)" },
  { symbols: "\u2757 \u2755", start: "(!)", inline: "(!)" },
  { symbols: "\u27A1 \u2192", start: "->", inline: "->" },
  { symbols: "\u2B05 \u2190", start: "<-", inline: "<-" },
  { symbols: "\u2194", start: "<->", inline: "<->" },
  { symbols: "\u2B50 \uD83C\uDF1F", start: "*", inline: "*" },
  { symbols: "\uD83D\uDD34", start: "(red)", inline: "(red)" },
  { symbols: "\uD83D\uDFE1", start: "(yellow)", inline: "(yellow)" },
  { symbols: "\uD83D\uDFE2", start: "(green)", inline: "(green)" },
  { symbols: "\uD83D\uDC4D", start: "(+1)", inline: "(+1)" },
  { symbols: "\uD83D\uDC4E", start: "(-1)", inline: "(-1)" },
];

// The rows as symbol -> row, longest symbol first, skipping blank symbols and
// rows that are not objects (a hand-edited map is not trusted to be tidy).
function emojiTable(map) {
  const out = [];
  for (const row of Array.isArray(map) ? map : []) {
    if (!row || typeof row !== "object") continue;
    for (const sym of String(row.symbols || "").replace(/[\uFE0E\uFE0F]/g, "").split(/\s+/)) {
      if (sym) out.push({ sym, start: String(row.start ?? ""), inline: String(row.inline ?? "") });
    }
  }
  return out.sort((a, b) => [...b.sym].length - [...a.sym].length);
}

// Whether the output line so far is only indentation and a list marker
// ("  - ", "12) "), which makes the next symbol a line start. Kept as a small
// state machine fed each character as it is written, rather than re-reading
// the line on every symbol, which was quadratic on a long line (41 s for one
// 500 KB line of emoji). States: 0 indent (a start), 1 after - * +, 2 digits,
// 3 after the digits' . or ), 4 marker and its space (a start), 5 anything else.
function leadStep(state, ch) {
  if (ch === "\n") return 0;
  const blank = ch === " " || ch === "\t";
  const digit = ch >= "0" && ch <= "9";
  switch (state) {
    case 0: return blank ? 0 : "-*+".includes(ch) ? 1 : digit ? 2 : 5;
    case 1: case 3: case 4: return blank ? 4 : 5;
    case 2: return digit ? 2 : ch === "." || ch === ")" ? 3 : 5;
    default: return 5;
  }
}

// Replaces each mapped symbol with its text. Spacing: a replacement gets a
// space before it unless it follows whitespace or an opening character, and
// one after it unless whitespace or closing punctuation follows, so "done\u2705."
// is "done (yes)." and "\u2705Done" is "[x] Done". A removed symbol takes one
// following space with it when nothing but whitespace precedes it.
// Mirrored exactly by html::map_emoji in Rust; test/fixtures/emoji-parity.json
// holds cases both suites assert.
export function mapEmoji(text, map) {
  const table = emojiTable(map);
  if (!table.length) return text;
  const firsts = new Set(table.map((r) => r.sym.codePointAt(0)));
  const out = [];
  let state = 0;   // leadStep state of the output line
  let last = "";   // the last character written, "" before any
  const write = (str) => {
    for (const ch of str) state = leadStep(state, ch);
    if (str) { out.push(str); last = str[str.length - 1]; }
  };
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const hit = firsts.has(cp) ? table.find((r) => text.startsWith(r.sym, i)) : null;
    if (!hit) {
      const ch = String.fromCodePoint(cp);
      write(ch);
      i += ch.length;
      continue;
    }
    i += hit.sym.length;
    const start = state === 0 || state === 4;
    const rep = start ? (hit.start || hit.inline) : hit.inline;
    const next = text[i] || "";
    if (!rep) {
      if ((next === " " || next === "\t") && (last === "" || " \t\n".includes(last))) i++;
      continue;
    }
    if (last !== "" && !" \t\n([{\"'/-".includes(last)) write(" ");
    write(rep);
    if (next && !" \t\n.,;:!?)]}\"'".includes(next)) write(" ");
  }
  return out.join("");
}

// Latin, for the joiner rule below: Basic Latin through IPA, Latin Extended
// Additional, C, D, E, and the fullwidth forms.
function isLatin(ch) {
  const u = ch.codePointAt(0);
  return u < 0x250 || (u >= 0x1E00 && u <= 0x1EFF) || (u >= 0x2C60 && u <= 0x2C7F) ||
    (u >= 0xA720 && u <= 0xA7FF) || (u >= 0xAB30 && u <= 0xAB6F) || (u >= 0xFF00 && u <= 0xFFEF);
}

// Emoji (Extended_Pictographic, as the Rust twin uses), skin-tone modifiers,
// Mathematical Operators and their Supplement, the Currency Symbols block, and
// cent, pound and yen, with at most one space either side.
const SYMBOL_RUN = /([ \t]?)((?:\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u2200-\u22FF\u2A00-\u2AFF\u20A0-\u20CF\u00A2\u00A3\u00A5])+)([ \t]?)/gu;

export function stripUnicode(text, emojiMap) {
  text = stripTerminalEscapes(text);
  // Zero-width & invisible formatting: soft hyphen, ZWSP, LRM, RLM, BOM
  text = text.replace(/[\u00AD\u200B\u200E\u200F\uFEFF]/g, "");
  // ZWNJ and ZWJ spell words in Persian, Arabic, Hindi and other scripts, so
  // they stay between two letters of a script that is not Latin. Anywhere
  // else (between Latin letters, next to a space or emoji) they are noise.
  text = text.replace(/(?<=([\p{L}\p{M}])?)[\u200C\u200D](?=([\p{L}\p{M}])?)/gu,
    (m, a, b) => (a && b && !isLatin(a) && !isLatin(b) ? m : ""));
  // Unusual spaces (no-break, narrow no-break, en/em/thin/hair, ideographic)
  // read as an ordinary space.
  text = text.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  // Line and paragraph separators are line breaks.
  text = text.replace(/[\u2028\u2029]/g, "\n");
  // Variation Selectors U+FE00-FE0F
  text = text.replace(/[\uFE00-\uFE0F]/g, "");
  // Variation Selectors Supplement U+E0100-E01EF (surrogate-pair encoded)
  text = text.replace(/\uDB40[\uDD00-\uDDEF]/g, "");
  // Bidi embedding/override controls U+202A-202E and isolates U+2066-2069
  text = text.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  // Control characters (TAB, LF and CR are preserved)
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  // To text mode: mapped symbols become their text first, after the
  // variation selectors above are gone, so the rest go as in Remove mode.
  if (emojiMap) text = mapEmoji(text, emojiMap);
  // Emoji (with their skin-tone modifiers), math operators and non-ASCII
  // currency symbols. A symbol takes a space beside it along, so "\u2705 Done"
  // is "Done" and "x \u2264 y" is "x y", not a doubled or leading space. One
  // space stays where a word would otherwise touch: "costs \u20AC5" is
  // "costs 5".
  text = text.replace(SYMBOL_RUN, (m, before, run, after, off, all) => {
    if (before && after) return " ";
    const word = /[\p{L}\p{N}]/u;
    if (before && word.test(all[off + m.length] || "")) return " ";
    if (after && word.test(all[off - 1] || "")) return " ";
    return "";
  });
  return text;
}

export function stripAiNoise(text) {
  // Colour codes and window titles are terminal noise too, so this pass
  // takes them even with strip Unicode off.
  return stripTerminalEscapes(text).split("\n").map((line) => {
    const t = line.trim();
    if (/^Thought for \d+/.test(t)) return null;          // "Thought for 8s"
    if (/^\u23BF/.test(t)) return null;                // U+23BF nested output marker
    let out = line.replace(/\s*\(ctrl\+o to expand\)/gi, "");
    out = out.replace(/^(\s*)[\u25CF\u23FA]\s+/, "$1");         // U+25CF / U+23FA tool markers
    return out;
  }).filter((l) => l !== null).join("\n");
}

// Tag names stripMarkdown removes. Only real HTML: a bare <[^>]+> also ate
// `Promise<void>`, `in <module>` and `Vec<String>`.
const HTML_TAG = new RegExp("</?(?:" + [
  "a", "abbr", "article", "aside", "audio", "b", "bdi", "bdo", "big", "blockquote", "body",
  "br", "button", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del",
  "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "form",
  "h[1-6]", "head", "header", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd",
  "label", "li", "link", "main", "mark", "meta", "nav", "ol", "p", "picture", "pre", "q", "s",
  "samp", "script", "section", "small", "source", "span", "strike", "strong", "style", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "tt", "u",
  "ul", "var", "video", "wbr",
].join("|") + ")(?=[\\s>/])[^<>]*>", "gi");

export function stripMarkdown(text) {
  text = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_, code) => code.trimEnd());
  // Inline code is held aside while the rules run, so `**kwargs`, `a_b_c` or
  // `\d+\.` inside backticks come back exactly as written, minus the ticks.
  const held = [];
  text = text.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`])\1(?!`)/g,
    (m, ticks, code) => "\uE004" + (held.push(code.replace(/^ (.*) $/, "$1")) - 1) + "\uE005");
  // A heading becomes its title, with a blank line after it unless one is
  // already there.
  text = text.replace(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm, (m, title, off, all) =>
    /^\n[ \t]*\S/.test(all.slice(off + m.length, off + m.length + 200)) ? title + "\n" : title);
  // Emphasis needs a non-space inside each marker and stays within a
  // paragraph, so `a * b` / `c * d` and 2*3*4 keep their asterisks. Each
  // marker looks at most 1000 characters ahead for its closer: unbounded, a
  // paste full of unclosed markers was quadratic (15 s for 200 KB).
  text = text.replace(/(^|[^\w*\\])(\*{1,3})(?=[^\s*])((?:[^\n]|\n(?![ \t]*\n)){0,1000}?[^\s*\\])\2(?![\w*])/g, "$1$3");
  text = text.replace(/(?<![\w\\])(_{1,3})(\S(?:[^\n]{0,1000}?\S)?)(?<!\\)\1(?!\w)/g, "$2"); // _em_ only at word boundaries, \_ is not a marker
  text = text.replace(/(^|[^~])~~(?=\S)([^\n]{0,1000}?\S)~~(?!~)/g, "$1$2");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  // Images first. The link pattern also matches the bracket pair inside
  // ![alt](src), which consumes it and strands the leading "!".
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1");           // <https://x>
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(HTML_TAG, "");
  // Obsidian: callout markers read as a label, wikilinks and embeds as their
  // display text, ==highlight== as plain text, %%comments%% not at all.
  text = text.replace(/^\[!(\w[\w-]*)\][+-]?[ \t]*(.*)$/gm, (_, kind, title) =>
    (title || kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase()) + ":");
  text = text.replace(/!?\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target, alias) =>
    (alias || target).trim());
  text = text.replace(/(^|[^=])==(?=\S)([^=\n]*?\S)==(?!=)/g, "$1$2");
  text = text.replace(/%%[\s\S]*?%%/g, "");
  // Backslash escapes (\* \_ \# ...) read as the character. Outside inline
  // code only, which is still held.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1");
  return text.replace(/\uE004(\d+)\uE005/g, (m, n) => held[Number(n)] ?? m);
}

export function normalizeBullets(text) {
  text = text.replace(/^[ \t]*[*+]\s+/gm, "- ");
  text = text.replace(/^([ \t]*)[-]\s{2,}/gm, "$1- ");
  return text;
}

// Joins soft-wrapped lines back into the paragraph or list item they came
// from. keepListIndent is for the markdown path: list lines keep their
// indentation (nesting), where the text path flattens them.
//
// In a paragraph, a break is a soft wrap when the next line's first word would
// not have fit on the line: a wrapper fills each line greedily, so if the word
// fit, the break was typed. The width is the block's longest line, and it only
// counts as a wrap column when a second line reaches it too, or when a long
// line runs on into a lowercase one. Without that, the longest line of any
// block (a list of short commands, two joined paragraphs on a second run)
// "does not fit" its successor by definition. This replaced a fixed "shorter
// than 50 characters is a title" rule, which never joined text wrapped
// narrower than 50 and split a paragraph's short last line from it.
//
// In a list item, continuation lines are part of the item, as CommonMark reads
// them whether or not they are indented, so they join unless a break was
// clearly meant. Everywhere, a line ending in ":" leads into what follows, a
// markdown hard break (two spaces or a backslash) is kept, a heading stands
// alone, and a sentence that ends where a capitalized one starts keeps its
// break (see softWrap).
const WRAP_MARKER = /^(?:[-*+]|\d+[.)])[ \t]/;
export function joinWrappedLines(text, keepListIndent) {
  // Box-drawing glyphs (U+2500 block) mark ASCII tables/diagrams we must not reflow.
  const BOX = /[\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C\u2502]/;
  const parts = text.split(/(\n{2,})/);
  return parts.map((part) => {
    if (/^\n+$/.test(part)) return part;
    const lines = part.split("\n").filter(Boolean);
    if (lines.length <= 1) return part;
    const trimmed = lines.map((l) => l.trim());
    // Quotes keep their lines: joining a quote put a stray " > " mid-line and
    // merged a > [!note] callout's title into its body.
    if (trimmed.some((l) => l.startsWith(">"))) {
      return keepListIndent ? lines.map((l) => l.trimEnd()).join("\n") : trimmed.join("\n");
    }
    if (trimmed.some((l) => BOX.test(l)) ||
        trimmed.filter((l) => l.startsWith("|")).length > 1) return trimmed.join("\n");
    // Widths without indentation, which strip indent may remove after this
    // pass; measured with it, a second run would see different geometry. The
    // wrap column needs two lines besides the last, which is usually short.
    const lens = trimmed.map((l) => l.length);
    // A loop, not Math.max(...lens): spreading 150k line lengths as arguments
    // overflowed the call stack on a large log paste.
    let width = 0;
    for (const n of lens) if (n > width) width = n;
    const slack = Math.max(3, Math.ceil(width * 0.1));
    const column = lens.slice(0, -1).filter((n) => n >= width - slack).length >= 2;
    const out = [];
    let prev = null;     // the last raw line of the paragraph or item being built
    let inItem = false;  // building a list item rather than a paragraph
    let depth = 0;       // brackets left open in the line being built
    for (const line of lines) {
      const t = line.trim();
      const marker = WRAP_MARKER.test(t);
      // An unclosed bracket runs on whatever the geometry says. The depth is
      // kept as lines are added: rescanning the whole paragraph each time
      // made a long paragraph quadratic (107 s for a 1.3 MB one).
      if (prev !== null && !marker && !hardBreak(prev, line) &&
          (inItem || depth > 0 || softWrap(prev, line, width, column))) {
        out[out.length - 1] += " " + t;
        depth = bracketDepth(t, depth);
      } else {
        depth = bracketDepth(t, 0);
        // Marker lines lose their indentation on the text path, as before;
        // any other line that starts fresh keeps it, so a second run sees the
        // same geometry this one did.
        out.push(marker && !keepListIndent ? t : line.trimEnd());
        inItem = marker;
      }
      prev = line;
    }
    return out.join("\n");
  }).join("");
}

// Brackets still open after text, starting from depth: more ( or [ opened
// than closed means the text runs on.
function bracketDepth(text, depth) {
  for (const c of text) {
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
  }
  return depth;
}

// A break that was typed, whatever the geometry.
function hardBreak(line, next) {
  if (/[\uE000\uE001]/.test(line) || /[\uE000\uE001]/.test(next)) return true;
  if (/(?: {2}|\\)$/.test(line)) return true;              // markdown hard break
  const a = line.trim(), b = next.trim();
  if (!a || !b || /:$/.test(a) || a.startsWith("#") || b.startsWith("#")) return true;
  if (/^(?:=+|-+)$/.test(b)) return true;                 // setext underline or rule
  // A sentence that ends where a capitalized one starts. Wrapped text splits
  // there only when a sentence happens to end at the wrap column, and without
  // this a second run could not tell two joined paragraphs from one wrapped one.
  return /[.!?]["')\]]*$/.test(a) && /^["'(\[]*[\p{Lu}\d]/u.test(b);
}

function softWrap(line, next, width, column) {
  const a = line.trim();
  const b = next.trim();
  if (a.length + 1 + b.split(/\s/)[0].length <= width) return false; // the word fit
  return column || (a.length >= 40 && /^[\p{Ll}]/u.test(b));
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

// hang: indent wrapped lines under the text of a list item. Off when strip
// indent is on, which would take the indent away again on the next run.
export function wrapLine(line, width, hang = true) {
  if (line.length <= width) return line;
  // The line's own indentation, then a list marker if there is one: wrapped
  // lines hang under the text, not the marker, and the marker keeps its first
  // word even when that word is too long to fit (a lone "-" line is not a
  // list item any more).
  const m = line.match(/^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+)?/);
  const lead = m[0];
  const prefix = hang ? m[1] + " ".repeat(m[2] ? m[2].length : 0) : "";
  const words = line.slice(lead.length).split(/ +/).filter(Boolean);
  const lines = [];
  let current = lead;
  for (const word of words) {
    const bare = current === lead || current === prefix;
    const test = bare ? current + word : current + " " + word;
    if (test.length > width && !bare) { lines.push(current); current = prefix + word; }
    else current = test;
  }
  if (current.trim()) lines.push(current);
  return lines.join("\n");
}

export function wrapText(text, width, hang = true) {
  return text.split("\n").map((line) => wrapLine(line, width, hang)).join("\n");
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
//   { from, to, kind: "fence" | "box" | "table" | "frontmatter" | "code", closed }
// `closed` is meaningful for a fence only, and says whether `to - 1` is the
// closing delimiter or the fence simply ran out of input.
//
// Fences follow CommonMark: ``` or ~~~, three or more, closed by a line of the
// same character at least as long with nothing after it. A backtick opener
// whose info string holds a backtick (```inline```) is inline code, not a fence.
//
// "code" is everything that is code-shaped without a fence around it: source,
// stack traces, logs, shell transcripts, diffs, JSON, YAML, aligned columns.
// See classifyCode below. It runs over what the explicit kinds left.
export function scanProtected(lines) {
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
    const open = fenceOpen(lines[i]);
    if (open) {
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j], open)) j++;
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
  // Classify the stretches between the explicit ranges.
  const all = [];
  let at = 0;
  for (const r of ranges) {
    if (r.from > at) for (const c of classifyCode(lines, at, r.from)) all.push(c);
    all.push(r);
    at = r.to;
  }
  if (at < lines.length) for (const c of classifyCode(lines, at, lines.length)) all.push(c);
  return all;
}

// An opening fence: its character, its length, and nothing else needed.
function fenceOpen(line) {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { ch: m[1][0], len: m[1].length };
}

function isFenceClose(line, open) {
  const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  return !!m && m[1][0] === open.ch && m[1].length >= open.len;
}

// --- Unfenced code ------------------------------------------------------------
// Terminal copies and AI answers carry code, logs and command output with no
// fence around them, and every prose pass (join lines, strip indent, strip
// markdown) mangles them: indentation flattened, stack frames joined into one
// line, `a * b` read as emphasis. This finds them so the mask can keep them
// verbatim.
//
// The cost of a mistake is lopsided. Leaving a prose paragraph alone costs a
// tidy-up; reflowing code breaks it. So the tells are specific, and a block
// needs code-shaped lines, not a lone keyword, before it is protected. The
// approach and several patterns follow CleanCopy (github.com/kart1ka/CleanCopy,
// MIT), whose rule is: when unsure, leave the block alone.

// A statement the way code writes it. English words that are also keywords
// (if, for, return, import) only count with the syntax code puts after them,
// so a wrapped paragraph whose line happens to start "for the" is not code.
const CODE_STATEMENT = new RegExp("^\\s*(?:" + [
  /(?:def|elif|fn|func|impl|struct|enum|trait|namespace|package)\s+\w/,
  /(?:if|for|while|switch|catch)\s*\(/,
  /(?:if|elif|while|for|with|try|except|finally|else)\b[^\n]*:\s*$/,
  /import\s+[\w.]+(?:\s+as\s+\w+)?\s*;?\s*$/,
  /from\s+[\w.]+\s+import\s/,
  /(?:const|let|var|val|mut)\s+[\w$]+\s*[:=]/,
  /(?:async\s+)?function\s*[\w$]*\s*\(/,
  /class\s+[\w$]+\s*(?:[:({<]|\s(?:extends|implements)\s)/,
  /(?:import|export)\b[^\n]*(?:\{|\bfrom\s*['"])/,
  /export\s+(?:default|async|const|function|class|interface|type)\b/,
  /(?:public|private|protected|internal)\s+(?:static|final|abstract|void|class|async|fun|override|readonly)\b/,
  /(?:raise|throw)\s+(?:new\s+)?[\w.]+\s*\(/,
  /return\s*;?\s*$/,
  /return\b[^\n]*[;)\]}]\s*$/,
  /#!\//,
  /#include\s*[<"]/,
  /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+TABLE|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|LEFT\s+JOIN|INNER\s+JOIN|JOIN)\b/,
].map((r) => r.source).join("|") + ")");

// A single line that is code, a stack frame, a log line or a diff header.
const STRONG_LINE = [
  CODE_STATEMENT,
  /^\s*[{}[\]()]+[;,]?\s*$/,                        // a lone bracket line
  /^\s*[}\])][}\])]*\s*(?:[;,.)\]}]|(?:else|catch|finally|while)\b|$)/, // }, });, } else {
  /(?:\{|=>)\s*$/,                                   // opens one
  /^(?=\s*\S)(?=[^\n]*[(=])[^\n]*;\s*$/,               // call or assignment ending in ; (lookaheads, not [^\n]*[(=][^\n]*, which backtracked quadratically)
  /^\s*[\w$.]+(?:\[[^\]]*\])?\s*(?:[-+*/%|&^]|\?\?|\|\||&&|:)?=(?!=)\s*\S/, // x = 1, x += 1, x := 1
  /^\s*(?:await\s+)?[\w$.]+\([^()]*\)\s*;?\s*$/,     // a bare call: main()
  /^\s*"[^"\n]*"\s*:\s*\S/,                          // "json": key
  /^\s*(?:\/\/|\/\*|\*\/|<!--|-->)/,                 // comment delimiters
  /^Traceback \(most recent call last\):/,
  /^\s*File "[^"]+", line \d+/,
  /^\s*at\s+\S[^\n]*(?:\(\S*:\d+(?::\d+)?\)|:\d+:\d+)\s*$/, // at fn (file:1:2)
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,          // timestamped log
  /^\s*\[?(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\]?[:\s]/,
  /^npm (?:ERR!|error|warn|notice) /,
  /^diff --git /, /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
  /^index [0-9a-f]{6,}\.\.[0-9a-f]{6,}/, /^(?:\+\+\+|---) (?:a\/|b\/|\/dev\/null)/,
  /^[-dlcbps][rwxsStT-]{9}[@+.]?\s+\d+\s/,            // ls -l
];

// Supporting evidence only; never enough alone.
const WEAK_LINE = [
  /^ *\t/,                                           // tab indentation
  /^\s*(?:[\w.]+\.)?[A-Z]\w*(?:Error|Exception)(?::|$)/, // ValueError: boom
  /(?:[^\s.!?:] {2,}\S.*){2}/,                        // two gaps of aligned columns
];

// A shell prompt with a command after it: "$ ls", "% git status",
// "user@host dir % cmd", "PS C:\> dir", "C:\> dir", ">>> x".
const PROMPT = new RegExp([
  /^\s*[$%\u276F\u279C] \S/,
  // user@host, then a path or one directory name that is not a bare number,
  // so an email address followed by "20 % off" is not a prompt.
  /^\s*[\w.-]+@[\w.-]+(?::[~\/]\S*|\s+[\w.\/~-]*[A-Za-z~\/][\w.\/~-]*)?\s?[$%#>](?: \S|\s*$)/,
  /^PS [A-Za-z]:\\[^>]*> /,
  /^[A-Za-z]:\\[^>]*>\S/,
  /^>>> /,
].map((r) => r.source).join("|"));

// A line that is a shell command: a command word that is not also English, an
// English one (find, make, open) followed by a flag or a path, an env-var
// prefix (FOO=1 cmd), a path invocation (./x), or a trailing \ continuation.
const COMMAND = new RegExp("^\\s*(?:" + [
  "(?:sudo\\s+)?(?:git|gh|npm|npx|pnpm|yarn|bun|deno|node|brew|cd|ls|mkdir|rmdir|rm|cp|mv|cat|echo|" +
    "export|unset|curl|wget|docker|podman|kubectl|helm|pip3?|pipx|python3?|uv|poetry|pytest|cargo|" +
    "rustup|rustc|go|gofmt|javac?|mvn|gradle|dotnet|ruby|gem|bundle|rails|php|composer|swift|" +
    "xcodebuild|xcrun|terraform|aws|gcloud|az|ssh|scp|rsync|chmod|chown|ln|tar|unzip|zip|grep|rg|" +
    "sed|awk|jq|xargs|tee|wc|du|df|ps|kill|pkill|killall|systemctl|launchctl|journalctl|apt|" +
    "apt-get|yum|dnf|pacman|choco|winget|scoop|psql|mysql|sqlite3|redis-cli|openssl|tauri|vite|" +
    "tsc|eslint|prettier|pbcopy|pbpaste|defaults|codesign|xattr|source|nvm|pyenv|conda)(?:\\s|$)",
  "(?:find|make|open|touch|less|head|tail|sort|uniq|diff|which|env|set|code|vim|nano|top|test)" +
    "\\s+(?:-|\\.|~|\\/|\\$)",
  "[A-Z_][A-Z0-9_]*=\\S*\\s+\\S",
  "\\.{1,2}\\/\\S",
].join("|") + ")|\\\\\\s*$");

// A YAML mapping: every line a key or a "- " item, some line nested under
// another. Keys are identifiers, so "Note: this" prose does not qualify.
const YAML_LINE = /^\s*(?:- )?[a-z_][\w.-]*:(?:\s|$)|^\s*- \S/;

// Why a block is code (for --explain), or null when it is not.
function isCodeBlock(lines) {
  // Judge the block without its shared margin: terminal copies indent every
  // line by the same amount, and a diff or YAML test anchors at column 0.
  const block = dedent(lines.join("\n")).split("\n");
  const n = block.length;
  if (/^\s*\/\*/.test(block[0]) && /\*\/\s*$/.test(block[n - 1])) return "block comment";
  if (/^\s*<!--/.test(block[0]) && /-->\s*$/.test(block[n - 1])) return "block comment";
  // Line comments all the way down: // and ; and -- (SQL).
  for (const pre of [/^\s*\/\/ ?/, /^\s*; /, /^\s*-- /]) {
    if (n >= 2 && block.every((l) => pre.test(l))) return "line comments";
  }
  if (n >= 2 && block.every((l) => YAML_LINE.test(l)) &&
      block.some((l) => /^\s+\S/.test(l)) && block.some((l) => /:(?:\s|$)/.test(l))) return "yaml";
  // A unified diff hunk with no headers: every line +, - or space, with both
  // an added and a removed line, and not a markdown list ("- a" / "+ b").
  if (n >= 2 && block.every((l) => /^[-+ ]/.test(l)) &&
      block.some((l) => /^\+(?!\+)/.test(l)) && block.some((l) => /^-(?!-)/.test(l)) &&
      block.some((l) => /^[-+](?! \S)/.test(l))) return "diff hunk";
  // git branch: "* current" once, the rest indented two.
  if (n >= 2 && block.every((l) => /^(?:\* | {2})[\w.\/-]+$/.test(l)) &&
      block.filter((l) => l.startsWith("* ")).length === 1) return "git branch list";
  // Two columns: a second column starting at the same place on every line
  // (make help, CLI usage, a key/description table).
  if (n >= 2) {
    const cols = block.map((l) => { const m = l.match(/^\s*\S(?:\S| (?! ))*? {2,}(?=\S)/); return m ? m[0].length : -1; });
    if (cols.every((c) => c > 0 && c === cols[0])) return "two columns";
  }
  // Paths, one per line, no spaces: a file list.
  if (n >= 2 && block.every((l) => /^\s*[\w.@~-]*[\/\\][\w.@~\/\\-]*\s*$/.test(l) || /^\s*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,6}\s*$/.test(l))) return "file list";
  // SQL in lowercase: a select list of bare names, then from a table.
  if (block.some((l) => /^\s*select\s+(?:\*|[\w.]+(?:\s*,\s*[\w.]+)*)\s+from\s+[\w.]+/i.test(l))) return "sql";
  // A run of shell commands with no prompt: most lines command-shaped.
  if (n >= 2 && block.filter((l) => COMMAND.test(l)).length * 3 >= n * 2) return "shell commands";
  // Aligned columns (kubectl, ps, docker): every line has two column gaps.
  if (n >= 2 && block.every((l) => WEAK_LINE[2].test(l))) return "aligned columns";
  let strong = 0, weak = 0;
  for (let k = 0; k < n; k++) {
    const l = block[k];
    // A make target with a tab-indented recipe under it.
    const target = /^[\w.\/%-]+:(?:[ \t][^=\n]*)?$/.test(l) && k + 1 < n && /^ *\t/.test(block[k + 1]);
    if (target || STRONG_LINE.some((r) => r.test(l))) strong++;
    else if (WEAK_LINE.some((r) => r.test(l))) weak++;
  }
  return strong >= 1 && (strong * 2 + weak) >= n ? `code-shaped lines (${strong} strong, ${weak} weak of ${n})` : null;
}

// Ranges of kind "code" in lines[from, to).
function classifyCode(lines, from, to) {
  const blank = (k) => !lines[k].trim();
  const out = [];
  // Shell transcripts first: from the first prompt to the last one, and the
  // last command's output up to the next blank line. Output between prompts
  // is kept whole, blank lines included.
  let first = -1, last = -1;
  for (let k = from; k < to; k++) {
    if (PROMPT.test(lines[k])) { if (first < 0) first = k; last = k; }
  }
  let tFrom = to, tTo = to;
  if (first >= 0) {
    let end = last + 1;
    while (end < to && !blank(end)) end++;
    tFrom = first; tTo = end;
  }
  let spanWhy = "shell transcript";
  // A /* block comment */ or <!-- --> that runs across blank lines is one
  // span, the same way (only when no transcript was found first).
  if (first < 0) {
    for (let k = from; k < to && tFrom === to; k++) {
      const pair = /^\s*\/\*/.test(lines[k]) && !/\*\//.test(lines[k]) ? /\*\/\s*$/
        : /^\s*<!--/.test(lines[k]) && !/-->/.test(lines[k]) ? /-->\s*$/ : null;
      if (!pair) continue;
      for (let j = k + 1; j < to && j - k < 200; j++) {
        if (pair.test(lines[j])) { tFrom = k; tTo = j + 1; spanWhy = "block comment"; break; }
      }
    }
  }
  // Blank-line separated blocks outside the transcript.
  const blocks = [];
  let k = from;
  while (k < to) {
    if (k === tFrom) { blocks.push({ from: tFrom, to: tTo, code: spanWhy }); k = tTo; continue; }
    if (blank(k)) { k++; continue; }
    let j = k;
    while (j < to && j !== tFrom && !blank(j)) j++;
    const block = lines.slice(k, j);
    blocks.push({ from: k, to: j, code: isCodeBlock(block),
                  indented: block.every((l) => /^\s/.test(l)) });
    k = j;
  }
  // Merge a code block with the code or indented blocks that follow it across
  // blank lines, so a function with a blank line inside, or a make recipe with
  // a gap, is one range and its blank lines stay as they were.
  for (let b = 0; b < blocks.length; b++) {
    if (!blocks[b].code) continue;
    let end = blocks[b].to;
    let c = b + 1;
    while (c < blocks.length && (blocks[c].code || blocks[c].indented)) { end = blocks[c].to; c++; }
    out.push({ from: blocks[b].from, to: end, kind: "code", closed: true, why: blocks[b].code });
    b = c - 1;
  }
  return out;
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

// The part of the noise and Unicode passes that also reaches code, logs and
// transcripts, which the mask otherwise keeps from every pass: terminal escapes
// (a colour code in a copied transcript is never content), and with strip
// Unicode the invisible characters (zero-width spaces, BOM, soft hyphens, bidi
// controls), which in code are a bug or a Trojan Source attack. Emoji,
// symbols and joiners inside code are left alone.
function stripUnmaskable(text, o) {
  if (o.stripNoise || o.stripUnicode) text = stripTerminalEscapes(text);
  if (o.stripUnicode) text = text.replace(/[\u00AD\u200B\u200E\u200F\uFEFF\u202A-\u202E\u2066-\u2069]/g, "");
  return text;
}

// --- Entry points -----------------------------------------------------------
// What both paths do to the input before anything else, whatever the options.
// Our own bookkeeping characters go (see SENTINEL_RANGE), and CRLF and lone CR
// line endings become LF: a Windows clipboard delivers CRLF, and the passes
// split lines on "\n" while a regex's ^ and $ also break at "\r", so the two
// disagreed about where a line ends, and "\r" counted toward wrap widths.
export function normalizeInput(text) {
  return String(text ?? "").replace(SENTINEL_RANGE, "").replace(/\r\n?/g, "\n");
}

// Pass order is load-bearing. The whole run is wrapped in maskProtected /
// unmaskProtected, which is what keeps table columns aligned. To protect new
// content, extend the masking; never teach an individual pass to skip tables.
export function clean(text, options) {
  const o = { ...DEFAULTS, ...options };
  // Our own bookkeeping characters are removed before masking. Otherwise a
  // paste carrying one, which happens for real because U+E000 onwards is where
  // Nerd Font glyphs live in terminal prompts, could be read back as a block
  // index and swap a chunk of the user's text for one of ours.
  text = normalizeInput(text);
  text = stripUnmaskable(text, o);
  const prot = maskProtected(text);
  let out = prot.masked;
  if (o.stripNoise)    out = stripAiNoise(out);
  if (o.stripUnicode)  out = stripUnicode(out, o.emojiMap);
  if (o.stripMarkdown) out = stripMarkdown(out);
  if (o.bullets)       out = normalizeBullets(out);
  if (o.joinLines)     out = joinWrappedLines(out);
  if (o.stripIndent)   out = stripIndent(out);
  if (o.collapseBlank) out = collapseBlankLines(out);
  if (o.wrap)          out = wrapText(out, o.wrapWidth, !o.stripIndent);
  // Plain text has no use for a note's YAML header: with markdown stripped,
  // frontmatter goes too.
  // Strip indent takes the margin shared by the whole paste (a terminal's
  // left gutter) off unfenced code too. Only that much: code indented under a
  // heading keeps its indentation, and code keeps its own nesting.
  const margin = o.stripIndent ? sharedMargin(text) : 0;
  const blocks = prot.blocks.map((b, n) => {
    if (o.stripMarkdown && prot.kinds[n] === "frontmatter") return "";
    if (margin && prot.kinds[n] === "code") {
      return b.split("\n").map((l) => l.replace(new RegExp("^[ \\t]{0," + margin + "}"), "")).join("\n");
    }
    return b;
  });
  return trimOuter(unmaskProtected(trimOuter(out), blocks));
}

// The indentation every non-blank line shares, in characters.
function sharedMargin(text) {
  let min = Infinity;
  for (const l of text.split("\n")) {
    if (l.trim()) min = Math.min(min, l.match(/^[ \t]*/)[0].length);
  }
  return min === Infinity ? 0 : min;
}

// Outer blank lines and trailing whitespace go; the first line's indentation
// stays, since it may be code. (A plain trim() used to flatten it.)
function trimOuter(text) {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd().replace(/^[ \t]+$/, "");
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
  if (fenceOpen(lines[0])) {
    const n = lines[0].match(/^[ \t]*/)[0].length;
    const strip = new RegExp("^[ \\t]{0," + n + "}");
    const out = n === 0 ? lines : lines.map((l) => l.replace(strip, ""));
    return (tilde ? retildeFence(out) : out).join("\n");
  }
  const d = dedent(block);
  const dlines = d.split("\n");
  if (dlines.every((l) => /^\|.*\|$/.test(l.trim())) && isGfmTable(dlines)) return d;
  // Longer than any run of the fence character inside, so a code block that
  // itself contains ``` cannot close its own fence early.
  const ch = tilde ? "~" : "`";
  const runs = d.match(tilde ? /~{3,}/g : /`{3,}/g) || [];
  const f = ch.repeat(runs.reduce((n, r) => Math.max(n, r.length + 1), 3));
  return f + "\n" + d + "\n" + f;
}

// ``` fences to ~~~, the opening line and a closing line of bare backticks.
function retildeFence(lines) {
  const out = lines.slice();
  // The whole run, so a four-backtick fence becomes four tildes, not "~~~`".
  const tildes = (m, ind, run) => ind + "~".repeat(run.length);
  out[0] = out[0].replace(/^(\s*)(`{3,})/, tildes);
  const last = out.length - 1;
  if (last > 0 && /^\s*`{3,}\s*$/.test(out[last])) out[last] = out[last].replace(/^(\s*)(`{3,})/, tildes);
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
  text = normalizeInput(text);
  text = stripUnmaskable(text, o);
  const prot = maskProtected(text);
  let out = prot.masked;
  if (o.stripNoise)    out = stripAiNoise(out);
  if (o.stripUnicode)  out = stripUnicode(out, o.emojiMap);
  if (o.joinLines)     out = joinWrappedLines(out, true);
  if (o.stripIndent)   out = stripIndentMarkdown(out);
  if (o.collapseBlank) out = collapseBlankLines(out);
  out = restyleMarkdown(out, o);
  const src = trimOuter(out);
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
