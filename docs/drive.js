const API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

export class DriveApi {
  constructor(getToken) {
    this.getToken = getToken;
  }

  async _fetch(url, options = {}) {
    const token = await this.getToken();
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
  }

  async listChildren(folderId) {
    const items = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, parents)",
        pageSize: "1000",
        spaces: "drive",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this._fetch(`${API_BASE}/files?${params.toString()}`);
      const data = await res.json();
      items.push(...data.files);
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return items;
  }

  async _listFolders(query) {
    const items = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: query,
        fields: "nextPageToken, files(id, name, owners(displayName))",
        pageSize: "200",
        spaces: "drive",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this._fetch(`${API_BASE}/files?${params.toString()}`);
      const data = await res.json();
      items.push(...data.files);
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return items;
  }

  // Folders the signed-in user can open without needing a pasted link:
  // ones they own at the root of their own Drive, plus ones someone else
  // has shared directly with them.
  async listAccessibleFolders() {
    const FOLDER_Q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    const [own, shared] = await Promise.all([
      this._listFolders(`'root' in parents and ${FOLDER_Q}`),
      this._listFolders(`sharedWithMe = true and ${FOLDER_Q}`),
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
    const params = new URLSearchParams({ fields: "id, name, mimeType" });
    const res = await this._fetch(`${API_BASE}/files/${folderId}?${params.toString()}`);
    return res.json();
  }

  async createFolder(name, parentId) {
    const res = await this._fetch(`${API_BASE}/files?fields=id,name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    });
    return res.json();
  }

  async moveFile(fileId, fromParentId, toParentId) {
    const params = new URLSearchParams({
      addParents: toParentId,
      removeParents: fromParentId,
      fields: "id, parents",
    });
    const res = await this._fetch(`${API_BASE}/files/${fileId}?${params.toString()}`, {
      method: "PATCH",
    });
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

  async writeTextFile(fileId, text) {
    await this._fetch(`${UPLOAD_BASE}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
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
    const res = await this._fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  }

  // Fetches the raw file bytes with the token in the Authorization header
  // (same pattern as readTextFile), rather than as a "?access_token=" URL
  // query parameter. The URL-parameter approach - what this used to do, to
  // get a directly embeddable <img>/<video> src - reliably got the request
  // blocked with Google's "unusual traffic" page on every single file, from
  // the very first one. Caller turns the returned Blob into an object URL.
  async mediaBlob(fileId) {
    const res = await this._fetch(`${API_BASE}/files/${fileId}?alt=media`);
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
