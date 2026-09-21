import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DriveApi, escapeQueryValue, extractFolderId } from "../docs/drive.js";

const realFetch = globalThis.fetch;
let calls;

function queueFetch(...responses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call: " + url);
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(url, init);
    return next;
  };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const noSleep = { sleepFn: async () => {} };
const makeApi = (extra = {}) => new DriveApi(async () => "TOKEN", { ...noSleep, ...extra });

afterEach(() => { globalThis.fetch = realFetch; });

test("sends the token as an Authorization header, never in the URL", async () => {
  queueFetch(json({ files: [] }));
  await makeApi().listChildren("root");
  assert.equal(calls[0].init.headers.Authorization, "Bearer TOKEN");
  assert.ok(!calls[0].url.includes("access_token"));
});

test("retries a 503 and then succeeds", async () => {
  queueFetch(new Response("busy", { status: 503 }), json({ files: [{ id: "a" }] }));
  const files = await makeApi().listChildren("root");
  assert.deepEqual(files, [{ id: "a" }]);
  assert.equal(calls.length, 2);
});

test("retries a 429 and honours Retry-After", async () => {
  const slept = [];
  const api = new DriveApi(async () => "T", { sleepFn: async (ms) => slept.push(ms) });
  queueFetch(new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }), json({ files: [] }));
  await api.listChildren("root");
  assert.deepEqual(slept, [2000]);
});

test("gives up after the max number of attempts and surfaces the status", async () => {
  queueFetch(...Array.from({ length: 4 }, () => new Response("down", { status: 500 })));
  await assert.rejects(() => makeApi().listChildren("root"), (e) => e.status === 500 && /Drive API 500/.test(e.message));
  assert.equal(calls.length, 4);
});

test("does not retry a permission error", async () => {
  queueFetch(new Response("nope", { status: 403 }));
  await assert.rejects(() => makeApi().listChildren("root"), (e) => e.status === 403);
  assert.equal(calls.length, 1);
});

test("a 401 invalidates the token and retries once with a fresh one", async () => {
  let invalidated = 0;
  let n = 0;
  const api = new DriveApi(async () => `TOKEN${++n}`, { ...noSleep, invalidateToken: () => invalidated++ });
  queueFetch(new Response("expired", { status: 401 }), json({ files: [] }));
  await api.listChildren("root");
  assert.equal(invalidated, 1);
  assert.equal(calls[1].init.headers.Authorization, "Bearer TOKEN2");
});

test("a persistent 401 is reported instead of looping forever", async () => {
  queueFetch(new Response("expired", { status: 401 }), new Response("expired", { status: 401 }));
  await assert.rejects(() => makeApi().listChildren("root"), (e) => e.status === 401);
  assert.equal(calls.length, 2);
});

test("retries a network failure for idempotent requests", async () => {
  queueFetch(new TypeError("network"), json({ files: [] }));
  await makeApi().listChildren("root");
  assert.equal(calls.length, 2);
});

test("never replays a POST after a network failure (could create a duplicate)", async () => {
  queueFetch(new TypeError("network"));
  await assert.rejects(() => makeApi().createFolder("x", "root"), TypeError);
  assert.equal(calls.length, 1);
});

test("a request that never answers is aborted by the timeout", async () => {
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
  const api = new DriveApi(async () => "T", { ...noSleep, maxAttempts: 1 });
  await assert.rejects(() => api._fetch("https://x.test/", { timeoutMs: 20 }), /Abort/);
});

test("a caller-cancelled request is not retried", async () => {
  const controller = new AbortController();
  let attempts = 0;
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    attempts++;
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
  const p = makeApi().mediaBlob("file1", { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p, /Abort/);
  assert.equal(attempts, 1);
});

test("waiting for the token is not subject to the network timeout", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = new DriveApi(async () => { await gate; return "T"; }, { ...noSleep, maxAttempts: 1 });
  queueFetch(json({ ok: true }));
  const p = api._fetch("https://x.test/", { timeoutMs: 20 });
  await new Promise((r) => setTimeout(r, 60)); // well past the timeout
  release();
  const res = await p;
  assert.equal(res.status, 200);
});

test("listChildren follows pagination", async () => {
  queueFetch(json({ files: [{ id: "1" }], nextPageToken: "p2" }), json({ files: [{ id: "2" }] }));
  const files = await makeApi().listChildren("root");
  assert.deepEqual(files.map((f) => f.id), ["1", "2"]);
  assert.ok(calls[1].url.includes("pageToken=p2"));
});

test("findChildren filters by name on the server and escapes quotes", async () => {
  queueFetch(json({ files: [] }));
  await makeApi().findChildren("PARENT", "it's a \\ test");
  const q = new URL(calls[0].url).searchParams.get("q");
  assert.equal(q, "'PARENT' in parents and name = 'it\\'s a \\\\ test' and trashed = false");
});

test("escapeQueryValue neutralises quotes and backslashes", () => {
  assert.equal(escapeQueryValue("a'b\\c"), "a\\'b\\\\c");
});

test("deleteFile treats an already-deleted file as success", async () => {
  queueFetch(new Response("gone", { status: 404 }));
  await makeApi().deleteFile("x");
});

test("deleteFile still reports real failures", async () => {
  queueFetch(new Response("forbidden", { status: 403 }));
  await assert.rejects(() => makeApi().deleteFile("x"), (e) => e.status === 403);
});

test("writeTextFile can return Google's modifiedTime", async () => {
  queueFetch(json({ modifiedTime: "2026-01-01T00:00:00.000Z" }));
  const res = await makeApi().writeTextFile("f", "{}", { wantModifiedTime: true });
  assert.equal(res.modifiedTime, "2026-01-01T00:00:00.000Z");
  assert.ok(calls[0].url.includes("fields=modifiedTime"));
});

test("extractFolderId understands links and raw ids", () => {
  assert.equal(extractFolderId("https://drive.google.com/drive/folders/abc123_-XYZ?usp=sharing"), "abc123_-XYZ");
  assert.equal(extractFolderId("abcdefghij1234"), "abcdefghij1234");
  assert.equal(extractFolderId("not a link"), null);
});
