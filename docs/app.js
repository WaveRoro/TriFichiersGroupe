import { initAuth, signIn, reconnect, getToken, invalidateToken, signOut, setAuthHandlers, refreshFromGesture } from "./auth.js";
import { DriveApi, extractFolderId } from "./drive.js";
import { DriveSorter } from "./sorter.js";
import { Presence } from "./presence.js";
import { Coordinator } from "./coordinator.js";
import { getDeviceId, getSessionId } from "./identity.js";
import { Zoom } from "./zoom.js";

// Fill in with the Client ID from Google Cloud Console (Credentials > OAuth client ID).
const CLIENT_ID = "917711651027-r9gt2l06bn0mdcd5n7kctbjd2m0lhihk.apps.googleusercontent.com";

let current = null; // the card being shown
let busy = false; // a swipe/undo is in flight
let opening = false; // a folder is being opened
let dragging = false;
let startX = 0, startY = 0, dx = 0, dy = 0;

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setHidden(elOrId, hide) {
  const node = typeof elOrId === "string" ? el(elOrId) : elOrId;
  if (hide) node.setAttribute("hidden", "");
  else node.removeAttribute("hidden");
}

// ---------- mobile immersive mode ----------
// On phones the text and buttons would cover the photo, so by default only a
// thin progress bar is left. A tap on the photo shows everything, another tap
// hides it again (a swipe never toggles it, so it can't fight the gesture).
// This is purely a CSS class: desktop has room for everything and ignores it.
const CHROME_KEY = "chromeVisible";
let chromeVisible = false;

function isMobileLayout() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function applyChrome() {
  el("app-screen").classList.toggle("chrome-hidden", !chromeVisible);
}

function loadChrome() {
  try { chromeVisible = localStorage.getItem(CHROME_KEY) === "true"; } catch (e) {}
  applyChrome();
}

// The phone layout slides the progress bar up by the height of the folder
// info when that is hidden, so it needs that height as a plain number.
function trackDetailHeight() {
  if (!("ResizeObserver" in window)) return;
  const bar = document.querySelector(".topbar");
  const inner = document.querySelector(".topbar-inner");
  new ResizeObserver(() => bar.style.setProperty("--detail-h", inner.offsetHeight + "px")).observe(inner);
}

function toggleChrome() {
  chromeVisible = !chromeVisible;
  try { localStorage.setItem(CHROME_KEY, String(chromeVisible)); } catch (e) {}
  applyChrome();
}

const screens = {
  signin: el("signin-screen"),
  folder: el("folder-screen"),
  loading: el("loading-screen"),
  app: el("app-screen"),
  done: el("done-screen"),
};

function showScreen(name) {
  for (const k in screens) setHidden(screens[k], k !== name);
  document.body.dataset.screen = name;
}

function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  setHidden(t, false);
  // Re-trigger the entrance animation when a toast replaces another one.
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
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

const RING_CIRCUMFERENCE = 100.53; // 2 * PI * r, r = 16 (see .ring-fill)
function updateProgressRing() {
  const vid = el("video-preview");
  const ring = el("ring-fill");
  if (!vid.duration || !isFinite(vid.duration)) return;
  const progress = vid.currentTime / vid.duration;
  ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
}

