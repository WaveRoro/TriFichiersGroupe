import { initAuth, signIn, reconnect, getToken, invalidateToken, signOut, setAuthHandlers, refreshFromGesture } from "./auth.js";
import { DriveApi, extractFolderId } from "./drive.js";
import { DriveSorter } from "./sorter.js";
import { Presence } from "./presence.js";
import { Coordinator } from "./coordinator.js";
import { getDeviceId, getSessionId } from "./identity.js";

// Fill in with the Client ID from Google Cloud Console (Credentials > OAuth client ID).
const CLIENT_ID = "917711651027-r9gt2l06bn0mdcd5n7kctbjd2m0lhihk.apps.googleusercontent.com";

let current = null; // the card being shown
let busy = false; // a swipe/undo is in flight
let opening = false; // a folder is being opened
let dragging = false;
let startX = 0, startY = 0, dx = 0, dy = 0;
const SWIPE_THRESHOLD = 120;

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setHidden(elOrId, hide) {
  const node = typeof elOrId === "string" ? el(elOrId) : elOrId;
  if (hide) node.setAttribute("hidden", "");
  else node.removeAttribute("hidden");
}

// ---------- mobile immersive mode ----------
// On phones, the surrounding text/buttons can cover part of the photo or
// video. By default (mobile only - this is a no-op on desktop, which has
// room to show everything at once) most of it is hidden, leaving just the
// progress bar (which moves up to take the vacated space). Tapping the card
// reveals everything for a few seconds; dragging to swipe deliberately does
// not, so it never fights with the accept/reject gesture.
const CHROME_IDS = ["topbar-detail", "side-actions", "card-footer", "controls-bar"];
const CHROME_REVEAL_MS = 3000;
let chromeHideTimer = null;

function isMobileLayout() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function setChromeVisible(visible) {
  const hide = isMobileLayout() ? !visible : false;
  for (const id of CHROME_IDS) setHidden(id, hide);
}

function revealChromeTemporarily() {
  setChromeVisible(true);
  clearTimeout(chromeHideTimer);
  chromeHideTimer = setTimeout(() => setChromeVisible(false), CHROME_REVEAL_MS);
}

// If the layout ever crosses from mobile to desktop width mid-session
// (a resized window, a rotated tablet), make sure nothing stays stuck
// hidden - desktop always shows everything regardless of chrome state.
window.addEventListener("resize", () => { if (!isMobileLayout()) setChromeVisible(true); });

const screens = {
  signin: el("signin-screen"),
  folder: el("folder-screen"),
  loading: el("loading-screen"),
  app: el("app-screen"),
  done: el("done-screen"),
};

function showScreen(name) {
  for (const k in screens) setHidden(screens[k], k !== name);
}

function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  setHidden(t, false);
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => setHidden(t, true), 3500);
}

// ---------- theme ----------

const THEME_ICONS = {
  auto: '<rect x="2" y="4" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  light: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>' +
    '<line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/>' +
    '<line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>' +
    '<line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
  dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
};
const THEME_LABELS = {
  auto: "Theme : automatique (systeme) - cliquer pour changer",
  light: "Theme : clair - cliquer pour changer",
  dark: "Theme : sombre - cliquer pour changer",
};
const THEME_ORDER = ["auto", "light", "dark"];
let themeMode = "auto";

function applyTheme(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = mode;
  el("theme-icon").innerHTML = THEME_ICONS[mode];
  el("theme-toggle").title = THEME_LABELS[mode];
}

function loadTheme() {
  let mode = "auto";
  try { mode = localStorage.getItem("themeMode") || "auto"; } catch (e) {}
  if (!THEME_ORDER.includes(mode)) mode = "auto";
  applyTheme(mode);
  return mode;
}

function cycleTheme() {
  themeMode = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length];
  try { localStorage.setItem("themeMode", themeMode); } catch (e) {}
  applyTheme(themeMode);
}

// ---------- audio prefs (video/audio volume) ----------

const audioPrefs = { volume: 70, muted: false };

