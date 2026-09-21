import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Coordinator, reorgMessage } from "../docs/coordinator.js";
import { DriveSorter } from "../docs/sorter.js";
import { Presence } from "../docs/presence.js";
import { FakeStore } from "./fake-drive.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESENCE = { heartbeatMs: 20, staleMs: 100, cleanupMs: 60000, verifyEvery: 3 };
const COORD = {
  settleMs: 40, minReorgPauseMs: 30, applyPauseMs: 20, refreshTimeoutMs: 400,
  retryDelayMs: 40, backgroundRetryMs: 120, newFilesCheckMs: 90, newFilesCountdownS: 3, countdownTickMs: 25,
};

class FakeUi {
  constructor() {
    this.overlay = false;
    this.shown = [];
    this.nestedShows = 0;
    this.renders = [];
    this.toasts = [];
    this.banners = [];
    this.invalidations = 0;
    this.visible = true;
  }
  showReorg(message) {
    if (this.overlay) this.nestedShows++;
    this.overlay = true;
    this.shown.push(message);
  }
  hideReorg() { this.overlay = false; }
  render(data) { this.renders.push(data); }
  toast(message) { this.toasts.push(message); }
  setNewFilesBanner(state) { this.banners.push(state); }
  get banner() { return this.banners.at(-1) ?? null; }
  invalidateMedia() { this.invalidations++; }
  isVisible() { return this.visible; }
}

const stacks = [];
function stack(store, name, { presence = {}, coord = {}, sorter = {} } = {}) {
  const drive = store.client(name);
  const s = new DriveSorter(drive, { saveDebounceMs: 10, deviceId: name, ...sorter });
  const p = new Presence(drive, { ...PRESENCE, sessionId: name, ...presence });
  const ui = new FakeUi();
  const c = new Coordinator({ sorter: s, presence: p, ui, options: { ...COORD, ...coord } });
  const st = { name, drive, sorter: s, presence: p, ui, coord: c };
  stacks.push(st);
  return st;
}