// "timeupdate" only fires a few times a second, which made the ring advance
// in visible steps: while the video plays it follows the clock every frame.
let ringFrame = 0;
function ringLoop() {
  ringFrame = 0;
  updateProgressRing();
  const vid = el("video-preview");
  if (!vid.paused && !vid.ended) ringFrame = requestAnimationFrame(ringLoop);
}
function startRingLoop() {
  if (!ringFrame) ringFrame = requestAnimationFrame(ringLoop);
}
function stopRingLoop() {
  if (ringFrame) cancelAnimationFrame(ringFrame);
  ringFrame = 0;
  updateProgressRing();
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

let filterBarSignature = "";

function renderFilterBar(data) {
  const bar = el("filter-bar");
  const availSet = new Set(data.availableKinds || []);
  const avail = KIND_ORDER.filter((k) => availSet.has(k));
  const active = new Set(data.activeFilters || []);
  // Runs after every swipe: rebuilding identical buttons would cost a layout
  // pass right when the next card appears.
  const signature = avail.length < 2 ? "" : avail.map((k) => k + (active.has(k) ? "+" : "-")).join(",");
  if (signature === filterBarSignature) return;
  filterBarSignature = signature;
  if (avail.length < 2) { setHidden(bar, true); bar.innerHTML = ""; return; }
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
  invalidateMedia() { pruneToQueue(); },
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
  el("progress-fill").style.transform = `scaleX(${percent / 100})`;
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

// ---------- media cache ----------

// How many upcoming files to keep prefetched, and how many of those fetch
// at once. Deeper prefetch means fewer waits when swiping fast, but these
// are full original-quality files (not compressed streaming chunks like
// TikTok/Instagram use) - too deep a buffer risks a lot of memory/bandwidth
// spent on files that might get rejected/skipped without ever being viewed.
const PRELOAD_DEPTH = 5;
const PRELOAD_CONCURRENCY = 2;

// One entry per file id: the (cancellable) download and, once it has
// arrived, an object URL for it. Kept for the file on screen and those
// coming up, so swiping to the next one shows an image that is already
// here instead of fetching it. Anything no longer needed is cancelled and
// its URL released, so a long session doesn't pile up memory.
const mediaCache = new Map(); // id -> { promise, controller, url }

function mediaEntry(id) {
  let entry = mediaCache.get(id);
  if (entry) return entry;
  const controller = new AbortController();
  entry = { controller, url: null, promise: null };
  entry.promise = drive.mediaBlob(id, { signal: controller.signal }).then((blob) => {
    if (controller.signal.aborted) throw new Error("cancelled");
    entry.url = URL.createObjectURL(blob);
    return entry;
  });
  // A failed download must not stay cached (the next attempt should retry),
  // and having a handler here keeps a prefetch nobody awaits from being
  // reported as an unhandled rejection.
  const failed = entry;
  entry.promise.catch(() => { if (mediaCache.get(id) === failed) mediaCache.delete(id); });
  mediaCache.set(id, entry);
  return entry;
}

function dropMedia(id) {
  const entry = mediaCache.get(id);
  if (!entry) return;
  entry.controller.abort();
  if (entry.url) URL.revokeObjectURL(entry.url);
  mediaCache.delete(id);
}

// Keeps only the files in `keepIds` (none by default).
function pruneMedia(keepIds = []) {
  const keep = new Set(keepIds);
  for (const id of [...mediaCache.keys()]) if (!keep.has(id)) dropMedia(id);
}

function pruneToQueue() {
  pruneMedia([current?.id, ...sorter.upcoming(PRELOAD_DEPTH).map((f) => f.id)]);
}

// Points a preview element at a file once it has downloaded. Ignored if the
// user has moved on to another file by then.
function attachMedia(node, id, onFail, afterSet) {
  mediaEntry(id).promise.then((entry) => {
    if (!current || current.id !== id) return;
    // Clearing src before reassigning it works around a Safari quirk where
    // reusing the same <img>/<video> element for a new blob: URL sometimes
    // doesn't refresh - it forces Safari to fully drop the previous source
    // first instead of possibly reusing stale internal state.
    node.removeAttribute("src");
    node.src = entry.url;
    if (afterSet) afterSet();
  }).catch(() => {
    if (current && current.id === id) onFail();
  });
}

function stopVideo() {
  const vid = el("video-preview");
  if (ringFrame) { cancelAnimationFrame(ringFrame); ringFrame = 0; }
  try { vid.pause(); vid.removeAttribute("src"); vid.load(); } catch (e) {}
}

// ---------- ambient fill ----------

// One direction of a box blur over RGBA pixels (edges repeat their last pixel).
function blurPass(src, dst, w, h, radius, horizontal) {
  const length = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const along = horizontal ? 4 : w * 4;
  const across = horizontal ? w * 4 : 4;
  const width = 2 * radius + 1;
  for (let line = 0; line < lines; line++) {
    const base = line * across;
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += src[base + Math.min(length - 1, Math.max(0, k)) * along + channel];
      }
      for (let i = 0; i < length; i++) {
        dst[base + i * along + channel] = sum / width;
        sum += src[base + Math.min(length - 1, i + radius + 1) * along + channel]
          - src[base + Math.max(0, i - radius) * along + channel];
      }
    }
  }
}

