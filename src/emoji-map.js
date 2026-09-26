// The emoji map: which emoji become which text when Settings > Emoji is set to
// To text. ASCII only, same rule as the rest of src/.
//
// The map starts as DEFAULT_EMOJI_MAP (src/pipeline.js), is edited in the
// #emoji-modal dialog, and is saved to localStorage under textmint-emoji-map.
// currentEmojiMap() is what src/main.js hands the pipeline and the Rust HTML
// cleaner; both read rows of { symbols, start, inline }.
import { DEFAULT_EMOJI_MAP } from "./pipeline.js";

const MAP_KEY = "textmint-emoji-map";

function el(id) { return document.getElementById(id); }
function copyRows(rows) { return rows.map((r) => ({ symbols: r.symbols, start: r.start, inline: r.inline })); }

// A saved map, kept only if it is a list of rows with string fields; anything
// else (a hand edit gone wrong, an older shape) falls back to the defaults.
function loadMap() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_KEY));
    if (Array.isArray(saved) && saved.every((r) => r && typeof r === "object" &&
        ["symbols", "start", "inline"].every((k) => typeof r[k] === "string"))) {
      return copyRows(saved);
    }
  } catch (e) { /* storage unavailable or not JSON */ }
  return copyRows(DEFAULT_EMOJI_MAP);
}

let map = null;

export function currentEmojiMap() {
  if (!map) map = loadMap();
  return copyRows(map);
}

// ctx.onChange() re-renders the outputs after an edit.
export function initEmojiMap(ctx) {
  map = loadMap();
  const modal = el("emoji-modal");
  const rowsEl = el("emoji-rows");
  const opener = el("btn-emoji-map");
  if (!modal || !rowsEl || !opener) return;

  let timer = null;
  function save() {
    try { localStorage.setItem(MAP_KEY, JSON.stringify(map)); } catch (e) { /* storage unavailable */ }
    clearTimeout(timer);
    timer = setTimeout(() => ctx.onChange(), 250);
  }

  function field(row, key, label) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = row[key];
    input.spellcheck = false;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => { row[key] = input.value; save(); });
    return input;
  }

  function render() {
    rowsEl.innerHTML = "";
    map.forEach((row, i) => {
      const line = document.createElement("div");
      line.className = "emoji-grid";
      const n = " (row " + (i + 1) + ")";
      line.appendChild(field(row, "symbols", "Symbols" + n));
      line.appendChild(field(row, "start", "Line start" + n));
      line.appendChild(field(row, "inline", "Mid-line" + n));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "emoji-del";
      del.innerHTML = "&#215;";
      del.setAttribute("aria-label", "Delete row " + (i + 1));
      del.addEventListener("click", () => { map.splice(i, 1); render(); save(); });
      line.appendChild(del);
      rowsEl.appendChild(line);
    });
  }

  function open() {
    render();
    modal.hidden = false;
    const first = rowsEl.querySelector("input") || el("emoji-add");
    first.focus();
  }
  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    opener.focus();
  }

  opener.addEventListener("click", open);
  el("emoji-add").addEventListener("click", () => {
    map.push({ symbols: "", start: "", inline: "" });
    render();
    save();
    const inputs = rowsEl.querySelectorAll("input");
    inputs[inputs.length - 3].focus();
  });
  el("emoji-reset").addEventListener("click", () => {
    map = copyRows(DEFAULT_EMOJI_MAP);
    render();
    save();
  });
  modal.addEventListener("click", (e) => {
    if (e.target && e.target.dataset && e.target.dataset.close) close();
  });
  // On window, in the capture phase, so Escape closes this dialog before the
  // drawer's own Escape handler (on document) can close the drawer under it or
  // update.js can read it as deferring an update.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || modal.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);
}
