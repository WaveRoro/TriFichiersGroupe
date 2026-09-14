import { PRESENCE_FILENAME } from "./sorter.js";

const HEARTBEAT_MS = 15000;
// A session is considered gone after missing ~3 heartbeats. There is no way
// to reliably detect a closed tab with only Drive as a backend (no
// server-sent events, and sendBeacon can't carry the Authorization header
// Drive's API needs) - so "someone left" is only ever detected this way,
// with this delay, rather than instantly.
const STALE_MS = 45000;

function randomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Tracks who else is currently sorting the same Drive folder, via a small
// shared JSON file each session heartbeats into. Polling-based (there is no
// push mechanism available here), so joins/leaves are only noticed within
// one heartbeat interval, not instantly.
export class Presence {
  constructor(drive) {
    this.drive = drive;
    this.sessionId = randomId();
    this.fileId = null;
    this.rootId = null;
    this.heartbeatTimer = null;
    this.pollTimer = null;
    this.onChange = null; // (activeSessionIds: string[]) => void
    this._lastKey = null;
  }

  async start(rootId) {
    this.stop();
    this.rootId = rootId;
    this._lastKey = null;
    try {
      await this._ensureFile();
      await this._beat();
      await this._poll();
    } catch {
      // If presence can't be set up (e.g. offline), fall back to acting
      // solo rather than breaking sorting entirely.
    }
    this.heartbeatTimer = setInterval(() => this._beat().catch(() => {}), HEARTBEAT_MS);
    this.pollTimer = setInterval(() => this._poll().catch(() => {}), HEARTBEAT_MS);
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = null;
    this.pollTimer = null;
  }

  async _ensureFile() {
    const children = await this.drive.listChildren(this.rootId);
    const existing = children.find((c) => c.name === PRESENCE_FILENAME);
    if (existing) {
      this.fileId = existing.id;
      return;
    }
    const created = await this.drive.createTextFile(
      PRESENCE_FILENAME,
      this.rootId,
      JSON.stringify({ sessions: {} })
    );
    this.fileId = created.id;
  }

  async _read() {
    try {
      const text = await this.drive.readTextFile(this.fileId);
      const data = JSON.parse(text);
      return data && typeof data.sessions === "object" && data.sessions ? data.sessions : {};
    } catch {
      return {};
    }
  }

  // Reads-then-writes without locking (Drive has no compare-and-swap we can
  // use here), so two heartbeats landing at the exact same moment can drop
  // one of them - self-heals on the next cycle 15s later, which is an
  // acceptable trade-off given there's no real backend to do this properly.
  async _beat() {
    const sessions = await this._read();
    const now = Date.now();
    sessions[this.sessionId] = { lastSeen: now };
    for (const id of Object.keys(sessions)) {
      if (id !== this.sessionId && now - sessions[id].lastSeen > STALE_MS) delete sessions[id];
    }
    await this.drive.writeTextFile(this.fileId, JSON.stringify({ sessions }));
  }

  async _poll() {
    const sessions = await this._read();
    const now = Date.now();
    const active = Object.keys(sessions)
      .filter((id) => id === this.sessionId || now - (sessions[id]?.lastSeen || 0) <= STALE_MS)
      .sort();
    const key = active.join(",");
    if (key !== this._lastKey) {
      this._lastKey = key;
      if (this.onChange) this.onChange(active);
    }
  }
}
