// Progress ("kept" files) lives in one small file per device, inside this
// folder. STATE_FILENAME is the older single shared file: still read (so
// earlier progress isn't lost) but never written again.
export const KEPT_DIRNAME = ".photosorter_kept";
const KEPT_FILE_PREFIX = "k_";
const STATE_FILENAME = ".photosorter_state.json";
export const PRESENCE_DIRNAME = ".photosorter_presence";
const LEGACY_PRESENCE_FILENAME = ".photosorter_presence.json";
const TRASH_DIRNAME = "_trash";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const IMAGE_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
  ".avif", ".svg", ".jfif", ".ico", ".heic", ".heif",
]);
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".m4v", ".3gp",
  ".flv", ".mpg", ".mpeg", ".m2ts", ".mts", ".ogv",
]);
const AUDIO_EXT = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma", ".opus", ".aiff",
]);
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".xml",
  ".yaml", ".yml", ".ini", ".cfg", ".conf", ".html", ".htm", ".css",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".c", ".h", ".cpp",
  ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".ps1", ".sql",
  ".toml", ".nfo", ".srt", ".vtt",
]);
const KIND_ORDER = ["image", "video", "audio", "pdf", "text", "other"];

// Cap on simultaneous Drive API requests while scanning subfolders. Fully
// unbounded parallelism can trip Google's automated-traffic protection on
// folders with many subfolders (which blocks the account for a while).
const SCAN_CONCURRENCY = 5;