// Fills the bars around a photo/video that doesn't fill the card with its own
// colours. The picture is shrunk to a tiny copy which is really blurred (a few
// box-blur passes) before the browser enlarges it: enlarging a tiny picture on
// its own leaves visible pixels, a blurred one becomes a smooth gradient.
// Drawn once per file, so it costs nothing while swiping.
function paintAmbient(canvas, source) {
  const w = source.naturalWidth || source.videoWidth;
  const h = source.naturalHeight || source.videoHeight;
  if (!w || !h) return;
  try {
    // Two steps: shrinking a large photo straight to a few pixels skips most of it.
    const step = document.createElement("canvas");
    const stepScale = 96 / Math.max(w, h);
    step.width = Math.max(2, Math.round(w * stepScale));
    step.height = Math.max(2, Math.round(h * stepScale));
    const stepCtx = step.getContext("2d");
    stepCtx.imageSmoothingQuality = "high";
    stepCtx.drawImage(source, 0, 0, step.width, step.height);

    const small = document.createElement("canvas");
    const scale = 40 / Math.max(w, h);
    small.width = Math.max(4, Math.round(w * scale));
    small.height = Math.max(4, Math.round(h * scale));
    const smallCtx = small.getContext("2d");
    smallCtx.imageSmoothingQuality = "high";
    smallCtx.drawImage(step, 0, 0, small.width, small.height);

    const image = smallCtx.getImageData(0, 0, small.width, small.height);
    const from = image.data;
    const to = new Uint8ClampedArray(from.length);
    for (let pass = 0; pass < 3; pass++) {
      blurPass(from, to, small.width, small.height, 4, true);
      blurPass(to, from, small.width, small.height, 4, false);
    }
    for (let i = 3; i < from.length; i += 4) from[i] = 255;
    smallCtx.putImageData(image, 0, 0);

    canvas.width = small.width;
    canvas.height = small.height;
    canvas.getContext("2d").drawImage(small, 0, 0);
    setHidden(canvas, false);
  } catch (e) {
    setHidden(canvas, true);
  }
}

// Sizes a photo/video to exactly the area it occupies inside the card and
// says which of its edges border the filled bars, so the stylesheet can feather
// those edges into the ambient fill instead of leaving a hard line.
function fitMedia(node) {
  const w = node.naturalWidth || node.videoWidth;
  const h = node.naturalHeight || node.videoHeight;
  const wrap = node.parentElement;
  if (!w || !h || !wrap) return;
  const boxW = wrap.clientWidth;
  const boxH = wrap.clientHeight;
  if (!boxW || !boxH) return;
  const scale = Math.min(boxW / w, boxH / h);
  const fitW = Math.round(w * scale);
  const fitH = Math.round(h * scale);
  node.style.width = fitW + "px";
  node.style.height = fitH + "px";
  node.classList.toggle("fade-x", fitW < boxW - 1);
  node.classList.toggle("fade-y", fitH < boxH - 1);
}

let refitFrame = 0;
window.addEventListener("resize", () => {
  if (refitFrame) return;
  refitFrame = requestAnimationFrame(() => {
    refitFrame = 0;
    for (const id of ["img-preview", "video-preview", "back-img", "back-video"]) {
      if (!el(id).hasAttribute("hidden")) fitMedia(el(id));
    }
    refitZoom();
  });
});

// ---------- the card underneath ----------

// Shows the next file behind the current one, so a swipe reveals it (with its
// name) instead of an empty background - and so that when it becomes the
// current card nothing changes on screen.
let backId = null;
let backTimer = null;

function clearBack() {
  const img = el("back-img");
  const vid = el("back-video");
  setHidden(img, true);
  setHidden(vid, true);
  setHidden("back-ambient", true);
  setHidden("back-placeholder", true);
  img.onload = null;
  vid.onloadeddata = null;
  img.removeAttribute("src");
  try { vid.pause(); vid.removeAttribute("src"); vid.load(); } catch (e) {}
}

