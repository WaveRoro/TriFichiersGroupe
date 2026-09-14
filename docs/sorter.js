const STATE_FILENAME = ".photosorter_state.json";
export const PRESENCE_FILENAME = ".photosorter_presence.json";
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
// unbounded parallelism (one request per subfolder, all at once) can trip
// Google's automated-traffic protection on folders with many subfolders,
// which then blocks the account for a while - this keeps most of the speed
// gain from scanning in parallel without bursting that hard.
const SCAN_CONCURRENCY = 5;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Ensures exactly one child with this name exists under parentId, returning
// its id. Two SEPARATE browser sessions (different devices/tabs, not just
// concurrent calls within our own code) can both check "does it exist?",
// both get "no", and both create one - Drive allows duplicate filenames in
// one folder, so this isn't hypothetical. When that happens, every session
// must converge on using the exact same file or they'll each silently work
// off their own isolated copy forever (which is exactly what broke presence
// across two real devices during testing). Re-listing after creating and
// deterministically picking the same winner (lowest id) - regardless of
// which session is asking - makes that converge instead.
export async function ensureNamedChild(drive, parentId, name, createFn) {
  let children = await drive.listChildren(parentId);
  let candidates = children.filter((c) => c.name === name);
  if (candidates.length === 0) {
    const created = await createFn();
    children = await drive.listChildren(parentId);
    candidates = children.filter((c) => c.name === name);
    if (candidates.length === 0) return created.id; // listing lagged behind our own write - fall back to it
  }
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates[0].id;
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

export class DriveSorter {
  constructor(drive) {
    this.drive = drive;
    this.rootId = null;
    this.rootName = "";
    this.allFiles = []; // { id, name, mimeType, size, parents, rel, kind }
    this._relIndex = new Map(); // rel -> position in allFiles, for multi-user splitting
    this.queue = [];
    this.index = 0;
    this.kept = new Set();
    this.history = [];
    this.totalFound = 0;
    this.activeFilters = new Set();
    this.trashedCount = 0;
    this.stateFileId = null;
    this.trashFolderCache = new Map(); // parentId -> trash folder id
    this.trashNamesCache = new Map(); // trashFolderId -> Set<name currently in it>
    // Chain of pending state-file writes, so accept() can save progress in
    // the background (without blocking the UI on the round trip) while
    // still guaranteeing writes land in order - awaiting each one directly
    // would let a slow write finish after a later, newer one and clobber it.
    this.saveQueue = Promise.resolve();
    // Optional callback: (message) => void, called when a background reject
    // (the actual file move) fails after we've already moved on to the next
    // card - set by the UI to surface it (e.g. as a toast).
    this.onError = null;
    // Multi-user work splitting: when more than one session is active on
    // this folder, each pending file is assigned to exactly one of them
    // (see _applyFilter) so everyone works through a different slice
    // instead of all seeing the same files in the same order.
    this.mySessionId = null;
    this.activeSessions = []; // sorted session ids, set via setPresence()
  }

  // Walks the whole folder tree once, collecting real files and counting
  // trashed ones in the same pass (instead of two separate full walks), and
  // queries sibling subfolders in parallel instead of one at a time - both
  // used to make loading a folder noticeably slower than it needs to be.
  async _scanWithTrash(rootId) {
    const files = [];
    const countRecursive = async (folderId) => {
      const children = await this.drive.listChildren(folderId);
      const counts = await mapWithConcurrency(children, SCAN_CONCURRENCY, (c) =>
        c.mimeType === FOLDER_MIME ? countRecursive(c.id) : Promise.resolve(1)
      );
      return counts.reduce((a, b) => a + b, 0);
    };
    // Returns the trash count found within this subtree. Each branch adds
    // its own file(s) to the shared `files` array (safe: push is never split
    // across an await) and returns its own count, summed once via reduce
    // after all branches settle - summing through a shared `total += await
    // ...` instead would lose updates, since each branch reads the old total
    // before its own await resolves.
    const walk = async (folderId, relPrefix) => {
      const children = await this.drive.listChildren(folderId);
      const trashCounts = await mapWithConcurrency(children, SCAN_CONCURRENCY, async (child) => {
        if (child.mimeType === FOLDER_MIME) {
          if (child.name === TRASH_DIRNAME) return countRecursive(child.id);
          return walk(child.id, relPrefix + child.name + "/");
        }
        if (child.name === STATE_FILENAME || child.name === PRESENCE_FILENAME) return 0;
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
    return { files, trashedCount };
  }

  async _loadState(rootId) {
    const children = await this.drive.listChildren(rootId);
    // Same convergence rule as ensureNamedChild (lowest id wins) applied to
    // reading, so if duplicates ever exist every session still agrees on
    // the same one instead of `.find()` picking whichever Drive happened to
    // list first.
    const candidates = children
      .filter((c) => c.name === STATE_FILENAME)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (candidates.length === 0) {
      this.stateFileId = null;
      return new Set();
    }
    this.stateFileId = candidates[0].id;
    try {
      const text = await this.drive.readTextFile(this.stateFileId);
      const data = JSON.parse(text);
      return new Set(Array.isArray(data.kept) ? data.kept : []);
    } catch {
      return new Set();
    }
  }

  async _saveState() {
    const payload = JSON.stringify({ kept: Array.from(this.kept).sort() });
    if (!this.stateFileId) {
      this.stateFileId = await ensureNamedChild(
        this.drive, this.rootId, STATE_FILENAME,
        () => this.drive.createTextFile(STATE_FILENAME, this.rootId, payload)
      );
    }
    await this.drive.writeTextFile(this.stateFileId, payload);
  }

  _availableKinds() {
    const kinds = new Set(this.allFiles.map((f) => f.kind));
    return KIND_ORDER.filter((k) => kinds.has(k));
  }

  _setAllFiles(files) {
    this.allFiles = files;
    this._relIndex = new Map(files.map((f, i) => [f.rel, i]));
  }

  // True if this file falls in my slice of the folder when several sessions
  // are sorting it at once. Uses the file's own fixed position in allFiles
  // (round-robin: file 0 -> rank 0, file 1 -> rank 1, ... wrapping around)
  // rather than a hash of its name - a hash only balances on average and
  // can land noticeably lopsided by chance (measured 11/11/18 across 3
  // people on one real test run), while position-based round-robin divides
  // the folder equally to within one file, always. allFiles is sorted
  // identically on every client (see _scanWithTrash), and activeSessions is
  // the same sorted list everywhere too, so every client computes the same
  // assignment without needing to compare full file lists with each other.
  _isMine(f) {
    const n = this.activeSessions.length;
    if (n <= 1 || !this.mySessionId) return true;
    const myRank = this.activeSessions.indexOf(this.mySessionId);
    if (myRank < 0) return true; // not registered in the active list yet
    const idx = this._relIndex.get(f.rel);
    return idx % n === myRank;
  }

  _applyFilter() {
    let filtered = this.activeFilters.size === 0
      ? this.allFiles
      : this.allFiles.filter((f) => this.activeFilters.has(f.kind));
    filtered = filtered.filter((f) => this._isMine(f));
    this.totalFound = filtered.length;
    this.queue = filtered.filter((f) => !this.kept.has(f.rel));
    this.index = 0;
  }

  // Re-splits the pending files against whatever is CURRENTLY in this.kept
  // / this.allFiles - it does not itself go check Drive for what other
  // sessions may have done since our own last scan. Fine for the very first
  // split right after loadFolder() (which just scanned), but a real
  // reassignment (someone joining/leaving while sorting is already under
  // way) should call refresh() first - see app.js's presence.onChange -
  // otherwise a file someone else already kept or trashed could resurface
  // for whoever inherits their share.
  setPresence(mySessionId, activeSessionIds) {
    this.mySessionId = mySessionId;
    this.activeSessions = [...activeSessionIds].sort();
    if (this.rootId) {
      this.history = [];
      this._applyFilter();
    }
  }

  // Re-reads the shared kept-list and re-scans the folder for what's been
  // moved to trash, so a reassignment (see setPresence above) reflects
  // whatever other sessions have actually decided since our last look,
  // instead of only knowing about our own decisions.
  async refresh() {
    if (!this.rootId) return;
    this.kept = await this._loadState(this.rootId);
    const { files, trashedCount } = await this._scanWithTrash(this.rootId);
    this._setAllFiles(files);
    this.trashedCount = trashedCount;
  }

  // Does a full rescan (same cost as refresh()) just to check whether any
  // file exists on Drive that we don't already know about, without
  // touching our own state - lets the UI ask "is there anything new?" and
  // only actually pull it in (via refresh()) once the user agrees to it.
  async peekNewFileIds() {
    if (!this.rootId) return [];
    const { files } = await this._scanWithTrash(this.rootId);
    const currentIds = new Set(this.allFiles.map((f) => f.id));
    return files.filter((f) => !currentIds.has(f.id)).map((f) => f.id);
  }

  async loadFolder(folderId, folderName) {
    this.rootId = folderId;
    this.rootName = folderName || folderId;
    this.mySessionId = null;
    this.activeSessions = [];
    this.kept = await this._loadState(folderId);
    const { files, trashedCount } = await this._scanWithTrash(folderId);
    this._setAllFiles(files);
    this.trashedCount = trashedCount;
    this.activeFilters = new Set();
    this.history = [];
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
    this.kept = new Set();
    if (this.stateFileId) {
      try {
        await this.drive.writeTextFile(this.stateFileId, JSON.stringify({ kept: [] }));
      } catch {
        // ignore
      }
    }
    const { files, trashedCount } = await this._scanWithTrash(this.rootId);
    this._setAllFiles(files);
    this.trashedCount = trashedCount;
    this.history = [];
    this._applyFilter();
    return this.current();
  }

  _status() {
    const remaining = Math.max(this.queue.length - this.index, 0);
    return {
      rootName: this.rootName,
      remaining,
      kept: this.kept.size,
      reviewed: this.index,
      total: this.totalFound,
      trashed: this.trashedCount,
      canUndo: this.history.length > 0,
      availableKinds: this._availableKinds(),
      activeFilters: Array.from(this.activeFilters),
      peopleCount: this.activeSessions.length,
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
      ...this._status(),
    };
  }

  async current() {
    if (!this.rootId) return { done: true, ...this._status() };
    if (this.index >= this.queue.length) return { done: true, ...this._status() };
    return this._fileInfo(this.queue[this.index]);
  }

  async peekNext() {
    if (!this.rootId) return { done: true };
    const i = this.index + 1;
    if (i >= this.queue.length) return { done: true };
    return this._fileInfo(this.queue[i]);
  }

  // Lightweight lookahead (id + kind only, no thumbnail/status work) used to
  // prefetch several files ahead instead of just the very next one.
  upcoming(n) {
    if (!this.rootId) return [];
    const end = Math.min(this.index + 1 + n, this.queue.length);
    return this.queue.slice(this.index + 1, end).map((f) => ({ id: f.id, kind: f.kind }));
  }

  async accept() {
    if (!this.rootId || this.index >= this.queue.length) return this.current();
    const f = this.queue[this.index];
    this.kept.add(f.rel);
    // Save in the background - the next card doesn't need to wait on this
    // network round trip, and saveQueue keeps writes landing in order.
    this.saveQueue = this.saveQueue.then(() => this._saveState()).catch(() => {});
    this.history.push({ type: "accept", rel: f.rel });
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

  // Caches the in-flight promise (not just the resolved id) so that two
  // rejects landing in the same brand-new parent folder before either has
  // finished share one creation instead of racing to create two "_trash"
  // folders.
  _getOrCreateTrashFolder(parentId) {
    if (!this.trashFolderCache.has(parentId)) {
      this.trashFolderCache.set(parentId, ensureNamedChild(
        this.drive, parentId, TRASH_DIRNAME,
        () => this.drive.createFolder(TRASH_DIRNAME, parentId)
      ));
    }
    return this.trashFolderCache.get(parentId);
  }

  // Only lists the folder's contents once per session (the first time a
  // file gets rejected into it) and tracks additions ourselves after that -
  // re-listing before every single reject added a full round trip to every
  // "refuser" click for no reason, since we already know what we put there.
  // Same in-flight-promise caching as above, for the same reason.
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
    await this.drive.moveFile(f.id, f.parentId, trashId);
    action.toParentId = trashId;
    action.finalName = finalName;
  }

  // Advances to the next card immediately and moves the file in the
  // background, instead of blocking every "refuser" on the move completing -
  // that round trip was the main remaining delay after accept() was made
  // non-blocking. If the move fails, we can't cleanly roll back an index the
  // user has likely already moved past, so we just surface the error via
  // onError instead. undo() awaits action.pending, so it can't run before
  // we know whether the move actually happened.
  async reject() {
    if (!this.rootId || this.index >= this.queue.length) return this.current();
    const f = this.queue[this.index];
    const action = { type: "reject", rel: f.rel, fileId: f.id, fromParentId: f.parentId, originalName: f.name };
    action.pending = this._moveToTrash(f, action).catch((e) => {
      action.failed = true;
      this.trashedCount = Math.max(this.trashedCount - 1, 0);
      if (this.onError) this.onError(`Impossible de deplacer "${f.name}" : ${e.message}`);
    });
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
      this.kept.delete(action.rel);
      await (this.saveQueue = this.saveQueue.then(() => this._saveState()));
    } else if (action.type === "reject") {
      if (this.index > 0) this.index -= 1;
      if (action.pending) await action.pending; // wait until we know if the move actually happened
      if (action.failed) {
        // Never actually moved (and trashedCount was already corrected there) - nothing to undo.
      } else {
        try {
          await this.drive.moveFile(action.fileId, action.toParentId, action.fromParentId);
          if (action.finalName !== action.originalName) {
            await this.drive.renameFile(action.fileId, action.originalName);
          }
          this.trashedCount = Math.max(this.trashedCount - 1, 0);
          const namesPromise = this.trashNamesCache.get(action.toParentId);
          if (namesPromise) (await namesPromise).delete(action.finalName);
        } catch {
          // ignore
        }
      }
    } else if (action.type === "skip") {
      const item = this.queue.pop();
      if (item) this.queue.splice(this.index, 0, item);
    }
    return this.current();
  }
}