// Accepts are batched into one save after this quiet period instead of
// re-uploading the progress file on every single swipe.
const SAVE_DEBOUNCE_MS = 1500;
const SAVE_DEBOUNCE_MAX_MS = 15000;
const SAVE_RETRY_MAX_MS = 30000;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// A pending save must never keep a Node process alive (tests, tooling).
// Browsers return a plain number from setTimeout, which has no unref.
function backgroundTimeout(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Ensures exactly one child with this name exists under parentId and returns
// its id. Two separate sessions can both look, both find nothing, and both
// create it (Drive allows duplicate names in one folder). Re-looking after
// creating and deterministically picking the same winner (lowest id) makes
// everyone converge on one instead of each silently using their own copy.
export async function ensureNamedChild(drive, parentId, name, createFn) {
  let found = await drive.findChildren(parentId, name);
  if (found.length === 0) {
    const created = await createFn();
    found = await drive.findChildren(parentId, name);
    if (found.length === 0) return created.id; // the listing lagged behind our own write
  }
  return [...found].sort(byId)[0].id;
}

// Which session owns a file must not depend on anything that can differ
// between two sessions' views of the folder. The previous scheme (position in
// the sorted file list) shifted for every later file as soon as one session
// had trashed a file the other still saw, giving duplicates and forgotten
// files. A hash of the file's own Drive id is the same for everyone. The
// avalanche step matters: a plain string hash of sequential names produces an
// arithmetic progression that can land entirely on one owner for small n.
export function stableHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function ownerIndex(fileId, sessionCount) {
  return stableHash(fileId) % sessionCount;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function classify(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if (TEXT_EXT.has(ext)) return "text";
  return "other";
}

export function humanSize(n) {
  let size = Number(n) || 0;
  const units = ["o", "Ko", "Mo", "Go", "To"];
  for (let i = 0; i < units.length; i++) {
    if (size < 1024 || units[i] === "To") {
      return units[i] === "o" ? `${Math.round(size)} o` : `${size.toFixed(1)} ${units[i]}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)} To`;
}

// The reason a move failed, in words a person can act on.
function describeMoveError(error) {
  if (error && error.status === 403) return "droits insuffisants sur ce fichier";
  if (error && error.status === 404) return "fichier introuvable";
  return (error && error.message) || "erreur inconnue";
}

export class DriveSorter {
  // deviceId names this device's own progress file (see identity.js).
  constructor(drive, { saveDebounceMs = SAVE_DEBOUNCE_MS, deviceId = "device" } = {}) {
    this.drive = drive;
    this._saveDebounceMs = saveDebounceMs;
    this._keptFileName = `${KEPT_FILE_PREFIX}${deviceId}.json`;
    // (message) => void - a background failure the user should hear about
    // (a move that failed after we'd already shown the next card, a save
    // that keeps failing).
    this.onError = null;
    this._resetFolderState();
  }

  _resetFolderState() {
    this.rootId = null;
    this.rootName = "";
    this.allFiles = []; // { id, name, mimeType, size, parentId, rel, kind }
    this._knownIds = new Set();
    this.queue = [];
    this.index = 0;
    // Relative paths of files kept. Split by who wrote them: this device's own
    // decisions (the only thing it ever writes) and everyone else's (read-only).
    this._myKept = new Set();
    this._othersKept = new Set();
    this._keptSize = 0;
    this.history = [];
    this.totalFound = 0;
    this.activeFilters = new Set();
    this.trashedCount = 0;
    this.keptFolderId = null;
    this.keptFileId = null;
    this.trashFolderCache = new Map(); // parentId -> Promise<trash folder id>
    this.trashNamesCache = new Map(); // trashFolderId -> Promise<Set<name>>
    // Files this session moved to trash (moves may still be in flight). They
    // must never come back into the queue, whether or not a later Drive
    // listing has caught up with the move.
    this._rejectedIds = new Set();
    this._pendingMoves = new Set();
    // Files whose move to trash failed and were not dealt with afterwards:
    // the person must be able to see that something did not go through.
    this._failedIds = new Set();
    this._saveDirty = false;
    this._saveTimer = null;
    this._saveChain = Promise.resolve();
    this._saveFailures = 0;
    // Multi-user splitting: when several sessions sort the same folder each
    // pending file has exactly one owner (see _isMine).
    this.mySessionId = null;
    this.activeSessions = []; // sorted session ids
    this._myRank = -1;
  }

  // ---------- scanning ----------

  // Walks the folder tree once, collecting real files and counting trashed
  // ones in the same pass; sibling subfolders are listed in parallel (capped).
  async _scanWithTrash(rootId) {
    const files = [];
    const countRecursive = async (folderId) => {
      const children = await this.drive.listChildren(folderId);
      const counts = await mapWithConcurrency(children, SCAN_CONCURRENCY, (c) =>
        c.mimeType === FOLDER_MIME ? countRecursive(c.id) : Promise.resolve(1)
      );
      return counts.reduce((a, b) => a + b, 0);
    };
    // Returns the trash count found in this subtree. Branches push their own
    // files into the shared array (safe: a push is never split across an
    // await) and return their own count, summed after all settle - a shared
    // `total += await ...` would lose updates, since each branch reads the
    // old total before its own await resolves.
    const walk = async (folderId, relPrefix) => {
      const children = await this.drive.listChildren(folderId);
      const trashCounts = await mapWithConcurrency(children, SCAN_CONCURRENCY, async (child) => {
        if (child.mimeType === FOLDER_MIME) {
          if (child.name === TRASH_DIRNAME) return countRecursive(child.id);
          if (child.name === PRESENCE_DIRNAME || child.name === KEPT_DIRNAME) return 0;
          return walk(child.id, relPrefix + child.name + "/");
        }
        if (child.name === STATE_FILENAME || child.name === LEGACY_PRESENCE_FILENAME) return 0;
        files.push({
          id: child.id,
          name: child.name,
          mimeType: child.mimeType,
          size: Number(child.size || 0),
          parentId: folderId,
          rel: relPrefix + child.name,
          kind: classify(child.name),
        });
        return 0;
      });
      return trashCounts.reduce((a, b) => a + b, 0);
    };
    const trashedCount = await walk(rootId, "");
    files.sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));
    return { files: files.filter((f) => !this._rejectedIds.has(f.id)), trashedCount };
  }

  _setAllFiles(files) {
    this.allFiles = files;
    this._knownIds = new Set(files.map((f) => f.id));
  }

  knowsFile(id) {
    return this._knownIds.has(id);
  }

  // ---------- progress ("kept") files ----------
  //
  // One file per device, only ever written by that device, so two people
  // saving at the same moment cannot overwrite each other (an earlier design
  // that merged into one shared file still lost updates whenever two saves
  // overlapped). Everyone reads all the files and takes the union.

  // An entry is either "id:<Drive file id>" (written now: two files can share
  // a name in one folder - Drive allows it - so a name can't identify one) or
  // a plain relative path (written by earlier versions, still honoured so
  // existing progress isn't lost).
  get kept() {
    return new Set([...this._othersKept, ...this._myKept]);
  }

  _keptKey(f) {
    return `id:${f.id}`;
  }

  isKept(f) {
    const key = this._keptKey(f);
    return this._myKept.has(key) || this._othersKept.has(key) || this._myKept.has(f.rel) || this._othersKept.has(f.rel);
  }

  _recountKept() {
    let n = this._myKept.size;
    for (const rel of this._othersKept) if (!this._myKept.has(rel)) n++;
    this._keptSize = n;
  }

  async _readKeptFile(fileId) {
    let text;
    try {
      text = await this.drive.readTextFile(fileId);
    } catch (e) {
      // Gone since we listed it: contributes nothing. Any other error must
      // propagate - reading nothing on a network failure would look like
      // "nothing kept yet" and let decided files come back.
      if (e.status === 404) return new Set();
      throw e;
    }
    try {
      const data = JSON.parse(text);
      return new Set(Array.isArray(data.kept) ? data.kept : []);
    } catch {
      return new Set(); // unreadable content: treat as empty
    }
  }

  // Reads every progress file for this folder. Duplicated folders/files (two
  // sessions creating them at once) are all read; writes target the lowest id.
  async _loadKeptAll(rootId) {
    const [folders, legacy] = await Promise.all([
      this.drive.findChildren(rootId, KEPT_DIRNAME),
      this.drive.findChildren(rootId, STATE_FILENAME),
    ]);
    const keptFolders = folders.filter((f) => f.mimeType === FOLDER_MIME).sort(byId);
    const inFolders = (await Promise.all(keptFolders.map((f) => this.drive.listChildren(f.id)))).flat();
    const mine = inFolders.filter((f) => f.name === this._keptFileName).sort(byId);
    const myFile = mine[0] || null;
    const otherFiles = [...inFolders.filter((f) => f !== myFile), ...legacy.filter((f) => f.mimeType !== FOLDER_MIME)];
    const [myKept, ...otherSets] = await Promise.all([
      myFile ? this._readKeptFile(myFile.id) : Promise.resolve(new Set()),
      ...otherFiles.map((f) => this._readKeptFile(f.id)),
    ]);
    const others = new Set();
    for (const set of otherSets) for (const rel of set) others.add(rel);
    return {
      folderId: keptFolders[0]?.id ?? null,
      myFileId: myFile?.id ?? null,
      mine: myKept,
      others,
      allFileIds: [myFile?.id, ...otherFiles.map((f) => f.id)].filter(Boolean),
    };
  }

  // The file is re-uploaded whole on every save and grows with every
  // decision (thousands of entries by the end of a long session), so the wait
  // between saves stretches as it grows. Pending decisions are still written
  // at once when the page is hidden/closed or the folder is left.
  _debounceMs() {
    return Math.min(Math.max(SAVE_DEBOUNCE_MAX_MS, this._saveDebounceMs), this._saveDebounceMs + this._myKept.size * 4);
  }

  _markDirty() {
    this._saveDirty = true;
    if (!this._saveTimer) this._saveTimer = backgroundTimeout(() => this._queueSave(), this._debounceMs());
  }

  _queueSave() {
    this._saveTimer = null;
    this._saveChain = this._saveChain.then(() => this._saveOnce()).catch(() => {});
    return this._saveChain;
  }

  // Saves everything pending now and resolves once it's persisted (or has
  // failed and been rescheduled). Call before anything that reads progress
  // back, and when the page is being hidden.
  flushSaves() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    return this._queueSave();
  }

  async _saveOnce() {
    if (!this._saveDirty || !this.rootId) return;
    const rootId = this.rootId;
    this._saveDirty = false;
    try {
      const payload = JSON.stringify({ kept: [...this._myKept].sort() });
      let createdId = null;
      if (!this.keptFileId) {
        if (!this.keptFolderId) {
          this.keptFolderId = await ensureNamedChild(this.drive, rootId, KEPT_DIRNAME, () =>
            this.drive.createFolder(KEPT_DIRNAME, rootId)
          );
        }
        const folderId = this.keptFolderId;
        this.keptFileId = await ensureNamedChild(this.drive, folderId, this._keptFileName, async () => {
          const created = await this.drive.createTextFile(this._keptFileName, folderId, payload);
          createdId = created.id;
          return created;
        });
      }
      // A file we just created already holds this content.
      if (this.keptFileId !== createdId) await this.drive.writeTextFile(this.keptFileId, payload);
      this._saveFailures = 0;
    } catch (e) {
      this._saveDirty = true;
      this._saveFailures++;
      if (this._saveFailures === 3) {
        this.onError?.("Sauvegarde de la progression impossible pour l'instant - nouvel essai automatique...");
      }
      if (!this._saveTimer) {
        const delay = Math.min(SAVE_RETRY_MAX_MS, this._saveDebounceMs * 2 ** this._saveFailures);
        this._saveTimer = backgroundTimeout(() => this._queueSave(), delay);
      }
    }
  }

  // ---------- filtering & multi-user split ----------

  // Kinds worth offering as a filter: only ones with something left to
  // decide. A kind everyone has finished (kept, or rejected by this session
  // before the next scan removes it from allFiles entirely) drops off the
  // filter bar on its own instead of lingering as a pill that filters down
  // to nothing.
  _availableKinds() {
    const kinds = new Set(
      this.allFiles.filter((f) => !this.isKept(f) && !this._rejectedIds.has(f.id)).map((f) => f.kind)
    );
    return KIND_ORDER.filter((k) => kinds.has(k));
  }

  _isMine(f) {
    const n = this.activeSessions.length;
    if (n <= 1 || this._myRank < 0) return true;
    return ownerIndex(f.id, n) === this._myRank;
  }

  _applyFilter() {
    // A filter kept selected past the point where it matches anything
    // (finished from under it, e.g. by another session) is dropped rather
    // than left silently filtering the queue down to nothing.
    const remaining = new Set(this._availableKinds());
    for (const kind of this.activeFilters) if (!remaining.has(kind)) this.activeFilters.delete(kind);
    let filtered = this.activeFilters.size === 0
      ? this.allFiles
      : this.allFiles.filter((f) => this.activeFilters.has(f.kind));
    filtered = filtered.filter((f) => this._isMine(f));
    this.totalFound = filtered.length;
    this.queue = filtered.filter((f) => !this.isKept(f) && !this._rejectedIds.has(f.id));
    this.index = 0;
  }

  // Re-splits the pending files between the sessions currently sorting. Works
  // on whatever this sorter currently knows - call refresh() first when other
  // sessions may have decided files since our last scan.
  setPresence(mySessionId, activeSessionIds) {
    this.activeSessions = [...new Set([...activeSessionIds, mySessionId])].sort();
    this.mySessionId = mySessionId;
    this._myRank = this.activeSessions.indexOf(mySessionId);
    if (this.rootId) {
      this.history = [];
      this._applyFilter();
    }
  }

  // ---------- loading ----------

  async _settlePendingMoves() {
    await Promise.allSettled([...this._pendingMoves]);
  }

  // Re-reads what other sessions decided (their progress files + what's been
  // moved to trash) so a reassignment doesn't hand anyone a file that's
  // already been dealt with. Our own decisions are the source of truth for
  // our own file (flushed first, never replaced from disk), and our in-flight
  // moves are awaited so a file we just trashed can't reappear from a scan
  // taken mid-move.
  async refresh() {
    if (!this.rootId) return;
    const rootId = this.rootId;
    await this.flushSaves();
    await this._settlePendingMoves();
    const loaded = await this._loadKeptAll(rootId);
    const { files, trashedCount } = await this._scanWithTrash(rootId);
    if (this.rootId !== rootId) return; // the folder changed while we were scanning
    this._othersKept = loaded.others;
    this._recountKept();
    this._setAllFiles(files);
    this.trashedCount = trashedCount;
  }

  // Same cost as refresh(), but only reports what's new without touching our
  // state - lets the UI announce new files before pulling them in.
  async peekNewFileIds() {
    if (!this.rootId) return [];
    const rootId = this.rootId;
    const { files } = await this._scanWithTrash(rootId);
    if (this.rootId !== rootId) return [];
    return files.filter((f) => !this._knownIds.has(f.id)).map((f) => f.id);
  }

  async loadFolder(folderId, folderName) {
    await this.flushSaves(); // progress of the folder we are leaving
    // Everything is read before anything is replaced, so a failed load leaves
    // the previous state untouched instead of a half-initialised sorter.
    const loaded = await this._loadKeptAll(folderId);
    const { files, trashedCount } = await this._scanWithTrash(folderId);
    this._resetFolderState();
    this.rootId = folderId;
    this.rootName = folderName || folderId;
    this.keptFolderId = loaded.folderId;
    this.keptFileId = loaded.myFileId;
    this._myKept = loaded.mine;
    this._othersKept = loaded.others;
    this._recountKept();
    this._setAllFiles(files);
    this.trashedCount = trashedCount;
    this._applyFilter();
    return this.current();
  }

  async setFilters(kinds) {
    if (!this.rootId) return this.current();
    this.activeFilters = new Set(kinds);
    this.history = [];
    this._applyFilter();
    return this.current();
  }

  async resetProgress() {
    if (!this.rootId) return this.current();
    const rootId = this.rootId;
    await this.flushSaves();
    await this._settlePendingMoves();
    this._saveDirty = false;
    // Clear every progress file, everyone's included: that's the point of
    // "start over". (Another device still holding its old decisions in
    // memory will write them back the next time it saves - starting over is
    // meant for when you are sorting alone.)
    const loaded = await this._loadKeptAll(rootId);
    await Promise.all(loaded.allFileIds.map((id) => this.drive.writeTextFile(id, JSON.stringify({ kept: [] }))));
    this._myKept = new Set();
    this._othersKept = new Set();
    this._recountKept();
    this.keptFolderId = loaded.folderId;
    this.keptFileId = loaded.myFileId;
    const { files, trashedCount } = await this._scanWithTrash(rootId);
    this._setAllFiles(files);
    this.trashedCount = trashedCount;
    this.history = [];
    this._applyFilter();
    return this.current();
  }

  // ---------- reading the queue ----------

  _status() {
    return {
      rootName: this.rootName,
      remaining: Math.max(this.queue.length - this.index, 0),
      kept: this._keptSize,
      reviewed: this.index,
      total: this.totalFound,
      trashed: this.trashedCount,
      canUndo: this.history.length > 0,
      availableKinds: this._availableKinds(),
      activeFilters: Array.from(this.activeFilters),
      peopleCount: this.activeSessions.length,
      failedMoves: this._failedIds.size,
    };
  }

  _fileInfo(f) {
    return {
      done: false,
      id: f.id,
      rel: f.rel,
      name: f.name,
      ext: extOf(f.name),
      kind: f.kind,
      size: f.size,
      sizeH: humanSize(f.size),
      mimeType: f.mimeType,
      ...this._status(),
    };
  }

  async current() {
    if (!this.rootId) return { done: true, ...this._status() };
    // Reaching the end of a filtered view (e.g. every image decided) isn't
    // the folder being done if other kinds still have files - drop the
    // filter and carry on into them instead of stopping here. A real "done"
    // only happens with no filter active and truly nothing left.
    if (this.index >= this.queue.length && this.activeFilters.size > 0 && this._availableKinds().length > 0) {
      this.history = [];
      this.activeFilters.clear();
      this._applyFilter();
    }
    if (this.index >= this.queue.length) return { done: true, ...this._status() };
    return this._fileInfo(this.queue[this.index]);
  }

  // Lightweight lookahead used to prefetch several files ahead and to draw the
  // card underneath the current one (so it carries what that card displays).
  upcoming(n) {
    if (!this.rootId) return [];
    const end = Math.min(this.index + 1 + n, this.queue.length);
    return this.queue.slice(this.index + 1, end).map((f) => ({
      id: f.id,
      kind: f.kind,
      name: f.name,
      ext: extOf(f.name),
      sizeH: humanSize(f.size),
    }));
  }

  // ---------- decisions ----------

  async accept() {
    if (!this.rootId || this.index >= this.queue.length) return this.current();
    const f = this.queue[this.index];
    this._failedIds.delete(f.id);
    const key = this._keptKey(f);
    this._myKept.add(key);
    this._recountKept();
    this._markDirty();
    this.history.push({ type: "accept", key });
    this.index += 1;
    return this.current();
  }

  async skipNow() {
    if (!this.rootId || this.index >= this.queue.length) return this.current();
    const [item] = this.queue.splice(this.index, 1);
    this.queue.push(item);
    this.history.push({ type: "skip" });
    return this.current();
  }

  // Caches the in-flight promise (not just the resolved id) so two rejects in
  // the same brand-new folder share one creation instead of racing to make
  // two "_trash" folders.
  _getOrCreateTrashFolder(parentId) {
    if (!this.trashFolderCache.has(parentId)) {
      this.trashFolderCache.set(parentId, ensureNamedChild(
        this.drive, parentId, TRASH_DIRNAME,
        () => this.drive.createFolder(TRASH_DIRNAME, parentId)
      ));
    }
    return this.trashFolderCache.get(parentId);
  }

  // Lists a trash folder once and tracks additions ourselves afterwards.
  // Names only need to stay distinct for readability (Drive allows
  // duplicates), so this is best-effort rather than a lock.
  async _uniqueNameIn(folderId, name) {
    if (!this.trashNamesCache.has(folderId)) {
      this.trashNamesCache.set(folderId, this.drive.listChildren(folderId).then(
        (children) => new Set(children.map((c) => c.name))
      ));
    }
    const existing = await this.trashNamesCache.get(folderId);
    let finalName = name;
    if (existing.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 1;
      while (existing.has(`${stem} (${n})${ext}`)) n += 1;
      finalName = `${stem} (${n})${ext}`;
    }
    existing.add(finalName);
    return finalName;
  }

  async _moveToTrash(f, action) {
    const trashId = await this._getOrCreateTrashFolder(f.parentId);
    const finalName = await this._uniqueNameIn(trashId, f.name);
    if (finalName !== f.name) await this.drive.renameFile(f.id, finalName);
    const moved = await this.drive.moveFile(f.id, f.parentId, trashId);
    // Trust Drive's answer about where the file is now, not just the absence
    // of an error: a reply that doesn't list the trash folder is not a move.
    if (moved && Array.isArray(moved.parents) && !moved.parents.includes(trashId)) {
      throw new Error("Drive n'a pas confirme le deplacement");
    }
    action.toParentId = trashId;
    action.finalName = finalName;
  }

  // A failed move is either a real failure, or someone else already trashed
  // this very file (two sessions can briefly overlap right after a
  // reassignment). The second case is not an error worth alarming anyone about.
  async _handleMoveFailure(f, action, error) {
    let alreadyGone = false;
    try {
      const meta = await this.drive.getFileMeta(f.id);
      alreadyGone = !!meta.trashed || !(meta.parents || []).includes(f.parentId);
    } catch {
      // can't tell - treat it as a real failure
    }
    this.trashedCount = Math.max(this.trashedCount - 1, 0);
    if (alreadyGone) {
      action.alreadyGone = true;
      return;
    }
    action.failed = true;
    this._rejectedIds.delete(f.id);
    this._failedIds.add(f.id);
    this.onError?.(`Un fichier n'a pas pu etre mis dans _trash (${describeMoveError(error)}). Il reste dans le dossier.`);
  }

  // Advances to the next card immediately and moves the file in the
  // background. If the move fails we can't roll back an index the user has
  // likely moved past, so the failure is reported through onError instead.
  // undo() and refresh() wait for the move, so neither can run before we
  // know whether it actually happened.
  async reject() {
    if (!this.rootId || this.index >= this.queue.length) return this.current();
    const f = this.queue[this.index];
    this._failedIds.delete(f.id); // trying again: judged by this attempt
    const action = { type: "reject", rel: f.rel, fileId: f.id, fromParentId: f.parentId, originalName: f.name };
    this._rejectedIds.add(f.id);
    const pending = this._moveToTrash(f, action).catch((e) => this._handleMoveFailure(f, action, e));
    this._pendingMoves.add(pending);
    pending.finally(() => this._pendingMoves.delete(pending));
    action.pending = pending;
    this.history.push(action);
    this.trashedCount += 1;
    this.index += 1;
    return this.current();
  }

  async undo() {
    if (!this.history.length) return this.current();
    const action = this.history.pop();
    if (action.type === "accept") {
      if (this.index > 0) this.index -= 1;
      this._myKept.delete(action.key);
      this._recountKept();
      this._markDirty();
    } else if (action.type === "reject") {
      if (this.index > 0) this.index -= 1;
      if (action.pending) await action.pending; // know whether the move really happened
      if (action.failed || action.alreadyGone) {
        // Never moved by us (and the count was already corrected): nothing to reverse.
      } else {
        try {
          await this.drive.moveFile(action.fileId, action.toParentId, action.fromParentId);
          if (action.finalName !== action.originalName) {
            await this.drive.renameFile(action.fileId, action.originalName);
          }
          this._rejectedIds.delete(action.fileId);
          this.trashedCount = Math.max(this.trashedCount - 1, 0);
          const names = this.trashNamesCache.get(action.toParentId);
          if (names) (await names).delete(action.finalName);
        } catch (e) {
          this.onError?.(`Impossible de restaurer "${action.originalName}" : ${e.message}`);
        }
      }
    } else if (action.type === "skip") {
      const item = this.queue.pop();
      if (item) this.queue.splice(this.index, 0, item);
    }
    return this.current();
  }
}