function renderBack(next) {
  const back = el("card-back");
  if (!next) {
    backId = null;
    back.classList.add("is-empty");
    clearBack();
    return;
  }
  back.classList.remove("is-empty");
  if (backId === next.id) return;
  backId = next.id;
  clearBack();
  el("back-name").textContent = next.name;
  el("back-meta").textContent = `${next.sizeH} - ${next.ext || "sans extension"}`;

  if (next.kind !== "image" && next.kind !== "video") {
    const placeholder = el("back-placeholder");
    placeholder.textContent = (next.ext || "fichier").toUpperCase();
    setHidden(placeholder, false);
    return;
  }
  const entry = mediaCache.get(next.id);
  if (!entry) return;
  const node = next.kind === "image" ? el("back-img") : el("back-video");
  entry.promise.then((loaded) => {
    if (backId !== next.id) return;
    // "#t=" makes a paused video show its first frame.
    const ready = () => { fitMedia(node); paintAmbient(el("back-ambient"), node); };
    if (next.kind === "video") node.onloadeddata = ready;
    else node.onload = ready;
    node.src = next.kind === "video" ? loaded.url + "#t=0.001" : loaded.url;
    setHidden(node, false);
  }).catch(() => {});
}

// ---------- the card on top ----------

// One layer serves all three gestures: the strongest one decides its colour
// and icon, and its opacity follows how far the gesture has gone.
let washKind = "";
function setBadges(like, nope, skip) {
  const wash = el("wash");
  const level = Math.max(like, nope, skip);
  if (level > 0) {
    const kind = like === level ? "like" : nope === level ? "nope" : "skip";
    if (kind !== washKind) {
      washKind = kind;
      wash.dataset.kind = kind;
    }
  }
  wash.style.opacity = level;
}

// 0 = card at rest, 1 = card gone. Drives how far the card underneath has
// grown (see .card-back in the stylesheet).
function setDragProgress(p) {
  el("card-back").style.setProperty("--p", String(p));
}

function resetCardTransform({ pop = false } = {}) {
  const card = el("card");
  card.classList.remove("fly-out", "snap-back", "dragging", "pop");
  // Everything jumps back at once: no fading badge or sliding card left over.
  card.classList.add("instant");
  card.style.transform = "";
  card.style.opacity = "1";
  setBadges(0, 0, 0);
  setDragProgress(0);
  void card.offsetWidth;
  card.classList.remove("instant");
  if (pop) card.classList.add("pop");
}

// Shows `data`'s media in the preview area. Resolves once it is on screen (or
// has failed), which is when a swap from the card underneath is invisible.
function showMedia(data, seq) {
  const img = el("img-preview");
  const vid = el("video-preview");
  const other = el("other-preview");
  const audioIconOverlay = el("audio-icon-overlay");
  const pdfFrame = el("pdf-preview");
  const textPreview = el("text-preview");
  const errBox = el("preview-error");
  const videoControls = el("video-controls");
  const ring = el("video-progress-ring");
  const wrap = el("media-wrap");

  for (const node of [img, vid, other, errBox, audioIconOverlay, pdfFrame, textPreview, videoControls, ring]) {
    setHidden(node, true);
  }
  el("ring-fill").style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  clearTimeout(controlsHideTimer);
  videoControls.classList.remove("controls-faded");
  stopVideo();
  pdfFrame.src = "about:blank";
  setHidden("ambient", true);
  wrap.classList.add("is-loading");

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (seq === renderSeq) wrap.classList.remove("is-loading");
      resolve();
    };
    const fail = (node) => {
      if (seq !== renderSeq) return finish();
      setHidden(node, true);
      setHidden(errBox, false);
      finish();
    };

    if (data.kind === "image") {
      img.onerror = () => fail(img);
      img.onload = () => {
        if (seq === renderSeq) {
          fitMedia(img);
          paintAmbient(el("ambient"), img);
        }
        // Decoded before it is shown, so nothing pops in half-drawn.
        const show = () => {
          if (seq === renderSeq) setHidden(img, false);
          finish();
        };
        (img.decode ? img.decode() : Promise.resolve()).then(show, show);
      };
      attachMedia(img, data.id, () => fail(img));
    } else if (data.kind === "video" || data.kind === "audio") {
      applyAudioPrefs();
      setHidden(audioIconOverlay, data.kind !== "audio");
      vid.onerror = () => fail(vid);
      vid.ontimeupdate = updateProgressRing;
      vid.onplaying = startRingLoop;
      vid.onpause = stopRingLoop;
      vid.oncanplay = () => {
        if (seq === renderSeq) {
          fitMedia(vid);
          paintAmbient(el("ambient"), vid);
          setHidden(vid, false);
          setHidden(videoControls, false);
          setHidden(ring, false);
          vid.play().catch(() => {});
          showVideoControls();
        }
        finish();
      };
      attachMedia(vid, data.id, () => fail(vid), () => vid.load());
    } else if (data.kind === "pdf") {
      setHidden(pdfFrame, false);
      pdfFrame.onerror = () => fail(pdfFrame);
      attachMedia(pdfFrame, data.id, () => fail(pdfFrame), finish);
    } else if (data.kind === "text") {
      setHidden(textPreview, false);
      el("text-content").textContent = "Chargement...";
      drive.readTextFile(data.id).then((text) => {
        if (current && current.id === data.id) el("text-content").textContent = text;
        finish();
      }).catch(() => {
        if (current && current.id === data.id) fail(textPreview);
        else finish();
      });
    } else {
      setHidden(other, false);
      el("other-ext").textContent = (data.ext || "?").toUpperCase();
      finish();
    }
  });
}

