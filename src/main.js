// Textmint - clean & convert AI text. Runs entirely on-device.
// Source is intentionally ASCII-only: every special codepoint is a \u escape
// so the cleaning regexes can never be corrupted by copy/paste.
import { clean, cleanToMarkdown } from "./pipeline.js";
import { initBridge } from "./bridge.js";
import { CHECK_IDS as PREF_CHECKS } from "./controls.js";

(function () {
  const inputEl      = document.getElementById("input");
  const outputEl     = document.getElementById("output");            // Text view
  const outputMdEl   = document.getElementById("output-markdown");   // Markdown view
  const outputRendEl = document.getElementById("output-rendered");   // Rendered HTML
  const outputHtmlEl = document.getElementById("output-html");       // HTML source
  const btnClean     = document.getElementById("btn-clean");
  const btnCopy      = document.getElementById("btn-copy");
  const btnCopyHtml  = document.getElementById("btn-copy-html");
  const btnClear     = document.getElementById("btn-clear");
  const statIn       = document.getElementById("stat-in");
  const statOut      = document.getElementById("stat-out");
  const statLines    = document.getElementById("stat-lines");
  const outMeta      = document.getElementById("output-meta");

  function opt(id) { return document.getElementById(id).checked; }
  function num(id) { return parseInt(document.getElementById(id).value, 10) || 80; }

  // Markdown -> HTML happens in Rust (engine::render_markdown), so the Rendered
  // view and Copy HTML are the same bytes. Reached through the global Tauri
  // invoke, the same channel the clipboard uses.
  async function renderMarkdown(md) {
    const t = window.__TAURI__;
    const invoke = t && t.core && t.core.invoke;
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!invoke) return "<pre>" + esc(md) + "</pre>"; // dev in a plain browser
    try { return await invoke("render_markdown", { input: md }); }
    catch (e) { return "<pre>render_markdown failed: " + esc(String(e)) + "</pre>"; }
  }

  // --- Native clipboard (Tauri) with browser fallback -----------------------
  const clip = () => window.__TAURI__ && window.__TAURI__.clipboardManager;

  async function copyText(text) {
    try {
      const c = clip();
      if (c && c.writeText) { await c.writeText(text); return true; }
    } catch (e) { /* fall through to browser API */ }
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
  }

  async function copyRichHtml(html) {
    try {
      const c = clip();
      if (c && c.writeHtml) { await c.writeHtml(html); return true; }
    } catch (e) { /* fall through */ }
    try {
      const blob = new Blob([html], { type: "text/html" });
      await navigator.clipboard.write([new ClipboardItem({ "text/html": blob })]);
      return true;
    } catch (e) {
      try { await navigator.clipboard.writeText(html); return true; } catch (e2) { return false; }
    }
  }

  function flashCopied(btn, label) {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = label; btn.classList.remove("copied"); }, 1500);
  }

  // --- Preferences ----------------------------------------------------------
  const PREF_KEY = "textmint-prefs";

  function savePrefs() {
    try {
      const p = {};
      PREF_CHECKS.forEach((id) => { p[id] = document.getElementById(id).checked; });
      p["opt-wrap-width"] = document.getElementById("opt-wrap-width").value;
      localStorage.setItem(PREF_KEY, JSON.stringify(p));
    } catch (e) { /* storage unavailable - ignore */ }
  }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY));
      if (!p) return;
      PREF_CHECKS.forEach((id) => {
        const el = document.getElementById(id);
        if (el && p[id] !== undefined) el.checked = p[id];
      });
      if (p["opt-wrap-width"]) document.getElementById("opt-wrap-width").value = p["opt-wrap-width"];
    } catch (e) { /* ignore */ }
  }

  // --- Options -------------------------------------------------------------
  // The pipeline is pure and lives in pipeline.js. This is the only place the
  // cleaning-options object is assembled from the DOM. The dev bridge reads and
  // writes the same controls (src/bridge.js) but never builds this object.
  function opts() {
    return {
      stripNoise:    opt("opt-strip-noise"),
      stripUnicode:  opt("opt-strip-unicode"),
      stripMarkdown: opt("opt-strip-markdown"),
      bullets:       opt("opt-bullets"),
      joinLines:     opt("opt-join-lines"),
      stripIndent:   opt("opt-strip-indent"),
      collapseBlank: opt("opt-collapse-blank"),
      wrap:          opt("opt-wrap"),
      wrapWidth:     num("opt-wrap-width"),
    };
  }

  function updateStats(inText, outText) {
    statIn.textContent  = "In: " + inText.length.toLocaleString() + " chars";
    statOut.textContent = "Out: " + outText.length.toLocaleString() + " chars";
    const lines = outText ? outText.split("\n").length : 0;
    statLines.textContent = lines.toLocaleString() + " lines";
    outMeta.textContent   = outText ? lines + " lines" : "";
  }

  // One render fills all four Output views from the current input and options:
  // Text (cleaned, markdown stripped), Markdown (cleaned, markdown kept), and
  // Rendered / HTML (that markdown run through the Rust renderer). Async because
  // the render is a Rust call; a sequence guard drops a stale result so a fast
  // typist never sees an earlier render land last.
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const o = opts();
    const input = inputEl.value;
    const md = cleanToMarkdown(input, o);
    outputEl.value = clean(input, o);
    outputMdEl.value = md;
    updateStats(input, outputEl.value);
    const html = await htmlFor(md); // htmlFor is the only place HTML is produced
    if (seq !== renderSeq) return html; // a newer render superseded this one
    outputRendEl.innerHTML = html;
    outputHtmlEl.value = html;
    return html;
  }

  // The button actions are named functions, not inline handlers, so the click
  // listeners, the keyboard shortcuts, and the automation bridge all drive the
  // app through one code path. Copying these into the bridge is exactly how
  // they would drift out of sync.
  function actClear() {
    renderSeq++; // invalidate any in-flight render so it cannot repaint after clear
    inputEl.value = "";
    outputEl.value = "";
    outputMdEl.value = "";
    outputRendEl.innerHTML = "";
    outputHtmlEl.value = "";
    updateStats("", "");
  }

  async function actCopy() {
    if (!outputEl.value) return false;
    return copyText(outputEl.value);
  }

  // The HTML the Preview shows and Copy HTML puts on the clipboard: the cleaned
  // markdown run through the Rust renderer. One source of truth. render() passes
  // the markdown it already computed; other callers let it be recomputed.
  async function htmlFor(md) {
    if (!inputEl.value) return "";
    return renderMarkdown(md != null ? md : cleanToMarkdown(inputEl.value, opts()));
  }

  async function actCopyHtml() {
    const html = await htmlFor();
    if (!html) return { ok: false, html: "" };
    return { ok: await copyRichHtml(html), html };
  }

  // --- Output tabs ----------------------------------------------------------
  const TAB_KEY = "textmint-output-tab";
  const tabs = Array.from(document.querySelectorAll(".output-tabs .tab"));
  const views = {
    text: outputEl, markdown: outputMdEl, rendered: outputRendEl, html: outputHtmlEl,
  };
  function showView(view) {
    if (!views[view]) view = "text";
    tabs.forEach((t) => {
      const on = t.dataset.view === view;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1; // roving tabindex: only the active tab is tabbable
    });
    Object.keys(views).forEach((v) => { views[v].hidden = v !== view; });
    try { localStorage.setItem(TAB_KEY, view); } catch (e) {}
  }
  tabs.forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  // Left/right arrows move between tabs, the standard tablist keyboard model.
  document.querySelector(".output-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.classList.contains("active"));
    const next = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    tabs[next].focus();
    showView(tabs[next].dataset.view);
  });

  // --- Wiring ---------------------------------------------------------------
  btnClean.addEventListener("click", render);

  btnCopy.addEventListener("click", async () => {
    if (await actCopy()) flashCopied(btnCopy, "Copy");
  });

  btnCopyHtml.addEventListener("click", async () => {
    if ((await actCopyHtml()).ok) flashCopied(btnCopyHtml, "Copy HTML");
  });

  btnClear.addEventListener("click", actClear);

  document.addEventListener("keydown", async (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key === "Enter") { e.preventDefault(); render(); }
    if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
      e.preventDefault();
      if (await actCopy()) flashCopied(btnCopy, "Copy");
    }
  });

  // Toggling an option saves it and re-renders, so every view stays live.
  document.querySelector(".controls").addEventListener("change", () => {
    savePrefs();
    render();
  });

  let debounceTimer;
  inputEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 400);
  });

  // --- Theme ----------------------------------------------------------------
  const btnTheme = document.getElementById("btn-theme");
  function applyTheme(light) {
    document.documentElement.dataset.theme = light ? "light" : "";
    try { localStorage.setItem("textmint-theme", light ? "light" : "dark"); } catch (e) {}
  }
  btnTheme.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme !== "light");
  });

  // --- Tooltips -------------------------------------------------------------
  const tipEl = document.createElement("div");
  tipEl.id = "tooltip";
  document.body.appendChild(tipEl);
  let tipTimer = null;

  function showTip(text, e) { tipEl.textContent = text; tipEl.style.display = "block"; placeTip(e); }
  function hideTip() { clearTimeout(tipTimer); tipEl.style.display = "none"; }
  function placeTip(e) {
    const x = e.clientX + 14;
    const y = e.clientY + 20;
    tipEl.style.left = Math.min(x, window.innerWidth - tipEl.offsetWidth - 8) + "px";
    tipEl.style.top  = Math.min(y, window.innerHeight - tipEl.offsetHeight - 8) + "px";
  }
  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-tip]");
    if (!target) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(target.dataset.tip, e), 600);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-tip]")) { clearTimeout(tipTimer); hideTip(); }
  });
  document.addEventListener("mousemove", (e) => { if (tipEl.style.display === "block") placeTip(e); });
  document.addEventListener("mousedown", hideTip);

  // --- Init -----------------------------------------------------------------
  loadPrefs();
  try { applyTheme(localStorage.getItem("textmint-theme") === "light"); } catch (e) {}
  try { showView(localStorage.getItem(TAB_KEY) || "text"); } catch (e) { showView("text"); }

  // CLI handoff: `textmint open <file>` launches the app with TEXTMINT_OPEN set;
  // load that text into the input once, on start, and render it.
  (async () => {
    try {
      const t = window.__TAURI__;
      const invoke = t && t.core && t.core.invoke;
      if (!invoke) return;
      const text = await invoke("startup_open");
      if (text != null && text !== "") { inputEl.value = String(text); render(); }
    } catch (e) { /* no handoff; ignore */ }
  })();

  // Dev-only automation bridge. No-ops unless the app was launched with
  // TEXTMINT_BRIDGE set and this is a debug build; see src/bridge.js. It drives
  // the same named actions the buttons do, so it can never behave differently.
  // runClean is the async render that fills every Output view.
  initBridge({
    inputEl, outputEl, applyTheme, savePrefs, showView,
    runClean: render, actClear, actCopy, actCopyHtml, htmlFor,
  });
})();