async function waitFor(cond, ms = 2000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

afterEach(async () => {
  while (stacks.length) await stacks.pop().coord.close();
});

const queueIds = (st) => new Set(st.sorter.queue.slice(st.sorter.index).map((f) => f.id));

test("reorgMessage names what actually happened", () => {
  assert.match(reorgMessage(1, 0), /Une personne rejoint/);
  assert.match(reorgMessage(3, 0), /3 personnes rejoignent/);
  assert.match(reorgMessage(0, 1), /Une personne a quitte/);
  assert.match(reorgMessage(0, 2), /2 personnes ont quitte/);
  assert.match(reorgMessage(1, 1), /Le groupe a change/);
});

test("opening a folder alone shows the first card and never any overlay", async () => {
  const store = new FakeStore();
  store.addMany(10);
  const a = stack(store, "aaa");
  const first = await a.coord.open("root", "root");
  assert.equal(first.done, false);
  assert.equal(a.sorter.queue.length, 10);
  await sleep(200);
  assert.deepEqual(a.ui.shown, []);
});

test("someone joining triggers exactly ONE overlay with the right message, then it lifts", async () => {
  const store = new FakeStore();
  store.addMany(100);
  const a = stack(store, "aaa");
  const b = stack(store, "bbb");
  await a.coord.open("root", "root");
  await b.coord.open("root", "root");
  await waitFor(() => a.ui.shown.length === 1, 2000, "a to react to b");
  await waitFor(() => !a.ui.overlay, 2000, "overlay to lift");
  assert.match(a.ui.shown[0], /Une personne rejoint/);
  await sleep(500);
  assert.equal(a.ui.shown.length, 1, "no repeated message");
  assert.equal(b.ui.shown.length, 0, "the joiner is not shown its own arrival");
  assert.equal(a.ui.nestedShows, 0);
  const ownA = queueIds(a);
  const ownB = queueIds(b);
  assert.equal([...ownA].filter((id) => ownB.has(id)).length, 0, "disjoint shares");
  assert.equal(ownA.size + ownB.size, 100);
});

test("someone leaving triggers exactly ONE overlay and their share comes back", async () => {
  const store = new FakeStore();
  store.addMany(60);
  const a = stack(store, "aaa");
  const b = stack(store, "bbb");
  await a.coord.open("root", "root");
  await b.coord.open("root", "root");
  await waitFor(() => a.ui.shown.length === 1 && !a.ui.overlay);
  assert.ok(queueIds(a).size < 60);
  await b.coord.close();
  await waitFor(() => a.ui.shown.length === 2 && !a.ui.overlay, 2000, "a to react to b leaving");
  assert.match(a.ui.shown[1], /Une personne a quitte/);
  assert.equal(queueIds(a).size, 60, "inherits the whole folder");
  await sleep(400);
  assert.equal(a.ui.shown.length, 2);
});

test("a change that reverts itself before it settles causes no overlay at all", async () => {
  const store = new FakeStore();
  store.addMany(20);
  const a = stack(store, "aaa", { coord: { settleMs: 80 } });
  await a.coord.open("root", "root");
  a.coord._onPresence(["aaa", "bbb"]);
  await sleep(20);
  a.coord._onPresence(["aaa"]);
  await sleep(300);
  assert.deepEqual(a.ui.shown, []);
});

test("a burst of changes is handled once, as its final state", async () => {
  const store = new FakeStore();
  store.addMany(20);
  const a = stack(store, "aaa", { coord: { settleMs: 80 } });
  await a.coord.open("root", "root");
  a.coord._onPresence(["aaa", "bbb"]);
  await sleep(15);
  a.coord._onPresence(["aaa", "bbb", "ccc"]);
  await sleep(15);
  a.coord._onPresence(["aaa", "bbb", "ccc", "ddd"]);
  await waitFor(() => a.ui.shown.length === 1 && !a.ui.overlay, 2000, "one reorganisation");
  await sleep(300);
  assert.equal(a.ui.shown.length, 1);
  assert.match(a.ui.shown[0], /3 personnes rejoignent/);
  assert.deepEqual(a.sorter.activeSessions, ["aaa", "bbb", "ccc", "ddd"]);
});

test("a burst of changes does not queue a pile of workers that delays everything else", async () => {
  // Every queued worker would hold the shared queue for a full settle delay,
  // so N changes in a row would make the next unrelated task wait N settles.
  const store = new FakeStore();
  store.addMany(10);
  const a = stack(store, "aaa", { coord: { settleMs: 100 } });
  await a.coord.open("root", "root");
  for (let i = 0; i < 8; i++) {
    a.coord._onPresence(i % 2 ? ["aaa", "bbb"] : ["aaa", "bbb", "ccc"]);
    await sleep(5);
  }
  const started = Date.now();
  await a.coord.reconcileIfDone();
  assert.ok(Date.now() - started < 450, `waited ${Date.now() - started}ms behind redundant workers`);
});

test("a change arriving mid-reorganisation waits its turn - overlays never stack", async () => {
  const store = new FakeStore({ latencyMs: 4 });
  store.addMany(30);
  const a = stack(store, "aaa", { coord: { settleMs: 20, minReorgPauseMs: 120 } });
  await a.coord.open("root", "root");
  a.coord._onPresence(["aaa", "bbb"]);
  await waitFor(() => a.ui.overlay, 1000, "first reorganisation to start");
  a.coord._onPresence(["aaa", "bbb", "ccc"]);
  await waitFor(() => a.ui.shown.length === 2 && !a.ui.overlay, 3000, "second one to run afterwards");
  assert.equal(a.ui.nestedShows, 0, "never two overlays at once");
  assert.deepEqual(a.sorter.activeSessions, ["aaa", "bbb", "ccc"]);
});

test("a failing refresh never leaves the screen locked, and it retries until it works", async () => {
  // Regression: any error during a reorganisation left the overlay up and
  // every control disabled, forever.
  const store = new FakeStore();
  store.addMany(20);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  store.failNext("listChildren", 2, Object.assign(new Error("Drive API 503: x"), { status: 503 }));
  a.coord._onPresence(["aaa", "bbb"]);
  await waitFor(() => a.ui.toasts.length >= 1, 2000, "a failure notice");
  assert.equal(a.ui.overlay, false, "overlay lifted after the failure");
  await waitFor(() => a.sorter.activeSessions.length === 2, 3000, "the retry to succeed");
  assert.equal(a.ui.overlay, false);
});

test("a refresh that never answers is given up on instead of hanging forever", async () => {
  const store = new FakeStore();
  store.addMany(10);
  const a = stack(store, "aaa", { coord: { refreshTimeoutMs: 80, maxRetries: 1, backgroundRetryMs: 10000 } });
  await a.coord.open("root", "root");
  const release = store.pause("listChildren");
  a.coord._onPresence(["aaa", "bbb"]);
  await waitFor(() => a.ui.toasts.length >= 1, 2000, "timeout notice");
  assert.equal(a.ui.overlay, false);
  release();
});

test("closing during a reorganisation lifts the overlay and nothing more is drawn", async () => {
  const store = new FakeStore({ latencyMs: 10 });
  store.addMany(20);
  const a = stack(store, "aaa", { coord: { minReorgPauseMs: 200 } });
  await a.coord.open("root", "root");
  a.coord._onPresence(["aaa", "bbb"]);
  await waitFor(() => a.ui.overlay, 1000);
  const rendersBefore = a.ui.renders.length;
  await a.coord.close();
  assert.equal(a.ui.overlay, false);
  await sleep(500);
  assert.equal(a.ui.renders.length, rendersBefore, "no render after leaving the folder");
  assert.equal(a.ui.overlay, false);
});

test("opening another folder while the first is still loading: only the second counts", async () => {
  const store = new FakeStore({ latencyMs: 8 });
  store.addMany(5);
  const other = store.addFolder("other");
  store.addMany(3, { parentId: other, prefix: "X_" });
  const a = stack(store, "aaa");
  const first = a.coord.open("root", "first");
  const second = a.coord.open(other, "second");
  assert.equal(await first, null);
  const data = await second;
  assert.equal(data.rootName, "second");
  assert.equal(a.sorter.rootId, other);
  assert.equal(a.sorter.queue.length, 3);
});

test("leaving a folder removes us from its presence list", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  await a.coord.close();
  const folder = store.named("root", ".photosorter_presence")[0];
  assert.equal(store.children(folder.id).length, 0);
});