// After a decision the card that flew away stays invisible until the next
// file is ready to take its place exactly where the card underneath already
// shows it. Waiting is capped so a slow download never leaves an empty screen.
const SEAMLESS_MAX_WAIT_MS = 350;
let renderSeq = 0;

// Returns a promise that resolves once the card is on screen again (only
// meaningful with `seamless`, so callers can keep input locked until then).
function render(data, { seamless = false } = {}) {
  const seq = ++renderSeq;
  if (!data || data.done) {
    fmtCounts(data || {});
    showScreen("done");
    const kept = data ? data.kept : 0;
    const trashed = data ? (data.trashed ?? 0) : 0;
    el("done-summary").textContent = `${kept} fichier(s) garde(s), ${trashed} envoye(s) a la poubelle.`;
    stopVideo();
    current = null;
    clearTimeout(backTimer);
    renderBack(null);
    pruneMedia();
    return Promise.resolve();
  }
  // A reorganisation or new files can bring cards back after "Termine".
  if (screens.app.hasAttribute("hidden")) showScreen("app");
  current = data;
  fmtCounts(data);
  if (!seamless) resetCardTransform({ pop: true });

  el("file-name").textContent = data.name;
  el("file-meta").textContent = `${data.sizeH} - ${data.ext || "sans extension"}`;

  resetZoom();
  const ready = showMedia(data, seq);
  preload();
  if (!seamless) return Promise.resolve();
  return Promise.race([ready, sleep(SEAMLESS_MAX_WAIT_MS)]).then(() => {
    if (seq === renderSeq) resetCardTransform();
  });
}

function preload() {
  const upcoming = sorter.upcoming(PRELOAD_DEPTH);
  // Anything cached or downloading that is no longer coming up (skipped,
  // reassigned, filtered out) is cancelled rather than left to finish.
  pruneMedia([current?.id, ...upcoming.map((f) => f.id)]);
  const items = upcoming.filter((f) => f.kind === "image" || f.kind === "video" || f.kind === "audio");
  let i = 0;
  const runNext = () => {
    if (i >= items.length) return;
    const item = items[i++];
    mediaEntry(item.id).promise.catch(() => {}).then(runNext);
  };
  for (let k = 0; k < PRELOAD_CONCURRENCY; k++) runNext();
  // Filling in the card underneath decodes another big image; do it just
  // after the new card has appeared rather than in the same frame.
  const next = upcoming[0] || null;
  clearTimeout(backTimer);
  backTimer = setTimeout(() => renderBack(next), 80);
}

// ---------- actions ----------

const FLY_DISTANCE = 900;
const FLY_MS = 280; // matches .card.fly-out in the stylesheet

function flyOut(transform, badges) {
  const card = el("card");
  card.classList.remove("dragging", "snap-back");
  card.classList.add("fly-out");
  card.style.transform = transform;
  card.style.opacity = "0";
  setBadges(...badges);
  setDragProgress(1);
  return sleep(FLY_MS);
}

function animateOut(action) {
  const dir = action === "accept" ? 1 : -1;
  return flyOut(
    `translate(${dir * FLY_DISTANCE}px, -40px) rotate(${dir * 24}deg)`,
    dir > 0 ? [1, 0, 0] : [0, 1, 0],
  );
}

function animateSkip() {
  return flyOut("translateY(-800px) scale(0.94)", [0, 0, 1]);
}

// After the card has flown away, a reorganisation or leaving the folder may
// have started. The decision is then dropped (nothing was recorded yet) and
// the card is put back, so it is never left invisible.
function droppedDuringAnimation() {
  if (!coord.reorganizing && coord.isOpen) return false;
  resetCardTransform();
  return true;
}

