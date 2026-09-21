// Stable random identifiers kept in the browser's storage.
//  - the device id (localStorage) names this device's own progress file, so
//    each device only ever writes its own file and two devices can never
//    overwrite each other's decisions;
//  - the session id (sessionStorage) identifies one browser tab in the
//    presence list, and survives a page reload so reloading isn't seen by
//    everyone else as "left, then joined".

export function randomId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 16);
  return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16);
}

// Ids end up inside Drive file names and queries: keep them to [a-z0-9].
export function getStoredId(storage, key, make = randomId) {
  try {
    let value = storage.getItem(key);
    if (!value || !/^[a-z0-9]{6,32}$/.test(value)) {
      value = make();
      storage.setItem(key, value);
    }
    return value;
  } catch {
    return make(); // storage blocked (private mode): fine, just not persistent
  }
}

// Merely reading globalThis.localStorage throws when storage is blocked.
function safeStorage(name) {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

export const getDeviceId = () => getStoredId(safeStorage("localStorage"), "photosorter.deviceId");
export const getSessionId = () => getStoredId(safeStorage("sessionStorage"), "photosorter.sessionId");
