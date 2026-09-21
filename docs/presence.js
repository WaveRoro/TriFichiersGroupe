import { PRESENCE_DIRNAME, ensureNamedChild } from "./sorter.js";
import { randomId } from "./identity.js";

const FILE_PREFIX = ".p_";

// Who else is sorting the same Drive folder, without any server of our own.
//
// Each session owns ONE small file (".p_<sessionId>") inside a shared folder
// and touches it every heartbeat. Everyone lists that folder and counts the
// files touched recently. This replaced a single shared file that every
// session read-modify-wrote: two heartbeats landing together overwrote each
// other, so people seemed to leave and rejoin without moving (the source of
// repeated "someone joined/left" messages). With one file per session nobody
// ever writes anyone else's data.
//
// Freshness is judged with Google's own modifiedTime, never with the clock of
// the device that wrote it: a phone whose clock is 20s off would otherwise
// flap between "here" and "gone". Our own writes tell us how the server clock
// compares to ours (see _calibrate).
export class Presence {
  constructor(drive, {
    heartbeatMs = 5000,
    staleMs = 15000, // ~3 missed heartbeats: one slow request must not evict someone
    cleanupMs = 10 * 60 * 1000, // our own leftover files older than this get deleted
    verifyEvery = 6, // re-check every N ticks that everyone uses the same presence folder
    now = () => Date.now(), // injectable so tests can give each device its own clock
    sessionId = randomId(),
  } = {}) {
    this.drive = drive;
    this.sessionId = sessionId;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this._cleanupMs = cleanupMs;
    this._verifyEvery = verifyEvery;
    this._now = now;

    // (activeSessionIds) => void - the set of people changed after start().
    this.onChange = null;
    // () => void - this session went silent long enough (asleep, backgrounded,
    // offline) that others may have re-split the folder without us.
    this.onResume = null;

    this._gen = 0; // bumped by start()/stop(): anything from an older run stops itself
    this._timer = null;
    this._rootId = null;
    this._folderId = null;
    this._fileId = null;
    this._offset = 0; // server clock minus our clock
    this._lastKey = null;
    this._active = null;
    this._lastTickAt = 0;
    this._ticks = 0;
    this._cleaned = new Set();
  }

  // Registers this session and resolves with the people active right now
  // (always includes us). Resolves null if a newer start()/stop() superseded
  // this call. Presence problems (offline, denied) never block sorting: we
  // start alone and keep retrying in the background.
  async start(rootId) {
    await this.stop();
    const gen = ++this._gen;
    this._rootId = rootId;
    this._lastKey = null;
    this._active = null;
    try {
      await this._register(gen);
      if (gen !== this._gen) return null;
      await this._tick(gen, true);
    } catch {
      // fall through: act solo, the loop retries
    }
    if (gen !== this._gen) return null;
    // If nothing was learned, "alone" is what we reported - so a later
    // discovery of other people must count as a change.
    if (this._lastKey === null) this._lastKey = this.sessionId;
    this._lastTickAt = this._now();
    this._schedule(gen);
    return this._active ?? [this.sessionId];
  }

  // Leaves promptly: deleting our file makes the others notice on their next
  // poll instead of waiting for it to go stale.
  async stop() {
    this._gen++;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    const fileId = this._fileId;
    this._fileId = null;
    this._folderId = null;
    this._rootId = null;
    this._lastKey = null;
    this._active = null;
    if (fileId) {
      try {
        await this.drive.deleteFile(fileId);
      } catch {
        // it will simply go stale
      }
    }
  }

  // Call when the page becomes visible again: beat and look right away
  // instead of waiting for the next scheduled tick.
  async resume() {
    if (!this._rootId) return;
    const gen = this._gen;
    if (this._timer) clearTimeout(this._timer);
    try {
      await this._tick(gen, false);
    } catch {
      // next cycle
    }
    if (gen === this._gen) this._schedule(gen);
  }

  _serverNow() {
    return this._now() + this._offset;
  }

  _calibrate(modifiedTime, sentAt, receivedAt) {
    const server = Date.parse(modifiedTime);
    if (Number.isFinite(server)) this._offset = server - (sentAt + receivedAt) / 2;
  }