function canAct() {
  return !busy && !coord.reorganizing && !!current;
}

async function afterDecision(data) {
  // Out of files: another session may have left work behind, or files may
  // have been added. The coordinator looks once more and draws the result.
  if (data.done) await coord.reconcileIfDone();
  else await render(data, { seamless: true });
}

// Runs one decision, keeping input locked until the next card is on screen.
async function runDecision(animate, perform) {
  if (!canAct()) return;
  busy = true;
  try {
    await animate();
    if (droppedDuringAnimation()) return;
    await afterDecision(await perform());
  } catch (e) {
    console.error(e);
    resetCardTransform();
    toast("Action impossible, reessaie.");
  } finally {
    busy = false;
  }
}

function decide(action) {
  return runDecision(
    () => animateOut(action),
    async () => {
      const data = action === "accept" ? await sorter.accept() : await sorter.reject();
      recordDecision();
      return data;
    },
  );
}

function doSkip() {
  return runDecision(animateSkip, () => sorter.skipNow());
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
  await coord.restart();
}

// ---------- folder loading ----------

// Leaves the current folder for good: stops presence and the new-files
// watch, saves pending progress, and forgets the card on screen.
async function leaveFolder() {
  current = null;
  pruneMedia();
  clearTimeout(backTimer);
  renderBack(null);
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
    pruneMedia();
    const first = await coord.open(folderId, folderName);
    if (!first) {
      // Superseded by leaving/opening something else; don't leave the
      // loading screen up if nothing else is going to replace it.
      if (!screens.loading.hasAttribute("hidden")) showScreen("folder");
      return;
    }
    showScreen("app");
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

const SWIPE_MIN = 70;
const SWIPE_MAX = 130;
const FLICK_SPEED = 0.55; // px per ms: a quick flick counts even over a short distance
const TAP_SLOP = 6;
const TAP_MAX_MS = 500;
const MAX_TILT_DEG = 16;

// Mostly-upward movement is a skip; anything else is judged on its horizontal part.
function isUpwardSwipe() {
  return dy < 0 && -dy > Math.abs(dx) * 1.2;
}

function setupDrag() {
  const card = el("card");
  const zone = el("card-zone");
  let samples = []; // recent pointer positions, to measure the speed at release
  let downAt = 0;
  let moved = false;
  let threshold = SWIPE_MAX; // measured once per gesture: reading sizes while moving forces a layout every frame
  let frame = 0;
  let shownLevel = -1;

  function badgeLevels() {
    if (isUpwardSwipe()) return { like: 0, nope: 0, skip: Math.min(1, -dy / threshold) };
    if (dx > 0) return { like: Math.min(1, dx / threshold), nope: 0, skip: 0 };
    return { like: 0, nope: Math.min(1, -dx / threshold), skip: 0 };
  }

  // Pointer events can arrive faster than the screen refreshes: they only
  // record the position, and the card is drawn at most once per frame.
  function paint() {
    frame = 0;
    if (!dragging) return;
    const tilt = Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, dx / 18));
    card.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${tilt}deg)`;
    const { like, nope, skip } = badgeLevels();
    const level = Math.max(like, nope, skip);
    // Only touch the feedback layer when it visibly changes.
    if (Math.abs(level - shownLevel) >= 0.02 || (level === 0 && shownLevel !== 0)) {
      shownLevel = level;
      setBadges(like, nope, skip);
    }
    setDragProgress(Math.min(1, Math.hypot(dx, dy) / (threshold * 1.8)));
  }

  function stopPainting() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    shownLevel = -1;
  }

  function snapBack() {
    card.classList.add("snap-back");
    card.style.transform = "";
    setBadges(0, 0, 0);
    setDragProgress(0);
  }

  // A second finger arrived: this is a pinch, not a swipe.
  function abort() {
    if (!dragging) return;
    dragging = false;
    stopPainting();
    zone.classList.remove("dragging");
    card.classList.remove("dragging");
    snapBack();
  }

  function speed() {
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = Math.max(last.t - first.t, 1);
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  function releaseAction() {
    const { vx, vy } = speed();
    if (isUpwardSwipe()) {
      return (-dy > threshold || (vy < -FLICK_SPEED && -dy > 40)) ? "skip" : null;
    }
    if (Math.abs(dx) > threshold || (Math.abs(vx) > FLICK_SPEED && Math.abs(dx) > 40)) {
      return dx > 0 ? "accept" : "reject";
    }
    return null;
  }

  card.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || !canAct()) return;
    dragging = true;
    moved = false;
    startX = e.clientX; startY = e.clientY;
    dx = 0; dy = 0;
    threshold = Math.max(SWIPE_MIN, Math.min(SWIPE_MAX, card.offsetWidth * 0.25));
    samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    downAt = e.timeStamp;
    shownLevel = -1;
    card.classList.remove("snap-back");
    card.classList.add("dragging");
    zone.classList.add("dragging");
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (!moved) {
      // A finger always wobbles a little: don't start moving the card for it.
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      moved = true;
    }
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0].t > 100) samples.shift();
    if (!frame) frame = requestAnimationFrame(paint);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    stopPainting();
    zone.classList.remove("dragging");
    card.classList.remove("dragging");

    const released = e.type === "pointerup";
    if (!moved) {
      // Barely moved and quickly let go: a tap, which toggles the phone overlay.
      snapBack();
      if (released && e.timeStamp - downAt < TAP_MAX_MS && isMobileLayout()) toggleChrome();
      return;
    }
    const action = released && canAct() ? releaseAction() : null;
    if (action === "skip") doSkip();
    else if (action) decide(action);
    else snapBack();
  }
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
  return { abort };
}

// ---------- zoom (photos only) ----------
// Two fingers pinch, the wheel or a trackpad pinch zooms at the cursor, a
// double click zooms in/out, and while zoomed one finger or the mouse pans
// instead of swiping. These handlers are registered before the swipe ones and
// take the events they use, so the two never fight over the same gesture.

const zoom = new Zoom();
let dragApi = null;

function zoomable() {
  return !!current && current.kind === "image" && !el("img-preview").hasAttribute("hidden")
    && !busy && !coord.reorganizing;
}

function zoomGeometry() {
  const img = el("img-preview");
  const wrap = el("media-wrap");
  const rect = wrap.getBoundingClientRect();
  return {
    centre: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    box: { w: wrap.clientWidth, h: wrap.clientHeight },
    fit: {
      w: parseFloat(img.style.width) || wrap.clientWidth,
      h: parseFloat(img.style.height) || wrap.clientHeight,
    },
  };
}

let zoomFrame = 0;
function drawZoom(smooth = false) {
  const img = el("img-preview");
  img.classList.toggle("zoom-smooth", smooth);
  img.classList.toggle("zoomed", zoom.active);
  if (smooth) {
    if (zoomFrame) cancelAnimationFrame(zoomFrame);
    zoomFrame = 0;
    img.style.transform = zoom.css();
    return;
  }
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = 0;
    img.style.transform = zoom.css();
  });
}

function resetZoom() {
  const img = el("img-preview");
  if (!zoom.active && !img.style.transform) return;
  zoom.reset();
  if (zoomFrame) cancelAnimationFrame(zoomFrame);
  zoomFrame = 0;
  img.classList.remove("zoom-smooth", "zoomed");
  img.style.transform = "";
}

function refitZoom() {
  if (!zoom.active) return;
  const g = zoomGeometry();
  zoom.refit(g.box, g.fit);
  drawZoom();
}

function setupZoom() {
  const card = el("card");
  const pointers = new Map(); // pointerId -> { x, y } for the fingers/mouse currently down
  let mode = "none"; // "none" | "pinch" | "pan"
  let geometry = null;
  let panId = null;
  let panMoved = false;
  let panStartAt = 0;
  let startDistance = 1;
  let lastClick = { t: 0, x: 0, y: 0 };

  const focalOf = (a, b) => ({
    x: (a.x + b.x) / 2 - geometry.centre.x,
    y: (a.y + b.y) / 2 - geometry.centre.y,
  });

  function startPinch() {
    const [a, b] = [...pointers.values()];
    geometry = zoomGeometry();
    startDistance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    zoom.beginPinch(focalOf(a, b));
    mode = "pinch";
  }

  function startPan(id) {
    geometry = zoomGeometry();
    panId = id;
    panMoved = false;
    panStartAt = performance.now();
    mode = "pan";
  }

  card.addEventListener("pointerdown", (e) => {
    // A primary pointer is the first finger of a new gesture, so anything still
    // listed (a release that never reached us) is stale.
    if (e.isPrimary) { pointers.clear(); mode = "none"; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!zoomable()) return;
    if (pointers.size === 2) {
      if (dragApi) dragApi.abort();
      card.setPointerCapture(e.pointerId);
      startPinch();
      e.stopImmediatePropagation();
      return;
    }
    if (pointers.size > 2) { e.stopImmediatePropagation(); return; }
    if (e.pointerType === "mouse" && e.button === 0) {
      const isDouble = e.timeStamp - lastClick.t < 320
        && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 8;
      lastClick = { t: isDouble ? 0 : e.timeStamp, x: e.clientX, y: e.clientY };
      if (isDouble) {
        const g = zoomGeometry();
        zoom.toggleAt({ x: e.clientX - g.centre.x, y: e.clientY - g.centre.y }, g.box, g.fit);
        drawZoom(true);
        e.stopImmediatePropagation();
        return;
      }
    }
    if (zoom.active && e.button === 0) {
      card.setPointerCapture(e.pointerId);
      startPan(e.pointerId);
      e.stopImmediatePropagation();
    }
  });

  card.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const moveX = e.clientX - p.x;
    const moveY = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (mode === "pinch") {
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const ratio = Math.hypot(a.x - b.x, a.y - b.y) / startDistance;
        zoom.pinchTo(ratio, focalOf(a, b), geometry.box, geometry.fit);
        drawZoom();
      }
      e.stopImmediatePropagation();
    } else if (mode === "pan" && e.pointerId === panId) {
      if (moveX || moveY) {
        panMoved = true;
        zoom.panBy(moveX, moveY, geometry.box, geometry.fit);
        drawZoom();
      }
      e.stopImmediatePropagation();
    }
  });

  function release(e) {
    if (!pointers.delete(e.pointerId)) return;
    if (mode === "pinch") {
      if (pointers.size < 2) {
        zoom.endPinch();
        drawZoom(!zoom.active); // slide back smoothly when the pinch ended (almost) unzoomed
        const rest = [...pointers.keys()][0];
        if (zoom.active && rest !== undefined) startPan(rest);
        else mode = "none";
      }
      e.stopImmediatePropagation();
    } else if (mode === "pan" && e.pointerId === panId) {
      const wasTap = e.type === "pointerup" && !panMoved && performance.now() - panStartAt < TAP_MAX_MS;
      mode = "none";
      panId = null;
      if (wasTap && isMobileLayout()) toggleChrome();
      e.stopImmediatePropagation();
    }
  }
  card.addEventListener("pointerup", release);
  card.addEventListener("pointercancel", release);

  card.addEventListener("wheel", (e) => {
    if (!zoomable()) return;
    e.preventDefault();
    const g = zoomGeometry();
    const unit = e.deltaMode === 1 ? 16 : 1;
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0018));
    zoom.zoomAt(factor, { x: e.clientX - g.centre.x, y: e.clientY - g.centre.y }, g.box, g.fit);
    drawZoom();
  }, { passive: false });
}

function setupKeys() {
  window.addEventListener("keydown", (e) => {
    if (screens.app.hasAttribute("hidden")) return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === "Escape" && zoom.active) { zoom.reset(); drawZoom(true); return; }
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
  loadChrome();
  trackDetailHeight();
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
      // Straight from the cache when the file is already here: opening a tab
      // after an await can be blocked as a popup on Safari.
      const entry = mediaEntry(current.id);
      const url = entry.url || (await entry.promise).url;
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

  setupZoom();
  dragApi = setupDrag();
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
    btn.innerHTML = FOLDER_ICON + `<span class="name">${escapeHtml(recent.name || recent.id)}</span>`;
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
      item.innerHTML = FOLDER_ICON + `<span class="name">${escapeHtml(f.name)}</span>` +
        (f.owner ? `<span class="owner">${escapeHtml(f.owner)}</span>` : "");
      item.addEventListener("click", () => openFolder(f.id, f.name));
      listEl.appendChild(item);
    }
  } catch (e) {
    if (call !== folderListCall) return;
    statusEl.textContent = "Impossible de lister les dossiers (" + e.message + "). Utilise le lien direct ci-dessous.";
  }
}

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

window.addEventListener("DOMContentLoaded", init);
