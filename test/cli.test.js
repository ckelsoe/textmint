// Tests for the CLI (bin/textmint.js). Spawns it as a subprocess and checks
// stdin -> stdout, the same way an agent would call it, so the wrapper and its
// reuse of the pipeline are both exercised.
//
// ASCII only, same rule as src/pipeline.js: a stray codepoint in a fixture would
// mislead the very passes this tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "textmint.js");

function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8" });
}

test("clean strips markdown and removes an emoji", () => {
  const r = run(["clean"], "# Title\n\n**bold** and an emoji \u{1F680}");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("#"), "heading marker survived:\n" + r.stdout);
  assert.ok(!r.stdout.includes("**"), "bold marker survived:\n" + r.stdout);
  assert.ok(r.stdout.includes("bold"), r.stdout);
  assert.ok(!/[\u{1F680}]/u.test(r.stdout), "emoji survived:\n" + r.stdout);
});

test("markdown keeps the markdown and a table verbatim", () => {
  const r = run(["markdown"], "# Title\n\n**bold**\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("# Title"), r.stdout);
  assert.ok(r.stdout.includes("**bold**"), r.stdout);
  assert.ok(r.stdout.includes("| a | b |"), r.stdout);
});

test("--no-strip-markdown keeps markdown on the clean path", () => {
  const r = run(["clean", "--no-strip-markdown"], "**bold**");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("**bold**"), r.stdout);
});

test("--version prints a semver", () => {
  const r = run(["--version"], "");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("no command prints usage", () => {
  const r = run([], "");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Usage:"), r.stdout);
});

test("an unknown command exits nonzero", () => {
  const r = run(["frobnicate"], "");
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("unknown command"), r.stderr);
});

test("an unknown option is rejected, not silently ignored", () => {
  // A typo like --no-strip-markdow would otherwise leave the pass on with no
  // sign anything was wrong.
  const r = run(["clean", "--no-strip-markdow"], "**bold**");
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("unknown option"), r.stderr);
});

// The html path shells to the Rust textmint-render binary. Only run it when that
// binary is built, so a checkout that has not compiled Rust still passes.
const RENDER = [
  join(ROOT, "src-tauri", "target", "release", "textmint-render"),
  join(ROOT, "src-tauri", "target", "debug", "textmint-render"),
];
const haveRender = RENDER.some(existsSync);

test("html renders through the Rust engine", { skip: haveRender ? false : "textmint-render not built" }, () => {
  const r = run(["html"], "# Hi\n\n**b** and ~~s~~\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("<h1>Hi</h1>"), r.stdout);
  assert.ok(r.stdout.includes("<strong>b</strong>"), r.stdout);
  assert.ok(r.stdout.includes("<table>"), r.stdout);
  assert.ok(r.stdout.includes("line-through"), "strikethrough must be a style, not <del>:\n" + r.stdout);
});
