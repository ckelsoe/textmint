// Textmint - clean & convert AI text. Runs entirely on-device.
// Source is intentionally ASCII-only: every special codepoint is a \u escape
// so the cleaning regexes can never be corrupted by copy/paste.
(function () {
  const inputEl     = document.getElementById("input");
  const outputEl    = document.getElementById("output");
  const btnClean    = document.getElementById("btn-clean");
  const btnCopy     = document.getElementById("btn-copy");
  const btnCopyHtml = document.getElementById("btn-copy-html");
  const btnClear    = document.getElementById("btn-clear");
  const statIn      = document.getElementById("stat-in");
  const statOut     = document.getElementById("stat-out");
  const statLines   = document.getElementById("stat-lines");
  const outMeta     = document.getElementById("output-meta");

  function opt(id) { return document.getElementById(id).checked; }
  function num(id) { return parseInt(document.getElementById(id).value, 10) || 80; }

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
  const PREF_CHECKS = [
    "opt-strip-noise", "opt-strip-unicode", "opt-strip-markdown", "opt-wrap",
    "opt-collapse-blank", "opt-strip-indent", "opt-bullets", "opt-join-lines",
  ];

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

  // --- Cleaning pipeline ----------------------------------------------------
  function stripUnicode(text) {
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

  function stripAiNoise(text) {
    return text.split("\n").map((line) => {
      const t = line.trim();
      if (/^Thought for \d+/.test(t)) return null;          // "Thought for 8s"
      if (/^\u23BF/.test(t)) return null;                // U+23BF nested output marker
      let out = line.replace(/\s*\(ctrl\+o to expand\)/gi, "");
      out = out.replace(/^(\s*)[\u25CF\u23FA]\s+/, "$1");         // U+25CF / U+23FA tool markers
      return out;
    }).filter((l) => l !== null).join("\n");
  }

  function stripMarkdown(text) {
    text = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_, code) => code.trimEnd());
    text = text.replace(/`([^`]+)`/g, "$1");
    text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, title) => title + "\n");
    text = text.replace(/(\*{1,3})(.+?)\1/gs, "$2");                       // *em* **strong**
    text = text.replace(/(?<!\w)(_{1,3})(\S(?:[^\n]*?\S)?)\1(?!\w)/g, "$2"); // _em_ only at word boundaries
    text = text.replace(/~~(.+?)~~/gs, "$1");
    text = text.replace(/^>\s?/gm, "");
    text = text.replace(/^[-*_]{3,}\s*$/gm, "");
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
    text = text.replace(/<[^>]+>/g, "");
    return text;
  }

  function normalizeBullets(text) {
    text = text.replace(/^[ \t]*[*+]\s+/gm, "- ");
    text = text.replace(/^([ \t]*)[-]\s{2,}/gm, "$1- ");
    return text;
  }

  function joinWrappedLines(text) {
    // Box-drawing glyphs (U+2500 block) mark ASCII tables/diagrams we must not reflow.
    const BOX = /[\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C\u2502]/;
    const parts = text.split(/(\n{2,})/);
    return parts.map((part) => {
      if (/^\n+$/.test(part)) return part;
      const lines = part.split("\n").filter(Boolean);
      if (lines.length <= 1) return part;
      const trimmed = lines.map((l) => l.trim());
      if (trimmed.some((l) => /^[-*+][ \t]/.test(l) || /^\d+\.[ \t]/.test(l))) return trimmed.join("\n");
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

  function stripIndent(text) { return text.replace(/^[ \t]+/gm, ""); }
  function collapseBlankLines(text) { return text.replace(/(\n[ \t]*){3,}\n/g, "\n\n"); }

  function wrapLine(line, width) {
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

  function wrapText(text, width) {
    return text.split("\n").map((line) => wrapLine(line, width)).join("\n");
  }

  // --- Protected blocks -----------------------------------------------------
  // Code fences and ASCII tables/box diagrams are swapped for sentinel tokens
  // (private-use chars that no cleaning pass touches) so they pass through the
  // whole pipeline verbatim, then restored. Keeps table columns aligned and
  // stops markdown/underscore rules from mangling code.
  function maskProtected(text) {
    const OPEN = "\uE000", CLOSE = "\uE001";
    const blocks = [];
    const box = /[\u2500-\u257F]/;    // Box Drawing block
    const pipeRow = /^\s*\|.*\|\s*$/;   // | a | b |
    const fence = /^\s*```/;
    const src = text.split("\n");
    const out = [];
    let i = 0;
    const stash = (from, to) => {
      out.push(OPEN + blocks.length + CLOSE);
      blocks.push(src.slice(from, to).join("\n"));
    };
    while (i < src.length) {
      if (fence.test(src[i])) {
        let j = i + 1;
        while (j < src.length && !fence.test(src[j])) j++;
        const end = j < src.length ? j + 1 : src.length;
        stash(i, end); i = end; continue;
      }
      if (box.test(src[i])) {
        let j = i;
        while (j < src.length && box.test(src[j])) j++;
        stash(i, j); i = j; continue;
      }
      if (pipeRow.test(src[i])) {
        let j = i;
        while (j < src.length && pipeRow.test(src[j])) j++;
        if (j - i >= 2) { stash(i, j); i = j; continue; }
      }
      out.push(src[i]); i++;
    }
    return { masked: out.join("\n"), blocks };
  }

  function unmaskProtected(text, blocks) {
    return text.replace(/\uE000(\d+)\uE001/g, (_, n) => blocks[Number(n)]);
  }

  // --- Markdown -> HTML (for rich paste into Outlook / Word) -----------------
  function inlineMd(text) {
    text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(/\*\*\*(.+?)\*\*\*/gs, "<strong><em>$1</em></strong>");
    text = text.replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>");
    text = text.replace(/(?<!\w)__(\S(?:[^\n]*?\S)?)__(?!\w)/g, "<strong>$1</strong>");
    text = text.replace(/\*(.+?)\*/gs, "<em>$1</em>");
    text = text.replace(/(?<!\w)_(\S(?:[^\n]*?\S)?)_(?!\w)/g, "<em>$1</em>");
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    text = text.replace(/~~(.+?)~~/gs, "<del>$1</del>");
    return text;
  }

  function markdownToHtml(text) {
    text = text.replace(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm, (_, code) => {
      const esc = code.trimEnd().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return "<pre><code>" + esc + "</code></pre>";
    });
    const lines = text.split("\n");
    const out = [];
    let listType = null;
    function closeList() { if (listType) { out.push("</" + listType + ">"); listType = null; } }
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { closeList(); continue; }
      if (line.startsWith("<pre>")) { closeList(); out.push(rawLine); continue; }
      const hm = line.match(/^(#{1,6})\s+(.+)$/);
      if (hm) { closeList(); const lvl = hm[1].length; out.push("<h" + lvl + ">" + inlineMd(hm[2]) + "</h" + lvl + ">"); continue; }
      const bm = line.match(/^[-*+]\s+(.+)$/);
      if (bm) { if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; } out.push("<li>" + inlineMd(bm[1]) + "</li>"); continue; }
      const nm = line.match(/^\d+\.\s+(.+)$/);
      if (nm) { if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; } out.push("<li>" + inlineMd(nm[1]) + "</li>"); continue; }
      if (/^[-*_]{3,}$/.test(line)) { closeList(); out.push("<hr>"); continue; }
      closeList();
      out.push("<p>" + inlineMd(line) + "</p>");
    }
    closeList();
    return out.join("\n");
  }

  function cleanToHtml(text) {
    if (opt("opt-strip-noise"))    text = stripAiNoise(text);
    if (opt("opt-strip-unicode"))  text = stripUnicode(text);
    if (opt("opt-join-lines"))     text = joinWrappedLines(text);
    if (opt("opt-strip-indent"))   text = stripIndent(text);
    if (opt("opt-collapse-blank")) text = collapseBlankLines(text);
    return markdownToHtml(text.trim());
  }

  function clean(text) {
    const prot = maskProtected(text);
    let out = prot.masked;
    if (opt("opt-strip-noise"))    out = stripAiNoise(out);
    if (opt("opt-strip-unicode"))  out = stripUnicode(out);
    if (opt("opt-strip-markdown")) out = stripMarkdown(out);
    if (opt("opt-bullets"))        out = normalizeBullets(out);
    if (opt("opt-join-lines"))     out = joinWrappedLines(out);
    if (opt("opt-strip-indent"))   out = stripIndent(out);
    if (opt("opt-collapse-blank")) out = collapseBlankLines(out);
    if (opt("opt-wrap"))           out = wrapText(out, num("opt-wrap-width"));
    return unmaskProtected(out.trim(), prot.blocks);
  }

  function updateStats(inText, outText) {
    statIn.textContent  = "In: " + inText.length.toLocaleString() + " chars";
    statOut.textContent = "Out: " + outText.length.toLocaleString() + " chars";
    const lines = outText ? outText.split("\n").length : 0;
    statLines.textContent = lines.toLocaleString() + " lines";
    outMeta.textContent   = outText ? lines + " lines" : "";
  }

  function runClean() {
    const result = clean(inputEl.value);
    outputEl.value = result;
    updateStats(inputEl.value, result);
  }

  // --- Wiring ---------------------------------------------------------------
  btnClean.addEventListener("click", runClean);

  btnCopy.addEventListener("click", async () => {
    if (!outputEl.value) return;
    if (await copyText(outputEl.value)) flashCopied(btnCopy, "Copy");
  });

  btnCopyHtml.addEventListener("click", async () => {
    if (!inputEl.value) return;
    const html = cleanToHtml(inputEl.value);
    if (await copyRichHtml(html)) flashCopied(btnCopyHtml, "Copy HTML");
  });

  btnClear.addEventListener("click", () => {
    inputEl.value = "";
    outputEl.value = "";
    updateStats("", "");
  });

  document.addEventListener("keydown", async (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key === "Enter") { e.preventDefault(); runClean(); }
    if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
      e.preventDefault();
      if (outputEl.value && await copyText(outputEl.value)) flashCopied(btnCopy, "Copy");
    }
  });

  document.querySelector(".controls").addEventListener("change", savePrefs);

  let debounceTimer;
  inputEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { if (inputEl.value) runClean(); }, 400);
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
})();
