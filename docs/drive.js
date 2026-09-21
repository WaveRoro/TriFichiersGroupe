const API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 4;
// Statuses Google documents as "try again later" - safe to retry with backoff.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drive query strings quote values with '...' - a name containing a quote or
// backslash has to be escaped or it breaks (or alters) the query.
export function escapeQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function backoffMs(attempt) {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return base * (0.75 + Math.random() * 0.5);
}

function retryAfterMs(res) {
  const header = res.headers?.get?.("Retry-After");
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30000) : null;
}

async function toApiError(res) {
  const body = await res.text().catch(() => "");
  const err = new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
  err.status = res.status;
  return err;
}

export class DriveApi {
  // getToken: () => Promise<string>. invalidateToken (optional) is called on a
  // 401 so the next getToken() fetches a fresh token instead of reusing the
  // one Google just rejected.
  constructor(getToken, { invalidateToken, sleepFn = sleep, maxAttempts = MAX_ATTEMPTS } = {}) {
    this.getToken = getToken;
    this.invalidateToken = invalidateToken;
    this._sleep = sleepFn;
    this._maxAttempts = maxAttempts;
  }

  // Authenticated fetch with timeout + retry. Only idempotent requests are
  // retried after a network failure: a POST that reached Google but whose
  // response got lost would otherwise be replayed and create a duplicate.
  // (429/5xx responses mean Google did not process it, so those are retried
  // for every method.)
  async _fetch(url, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...init } = {}) {
    const method = (init.method || "GET").toUpperCase();
    const retryNetworkErrors = method !== "POST";
    let refreshedAfter401 = false;

    for (let attempt = 1; attempt <= this._maxAttempts; attempt++) {
      // Token acquisition is deliberately outside the timeout: waiting for
      // the user to re-authorise is not a network failure.
      const token = await this.getToken();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        signal.addEventListener("abort", forwardAbort, { once: true });
      }
      const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

      let res;
      try {
        res = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
        });
      } catch (e) {
        if (signal?.aborted) throw e; // the caller cancelled on purpose
        if (!retryNetworkErrors || attempt === this._maxAttempts) throw e;
        await this._sleep(backoffMs(attempt));
        continue;
      } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", forwardAbort);
      }

      if (res.ok) return res;

      if (res.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.invalidateToken?.();
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < this._maxAttempts) {
        await this._sleep(retryAfterMs(res) ?? backoffMs(attempt));
        continue;
      }
      throw await toApiError(res);
    }
    throw new Error("Drive API: nombre maximal de tentatives atteint");
  }

  async _listAll(query, fields, pageSize = 1000) {
    const items = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken, files(${fields})`,
        pageSize: String(pageSize),
        spaces: "drive",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this._fetch(`${API_BASE}/files?${params.toString()}`);
      const data = await res.json();
      items.push(...(data.files || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return items;
  }

  listChildren(folderId) {
    return this._listAll(`'${folderId}' in parents and trashed = false`, "id, name, mimeType, size, parents");
  }

  // Server-side name filter: looking up one known file (progress file, a
  // "_trash" folder...) must not download the listing of a 6000-file folder.
  findChildren(parentId, name) {
    const q = `'${parentId}' in parents and name = '${escapeQueryValue(name)}' and trashed = false`;
    return this._listAll(q, "id, name, mimeType", 100);
  }

  // Presence entries carry Google's own modifiedTime, so how fresh a session
  // is never depends on the (possibly wrong) clock of the device that wrote it.
  listPresence(folderId) {
    return this._listAll(`'${folderId}' in parents and trashed = false`, "id, name, modifiedTime, ownedByMe", 100);
  }

  // Folders the signed-in user can open without needing a pasted link:
  // ones they own at the root of their own Drive, plus ones someone else
  // has shared directly with them.
  async listAccessibleFolders() {
    const folderQuery = `mimeType = '${FOLDER_MIME}' and trashed = false`;
    const fields = "id, name, owners(displayName)";
    const [own, shared] = await Promise.all([
      this._listAll(`'root' in parents and ${folderQuery}`, fields, 200),
      this._listAll(`sharedWithMe = true and ${folderQuery}`, fields, 200),
    ]);
    const seen = new Set();
    const merged = [];
    for (const f of [...own, ...shared]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      merged.push({ id: f.id, name: f.name, owner: f.owners?.[0]?.displayName || "" });
    }
    merged.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return merged;
  }

  async getFolderMeta(folderId) {
    return this.getFileMeta(folderId, "id, name, mimeType");
  }

  async getFileMeta(fileId, fields = "id, name, parents, trashed") {
    const params = new URLSearchParams({ fields });
    const res = await this._fetch(`${API_BASE}/files/${fileId}?${params.toString()}`);
    return res.json();
  }

  async createFolder(name, parentId) {
    const res = await this._fetch(`${API_BASE}/files?fields=id,name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return res.json();
  }

  async moveFile(fileId, fromParentId, toParentId) {
    const params = new URLSearchParams({
      addParents: toParentId,
      removeParents: fromParentId,
      fields: "id, parents",
    });
    const res = await this._fetch(`${API_BASE}/files/${fileId}?${params.toString()}`, { method: "PATCH" });
    return res.json();
  }

  async renameFile(fileId, newName) {
    const res = await this._fetch(`${API_BASE}/files/${fileId}?fields=id,name`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    return res.json();
  }

  async readTextFile(fileId) {
    const res = await this._fetch(`${API_BASE}/files/${fileId}?alt=media`);
    return res.text();
  }

  // With wantModifiedTime, returns { modifiedTime } as stamped by Google's
  // servers (used by presence to learn the server clock).
  async writeTextFile(fileId, text, { wantModifiedTime = false } = {}) {
    const fields = wantModifiedTime ? "&fields=modifiedTime" : "";
    const res = await this._fetch(`${UPLOAD_BASE}/files/${fileId}?uploadType=media${fields}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    return wantModifiedTime ? res.json() : null;
  }

  async createTextFile(name, parentId, text) {
    const boundary = "photosorter_boundary_" + Math.random().toString(36).slice(2);
    const metadata = { name, parents: [parentId] };
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${text}\r\n` +
      `--${boundary}--`;
    const res = await this._fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,modifiedTime`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  }

  // Permanently deletes a file we created (presence entries). Already gone
  // counts as success - the goal is just that it no longer exists.
  async deleteFile(fileId) {
    try {
      await this._fetch(`${API_BASE}/files/${fileId}`, { method: "DELETE" });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  // Fetches the raw file bytes with the token in the Authorization header
  // (same pattern as readTextFile), rather than as a "?access_token=" URL
  // query parameter, which Google's abuse detection blocks. The caller turns
  // the returned Blob into an object URL. signal lets the caller cancel a
  // prefetch that is no longer needed.
  async mediaBlob(fileId, { signal } = {}) {
    const res = await this._fetch(`${API_BASE}/files/${fileId}?alt=media`, { signal });
    return res.blob();
  }
}

export function extractFolderId(input) {
  const trimmed = input.trim();
  const m = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}
