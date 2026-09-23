// Textmint - clean & convert AI text. Runs entirely on-device.
// Source is intentionally ASCII-only: every special codepoint is a \u escape
// so the cleaning regexes can never be corrupted by copy/paste.
import { clean, cleanToMarkdown, looksLikeHtml, prefersPlainPaste } from "./pipeline.js";
import { initBridge } from "./bridge.js";
import { initUpdate } from "./update.js";
import { CHECK_IDS, SETTING_IDS, MD_PRESETS, HTML_OPTION_IDS, renderFlavorFor } from "./controls.js";

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
  // A control's value by its type: a checkbox's checked state, else its value.
  function val(id) {
    const el = document.getElementById(id);
    if (!el) return undefined;
    return el.type === "checkbox" ? el.checked : el.value;
  }

  // The Rust engine, through the global Tauri invoke (the same channel the
  // clipboard uses). null when there is no Tauri (a plain browser) or the call
  // fails, which callers treat as "fall back".
  async function engine(cmd, args) {
    const t = window.__TAURI__;
    const invoke = t && t.core && t.core.invoke;
    if (!invoke) return null;
    try { return await invoke(cmd, args); }
    catch (e) { console.error("textmint: " + cmd + " failed:", e); return null; }
  }

  function renderFlavor() { return renderFlavorFor(val("md-flavor"), val("md-gfm")); }

  // Markdown -> HTML happens in Rust (engine::render_with), so the Rendered
  // view and Copy HTML are the same bytes.
  async function renderMarkdown(md) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = await engine("render_markdown", { input: md, flavor: renderFlavor() });
    return html != null ? html : "<pre>" + esc(md) + "</pre>"; // dev in a plain browser
  }

  // Settings for the Rust HTML cleaner and the HTML-to-markdown converter. Key
  // names match the serde structs in src-tauri/src/html.rs.
  function htmlOpts() {
    const o = { stripUnicode: opt("opt-strip-unicode") };
    Object.keys(HTML_OPTION_IDS).forEach((id) => { o[HTML_OPTION_IDS[id]] = val(id); });
    return o;
  }
  function mdConvertOpts() {
    return { math: val("md-math"), mergedTables: val("md-merged") };
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
      CHECK_IDS.concat(SETTING_IDS).forEach((id) => { p[id] = val(id); });
      p["opt-wrap-width"] = document.getElementById("opt-wrap-width").value;
      localStorage.setItem(PREF_KEY, JSON.stringify(p));
    } catch (e) { /* storage unavailable - ignore */ }
  }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY));
      if (!p) return;
      CHECK_IDS.concat(SETTING_IDS).forEach((id) => {
        const el = document.getElementById(id);
        if (!el || p[id] === undefined) return;
        if (el.type === "checkbox") el.checked = !!p[id];
        // A select only takes a value it offers, so a stale pref cannot blank it.
        else if (Array.from(el.options || []).some((o) => o.value === p[id])) el.value = p[id];
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
      // Markdown style; "" (As written) is null, which leaves the markdown alone.
      mdBullet:      val("md-bullet") || null,
      mdEmphasis:    val("md-emphasis") || null,
      mdHeading:     val("md-heading") || null,
      mdFence:       val("md-fence") || null,
      mdLinks:       val("md-links") || null,
      mdHighlight:   val("md-highlight") || null,
      mdCallouts:    !!val("md-callouts"),
      mdWrap:        !!val("md-wrap"),
    };
  }

  // --- Rich paste -------------------------------------------------------------
  // A paste carrying HTML (Word, Google Docs, a web page, a chat app) goes into
  // the input as markdown converted from that HTML, and the HTML itself is held
  // for the HTML output's Clean HTML mode. Editing the input drops it, since the
  // two no longer match. See docs/plans/html-input.md.
  let heldHtml = null;
  let applyingPaste = false; // our own insert, not a user edit
  const richChip = document.getElementById("rich-chip");
  const inputHint = document.getElementById("input-hint");

  function setHeld(html) {
    heldHtml = html || null;
    richChip.hidden = !heldHtml;
    inputHint.hidden = !!heldHtml;
  }

  // Replace the selection with text. Not execCommand("insertText"): WebKit
  // treats that as typing, and macOS smart dashes and quotes then rewrite it
  // (a table's |---| row came back as em dashes). setRangeText is not typing.
  function insertText(text) {
    applyingPaste = true;
    try {
      inputEl.focus();
      inputEl.setRangeText(text, inputEl.selectionStart, inputEl.selectionEnd, "end");
    } finally {
      applyingPaste = false;
    }
  }

  // Convert and insert. The HTML is held only when the markdown replaces the
  // entire input, since only then does it describe the input. That is decided
  // after the conversion, from the same selection the insert then uses, so a
  // click or keystroke while the conversion runs cannot leave it held against
  // part of the text.
  async function pasteHtml(html) {
    const md = await engine("html_markdown", { input: html, options: mdConvertOpts() });
    if (md == null) return false;
    const whole = inputEl.value === "" ||
      (inputEl.selectionStart === 0 && inputEl.selectionEnd === inputEl.value.length);
    insertText(md);
    setHeld(whole ? html : null);
    await render();
    return true;
  }

  inputEl.addEventListener("paste", (e) => {
    if (!val("opt-rich-paste") || !e.clipboardData) return;
    const plain = e.clipboardData.getData("text/plain");
    let html = e.clipboardData.getData("text/html");
    if (html && prefersPlainPaste(html)) html = "";
    if (!html && looksLikeHtml(plain)) html = plain;
    if (!html || !(window.__TAURI__ && window.__TAURI__.core)) return; // plain paste
    e.preventDefault();
    pasteHtml(html).then((ok) => {
      if (!ok) { insertText(plain); render(); }
    });
  });

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
    setHeld(null);
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
  // In Clean HTML mode with a rich paste held, that is the pasted HTML cleaned;
  // otherwise the markdown rendered.
  async function htmlFor(md) {
    if (!inputEl.value) return "";
    if (heldHtml && val("html-mode") === "clean") {
      const h = await engine("html_clean", { input: heldHtml, options: htmlOpts() });
      if (h != null) return h;
    }
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

  // --- Settings panel -------------------------------------------------------
  const settingsModal = document.getElementById("settings-modal");
  function openSettings() {
    settingsModal.hidden = false;
    document.getElementById("settings-close").focus();
  }
  function closeSettings() {
    if (settingsModal.hidden) return;
    settingsModal.hidden = true;
    document.getElementById("btn-settings").focus();
  }
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  settingsModal.addEventListener("click", (e) => {
    if (e.target && e.target.dataset && e.target.dataset.close) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !settingsModal.hidden) closeSettings();
  });

  function applyPreset(flavor) {
    const preset = MD_PRESETS[flavor];
    if (!preset) return;
    Object.keys(preset).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === "checkbox") el.checked = preset[id];
      else el.value = preset[id];
    });
  }

  // The paste-time settings (math, merged tables) shape the markdown already in
  // the input; with a rich paste held, convert it again so the change shows.
  async function reconvert() {
    if (!heldHtml) return;
    const md = await engine("html_markdown", { input: heldHtml, options: mdConvertOpts() });
    if (md != null) inputEl.value = md;
  }

  settingsModal.addEventListener("change", async (e) => {
    const id = e.target && e.target.id;
    if (id === "md-flavor") applyPreset(e.target.value);
    savePrefs();
    if (id === "md-math" || id === "md-merged" || id === "md-flavor") await reconvert();
    render();
  });

  let debounceTimer;
  inputEl.addEventListener("input", () => {
    if (!applyingPaste && heldHtml) setHeld(null); // an edit: the HTML no longer matches
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

  // About box and in-app updates. Self-contained (src/update.js); the About box
  // works even with no Tauri, and the update check no-ops until a real build with
  // a signing key is installed.
  initUpdate();

  // CLI handoff: `textmint open <file>` launches the app with TEXTMINT_OPEN set;
  // load that text into the input once, on start, and render it.
  (async () => {
    try {
      const t = window.__TAURI__;
      const invoke = t && t.core && t.core.invoke;
      if (!invoke) return;
      const text = await invoke("startup_open");
      if (text == null || text === "") return;
      // An HTML file handed over by `textmint open` is a rich paste, taken in
      // the same way as one from the clipboard.
      if (looksLikeHtml(String(text)) && (await pasteHtml(String(text)))) return;
      inputEl.value = String(text); render();
    } catch (e) { /* no handoff; ignore */ }
  })();

  // Dev-only automation bridge. No-ops unless the app was launched with
  // TEXTMINT_BRIDGE set and this is a debug build; see src/bridge.js. It drives
  // the same named actions the buttons do, so it can never behave differently.
  // runClean is the async render that fills every Output view.
  initBridge({
    inputEl, outputEl, outputMdEl, applyTheme, savePrefs, showView,
    runClean: render, actClear, actCopy, actCopyHtml, htmlFor,
    pasteHtml, applyPreset, hasHeldHtml: () => !!heldHtml,
  });
})();
