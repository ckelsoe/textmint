// In-app updates. ASCII only, same rule as the rest of src/.
//
// Two behaviours, chosen at runtime by the Rust `update_channel` command:
//   - "auto"     (macOS, the Windows NSIS per-user install): the update downloads
//                through the Tauri updater first, then asks "Restart now?" so a
//                user in the middle of something can choose Later. Nothing is
//                installed until they say so.
//   - "download" (the Windows per-machine MSI): the About box links to the
//                releases page instead, so it never drops a second copy beside a
//                managed install.
//   - "move"     (macOS running from a read-only place: App Translocation or the
//                mounted DMG): the updater cannot replace the bundle, so the UI
//                asks the user to move Textmint to Applications and reopen it.
// Either way, once a check finds a newer version a mint pill appears in the
// status bar next to the version. Clicking it downloads the update on the auto
// channel, or opens the releases page on the download channel. See
// docs/plans/self-update.md.
//
// Everything degrades quietly: with no Tauri (a plain browser during dev) or an
// unkeyed build the check simply finds nothing, and the About box still opens and
// reports its state.

const RELEASES_URL = "https://github.com/ckelsoe/textmint/releases/latest";
const CHECK_PREF = "textmint-update-check";
const MOVE_TEXT = "Move Textmint to Applications in Finder, then reopen it to update.";

// null = not checked yet, "none" = up to date, "error" = check failed,
// otherwise the Update object returned by the plugin.
let state = null;
let checking = false;
let channelKind = "download"; // safe default: never self-install unless told to
// What the status-bar pill shows: "idle" (the offer), "busy" (downloading or
// installing), "ready" (downloaded, asking Restart now / Later), "later"
// (downloaded, user deferred), "failed", "copied", or "move".
let pill = "idle";
let busyText = "";
let busy = false;       // a download or install is running
let downloaded = false; // the verified update is held in memory, ready to install

const tauri = () => window.__TAURI__;

function el(id) { return document.getElementById(id); }

function prefOn() {
  try { return localStorage.getItem(CHECK_PREF) !== "0"; } catch (e) { return true; }
}
function setPref(on) {
  try { localStorage.setItem(CHECK_PREF, on ? "1" : "0"); } catch (e) {}
}

async function appVersion() {
  try {
    const t = tauri();
    if (t && t.app && t.app.getVersion) return await t.app.getVersion();
  } catch (e) {}
  // Fall back to the footer, which ships with the full version.
  const f = document.querySelector(".footer-version");
  return f ? f.textContent.replace(/^v/, "") : "";
}

async function loadChannel() {
  try {
    const t = tauri();
    const invoke = t && t.core && t.core.invoke;
    if (invoke) channelKind = await invoke("update_channel");
  } catch (e) { /* keep the safe default */ }
}

// Returns the Update object, "none" if current, or "error" if the check failed
// (offline, or a build whose public key is not set yet).
async function check() {
  const t = tauri();
  if (!t || !t.updater || !t.updater.check) return "error";
  try {
    const upd = await t.updater.check();
    return upd ? upd : "none";
  } catch (e) {
    console.error("textmint: update check failed:", e);
    return "error";
  }
}

function hasUpdate() {
  return !!state && state !== "none" && state !== "error";
}

async function runCheck() {
  // A downloaded update lives on the current Update object; a fresh check would
  // replace it and throw the download away.
  if (checking || busy || downloaded) return;
  checking = true;
  renderAbout();
  state = await check();
  checking = false;
  renderAbout();
  renderPill();
}

