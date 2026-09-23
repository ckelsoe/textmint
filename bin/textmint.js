#!/usr/bin/env node
// Textmint CLI. Data in, data out: pipe AI text through it like any Unix tool,
// or hand a file to the GUI for review. It reuses the exact same passes
// (src/pipeline.js) and, for HTML, the same Rust engine the app uses, so CLI
// output and app output match.
//
//   textmint clean    < messy.txt       # cleaned plain text (markdown removed)
//   textmint markdown < notes.md        # cleaned, markdown kept (source for HTML)
//   textmint html     < notes.md        # the same HTML Copy HTML produces
//   textmint open       notes.md        # load into the Textmint window to review
//
// Options for clean/markdown/html (all passes on by default, matching the app's
// shipped defaults): --no-strip-noise --no-strip-unicode --no-strip-markdown
// --no-bullets --no-join-lines --no-strip-indent --no-collapse-blank --no-wrap
// --wrap <n>
//
// HTML input (a saved web page, a Word export, a clipboard dump) is detected
// and handled like the app's rich paste: converted to markdown for clean and
// markdown, and cleaned with its formatting kept for html. --from-html forces
// that, --plain turns detection off. --flavor commonmark|github|obsidian and
// --html-mode clean|markdown match the app's Settings.

import { clean, cleanToMarkdown, looksLikeHtml } from "../src/pipeline.js";
import { MD_PRESETS, HTML_DEFAULTS, renderFlavorFor } from "../src/controls.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync, spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every accepted flag. An unknown one (a typo like --no-strip-markdow) is
// rejected rather than ignored, so a silently-on pass never surprises a caller.
const KNOWN_FLAGS = new Set([
  "help", "version", "wrap", "from-html", "plain", "flavor", "html-mode",
  "no-strip-noise", "no-strip-unicode", "no-strip-markdown", "no-bullets",
  "no-join-lines", "no-strip-indent", "no-collapse-blank", "no-wrap",
]);

function fail(msg) {
  process.stderr.write("textmint: " + msg + "\n");
  process.exit(1);
}

