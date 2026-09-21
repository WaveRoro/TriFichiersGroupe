import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Presence } from "../docs/presence.js";
import { PRESENCE_DIRNAME } from "../docs/sorter.js";
import { FakeStore } from "./fake-drive.mjs";

// Real timers, scaled down: a "heartbeat" is 20ms and "stale" is 100ms.
const FAST = { heartbeatMs: 20, staleMs: 100, cleanupMs: 400, verifyEvery: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const running = [];
function make(store, name, opts = {}) {
  const p = new Presence(store.client(name), { ...FAST, sessionId: name, ...opts });
  p.events = [];
  p.resumed = 0;
  p.onChange = (active) => p.events.push(active);
  p.onResume = () => p.resumed++;
  running.push(p);
  return p;
}

// A tab that vanishes without saying goodbye (crash, lost signal).
function crash(p) {
  p._gen++;
  clearTimeout(p._timer);
}

async function waitFor(cond, ms = 1500, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

afterEach(async () => {
  while (running.length) await running.pop().stop();
});

test("two sessions find each other", async () => {
  const store = new FakeStore();
  const a = make(store, "aaa");
  const b = make(store, "bbb");
  assert.deepEqual(await a.start("root"), ["aaa"]);
  assert.deepEqual(await b.start("root"), ["aaa", "bbb"]);
  await waitFor(() => a.events.length === 1, 1000, "a to see b");
  assert.deepEqual(a.events[0], ["aaa", "bbb"]);
});

test("joining is reported once, not repeatedly", async () => {
  const store = new FakeStore();
  const a = make(store, "aaa");
  await a.start("root");
  const b = make(store, "bbb");
  await b.start("root");
  await sleep(400);
  assert.equal(a.events.length, 1);
  assert.equal(b.events.length, 0, "the joiner learns the group from start(), not from a change event");
});

test("concurrent heartbeats never make anyone appear to leave and rejoin", async () => {
  // Regression: with one shared presence file every session read-modify-wrote,
  // and two beats landing together dropped someone for a cycle - producing
  // "left" / "joined" messages while nobody moved.
  const store = new FakeStore({ latencyMs: 2, jitterMs: 8 });
  const sessions = ["aaa", "bbb", "ccc", "ddd"].map((n) => make(store, n, { staleMs: 250 }));
  await Promise.all(sessions.map((s) => s.start("root")));
  await waitFor(() => sessions.every((s) => s._active.length === 4), 2000, "everyone to see everyone");
  for (const s of sessions) s.events.length = 0;
  await sleep(1200); // ~50 heartbeats each
  for (const s of sessions) assert.deepEqual(s.events, [], `${s.sessionId} saw spurious changes`);
});

test("devices with wrong clocks (minutes off) still agree - freshness uses Google's clock", async () => {
  // Regression: freshness used the writer's own Date.now(), so a phone 20s
  // behind looked permanently stale (or flapped) to everyone else.
  const store = new FakeStore({ serverSkewMs: 7000 });
  const early = make(store, "aaa", { now: () => Date.now() - 180000 });
  const late = make(store, "bbb", { now: () => Date.now() + 95000 });
  const normal = make(store, "ccc");
  await early.start("root");
  await late.start("root");
  await normal.start("root");
  await waitFor(() => [early, late, normal].every((p) => p._active.length === 3), 1500, "all three to agree");
  for (const p of [early, late, normal]) p.events.length = 0;
  await sleep(500);
  for (const p of [early, late, normal]) assert.deepEqual(p.events, [], `${p.sessionId} flapped`);
});

test("someone who vanishes is noticed after the stale delay, once", async () => {
  const store = new FakeStore();
  const a = make(store, "aaa");
  const b = make(store, "bbb");
  await a.start("root");
  await b.start("root");
  await waitFor(() => a.events.length === 1);
  crash(b);
  const crashedAt = Date.now();
  await waitFor(() => a.events.length === 2, 1500, "a to notice b is gone");
  assert.deepEqual(a.events[1], ["aaa"]);
  const took = Date.now() - crashedAt;
  assert.ok(took >= FAST.staleMs - FAST.heartbeatMs, `noticed too early (${took}ms)`);
  assert.ok(took < FAST.staleMs + FAST.heartbeatMs * 4, `noticed too late (${took}ms)`);
  await sleep(300);
  assert.equal(a.events.length, 2, "the departure is reported once, not again and again");
});

test("leaving on purpose is noticed within a heartbeat, without waiting for the stale delay", async () => {
  const store = new FakeStore();
  const a = make(store, "aaa");
  const b = make(store, "bbb");
  await a.start("root");
  await b.start("root");
  await waitFor(() => a.events.length === 1);
  const before = Date.now();
  await b.stop();
  await waitFor(() => a.events.length === 2, 1000, "a to notice b left");
  assert.ok(Date.now() - before < FAST.staleMs, "faster than waiting for staleness");
});

test("reloading a tab (same session id) is not seen as leaving and joining", async () => {
  const store = new FakeStore();
  const a = make(store, "aaa");
  const b = make(store, "bbb");
  await a.start("root");
  await b.start("root");
  await waitFor(() => a.events.length === 1);
  crash(b); // page unloaded without a goodbye
  const reloaded = make(store, "bbb"); // same sessionStorage id after reload
  await reloaded.start("root");
  await sleep(400);
  assert.equal(a.events.length, 1, "no leave/join pair for a quick reload");
  assert.equal(store.named(store.named("root", PRESENCE_DIRNAME)[0].id, ".p_bbb").length, 1, "still one file for that session");
});

test("a session that was asleep is told to resynchronise", async () => {
  const store = new FakeStore();
  let skew = 0;
  const a = make(store, "aaa", { now: () => Date.now() + skew });
  await a.start("root");
  assert.equal(a.resumed, 0);
  skew += 5000; // the device slept: our clock jumps far past staleMs + heartbeat
  await waitFor(() => a.resumed === 1, 1000, "resume notification");
  await sleep(100);
  assert.equal(a.resumed, 1, "reported once");
});

test("becoming visible again beats immediately instead of waiting for the timer", async () => {
  const store = new FakeStore();
  const a = make(store, "aaa", { heartbeatMs: 60000 });
  await a.start("root");
  const before = a.drive.calls.writeTextFile;
  await a.resume();
  assert.equal(a.drive.calls.writeTextFile, before + 1);
});

test("two sessions creating the presence folder at once still end up together", async () => {
  const store = new FakeStore({ latencyMs: 1, jitterMs: 6 });
  const a = make(store, "aaa");
  const b = make(store, "bbb");
  await Promise.all([a.start("root"), b.start("root")]);
  await waitFor(() => a._active?.length === 2 && b._active?.length === 2, 2000, "both to see each other");
  assert.equal(a._folderId, b._folderId, "both use the same folder");
});

test("our own leftover files from earlier tabs are cleaned up, other people's are not", async () => {
  const store = new FakeStore();
  const folder = store.addFolder(PRESENCE_DIRNAME);
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const mine = store.addFile(".p_oldmine", folder, { owner: "aaa" });
  const theirs = store.addFile(".p_oldtheirs", folder, { owner: "someone" });
  store.files.get(mine).modifiedTime = old;
  store.files.get(theirs).modifiedTime = old;
  const a = make(store, "aaa");
  await a.start("root");
  await waitFor(() => !store.files.has(mine), 1000, "cleanup of our own leftover");
  assert.ok(store.files.has(theirs), "someone else's file is left alone");
});

test("stale entries are not counted, unrelated files are ignored", async () => {
  const store = new FakeStore();
  const folder = store.addFolder(PRESENCE_DIRNAME);
  const gone = store.addFile(".p_gone", folder);
  store.files.get(gone).modifiedTime = new Date(Date.now() - 60000).toISOString();
  store.addFile("readme.txt", folder);
  const a = make(store, "aaa");
  assert.deepEqual(await a.start("root"), ["aaa"]);
});

test("a newer start() supersedes an older one still in flight", async () => {
  const store = new FakeStore({ latencyMs: 15 });
  const other = store.addFolder("other");
  const a = make(store, "aaa");
  const first = a.start("root");
  const second = a.start(other);
  assert.equal(await first, null);
  assert.deepEqual(await second, ["aaa"]);
  assert.ok(store.named(store.named(other, PRESENCE_DIRNAME)[0].id, ".p_aaa").length === 1);
});

test("if our file gets deleted under us we register again", async () => {
  const store = new FakeStore();
  const a = make(store, "aaa");
  await a.start("root");
  store.files.delete(a._fileId);
  await waitFor(() => store.named(store.named("root", PRESENCE_DIRNAME)[0].id, ".p_aaa").length === 1, 1000, "re-registration");
});

test("failing to reach Drive at start means acting alone, and later discovery still counts as a change", async () => {
  const store = new FakeStore();
  const b = make(store, "bbb");
  await b.start("root");
  store.failNext("findChildren", 2);
  const a = make(store, "aaa");
  assert.deepEqual(await a.start("root"), ["aaa"], "started alone rather than blocking");
  await waitFor(() => a.events.length === 1, 1500, "a to discover b afterwards");
  assert.deepEqual(a.events[0], ["aaa", "bbb"]);
});

test("stop() then start() on another folder leaves nothing behind in the first", async () => {
  const store = new FakeStore();
  const other = store.addFolder("other");
  const a = make(store, "aaa");
  await a.start("root");
  await a.start(other);
  const first = store.named("root", PRESENCE_DIRNAME)[0];
  assert.equal(store.children(first.id).length, 0);
});