// --- Status-bar pill ------------------------------------------------------
function renderPill() {
  const box = el("update-pill");
  if (!box) return;
  box.innerHTML = "";
  if (!hasUpdate()) { box.hidden = true; return; }
  box.hidden = false;

  if (pill === "busy") {
    box.appendChild(document.createTextNode(busyText));
  } else if (pill === "ready") {
    // No focus() here: the download finishes on its own, often while the user
    // is typing, and stealing focus would drop their keystrokes on a button.
    box.appendChild(document.createTextNode("Update ready. Restart now?"));
    box.appendChild(pillButton("Restart now", "Installs the update and relaunches Textmint.", installNow));
    box.appendChild(pillButton("Later", "Keep working. Restart from here when you are ready.", deferInstall, true));
  } else if (pill === "later") {
    box.appendChild(pillButton("Restart to update",
      "Installs the downloaded v" + state.version + " and relaunches Textmint.", installNow));
  } else if (pill === "failed") {
    box.appendChild(pillButton("Update failed: open download page",
      "Opens the releases page in your browser.", pillDownload));
  } else if (pill === "copied") {
    box.appendChild(document.createTextNode("Download link copied. Open it in your browser."));
  } else if (pill === "move") {
    box.appendChild(document.createTextNode(MOVE_TEXT));
  } else if (channelKind === "move") {
    box.appendChild(pillButton("v" + state.version + " available",
      "Textmint is running from a read-only location and cannot update itself.",
      () => { pill = "move"; renderPill(); }));
  } else if (channelKind === "auto") {
    box.appendChild(pillButton("v" + state.version + " available",
      "Downloads the update. Textmint asks before it restarts.", startDownload));
  } else {
    box.appendChild(pillButton("v" + state.version + " available",
      "This install updates from the download page. Opens it in your browser.", pillDownload));
  }
}

function pillButton(label, tip, fn, quiet) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (tip) b.dataset.tip = tip;
  if (quiet) b.className = "quiet";
  b.addEventListener("click", fn);
  return b;
}

function deferInstall() {
  if (pill !== "ready") return;
  pill = "later";
  renderPill();
  renderAbout();
}

async function pillDownload() {
  if (await openExternal(RELEASES_URL)) return;
  if (await copyToClipboard(RELEASES_URL)) { pill = "copied"; renderPill(); }
}

// --- About box ------------------------------------------------------------
function openAbout() {
  const m = el("about-modal");
  if (!m) return;
  m.hidden = false;
  const close = el("about-close");
  if (close) close.focus();
  // If nothing has run yet, let the check drive the display so the box never
  // flashes a stale "latest". Otherwise repaint from the state we have.
  const t = tauri();
  if (state === null && !checking && t && t.updater) runCheck();
  else renderAbout();
}
function closeAbout() {
  const m = el("about-modal");
  if (m) m.hidden = true;
}

// Paints the update area of the About box for the current state and channel.
function renderAbout() {
  const box = el("about-update");
  if (!box) return;
  // Mid-download or install, setBusy owns this area; a repaint would offer the
  // button again.
  if (busy) return;
  box.innerHTML = "";

  const t = tauri();
  if (!t || !t.updater) {
    box.appendChild(line("Updates run in the installed app."));
    return;
  }
  if (checking) { box.appendChild(line("Checking for updates...")); return; }
  if (state === "error") {
    box.appendChild(line("Could not check for updates right now."));
    box.appendChild(actionButton("Check again", runCheck));
    return;
  }
  if (state === "none") {
    box.appendChild(line("You have the latest version."));
    box.appendChild(actionButton("Check for updates", runCheck));
    return;
  }
  if (state === null) {
    box.appendChild(line("Not checked yet."));
    box.appendChild(actionButton("Check for updates", runCheck));
    return;
  }

  // An update is available.
  box.appendChild(line("Version " + state.version + " is available."));
  if (channelKind === "auto" && downloaded) {
    box.appendChild(line("The update is downloaded and ready to install."));
    box.appendChild(actionButton("Restart now", installNow, true));
  } else if (channelKind === "auto") {
    box.appendChild(actionButton("Download update", startDownload, true));
  } else if (channelKind === "move") {
    box.appendChild(line(MOVE_TEXT));
    box.appendChild(actionButton("Open download page", downloadAction));
  } else {
    box.appendChild(line("This install updates from the download page."));
    box.appendChild(actionButton("Open download page", downloadAction));
  }
}

function line(text) {
  const p = document.createElement("p");
  p.className = "about-line";
  p.textContent = text;
  return p;
}
function actionButton(label, fn, primary) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = primary ? "about-btn primary" : "about-btn";
  b.addEventListener("click", fn);
  return b;
}

// Open a URL in the default browser through the opener plugin, falling back to
// window.open in a plain browser during dev. The plugin only permits the repo
// URLs listed in capabilities/default.json.
async function openExternal(url) {
  const t = tauri();
  try {
    if (t && t.opener && t.opener.openUrl) { await t.opener.openUrl(url); return true; }
  } catch (e) {}
  try { window.open(url, "_blank"); return true; } catch (e) {}
  return false;
}