function loadAudioPrefs() {
  try {
    const v = localStorage.getItem("videoVolume");
    const m = localStorage.getItem("videoMuted");
    if (v !== null) audioPrefs.volume = Number(v);
    if (m !== null) audioPrefs.muted = m === "true";
  } catch (e) {}
}
function saveAudioPrefs() {
  try {
    localStorage.setItem("videoVolume", String(audioPrefs.volume));
    localStorage.setItem("videoMuted", String(audioPrefs.muted));
  } catch (e) {}
}

const ICON_SOUND_ON =
  '<polygon points="4,9 4,15 8,15 13,20 13,4 8,9" fill="currentColor" stroke="none"/>' +
  '<path d="M16 8a5 5 0 0 1 0 8"/>' +
  '<path d="M18.5 5.5a9 9 0 0 1 0 13"/>';
const ICON_SOUND_OFF =
  '<polygon points="4,9 4,15 8,15 13,20 13,4 8,9" fill="currentColor" stroke="none"/>' +
  '<line x1="16" y1="9" x2="22" y2="15"/>' +
  '<line x1="22" y1="9" x2="16" y2="15"/>';

function updateMuteIcon() {
  el("icon-mute-toggle").innerHTML = audioPrefs.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
}
function applyAudioPrefs() {
  const vid = el("video-preview");
  vid.volume = audioPrefs.volume / 100;
  vid.muted = audioPrefs.muted;
}

let controlsHideTimer = null;
function showVideoControls() {
  const vc = el("video-controls");
  if (vc.hasAttribute("hidden")) return;
  vc.classList.remove("controls-faded");
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => vc.classList.add("controls-faded"), 2500);
}
function setupVideoControlsAutoHide() {
  const mediaWrap = el("media-wrap");
  mediaWrap.addEventListener("mousemove", showVideoControls);
  mediaWrap.addEventListener("mouseenter", showVideoControls);
  mediaWrap.addEventListener("mouseleave", () => {
    clearTimeout(controlsHideTimer);
    el("video-controls").classList.add("controls-faded");
  });
}

const RING_CIRCUMFERENCE = 97.39;
function updateProgressRing() {
  const vid = el("video-preview");
  const ring = el("ring-fill");
  if (!vid.duration) return;
  const progress = vid.currentTime / vid.duration;
  ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
}

// ---------- speed stats ----------