test("closing saves the decisions still waiting for their debounce", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const a = stack(store, "aaa", { sorter: { saveDebounceMs: 60000 } });
  await a.coord.open("root", "root");
  await a.sorter.accept();
  await a.sorter.accept();
  await a.coord.close();
  const folder = store.named("root", ".photosorter_kept")[0];
  const file = store.named(folder.id, "k_aaa.json")[0];
  assert.equal(JSON.parse(file.content).kept.length, 2);
});

// ---------- files added while sorting ----------

test("new files: banner with a countdown, then the file joins the queue", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  const added = store.addFile("IMG_99999.jpg");
  await waitFor(() => a.ui.banner?.count === 1, 2000, "the banner");
  assert.ok(a.ui.banner.secondsLeft <= 3);
  await waitFor(() => a.sorter.knowsFile(added), 3000, "auto-apply");
  await waitFor(() => a.ui.banner === null && !a.ui.overlay);
  assert.ok(a.sorter.queue.some((f) => f.id === added));
  assert.ok(a.ui.renders.length >= 1);
});

test("the countdown actually counts down", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const a = stack(store, "aaa", { coord: { newFilesCountdownS: 4, countdownTickMs: 40 } });
  await a.coord.open("root", "root");
  store.addFile("IMG_99999.jpg");
  await waitFor(() => a.ui.banners.some((b) => b?.secondsLeft === 4), 2000);
  await waitFor(() => a.ui.banners.some((b) => b?.secondsLeft === 2), 2000);
  const seconds = a.ui.banners.filter(Boolean).map((b) => b.secondsLeft);
  assert.deepEqual([...seconds].sort((x, y) => y - x), seconds, "monotonically decreasing");
});

test("dismissing new files stops the countdown and doesn't nag about the same ones", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const a = stack(store, "aaa", { coord: { newFilesCountdownS: 50 } });
  await a.coord.open("root", "root");
  const first = store.addFile("IMG_99991.jpg");
  await waitFor(() => a.ui.banner?.count === 1, 2000);
  a.coord.dismissNewFiles();
  assert.equal(a.ui.banner, null);
  await sleep(400); // several checks
  assert.equal(a.ui.banner, null, "same file, no new banner");
  assert.equal(a.sorter.knowsFile(first), false, "and it was not applied either");
  store.addFile("IMG_99992.jpg");
  await waitFor(() => a.ui.banner?.count === 2, 2000, "banner again for the additional file");
});

test("applying now skips the wait", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const a = stack(store, "aaa", { coord: { newFilesCountdownS: 500 } });
  await a.coord.open("root", "root");
  const added = store.addFile("IMG_99999.jpg");
  await waitFor(() => a.ui.banner?.count === 1);
  await a.coord.applyNewFilesNow();
  assert.ok(a.sorter.knowsFile(added));
  assert.equal(a.ui.banner, null);
});

test("a reorganisation that already picked the new files makes applying them a no-op", async () => {
  const store = new FakeStore();
  store.addMany(6);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  const added = store.addFile("IMG_99999.jpg");
  a.coord._pendingNew = [added];
  a.coord._onPresence(["aaa", "bbb"]); // its refresh will learn about `added`
  await waitFor(() => a.ui.shown.length === 1 && !a.ui.overlay);
  assert.ok(a.sorter.knowsFile(added));
  const showsBefore = a.ui.shown.length;
  await a.coord.applyNewFilesNow();
  assert.equal(a.ui.shown.length, showsBefore, "no second overlay for the same files");
});

