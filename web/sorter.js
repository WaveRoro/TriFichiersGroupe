const STATE_FILENAME = ".photosorter_state.json";
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
    this.queue = [];
    this.index = 0;
    this.kept = new Set();
    this.history = [];
    this.totalFound = 0;
    this.activeFilters = new Set();
    this.trashedCount = 0;
    this.stateFileId = null;
    this.trashFolderCache = new Map(); // parentId -> trash folder id
  }

  async _scan(rootId) {
    const files = [];
    const walk = async (folderId, relPrefix) => {
      const children = await this.drive.listChildren(folderId);
      for (const child of children) {
        if (child.mimeType === FOLDER_MIME) {
          if (child.name === TRASH_DIRNAME) continue;
          await walk(child.id, relPrefix + child.name + "/");
        } else {
          if (child.name === STATE_FILENAME) continue;
          files.push({
            id: child.id,
            name: child.name,
            mimeType: child.mimeType,
            size: Number(child.size || 0),
            parentId: folderId,
            rel: relPrefix + child.name,
            kind: classify(child.name),
          });
        }
      }
    };
    await walk(rootId, "");
    files.sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));
    return files;
  }

  async _countTrash(rootId) {
    let count = 0;
    const walk = async (folderId) => {
      const children = await this.drive.listChildren(folderId);
      for (const child of children) {
        if (child.mimeType !== FOLDER_MIME) continue;
        if (child.name === TRASH_DIRNAME) {
          count += await this._countRecursive(child.id);
        } else {
          await walk(child.id);
        }
      }
    };
    await walk(rootId);
    return count;
  }

  async _countRecursive(folderId) {
    let count = 0;
    const children = await this.drive.listChildren(folderId);
    for (const child of children) {
      if (child.mimeType === FOLDER_MIME) count += await this._countRecursive(child.id);
      else count += 1;
    }
    return count;
  }

  async _loadState(rootId) {
    const children = await this.drive.listChildren(rootId);
    const stateFile = children.find((c) => c.name === STATE_FILENAME);
    if (!stateFile) {
      this.stateFileId = null;
      return new Set();
    }
    this.stateFileId = stateFile.id;
    try {
      const text = await this.drive.readTextFile(stateFile.id);
      const data = JSON.parse(text);
      return new Set(Array.isArray(data.kept) ? data.kept : []);
    } catch {
      return new Set();
    }
  }

  async _saveState() {
    const payload = JSON.stringify({ kept: Array.from(this.kept).sort() });
    if (this.stateFileId) {
      await this.drive.writeTextFile(this.stateFileId, payload);
    } else {
      const created = await this.drive.createTextFile(STATE_FILENAME, this.rootId, payload);
      this.stateFileId = created.id;
    }
  }

  _availableKinds() {
    const kinds = new Set(this.allFiles.map((f) => f.kind));
    return KIND_ORDER.filter((k) => kinds.has(k));
  }

  _applyFilter() {
    const filtered = this.activeFilters.size === 0
      ? this.allFiles
      : this.allFiles.filter((f) => this.activeFilters.has(f.kind));
    this.totalFound = filtered.length;
    this.queue = filtered.filter((f) => !this.kept.has(f.rel));
    this.index = 0;
  }

  async loadFolder(folderId, folderName) {
    this.rootId = folderId;
    this.rootName = folderName || folderId;
    this.kept = await this._loadState(folderId);
    this.allFiles = await this._scan(folderId);
    this.activeFilters = new Set();
    this.history = [];
    this.trashedCount = await this._countTrash(folderId);
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
    this.allFiles = await this._scan(this.rootId);
    this.history = [];
    this.trashedCount = await this._countTrash(this.rootId);
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
    };
  }

  async _fileInfo(f) {
    const url = await this.drive.mediaUrl(f.id);
    return {
      done: false,
      id: f.id,
      rel: f.rel,
      name: f.name,
      ext: extOf(f.name),
      kind: f.kind,
      size: f.size,
      sizeH: humanSize(f.size),
      url,
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

  async accept() {
    if (!this.rootId || this.index >= this.queue.length) return this.current();
    const f = this.queue[this.index];
    this.kept.add(f.rel);
    await this._saveState();
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

  async _getOrCreateTrashFolder(parentId) {
    if (this.trashFolderCache.has(parentId)) return this.trashFolderCache.get(parentId);
    const children = await this.drive.listChildren(parentId);
    let trash = children.find((c) => c.mimeType === FOLDER_MIME && c.name === TRASH_DIRNAME);
    if (!trash) {
      trash = await this.drive.createFolder(TRASH_DIRNAME, parentId);
    }
    this.trashFolderCache.set(parentId, trash.id);
    return trash.id;
  }

  async _uniqueNameIn(folderId, name) {
    const children = await this.drive.listChildren(folderId);
    const existing = new Set(children.map((c) => c.name));
    if (!existing.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 1;
    while (existing.has(`${stem} (${n})${ext}`)) n += 1;
    return `${stem} (${n})${ext}`;
  }

  async reject() {
    if (!this.rootId || this.index >= this.queue.length) return this.current();
    const f = this.queue[this.index];
    try {
      const trashId = await this._getOrCreateTrashFolder(f.parentId);
      const finalName = await this._uniqueNameIn(trashId, f.name);
      if (finalName !== f.name) await this.drive.renameFile(f.id, finalName);
      await this.drive.moveFile(f.id, f.parentId, trashId);
      this.history.push({
        type: "reject",
        rel: f.rel,
        fileId: f.id,
        fromParentId: f.parentId,
        toParentId: trashId,
        originalName: f.name,
        finalName,
      });
      this.trashedCount += 1;
    } catch (e) {
      return { error: `Impossible de deplacer le fichier : ${e.message}`, done: false, ...this._status() };
    }
    this.index += 1;
    return this.current();
  }

  async undo() {
    if (!this.history.length) return this.current();
    const action = this.history.pop();
    if (action.type === "accept") {
      if (this.index > 0) this.index -= 1;
      this.kept.delete(action.rel);
      await this._saveState();
    } else if (action.type === "reject") {
      if (this.index > 0) this.index -= 1;
      try {
        await this.drive.moveFile(action.fileId, action.toParentId, action.fromParentId);
        if (action.finalName !== action.originalName) {
          await this.drive.renameFile(action.fileId, action.originalName);
        }
        this.trashedCount = Math.max(this.trashedCount - 1, 0);
      } catch {
        // ignore
      }
    } else if (action.type === "skip") {
      const item = this.queue.pop();
      if (item) this.queue.splice(this.index, 0, item);
    }
    return this.current();
  }
}
