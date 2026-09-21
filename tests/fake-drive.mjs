// An in-memory stand-in for Google Drive, shared by every test that needs to
// exercise several sessions against the same folder.
//
// It deliberately keeps the behaviours that bit us in real use:
//  - duplicate names in one folder are allowed (two sessions can both create
//    "the" progress file / presence folder)
//  - modifiedTime is stamped by a *server* clock that can differ from every
//    client's clock
//  - requests take time and interleave (optional latency + jitter)
//  - anything can fail on demand
export const FOLDER_MIME = "application/vnd.google-apps.folder";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiError(status, message = "error") {
  const err = new Error(`Drive API ${status}: ${message}`);
  err.status = status;
  return err;
}

export class FakeStore {
  constructor({ serverSkewMs = 0, latencyMs = 0, jitterMs = 0 } = {}) {
    this.files = new Map();
    this.serverSkewMs = serverSkewMs;
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.strictMove = false; // moving a file out of a parent it isn't in fails
    this._seq = 0;
    this._failures = [];
    this._gates = new Map();
    this.files.set("root", this._record({ id: "root", name: "root", mimeType: FOLDER_MIME, parents: [] }));
  }

  serverNow() {
    return Date.now() + this.serverSkewMs;
  }

  _record({ id, name, mimeType, parents, size = 0, content = "", owner = "owner" }) {
    return { id, name, mimeType, parents, size, content, owner, trashed: false, modifiedTime: new Date(this.serverNow()).toISOString() };
  }

  newId() {
    return `id${String(++this._seq).padStart(6, "0")}`;
  }

  addFolder(name, parentId = "root", owner = "owner") {
    const id = this.newId();
    this.files.set(id, this._record({ id, name, mimeType: FOLDER_MIME, parents: [parentId], owner }));
    return id;
  }

  addFile(name, parentId = "root", { size = 100, content = "", owner = "owner", mimeType = "image/jpeg" } = {}) {
    const id = this.newId();
    this.files.set(id, this._record({ id, name, mimeType, parents: [parentId], size, content, owner }));
    return id;
  }

  // IMG_0001.jpg ... - sequential camera-style names, the real-world shape.
  addMany(count, { parentId = "root", prefix = "IMG_", ext = ".jpg", start = 1 } = {}) {
    const ids = [];
    for (let i = 0; i < count; i++) ids.push(this.addFile(`${prefix}${String(start + i).padStart(5, "0")}${ext}`, parentId));
    return ids;
  }

  children(parentId) {
    return [...this.files.values()].filter((f) => !f.trashed && f.parents.includes(parentId));
  }

  named(parentId, name) {
    return this.children(parentId).filter((f) => f.name === name);
  }

  // The next `times` calls to `method` throw `error`.
  failNext(method, times = 1, error = apiError(503, "injected failure")) {
    this._failures.push({ method, times, error });
  }

  // Calls to `method` block until the returned function is called.
  pause(method) {
    let release;
    const gate = new Promise((r) => { release = r; });
    this._gates.set(method, gate);
    return () => { this._gates.delete(method); release(); };
  }

  async _enter(method) {
    if (this.latencyMs || this.jitterMs) await sleep(this.latencyMs + Math.random() * this.jitterMs);
    const gate = this._gates.get(method);
    if (gate) await gate;
    const failure = this._failures.find((f) => f.method === method && f.times > 0);
    if (failure) {
      failure.times--;
      throw failure.error;
    }
  }

  client(userId = "owner") {
    return new FakeDrive(this, userId);
  }
}

export class FakeDrive {
  constructor(store, userId) {
    this.store = store;
    this.userId = userId;
    this.calls = {};
  }

  async _enter(method) {
    this.calls[method] = (this.calls[method] || 0) + 1;
    await this.store._enter(method);
  }

  _get(id) {
    const f = this.store.files.get(id);
    if (!f) throw apiError(404, "File not found: " + id);
    return f;
  }

  async listChildren(folderId) {
    await this._enter("listChildren");
    return this.store.children(folderId).map(({ id, name, mimeType, size, parents }) => ({ id, name, mimeType, size, parents: [...parents] }));
  }

  async findChildren(parentId, name) {
    await this._enter("findChildren");
    return this.store.named(parentId, name).map(({ id, name, mimeType }) => ({ id, name, mimeType }));
  }

  async listPresence(folderId) {
    await this._enter("listPresence");
    return this.store.children(folderId).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, ownedByMe: f.owner === this.userId }));
  }

  async getFolderMeta(id) {
    await this._enter("getFolderMeta");
    const f = this._get(id);
    return { id: f.id, name: f.name, mimeType: f.mimeType };
  }

  async getFileMeta(id) {
    await this._enter("getFileMeta");
    const f = this._get(id);
    return { id: f.id, name: f.name, parents: [...f.parents], trashed: f.trashed };
  }

  async createFolder(name, parentId) {
    await this._enter("createFolder");
    return { id: this.store.addFolder(name, parentId, this.userId), name };
  }

  async createTextFile(name, parentId, text) {
    await this._enter("createTextFile");
    const id = this.store.addFile(name, parentId, { content: text, owner: this.userId, mimeType: "application/json" });
    return { id, name, modifiedTime: this.store.files.get(id).modifiedTime };
  }

  async readTextFile(id) {
    await this._enter("readTextFile");
    return this._get(id).content;
  }

  async writeTextFile(id, text, { wantModifiedTime = false } = {}) {
    await this._enter("writeTextFile");
    const f = this._get(id);
    f.content = text;
    f.modifiedTime = new Date(this.store.serverNow()).toISOString();
    return wantModifiedTime ? { modifiedTime: f.modifiedTime } : null;
  }

  async deleteFile(id) {
    await this._enter("deleteFile");
    this.store.files.delete(id);
  }

  async moveFile(id, fromParentId, toParentId) {
    await this._enter("moveFile");
    const f = this._get(id);
    if (this.store.strictMove && !f.parents.includes(fromParentId)) throw apiError(404, "not in that parent");
    f.parents = f.parents.filter((p) => p !== fromParentId);
    if (!f.parents.includes(toParentId)) f.parents.push(toParentId);
    return { id, parents: [...f.parents] };
  }

  async renameFile(id, newName) {
    await this._enter("renameFile");
    this._get(id).name = newName;
    return { id, name: newName };
  }

  async mediaBlob(id) {
    await this._enter("mediaBlob");
    return new Blob([this._get(id).content]);
  }
}