test("nothing is scanned while the page is hidden", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  a.ui.visible = false;
  store.addFile("IMG_99999.jpg");
  const listsBefore = a.drive.calls.listChildren;
  await sleep(350);
  assert.equal(a.drive.calls.listChildren, listsBefore);
  assert.equal(a.ui.banner, null);
  a.ui.visible = true;
  await waitFor(() => a.ui.banner?.count === 1, 2000, "banner once visible again");
});

// ---------- coming back after a pause ----------

test("a session that slept is resynchronised, once", async () => {
  const store = new FakeStore();
  store.addMany(20);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  a.presence.onResume();
  await waitFor(() => a.ui.shown.length === 1 && !a.ui.overlay);
  assert.match(a.ui.shown[0], /Reconnexion/);
  await sleep(300);
  assert.equal(a.ui.shown.length, 1);
});

// ---------- end of my share / restart ----------

test("running out of files checks once more and finds work that appeared", async () => {
  const store = new FakeStore();
  store.addMany(2);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  await a.sorter.accept();
  const data = await a.sorter.accept();
  assert.equal(data.done, true);
  const added = store.addFile("IMG_99999.jpg");
  await a.coord.reconcileIfDone();
  const last = a.ui.renders.at(-1);
  assert.equal(last.done, false);
  assert.equal(last.id, added);
});

test("running out of files and nothing new: reports done", async () => {
  const store = new FakeStore();
  store.addMany(1);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  await a.sorter.accept();
  await a.coord.reconcileIfDone();
  assert.equal(a.ui.renders.at(-1).done, true);
  assert.equal(a.ui.overlay, false);
});

test("start over clears the group's progress and redraws", async () => {
  const store = new FakeStore();
  store.addMany(4);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  await a.sorter.accept();
  await a.sorter.accept();
  await a.coord.restart();
  assert.equal(a.ui.renders.at(-1).remaining, 4);
  assert.equal(a.ui.overlay, false);
});

// ---------- the scenario from real use ----------

test("end to end: when someone leaves, their decided files are NOT handed to the person who stays", async () => {
  const store = new FakeStore();
  store.addMany(80);
  const a = stack(store, "aaa");
  const b = stack(store, "bbb");
  await a.coord.open("root", "root");
  await b.coord.open("root", "root");
  await waitFor(() => a.ui.shown.length === 1 && !a.ui.overlay && a.sorter.activeSessions.length === 2);

  // b works through part of its share, keeping some and rejecting others.
  const decided = [];
  for (let i = 0; i < 3; i++) { decided.push((await b.sorter.current()).id); await b.sorter.accept(); }
  for (let i = 0; i < 2; i++) { decided.push((await b.sorter.current()).id); await b.sorter.reject(); }
  await b.sorter._settlePendingMoves();
  const undecidedOfB = [...queueIds(b)];
  await b.coord.close(); // saves b's progress and leaves

  await waitFor(() => a.ui.shown.length === 2 && !a.ui.overlay, 3000, "a to absorb b's share");
  const mine = queueIds(a);
  for (const id of decided) assert.equal(mine.has(id), false, "a was handed a file b already decided");
  for (const id of undecidedOfB) assert.equal(mine.has(id), true, "a should now own b's still-pending files");
  assert.equal(mine.size, 80 - decided.length);
});

test("end to end: nobody is shown a repeated message across a whole join/leave/rejoin story", async () => {
  const store = new FakeStore({ latencyMs: 2, jitterMs: 6 });
  store.addMany(120);
  const a = stack(store, "aaa");
  await a.coord.open("root", "root");
  const b = stack(store, "bbb");
  await b.coord.open("root", "root");
  const c = stack(store, "ccc");
  await c.coord.open("root", "root");
  await waitFor(() => a.sorter.activeSessions.length === 3 && !a.ui.overlay, 3000);
  await b.coord.close();
  await waitFor(() => a.sorter.activeSessions.length === 2 && !a.ui.overlay, 3000);
  await sleep(600);
  // joined (b), joined (c) [possibly coalesced], left (b): never more than one message per real event
  assert.ok(a.ui.shown.length <= 3, `too many messages: ${a.ui.shown.join(" | ")}`);
  assert.equal(a.ui.nestedShows, 0);
  const shares = [queueIds(a), queueIds(c)];
  assert.equal(shares[0].size + shares[1].size, 120);
});