const SPEED_WINDOW = 15;
let decisionTimestamps = [];
function recordDecision() {
  decisionTimestamps.push(Date.now());
  if (decisionTimestamps.length > SPEED_WINDOW) decisionTimestamps.shift();
}
function resetSpeedStats() {
  decisionTimestamps = [];
  setHidden("stat-speed", true);
}
function formatDuration(minutes) {
  if (minutes < 1) return "< 1 min";
  const totalMin = Math.round(minutes);
  if (totalMin < 60) return `~${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
}
function updateSpeedStats(remaining) {
  const speedEl = el("stat-speed");
  if (decisionTimestamps.length < 3 || !remaining) { setHidden(speedEl, true); return; }
  const first = decisionTimestamps[0];
  const last = decisionTimestamps[decisionTimestamps.length - 1];
  const elapsedMin = (last - first) / 60000;
  const rate = elapsedMin > 0 ? (decisionTimestamps.length - 1) / elapsedMin : 0;
  if (!rate || !isFinite(rate)) { setHidden(speedEl, true); return; }
  setHidden(speedEl, false);
  speedEl.textContent = `≈ ${Math.round(rate)} fichiers/min · ${formatDuration(remaining / rate)} restant`;
}

// ---------- filters ----------

const KIND_ORDER = ["image", "video", "audio", "pdf", "text", "other"];
const KIND_LABELS = { image: "Images", video: "Videos", audio: "Audio", pdf: "PDF", text: "Texte", other: "Autres" };

function renderFilterBar(data) {
  const bar = el("filter-bar");
  const availSet = new Set(data.availableKinds || []);
  const avail = KIND_ORDER.filter((k) => availSet.has(k));
  if (avail.length < 2) { setHidden(bar, true); bar.innerHTML = ""; return; }
  const active = new Set(data.activeFilters || []);
  setHidden(bar, false);
  bar.innerHTML = "";
  for (const kind of avail) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "filter-pill" + (active.has(kind) ? " active" : "");
    pill.textContent = KIND_LABELS[kind] || kind;
    pill.addEventListener("click", () => toggleFilter(kind, active));
    bar.appendChild(pill);
  }
}

async function toggleFilter(kind, currentActive) {
  if (busy || coord.reorganizing || !coord.isOpen) return;
  const next = new Set(currentActive);
  if (next.has(kind)) next.delete(kind); else next.add(kind);
  clearBlobCache();
  const result = await sorter.setFilters(Array.from(next));
  resetSpeedStats();
  render(result);
}

// ---------- drive / sorter / coordination setup ----------

const drive = new DriveApi(getToken, { invalidateToken });
const sorter = new DriveSorter(drive, { deviceId: getDeviceId() });
sorter.onError = (msg) => toast(msg);
const presence = new Presence(drive, { sessionId: getSessionId() });

function setControlsDisabled(disabled) {
  el("btn-accept").disabled = disabled;
  el("btn-reject").disabled = disabled;
  el("btn-skip").disabled = disabled;
  el("btn-undo").disabled = disabled || !sorter.history.length;
}

function newFilesLabel(count) {
  return count === 1 ? "1 nouveau fichier a ete ajoute" : `${count} nouveaux fichiers ont ete ajoutes`;
}

// What the coordinator (which knows nothing about the page) needs from it.
const ui = {
  showReorg(message) {
    setControlsDisabled(true);
    el("reorg-message").textContent = message;
    setHidden("reorg-overlay", false);
  },
  hideReorg() {
    setHidden("reorg-overlay", true);
    setControlsDisabled(false);
  },
  render(data) { render(data); },
  toast(message) { toast(message); },
  setNewFilesBanner(state) {
    if (!state) { setHidden("newfiles-banner", true); return; }
    el("newfiles-message").textContent = `${newFilesLabel(state.count)} - actualisation dans ${state.secondsLeft}s...`;
    setHidden("newfiles-banner", false);
  },
  invalidateMedia() { clearBlobCache(); },
  isVisible() { return document.visibilityState === "visible"; },
  setLoadingText(text) { el("loading-text").textContent = text; },
};

const coord = new Coordinator({ sorter, presence, ui });

function lastFolder() {
  try { return JSON.parse(localStorage.getItem("lastFolder") || "null"); } catch (e) { return null; }
}
function setLastFolder(id, name) {
  try { localStorage.setItem("lastFolder", JSON.stringify({ id, name })); } catch (e) {}
}

// ---------- rendering ----------

function fmtCounts(data) {
  el("stat-remaining").textContent = data.remaining ?? 0;
  el("stat-kept").textContent = data.kept ?? 0;
  el("stat-trashed").textContent = data.trashed ?? 0;
  const total = data.total || 1;
  const done = Math.max(total - (data.remaining || 0), 0);
  const percent = Math.min(100, Math.round((done / total) * 100));
  el("progress-fill").style.width = percent + "%";
  el("progress-percent").textContent = percent + "%";
  el("btn-undo").disabled = !data.canUndo || coord.reorganizing;
  updateSpeedStats(data.remaining || 0);
  renderFilterBar(data);
  const peopleEl = el("stat-people");
  if (data.peopleCount > 1) {
    peopleEl.textContent = `${data.peopleCount} personnes trient ce dossier en ce moment`;
    setHidden(peopleEl, false);
  } else {
    setHidden(peopleEl, true);
  }
}

// Blob cache keyed by file id, used to preload upcoming files while the
// current one is being viewed, and to hand render() an already-resolved blob
// when the user swipes to it (feels instant instead of re-fetching). Each
// entry can be cancelled, so a prefetch nobody needs any more stops
// downloading instead of running to completion in the background.
const blobCache = new Map(); // id -> { promise, controller }
function getBlob(id) {
  let entry = blobCache.get(id);
  if (!entry) {
    const controller = new AbortController();
    const promise = drive.mediaBlob(id, { signal: controller.signal }).catch((e) => {
      blobCache.delete(id);
      throw e;
    });
    entry = { promise, controller };
    blobCache.set(id, entry);
  }
  return entry.promise;
}
// Drops (and cancels) cached/in-flight blobs, except those in `keep`. Called
// with no argument when the queue is rebuilt (new folder, filter, reorg).
function clearBlobCache(keep = null) {
  for (const [id, entry] of blobCache) {
    if (keep && keep.has(id)) continue;
    entry.controller.abort();
    blobCache.delete(id);
  }
}

// Object URL currently assigned to the visible media element. Revoked and
// replaced each time a new file is shown, so we don't leak memory over a
// long sorting session.
let liveObjectUrl = null;
function loadMediaSrc(el, id, errBox, afterSet) {
  getBlob(id).then((blob) => {
    if (!current || current.id !== id) return;
    blobCache.delete(id);
    if (liveObjectUrl) URL.revokeObjectURL(liveObjectUrl);
    liveObjectUrl = URL.createObjectURL(blob);
    // Clearing src before reassigning it works around a Safari quirk where
    // reusing the same <img>/<video> element for a new blob: URL sometimes
    // doesn't refresh - it forces Safari to fully drop the previous source
    // first instead of possibly reusing stale internal state.
    el.removeAttribute("src");
    el.src = liveObjectUrl;
    if (afterSet) afterSet();
  }).catch(() => {
    if (!current || current.id !== id) return;
    setHidden(el, true);
    setHidden(errBox, false);
  });
}

function stopVideo() {
  const vid = el("video-preview");
  try { vid.pause(); vid.removeAttribute("src"); vid.load(); } catch (e) {}
}

function resetCardTransform() {
  const card = el("card");
  card.classList.remove("fly-out", "snap-back", "dragging", "pop");
  card.style.transform = "";
  card.style.opacity = "1";
  el("badge-nope").style.opacity = 0;
  el("badge-like").style.opacity = 0;
  void card.offsetWidth;
  card.classList.add("pop");
}

function render(data) {
  if (!data || data.done) {
    fmtCounts(data || {});
    showScreen("done");
    const kept = data ? data.kept : 0;
    const trashed = data ? (data.trashed ?? 0) : 0;
    el("done-summary").textContent = `${kept} fichier(s) garde(s), ${trashed} envoye(s) a la poubelle.`;
    stopVideo();
    current = null;
    return;
  }
  // A reorganisation or new files can bring cards back after "Termine !".
  if (screens.app.hasAttribute("hidden")) {
    showScreen("app");
    setChromeVisible(false);
  }
  current = data;
  fmtCounts(data);
  resetCardTransform();

  el("file-name").textContent = data.name;
  el("file-meta").textContent = `${data.sizeH} - ${data.ext || "sans extension"}`;

  const img = el("img-preview");
  const vid = el("video-preview");
  const other = el("other-preview");
  const audioIconOverlay = el("audio-icon-overlay");
  const pdfFrame = el("pdf-preview");
  const textPreview = el("text-preview");
  const errBox = el("preview-error");
  const videoControls = el("video-controls");
  const ring = el("video-progress-ring");
  const ringFill = el("ring-fill");

  setHidden(img, true); setHidden(vid, true); setHidden(other, true); setHidden(errBox, true);
  setHidden(audioIconOverlay, true); setHidden(pdfFrame, true); setHidden(textPreview, true);
  setHidden(videoControls, true);
  setHidden(ring, true);
  ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  clearTimeout(controlsHideTimer);
  videoControls.classList.remove("controls-faded");
  stopVideo();
  pdfFrame.src = "about:blank";
  if (liveObjectUrl) { URL.revokeObjectURL(liveObjectUrl); liveObjectUrl = null; }

  if (data.kind === "image") {
    img.onerror = () => { setHidden(img, true); setHidden(errBox, false); };
    img.onload = () => setHidden(img, false);
    loadMediaSrc(img, data.id, errBox);
  } else if (data.kind === "video" || data.kind === "audio") {
    applyAudioPrefs();
    setHidden(audioIconOverlay, data.kind !== "audio");
    vid.onerror = () => { setHidden(vid, true); setHidden(errBox, false); };
    vid.ontimeupdate = updateProgressRing;
    vid.oncanplay = () => {
      setHidden(vid, false);
      setHidden(videoControls, false);
      setHidden(ring, false);
      vid.play().catch(() => {});
      showVideoControls();
    };
    loadMediaSrc(vid, data.id, errBox, () => vid.load());
  } else if (data.kind === "pdf") {
    setHidden(pdfFrame, false);
    pdfFrame.onerror = () => { setHidden(pdfFrame, true); setHidden(errBox, false); };
    loadMediaSrc(pdfFrame, data.id, errBox);
  } else if (data.kind === "text") {
    setHidden(textPreview, false);
    el("text-content").textContent = "Chargement...";
    drive.readTextFile(data.id).then((text) => {
      if (!current || current.id !== data.id) return;
      el("text-content").textContent = text;
    }).catch(() => {
      if (!current || current.id !== data.id) return;
      setHidden(textPreview, true);
      setHidden(errBox, false);
    });
  } else {
    setHidden(other, false);
    el("other-ext").textContent = (data.ext || "?").toUpperCase();
  }

  preload();
}

// How many upcoming files to keep prefetched, and how many of those fetch
// at once. Deeper prefetch means fewer waits when swiping fast, but these
// are full original-quality files (not compressed streaming chunks like
// TikTok/Instagram use) - too deep a buffer risks a lot of memory/bandwidth
// spent on files that might get rejected/skipped without ever being viewed.
const PRELOAD_DEPTH = 5;
const PRELOAD_CONCURRENCY = 2;

function preload() {
  const upcoming = sorter.upcoming(PRELOAD_DEPTH);
  // Anything cached or downloading that is no longer coming up (skipped,
  // reassigned, filtered out) is cancelled rather than left to finish.
  clearBlobCache(new Set([current?.id, ...upcoming.map((f) => f.id)]));
  const items = upcoming.filter((f) => f.kind === "image" || f.kind === "video" || f.kind === "audio");
  let i = 0;
  const runNext = () => {
    if (i >= items.length) return;
    const item = items[i++];
    getBlob(item.id).catch(() => {}).then(runNext);
  };
  for (let k = 0; k < PRELOAD_CONCURRENCY; k++) runNext();
}

// ---------- actions ----------

const FLY_DISTANCE = 900;
const FLY_MS = 260;

function animateOut(action) {
  const card = el("card");
  const dir = action === "accept" ? 1 : -1;
  card.classList.add("fly-out");
  card.style.transform = `translate(${dir * FLY_DISTANCE}px, -40px) rotate(${dir * 30}deg)`;
  card.style.opacity = "0";
  return sleep(FLY_MS);
}
function animateSkip() {
  const card = el("card");
  card.classList.add("fly-out");
  card.style.transform = "translateY(-700px) scale(0.92)";
  card.style.opacity = "0";
  return sleep(FLY_MS);
}

// After the card has flown away, a reorganisation or leaving the folder may
// have started. The decision is then dropped (nothing was recorded yet) and
// the card is put back, so it is never left invisible.
function droppedDuringAnimation() {
  if (!coord.reorganizing && coord.isOpen) return false;
  resetCardTransform();
  return true;
}

async function afterDecision(data) {
  // Out of files: another session may have left work behind, or files may
  // have been added. The coordinator looks once more and draws the result.
  if (data.done) await coord.reconcileIfDone();
  else render(data);
}

async function decide(action) {
  if (busy || coord.reorganizing || !current) return;
  busy = true;
  try {
    await animateOut(action);
    if (droppedDuringAnimation()) return;
    const data = action === "accept" ? await sorter.accept() : await sorter.reject();
    recordDecision();
    await afterDecision(data);
  } finally {
    busy = false;
  }
}

async function doSkip() {
  if (busy || coord.reorganizing || !current) return;
  busy = true;
  try {
    await animateSkip();
    if (droppedDuringAnimation()) return;
    render(await sorter.skipNow());
  } finally {
    busy = false;
  }
}

async function doUndo() {
  if (busy || coord.reorganizing || !coord.isOpen) return;
  busy = true;
  try {
    render(await sorter.undo());
  } finally {
    busy = false;
  }
}

async function doRestartFolder() {
  if (busy || coord.reorganizing || !coord.isOpen) return;
  resetSpeedStats();
  setChromeVisible(false);
  await coord.restart();
}

// ---------- folder loading ----------

// Leaves the current folder for good: stops presence and the new-files
// watch, saves pending progress, and forgets the card on screen.
async function leaveFolder() {
  current = null;
  clearBlobCache();
  stopVideo();
  await coord.close();
}

async function openFolder(folderId, name) {
  if (opening) return;
  opening = true;
  showScreen("loading");
  el("loading-text").textContent = "Chargement du dossier...";
  try {
    const meta = name ? { name } : await drive.getFolderMeta(folderId);
    const folderName = name || meta.name;
    setLastFolder(folderId, folderName);
    el("folder-path").textContent = folderName;
    el("folder-path").title = folderName;
    resetSpeedStats();
    clearBlobCache();
    const first = await coord.open(folderId, folderName);
    if (!first) {
      // Superseded by leaving/opening something else; don't leave the
      // loading screen up if nothing else is going to replace it.
      if (!screens.loading.hasAttribute("hidden")) showScreen("folder");
      return;
    }
    showScreen("app");
    setChromeVisible(false);
    render(first);
  } catch (e) {
    setHidden(el("folder-error"), false);
    el("folder-error").textContent = "Impossible d'ouvrir ce dossier : " + e.message;
    showScreen("folder");
  } finally {
    opening = false;
  }
}

function handleFolderSubmit() {
  const input = el("folder-input").value;
  const id = extractFolderId(input);
  setHidden(el("folder-error"), true);
  if (!id) {
    setHidden(el("folder-error"), false);
    el("folder-error").textContent = "Lien de dossier invalide.";
    return;
  }
  openFolder(id);
}

// ---------- keys & drag ----------

function setupDrag() {
  const card = el("card");
  card.addEventListener("pointerdown", (e) => {
    if (busy || coord.reorganizing) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    dx = 0; dy = 0;
    card.classList.remove("snap-back");
    card.classList.add("dragging");
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    const rot = dx / 18;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    const ratio = Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1);
    if (dx > 0) { el("badge-like").style.opacity = ratio; el("badge-nope").style.opacity = 0; }
    else if (dx < 0) { el("badge-nope").style.opacity = ratio; el("badge-like").style.opacity = 0; }
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("dragging");
    if (Math.abs(dx) > SWIPE_THRESHOLD && !busy) {
      decide(dx > 0 ? "accept" : "reject");
    } else {
      card.classList.add("snap-back");
      card.style.transform = "";
      el("badge-like").style.opacity = 0;
      el("badge-nope").style.opacity = 0;
      // Barely moved -> a tap, not a swipe attempt. Reveal the mobile chrome.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) revealChromeTemporarily();
    }
  }
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
}

function setupKeys() {
  window.addEventListener("keydown", (e) => {
    if (screens.app.hasAttribute("hidden")) return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); decide("accept"); }
    else if (e.key === "ArrowLeft" || e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); decide("reject"); }
    else if (e.key === " " || e.code === "Space") { e.preventDefault(); doSkip(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); }
  });
}

// ---------- page lifecycle & session ----------

function setupLifecycle() {
  // Google sessions last about an hour and can only be renewed from a real
  // tap/click (a background renewal is blocked by the browser): renew ahead
  // of time whenever the user is interacting, and if that still fails, ask
  // them to reconnect instead of letting everything freeze silently.
  document.addEventListener("pointerup", refreshFromGesture, true);
  document.addEventListener("keydown", refreshFromGesture, true);
  setAuthHandlers({
    onNeedsUser: () => setHidden("auth-banner", false),
    onRecovered: () => setHidden("auth-banner", true),
  });
  el("btn-auth-reconnect").addEventListener("click", () => {
    reconnect().catch(() => toast("Reconnexion impossible - reessaie."));
  });

  // Save what is pending as soon as the page may go away, and check in again
  // (heartbeat + who is here) the moment it comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sorter.flushSaves();
    else if (coord.isOpen) coord.resume().catch(() => {});
  });
  window.addEventListener("pagehide", () => { sorter.flushSaves(); });
  window.addEventListener("online", () => { if (coord.isOpen) coord.resume().catch(() => {}); });
}

// ---------- init ----------

async function init() {
  themeMode = loadTheme();
  el("theme-toggle").addEventListener("click", cycleTheme);
  loadAudioPrefs();
  updateMuteIcon();
  el("volume-slider").value = audioPrefs.volume;

  const videoControls = el("video-controls");
  videoControls.addEventListener("pointerdown", (e) => e.stopPropagation());
  el("btn-mute").addEventListener("click", () => {
    audioPrefs.muted = !audioPrefs.muted;
    saveAudioPrefs(); updateMuteIcon(); applyAudioPrefs();
  });
  el("volume-slider").addEventListener("input", (e) => {
    audioPrefs.volume = Number(e.target.value);
    if (audioPrefs.volume > 0 && audioPrefs.muted) { audioPrefs.muted = false; updateMuteIcon(); }
    saveAudioPrefs(); applyAudioPrefs();
  });

  el("btn-accept").addEventListener("click", () => decide("accept"));
  el("btn-reject").addEventListener("click", () => decide("reject"));
  el("btn-skip").addEventListener("click", doSkip);
  el("btn-undo").addEventListener("click", doUndo);
  el("btn-open-external").addEventListener("click", async () => {
    if (!current) return;
    try {
      let url = liveObjectUrl;
      if (!url) {
        const blob = await getBlob(current.id);
        url = URL.createObjectURL(blob);
      }
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast("Impossible d'ouvrir le fichier.");
    }
  });
  const backToFolders = async () => {
    showScreen("folder");
    loadFolderList();
    await leaveFolder();
  };
  el("btn-choose-again").addEventListener("click", backToFolders);
  el("btn-change-folder").addEventListener("click", backToFolders);
  el("btn-restart-folder").addEventListener("click", doRestartFolder);
  el("btn-open-folder").addEventListener("click", handleFolderSubmit);
  el("folder-input").addEventListener("keydown", (e) => { if (e.key === "Enter") handleFolderSubmit(); });
  el("btn-signout").addEventListener("click", async () => {
    showScreen("signin");
    // Leave first (it needs the token to remove our presence and save
    // progress) but never let a stuck network keep someone from signing out.
    await Promise.race([leaveFolder(), sleep(3000)]);
    signOut();
  });
  el("btn-newfiles-dismiss").addEventListener("click", () => coord.dismissNewFiles());
  el("btn-newfiles-refresh").addEventListener("click", () => coord.applyNewFilesNow());

  setupDrag();
  setupKeys();
  setupVideoControlsAutoHide();
  setupLifecycle();

  try {
    await initAuth(CLIENT_ID);
  } catch (e) {
    el("signin-error").textContent = "Erreur de chargement Google : " + e.message;
    setHidden(el("signin-error"), false);
    showScreen("signin");
    return;
  }

  el("btn-signin").addEventListener("click", async () => {
    setHidden(el("signin-error"), true);
    try {
      await signIn();
      afterSignIn();
    } catch (e) {
      el("signin-error").textContent = "Connexion refusee ou impossible.";
      setHidden(el("signin-error"), false);
    }
  });

  showScreen("signin");
}

function afterSignIn() {
  const recent = lastFolder();
  if (recent) {
    setHidden(el("recent-wrap"), false);
    const btn = el("btn-recent");
    btn.textContent = recent.name || recent.id;
    btn.onclick = () => openFolder(recent.id, recent.name);
  }
  showScreen("folder");
  loadFolderList();
}

let folderListCall = 0;
async function loadFolderList() {
  const call = ++folderListCall; // ignore answers that were superseded by a newer call
  const statusEl = el("folder-list-status");
  const listEl = el("folder-list");
  statusEl.textContent = "Recherche de tes dossiers Drive...";
  setHidden(statusEl, false);
  listEl.innerHTML = "";
  try {
    const folders = await drive.listAccessibleFolders();
    if (call !== folderListCall) return;
    if (!folders.length) {
      statusEl.textContent = "Aucun dossier trouve (verifie qu'il a bien ete partage avec toi).";
      return;
    }
    setHidden(statusEl, true);
    for (const f of folders) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "folder-list-item";
      item.innerHTML = `<span>${escapeHtml(f.name)}</span>` +
        (f.owner ? `<span class="owner">${escapeHtml(f.owner)}</span>` : "");
      item.addEventListener("click", () => openFolder(f.id, f.name));
      listEl.appendChild(item);
    }
  } catch (e) {
    if (call !== folderListCall) return;
    statusEl.textContent = "Impossible de lister les dossiers (" + e.message + "). Utilise le lien direct ci-dessous.";
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

window.addEventListener("DOMContentLoaded", init);
