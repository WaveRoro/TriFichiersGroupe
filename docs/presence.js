import { PRESENCE_FILENAME, ensureNamedChild } from "./sorter.js";

const HEARTBEAT_MS = 5000;
// A session is considered gone after missing ~3 heartbeats (kept at 3, not
// 1, so a single slow/dropped request doesn't wrongly evict someone still
// there). There is no way to reliably detect a closed tab - or a
// backgrounded mobile browser, whose timers get suspended by the OS the
// same way - with only Drive as a backend (no server-sent events, and
// sendBeacon can't carry the Authorization header Drive's API needs) - so
// "someone left" is only ever detected this way, worst case STALE_MS +
// HEARTBEAT_MS after they actually stopped (~20s at these values).
const STALE_MS = 15000;

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
    this.fileId = await ensureNamedChild(
      this.drive, this.rootId, PRESENCE_FILENAME,
      () => this.drive.createTextFile(PRESENCE_FILENAME, this.rootId, JSON.stringify({ sessions: {} }))
    );
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
      // Awaited deliberately: callers (start(), and the periodic poll timer)
      // rely on this fully finishing - e.g. a caller waiting on start() to
      // know the initial file split is ready - before moving on.
      if (this.onChange) await this.onChange(active);
    }
  }
}