const USAGE = `textmint - clean & convert AI text on the command line

Usage:
  textmint clean    [options] [file]   Clean text, markdown removed (stdin -> stdout)
  textmint markdown [options] [file]   Clean text, markdown kept   (stdin -> stdout)
  textmint html     [options] [file]   Clean to markdown, render to HTML
  textmint open     [file|-]           Load text into the Textmint window to review

Options (clean/markdown/html), all on by default:
  --no-strip-noise --no-strip-unicode --no-strip-markdown --no-bullets
  --no-join-lines --no-strip-indent --no-collapse-blank
  --no-wrap            Do not hard-wrap lines
  --wrap <n>           Wrap width (default 80)

HTML input is detected and kept formatted, as the app's rich paste does:
  --from-html          Treat the input as HTML even if it does not look like it
  --plain              Treat the input as plain text, never as HTML
  --flavor <f>         Markdown flavor: commonmark, github (default), obsidian
  --html-mode <m>      html from HTML input: clean (default, keeps formatting)
                       or markdown (rendered from the converted markdown)
  -h, --help           Show this help
  -v, --version        Show version

A file argument (or - for stdin) is read as input; with none, reads stdin.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  const values = {};
  let wrapWidth = 80;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wrap") {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n)) fail("--wrap needs a number");
      wrapWidth = n;
    } else if (a === "--flavor" || a === "--html-mode") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(a + " needs a value");
      flags.add(a.slice(2));
      values[a.slice(2)] = v;
    } else if (a === "-h" || a === "--help") {
      flags.add("help");
    } else if (a === "-v" || a === "--version") {
      flags.add("version");
    } else if (a.startsWith("--")) {
      flags.add(a.slice(2));
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, values, wrapWidth };
}

function optsFrom({ flags, values, wrapWidth }) {
  const on = (name) => !flags.has("no-" + name);
  const preset = MD_PRESETS[values.flavor || "github"] || MD_PRESETS.github;
  return {
    // The flavor's highlight setting, from the same presets the app applies.
    mdHighlight: preset["md-highlight"],
    stripNoise: on("strip-noise"),
    stripUnicode: on("strip-unicode"),
    stripMarkdown: on("strip-markdown"),
    bullets: on("bullets"),
    joinLines: on("join-lines"),
    stripIndent: on("strip-indent"),
    collapseBlank: on("collapse-blank"),
    wrap: on("wrap"),
    wrapWidth,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function readInput(positional) {
  const src = positional[0];
  if (src && src !== "-") return readFileSync(src, "utf8");
  return readStdin();
}

// The places the CLI needs the Rust engine: rendering markdown to HTML, and
// converting or cleaning HTML input. It shells to a small textmint-render
// binary built from the same engine the app uses, so there is never a second
// converter to drift.
function runEngine(args, input) {
  const candidates = [
    join(ROOT, "src-tauri", "target", "release", "textmint-render"),
    join(ROOT, "src-tauri", "target", "debug", "textmint-render"),
  ];
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    // 64 MB, not the 1 MB default: a big pasted document renders to more HTML
    // than the default stdout buffer holds, and the app handles it, so the CLI
    // must too.
    const r = spawnSync(bin, args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) fail("render failed: " + (r.stderr || (r.error && r.error.message) || "unknown"));
    return r.stdout;
  }
  fail("the render binary is not built. Run: cd src-tauri && cargo build --bin textmint-render");
}

function renderMarkdown(md, flavor) {
  return runEngine(["--flavor", flavor], md);
}

// A runnable Textmint app: the repo's own release build (for a developer), or an
// installed .app (for everyone else). The debug build is deliberately excluded:
// it only loads its UI under `tauri dev`, so launched on its own it opens blank.
function appBinary() {
  const candidates = [
    join(ROOT, "src-tauri", "target", "release", "textmint"),
    "/Applications/Textmint.app/Contents/MacOS/textmint",
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

// Hand text to the GUI for review. Resolves a runnable app first, then writes a
// private one-shot handoff file and launches the app with TEXTMINT_OPEN pointing
// at it; the app reads it once on start (src-tauri/src/startup.rs, src/main.js)
// and deletes it. User-initiated and one-shot, not the always-listening bridge.
function openInGui(text) {
  const app = appBinary();
  if (!app) {
    fail("no runnable Textmint app found. Install Textmint, or build it once:\n" +
      "  npm run tauri build                                    (installable app)\n" +
      "  cd src-tauri && cargo build --release --bin textmint   (repo build)");
  }
  // Owner-only (0600): a plaintext copy of the user's text should not be world
  // readable, even for the instant before the app reads and deletes it.
  const tmp = join(process.env.TMPDIR || "/tmp", "textmint-open-" + process.pid + ".txt");
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    const child = spawn(app, [], {
      env: { ...process.env, TEXTMINT_OPEN: tmp },
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => { try { unlinkSync(tmp); } catch (e) { /* best effort */ } });
    child.unref();
  } catch (e) {
    try { unlinkSync(tmp); } catch (e2) { /* best effort */ }
    fail("could not launch the app: " + (e && e.message ? e.message : e));
  }
  // It launched; whether an older installed app knows how to load the handoff is
  // out of our hands, so report the launch, not a load.
  process.stderr.write("textmint: launched Textmint (" + text.length + " chars)\n");
}

async function main() {
  const { positional, flags, values, wrapWidth } = parseArgs(process.argv.slice(2));
  for (const f of flags) {
    if (!KNOWN_FLAGS.has(f)) fail("unknown option: --" + f + "\n\n" + USAGE);
  }
  const cmd = positional.shift();

  if (flags.has("version")) {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    process.stdout.write(pkg.version + "\n");
    return;
  }
  if (!cmd || flags.has("help")) {
    process.stdout.write(USAGE);
    return;
  }

  const flavor = values.flavor || "github";
  if (!MD_PRESETS[flavor]) fail("--flavor must be " + Object.keys(MD_PRESETS).join(", "));
  const preset = MD_PRESETS[flavor];
  const opts = optsFrom({ flags, values, wrapWidth });
  const renderFlavor = renderFlavorFor(flavor, preset["md-gfm"]);
  const htmlMode = values["html-mode"] || "clean";
  if (!["clean", "markdown"].includes(htmlMode)) fail("--html-mode must be clean or markdown");

  // HTML input becomes markdown for the text passes, and is kept for html.
  const load = async () => {
    const raw = await readInput(positional);
    const isHtml = flags.has("from-html") || (!flags.has("plain") && looksLikeHtml(raw));
    if (!isHtml) return { text: raw, html: null };
    const math = preset["md-math"];
    return { text: runEngine(["--from-html", "--options", JSON.stringify({ math })], raw), html: raw };
  };

  if (cmd === "clean") {
    process.stdout.write(clean((await load()).text, opts));
  } else if (cmd === "markdown" || cmd === "md") {
    process.stdout.write(cleanToMarkdown((await load()).text, opts));
  } else if (cmd === "html") {
    const { text, html } = await load();
    if (html != null && htmlMode === "clean") {
      const o = { ...HTML_DEFAULTS, stripUnicode: opts.stripUnicode };
      process.stdout.write(runEngine(["--clean-html", "--options", JSON.stringify(o)], html));
    } else {
      process.stdout.write(renderMarkdown(cleanToMarkdown(text, opts), renderFlavor));
    }
  } else if (cmd === "open") {
    openInGui(await readInput(positional));
  } else {
    fail("unknown command: " + cmd + "\n\n" + USAGE);
  }
}

main().catch((e) => fail(String(e && e.message ? e.message : e)));
