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

import { clean, cleanToMarkdown } from "../src/pipeline.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync, spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every accepted flag. An unknown one (a typo like --no-strip-markdow) is
// rejected rather than ignored, so a silently-on pass never surprises a caller.
const KNOWN_FLAGS = new Set([
  "help", "version", "wrap",
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
  -h, --help           Show this help
  -v, --version        Show version

A file argument (or - for stdin) is read as input; with none, reads stdin.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  let wrapWidth = 80;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wrap") {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n)) fail("--wrap needs a number");
      wrapWidth = n;
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
  return { positional, flags, wrapWidth };
}

function optsFrom({ flags, wrapWidth }) {
  const on = (name) => !flags.has("no-" + name);
  return {
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

// The one place the CLI needs the Rust engine: rendering markdown to HTML. It
// shells to a small textmint-render binary built from the same engine the app
// uses, so there is never a second converter to drift.
function renderMarkdown(md) {
  const candidates = [
    join(ROOT, "src-tauri", "target", "release", "textmint-render"),
    join(ROOT, "src-tauri", "target", "debug", "textmint-render"),
  ];
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    // 64 MB, not the 1 MB default: a big pasted document renders to more HTML
    // than the default stdout buffer holds, and the app handles it, so the CLI
    // must too.
    const r = spawnSync(bin, [], { input: md, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) fail("render failed: " + (r.stderr || (r.error && r.error.message) || "unknown"));
    return r.stdout;
  }
  fail("the render binary is not built. Run: cd src-tauri && cargo build --bin textmint-render");
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
  const { positional, flags, wrapWidth } = parseArgs(process.argv.slice(2));
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

  const opts = optsFrom({ flags, wrapWidth });

  if (cmd === "clean") {
    process.stdout.write(clean(await readInput(positional), opts));
  } else if (cmd === "markdown" || cmd === "md") {
    process.stdout.write(cleanToMarkdown(await readInput(positional), opts));
  } else if (cmd === "html") {
    process.stdout.write(renderMarkdown(cleanToMarkdown(await readInput(positional), opts)));
  } else if (cmd === "open") {
    openInGui(await readInput(positional));
  } else {
    fail("unknown command: " + cmd + "\n\n" + USAGE);
  }
}

main().catch((e) => fail(String(e && e.message ? e.message : e)));
