// Dev-only automation bridge (frontend half).
//
// Lets a local process drive the app without clicking at screen coordinates:
// set the input, flip any option, switch theme, and press any button. It is
// the counterpart to src-tauri/src/bridge.rs. See docs/AUTOMATION.md.
//
// This file ships in the bundle but stays completely inert in a normal launch:
// the Rust command that reports the bridge active is compiled only into debug
// builds, and even there it reports inactive unless the app was started with
// TEXTMINT_BRIDGE set. When bridge_status is missing or inactive, initBridge
// returns after one call and never polls.
//
// Every action runs through the same named functions the buttons use (passed
// in as ctx), never a copy of them, so the bridge can never behave differently
// from a human clicking.
//
// Protocol: the driver writes <dir>/command.json; this loop polls it, runs the
// command once per new sequence number, and writes <dir>/result.json back.
//   command.json: { seq, action, input?, options?, theme? }
//     options: { "opt-strip-markdown": true, "opt-wrap-width": "100", ... }
//               keyed by the control ids in src/index.html
//   result.json:  { seq, ok, action, input, output, html, copyOk, stats,
//                   settings, actions, error }
// The set of valid actions is ACTIONS below; every result echoes its keys, so
// a driver reads the current action list instead of trusting this comment.

import { CHECK_IDS } from "./controls.js";

const POLL_MS = 200;

// action -> handler. Each returns the fields it wants merged into the result;
// the rest of the result (input, output, stats, settings) is filled the same
// way for every action. Adding an action is one entry here and one line in the
// command.json doc, and the result's `actions` list surfaces it immediately.
const ACTIONS = {
  state: () => ({}),
  clean: async (ctx) => { await ctx.runClean(); return {}; },
  clear: (ctx) => { ctx.actClear(); return {}; },
  copy: async (ctx) => ({ copyOk: await ctx.actCopy() }),
  copyHtml: async (ctx) => {
    const r = await ctx.actCopyHtml();
    return { copyOk: r.ok, html: r.html };
  },
  // Preview the HTML without touching the clipboard, so a driver can inspect
  // the exact markup Copy HTML would put on the pasteboard.
  html: async (ctx) => ({ html: await ctx.htmlFor() }),
  // Switch the Output tab (text | markdown | rendered | html); an unknown name
  // falls back to text, and result.settings.outputTab reports what took.
  view: (ctx, cmd) => { ctx.showView(cmd.view); return {}; },
};

function invoker() {
  const t = window.__TAURI__;
  return t && t.core && typeof t.core.invoke === "function" ? t.core.invoke : null;
}

function currentSettings() {
  const s = {};
  CHECK_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) s[id] = !!el.checked;
  });
  const w = document.getElementById("opt-wrap-width");
  if (w) s["opt-wrap-width"] = w.value;
  s.theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const activeTab = document.querySelector(".output-tabs .tab.active");
  s.outputTab = activeTab ? activeTab.dataset.view : null;
  return s;
}

// Every control is set by its id, checkbox or not, so there is one way to set
// wrap width (options["opt-wrap-width"]) and no second spelling to disagree.
// The lookup is scoped to .controls so options can only reach real controls,
// never the input/output panes, and any id that is not a control is returned
// as unknown rather than silently dropped, so a driver's typo is visible.
function applyOptions(options) {
  const unknown = [];
  if (!options || typeof options !== "object") return unknown;
  const controls = document.querySelector(".controls");
  Object.keys(options).forEach((id) => {
    const el = document.getElementById(id);
    if (!el || !controls || !controls.contains(el)) { unknown.push(id); return; }
    if (el.type === "checkbox") el.checked = !!options[id];
    else el.value = String(options[id]);
  });
  return unknown;
}

async function runCommand(ctx, cmd) {
  const action = cmd.action || "state";
  const result = {
    seq: cmd.seq, ok: true, action,
    input: null, output: null, html: null, copyOk: null,
    stats: null, settings: null, actions: Object.keys(ACTIONS),
    unknownOptions: [], error: null,
  };

  try {
    if (cmd.input != null) ctx.inputEl.value = String(cmd.input);
    if (cmd.theme === "light" || cmd.theme === "dark") ctx.applyTheme(cmd.theme === "light");
    result.unknownOptions = applyOptions(cmd.options);
    // Persist the flipped options so the state survives the next launch, the
    // same as a human toggling a checkbox does.
    ctx.savePrefs();

    const handler = ACTIONS[action];
    if (handler) Object.assign(result, await handler(ctx, cmd));
    else { result.ok = false; result.error = "unknown action: " + action; }
  } catch (e) {
    result.ok = false;
    result.error = String(e && e.message ? e.message : e);
  }

  const inText = ctx.inputEl.value;
  const outText = ctx.outputEl.value;
  result.input = inText;
  result.output = outText;
  result.stats = {
    inChars: inText.length,
    outChars: outText.length,
    outLines: outText ? outText.split("\n").length : 0,
  };
  result.settings = currentSettings();
  return result;
}

export async function initBridge(ctx) {
  const invoke = invoker();
  if (!invoke) return; // not running under Tauri (plain browser, or no globals)

  let status;
  try {
    status = await invoke("bridge_status");
  } catch (e) {
    // A release build does not register bridge_status, so invoke rejects with
    // a not-found error: that is the normal inert path, stay quiet. Any other
    // rejection in a debug build is a real fault worth showing.
    const msg = String(e && e.message ? e.message : e);
    if (!/not\s*found|unknown command|not allowed|bridge_status/i.test(msg)) {
      console.warn("textmint bridge: status check failed:", e);
    }
    return;
  }
  if (!status || !status.active) return;

  console.log("textmint bridge active, dir:", status.dir);

  let lastSeq = -1;
  let busy = false;

  setInterval(async () => {
    if (busy) return;
    let raw;
    try {
      raw = await invoke("bridge_poll");
    } catch (e) {
      // Unexpected once the bridge is active: surface it so a quiet loop is
      // visible in devtools instead of looking like the app hung.
      console.warn("textmint bridge: poll failed:", e);
      return;
    }
    if (!raw) return;

    let cmd;
    try {
      cmd = JSON.parse(raw);
    } catch (e) {
      return; // half-written file: the expected torn read, retry next tick
    }
    if (typeof cmd.seq !== "number" || cmd.seq <= lastSeq) return;

    busy = true;
    lastSeq = cmd.seq;
    try {
      const result = await runCommand(ctx, cmd);
      await invoke("bridge_result", { json: JSON.stringify(result) });
    } catch (e) {
      console.warn("textmint bridge: result write failed:", e);
    } finally {
      busy = false;
    }
  }, POLL_MS);
}