// The MSI's update path: open the releases page, or copy the link if that fails.
async function downloadAction() {
  if (await openExternal(RELEASES_URL)) return;
  // Replace any prior status line so repeated clicks do not stack.
  const box = el("about-update");
  if (!box) return;
  const old = box.querySelector(".about-status");
  if (old) old.remove();
  const ok = await copyToClipboard(RELEASES_URL);
  const p = line(ok ? "Link copied. Open it in your browser." : RELEASES_URL);
  p.classList.add("about-status");
  box.appendChild(p);
}

async function copyToClipboard(text) {
  const t = tauri();
  try {
    if (t && t.clipboardManager && t.clipboardManager.writeText) {
      await t.clipboardManager.writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Shows one progress message in both the pill and the About box, so starting
// the update from either place keeps the other in step.
function setBusy(text) {
  pill = "busy";
  busyText = text;
  renderPill();
  const box = el("about-update");
  if (box) { box.innerHTML = ""; box.appendChild(line(text)); }
}

// Step one: download and verify. Installs nothing, so it needs no confirmation.
async function startDownload() {
  if (!hasUpdate() || busy || downloaded) return;
  busy = true;
  let total = 0;
  let got = 0;
  let shown = -1;
  try {
    setBusy("Downloading update...");
    await state.download((event) => {
      if (!event) return;
      if (event.event === "Started") {
        total = (event.data && event.data.contentLength) || 0;
      } else if (event.event === "Progress" && total) {
        got += (event.data && event.data.chunkLength) || 0;
        // Step by 10% so the live region is not flooded with announcements.
        const pct = Math.min(100, Math.floor((got * 10) / total) * 10);
        if (pct !== shown) { shown = pct; setBusy("Downloading update " + pct + "%"); }
      }
    });
    busy = false;
    downloaded = true;
    pill = "ready";
    renderPill();
    renderAbout();
  } catch (e) {
    fail("download", e);
  }
}

// Step two, only on the user's say-so: install and relaunch. On Windows the
// NSIS installer takes over and the app exits during install().
async function installNow() {
  if (!downloaded || busy) return;
  busy = true;
  try {
    setBusy("Installing. Textmint will relaunch.");
    await state.install();
    setBusy("Relaunching...");
    const t = tauri();
    if (t && t.process && t.process.relaunch) await t.process.relaunch();
  } catch (e) {
    fail("install", e);
  }
}

function fail(step, e) {
  console.error("textmint: update " + step + " failed:", e);
  busy = false;
  downloaded = false;
  pill = "failed";
  renderPill();
  const box = el("about-update");
  if (box) {
    box.innerHTML = "";
    box.appendChild(line("Update failed. Try the download page instead."));
    // The plugin rejects with a string or an Error; show it so a report has
    // something to go on.
    const why = e && e.message ? e.message : String(e || "");
    if (why) box.appendChild(line("Reason: " + why));
    box.appendChild(actionButton("Open download page", downloadAction));
  }
}

// --- Init -----------------------------------------------------------------
export function initUpdate() {
  const checkbox = el("opt-update-check");
  if (checkbox) {
    checkbox.checked = prefOn();
    checkbox.addEventListener("change", () => setPref(checkbox.checked));
  }

  const about = el("btn-about");
  if (about) about.addEventListener("click", openAbout);

  document.querySelectorAll(".about-links [data-url]").forEach((a) => {
    a.addEventListener("click", () => openExternal(a.dataset.url));
  });

  const modal = el("about-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close) closeAbout();
    });
  }
  document.addEventListener("keydown", (e) => {
    // An Escape something else already handled (the settings drawer closing)
    // is not also a request to defer an update.
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const m = el("about-modal");
    if (m && !m.hidden) closeAbout();
    else deferInstall();
  });

  // The footer ships with the version from index.html; the running app corrects it
  // from Tauri, so an installed copy always shows its real version.
  appVersion().then((v) => {
    if (!v) return;
    const s = el("about-version");
    if (s) s.textContent = v;
    if (about) about.textContent = "v" + v;
  });

  // Learn the channel, then run the launch check if it is enabled and this is a
  // real build with the updater present.
  loadChannel().then(() => {
    const t = tauri();
    if (t && t.updater && prefOn()) setTimeout(runCheck, 1200);
  });
}