  _schedule(gen) {
    this._timer = setTimeout(async () => {
      if (gen !== this._gen) return;
      try {
        await this._tick(gen, false);
      } catch {
        // transient failure: try again next cycle
      }
      if (gen === this._gen) this._schedule(gen);
    }, this.heartbeatMs);
  }

  async _register(gen) {
    this._folderId = await ensureNamedChild(this.drive, this._rootId, PRESENCE_DIRNAME, () =>
      this.drive.createFolder(PRESENCE_DIRNAME, this._rootId)
    );
    if (gen !== this._gen) return;
    await this._ensureOwnFile();
  }

  async _ensureOwnFile() {
    const name = FILE_PREFIX + this.sessionId;
    const folderId = this._folderId;
    this._fileId = await ensureNamedChild(this.drive, folderId, name, async () => {
      const sentAt = this._now();
      const created = await this.drive.createTextFile(name, folderId, JSON.stringify({ v: 1 }));
      this._calibrate(created.modifiedTime, sentAt, this._now());
      return created;
    });
  }

  // Two sessions can create the presence folder at the same moment. Both must
  // end up in the same one or they'd never see each other, so this re-checks
  // periodically and moves if a lower-id twin exists.
  async _verifyFolder(gen) {
    const canonical = await ensureNamedChild(this.drive, this._rootId, PRESENCE_DIRNAME, () =>
      this.drive.createFolder(PRESENCE_DIRNAME, this._rootId)
    );
    if (gen !== this._gen || canonical === this._folderId) return;
    const stale = this._fileId;
    this._folderId = canonical;
    this._fileId = null;
    await this._ensureOwnFile();
    if (stale) this.drive.deleteFile(stale).catch(() => {});
  }

  async _beat() {
    const sentAt = this._now();
    try {
      const res = await this.drive.writeTextFile(this._fileId, JSON.stringify({ v: 1 }), { wantModifiedTime: true });
      this._calibrate(res.modifiedTime, sentAt, this._now());
    } catch (e) {
      if (e.status !== 404) throw e;
      await this._ensureOwnFile(); // deleted under us: register again
    }
  }

  async _tick(gen, initial) {
    const startedAt = this._now();
    const resumed = !initial && this._lastTickAt > 0 && startedAt - this._lastTickAt > this.staleMs + this.heartbeatMs;
    if (!this._folderId || !this._fileId) await this._register(gen);
    if (gen !== this._gen) return;
    if (++this._ticks % this._verifyEvery === 0) await this._verifyFolder(gen);
    if (gen !== this._gen) return;
    await this._beat();
    if (gen !== this._gen) return;
    const entries = await this.drive.listPresence(this._folderId);
    if (gen !== this._gen) return;

    const active = this._computeActive(entries);
    this._cleanup(entries);
    this._lastTickAt = this._now();
    const key = active.join(",");
    const previous = this._lastKey;
    this._lastKey = key;
    this._active = active;
    if (resumed) this.onResume?.();
    if (previous !== null && previous !== key) this.onChange?.(active);
  }

  _computeActive(entries) {
    const serverNow = this._serverNow();
    const ids = new Set([this.sessionId]);
    for (const entry of entries) {
      if (!entry.name.startsWith(FILE_PREFIX)) continue;
      const id = entry.name.slice(FILE_PREFIX.length);
      if (id && serverNow - Date.parse(entry.modifiedTime) <= this.staleMs) ids.add(id);
    }
    return [...ids].sort();
  }

  // Leftovers of our own earlier sessions (tab closed without leaving) are
  // deleted; other people's are theirs to clean - we couldn't delete them anyway.
  _cleanup(entries) {
    const serverNow = this._serverNow();
    for (const entry of entries) {
      if (!entry.ownedByMe || entry.id === this._fileId || this._cleaned.has(entry.id)) continue;
      if (!entry.name.startsWith(FILE_PREFIX)) continue;
      if (serverNow - Date.parse(entry.modifiedTime) <= this._cleanupMs) continue;
      this._cleaned.add(entry.id);
      this.drive.deleteFile(entry.id).catch(() => {});
    }
  }
}
