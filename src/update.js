// In-app updates. ASCII only, same rule as the rest of src/.
//
// Two behaviours, chosen at runtime by the Rust `update_channel` command:
//   - "auto"     (macOS, the Windows NSIS per-user install): the About box gets
//                an "Update now" button that installs through the Tauri updater
//                and relaunches.
//   - "download" (the Windows per-machine MSI): the About box links to the
//                releases page instead, so it never drops a second copy beside a
//                managed install.
// Either way, a launch-time check shows a dismissible banner when a newer
// version exists. See docs/plans/self-update.md.
//
// Everything degrades quietly: with no Tauri (a plain browser during dev) or an
// unkeyed build the check simply finds nothing, and the About box still opens and
// reports its state.

const RELEASES_URL = "https://github.com/ckelsoe/textmint/releases/latest";
const CHECK_PREF = "textmint-update-check";

// null = not checked yet, "none" = up to date, "error" = check failed,
// otherwise the Update object returned by the plugin.
let state = null;
let checking = false;
let channelKind = "download"; // safe default: never self-install unless told to

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
  // Fall back to the footer, which carries only major.minor.
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
    return "error";
  }
}

async function runCheck(announce) {
  if (checking) return;
  checking = true;
  renderAbout();
  state = await check();
  checking = false;
  if (announce && state && state !== "none" && state !== "error") showBanner(state.version);
  renderAbout();
}

// --- Banner ---------------------------------------------------------------
function showBanner(version) {
  const bar = el("update-banner");
  const msg = el("update-banner-msg");
  if (!bar || !msg) return;
  msg.textContent = "Textmint " + version + " is available.";
  bar.hidden = false;
}
function hideBanner() {
  const bar = el("update-banner");
  if (bar) bar.hidden = true;
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
  if (state === null && !checking && t && t.updater) runCheck(false);
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
  box.innerHTML = "";

  const t = tauri();
  if (!t || !t.updater) {
    box.appendChild(line("Updates run in the installed app."));
    return;
  }
  if (checking) { box.appendChild(line("Checking for updates...")); return; }
  if (state === "error") {
    box.appendChild(line("Could not check for updates right now."));
    box.appendChild(actionButton("Check again", () => runCheck(false)));
    return;
  }
  if (state === "none") {
    box.appendChild(line("You have the latest version."));
    box.appendChild(actionButton("Check for updates", () => runCheck(false)));
    return;
  }
  if (state === null) {
    box.appendChild(line("Not checked yet."));
    box.appendChild(actionButton("Check for updates", () => runCheck(false)));
    return;
  }

  // An update is available.
  box.appendChild(line("Version " + state.version + " is available."));
  if (channelKind === "auto") {
    box.appendChild(actionButton("Update now", doAutoUpdate, true));
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
  if (!(await openExternal(RELEASES_URL))) copyLink();
}

async function copyLink() {
  const t = tauri();
  // Replace any prior status line so repeated clicks do not stack.
  const say = (text) => {
    const box = el("about-update");
    if (!box) return;
    const old = box.querySelector(".about-status");
    if (old) old.remove();
    const p = line(text);
    p.classList.add("about-status");
    box.appendChild(p);
  };
  try {
    if (t && t.clipboardManager && t.clipboardManager.writeText) {
      await t.clipboardManager.writeText(RELEASES_URL);
    } else {
      await navigator.clipboard.writeText(RELEASES_URL);
    }
    say("Link copied. Open it in your browser.");
  } catch (e) {
    say(RELEASES_URL);
  }
}

async function doAutoUpdate() {
  const box = el("about-update");
  if (!state || state === "none" || state === "error") return;
  try {
    if (box) { box.innerHTML = ""; box.appendChild(line("Downloading update...")); }
    await state.downloadAndInstall((event) => {
      if (box && event && event.event === "Finished") {
        box.innerHTML = "";
        box.appendChild(line("Installing. Textmint will relaunch."));
      }
    });
    const t = tauri();
    if (t && t.process && t.process.relaunch) await t.process.relaunch();
  } catch (e) {
    if (box) {
      box.innerHTML = "";
      box.appendChild(line("Update failed. Try the download page instead."));
      box.appendChild(actionButton("Open download page", downloadAction));
    }
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

  const view = el("update-banner-view");
  if (view) view.addEventListener("click", () => { hideBanner(); openAbout(); });
  const dismiss = el("update-banner-dismiss");
  if (dismiss) dismiss.addEventListener("click", hideBanner);

  const modal = el("about-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close) closeAbout();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAbout();
  });

  appVersion().then((v) => { const s = el("about-version"); if (s && v) s.textContent = v; });

  // Learn the channel, then run the launch check if it is enabled and this is a
  // real build with the updater present.
  loadChannel().then(() => {
    const t = tauri();
    if (t && t.updater && prefOn()) setTimeout(() => runCheck(true), 1200);
  });
}
