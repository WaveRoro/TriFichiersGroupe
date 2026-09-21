import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveSorter, ensureNamedChild, stableHash, ownerIndex, PRESENCE_DIRNAME, KEPT_DIRNAME } from "../docs/sorter.js";
import { FakeStore } from "./fake-drive.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each user is also a distinct device (own progress file), like real life.
async function open(store, user = "owner", opts = {}) {
  const sorter = new DriveSorter(store.client(user), { saveDebounceMs: 10, deviceId: user, ...opts });
  await sorter.loadFolder("root", "root");
  return sorter;
}

const idKey = (store, name) => `id:${store.named("root", name)[0].id}`;
const keptFolder = (store) => store.named("root", KEPT_DIRNAME)[0];
const keptFile = (store, device) => keptFolder(store) && store.named(keptFolder(store).id, `k_${device}.json`)[0];
const keptOf = (store, device) => {
  const f = keptFile(store, device);
  return f ? JSON.parse(f.content).kept : null;
};
const allKeptOnDrive = (store) => {
  const folder = keptFolder(store);
  const out = new Set();
  if (folder) for (const f of store.children(folder.id)) for (const rel of JSON.parse(f.content).kept) out.add(rel);
  return out;
};

// ---------- multi-user split ----------

test("every file has exactly one owner, whatever the number of sessions", () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `id${String(i).padStart(6, "0")}`);
  for (const n of [2, 3, 4, 5, 7]) {
    const counts = new Array(n).fill(0);
    for (const id of ids) counts[ownerIndex(id, n)]++;
    assert.equal(counts.reduce((a, b) => a + b, 0), ids.length);
  }
});

test("the split is close to equal on a realistic folder (6000 files)", () => {
  // Deterministic pseudo-random Drive-like ids (a seeded generator, so this
  // test can never flake): hashing balances statistically, not exactly.
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0).toString(36);
  const ids = Array.from({ length: 6000 }, () => `1${next()}${next()}${next()}`);
  for (const n of [2, 3, 4, 5]) {
    const counts = new Array(n).fill(0);
    for (const id of ids) counts[ownerIndex(id, n)]++;
    const ideal = ids.length / n;
    for (const c of counts) assert.ok(Math.abs(c - ideal) / ideal < 0.08, `n=${n}: ${counts} is too lopsided`);
  }
});

test("sequential ids (worst case for a naive hash) still spread evenly across 3 sessions", () => {
  const counts = [0, 0, 0];
  for (let i = 0; i < 3000; i++) counts[ownerIndex(`id${String(i).padStart(6, "0")}`, 3)]++;
  for (const c of counts) assert.ok(Math.abs(c - 1000) < 100, `got ${counts}`);
});

test("stableHash is deterministic", () => {
  assert.equal(stableHash("abc"), stableHash("abc"));
  assert.notEqual(stableHash("abc"), stableHash("abd"));
});

test("two sessions get disjoint shares that together cover every file", async () => {
  const store = new FakeStore();
  store.addMany(300);
  const a = await open(store, "alice");
  const b = await open(store, "bob");
  a.setPresence("A", ["A", "B"]);
  b.setPresence("B", ["A", "B"]);
  const mineA = new Set(a.queue.map((f) => f.id));
  const mineB = new Set(b.queue.map((f) => f.id));
  assert.equal([...mineA].filter((id) => mineB.has(id)).length, 0, "no file in both queues");
  assert.equal(mineA.size + mineB.size, 300, "no file in neither queue");
  assert.ok(mineA.size > 100 && mineB.size > 100);
});

test("the split does not shift when the two sessions' file lists differ by one file", async () => {
  // Regression: with position-based assignment, one session having already
  // trashed a file the other still listed flipped ownership of EVERY later file.
  const store = new FakeStore();
  const ids = store.addMany(400);
  const a = await open(store, "alice");
  a.setPresence("A", ["A", "B"]);
  const before = new Map(a.allFiles.map((f) => [f.id, a._isMine(f)]));
  const trash = store.addFolder("_trash");
  store.files.get(ids[3]).parents = [trash]; // B trashed a file early in the list
  await a.refresh();
  a.setPresence("A", ["A", "B"]);
  for (const f of a.allFiles) assert.equal(a._isMine(f), before.get(f.id), `ownership of ${f.name} moved`);
});

test("someone alone owns everything", async () => {
  const store = new FakeStore();
  store.addMany(50);
  const s = await open(store);
  s.setPresence("A", ["A"]);
  assert.equal(s.queue.length, 50);
});

test("setPresence always counts the caller itself", async () => {
  const store = new FakeStore();
  store.addMany(50);
  const s = await open(store);
  s.setPresence("A", ["B", "C"]);
  assert.deepEqual(s.activeSessions, ["A", "B", "C"]);
});

// ---------- progress files ----------

test("accepts are batched into one save instead of one upload per swipe", async () => {
  const store = new FakeStore();
  store.addMany(10);
  const s = await open(store);
  for (let i = 0; i < 6; i++) await s.accept();
  await sleep(80);
  const writes = (s.drive.calls.createTextFile || 0) + (s.drive.calls.writeTextFile || 0);
  assert.equal(writes, 1);
  assert.equal(keptOf(store, "owner").length, 6);
});

test("each device only ever writes its own file", async () => {
  const store = new FakeStore();
  store.addMany(20);
  const a = await open(store, "alice");
  const b = await open(store, "bob");
  await a.accept();
  await a.flushSaves();
  await b.accept(); // b's first decision is the same first file as a's - irrelevant here
  await b.skipNow();
  await b.accept();
  await b.flushSaves();
  const fileA = keptFile(store, "alice");
  const fileB = keptFile(store, "bob");
  assert.notEqual(fileA.id, fileB.id);
  assert.equal(JSON.parse(fileA.content).kept.length, 1, "b's saves never touched a's file");
});

test("two devices saving at the same moment lose nothing", async () => {
  // Regression: the earlier single shared file lost updates whenever two
  // saves overlapped (read, read, write, write).
  const store = new FakeStore({ latencyMs: 2, jitterMs: 6 });
  store.addMany(60);
  const a = await open(store, "alice");
  const b = await open(store, "bob");
  a.setPresence("A", ["A", "B"]);
  b.setPresence("B", ["A", "B"]);
  const decided = [];
  for (let i = 0; i < 12; i++) {
    decided.push(`id:${a.queue[a.index].id}`, `id:${b.queue[b.index].id}`);
    await Promise.all([a.accept(), b.accept()]);
    if (i % 3 === 2) await Promise.all([a.flushSaves(), b.flushSaves()]);
  }
  await Promise.all([a.flushSaves(), b.flushSaves()]);
  const persisted = allKeptOnDrive(store);
  for (const key of decided) assert.ok(persisted.has(key), `${key} was lost`);
  assert.equal(persisted.size, 24);
});

test("undoing an accept removes it from this device's file", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const s = await open(store);
  await s.accept();
  await s.accept();
  await s.flushSaves();
  assert.equal(keptOf(store, "owner").length, 2);
  await s.undo();
  await s.flushSaves();
  assert.equal(keptOf(store, "owner").length, 1);
});

test("an undone accept is not resurrected by anyone else's copy", async () => {
  // Regression: with one shared file, another session's stale in-memory copy
  // wrote the undone decision straight back.
  const store = new FakeStore();
  store.addMany(5);
  const a = await open(store, "alice");
  await a.accept();
  await a.flushSaves();
  const b = await open(store, "bob"); // sees a's accept of IMG_00001
  assert.equal(b.kept.size, 1);
  await a.undo();
  await a.flushSaves();
  await b.accept(); // b's first pending file is now IMG_00002
  await b.flushSaves();
  assert.ok(!allKeptOnDrive(store).has(idKey(store, "IMG_00001.jpg")), "the undone decision was written back");
  assert.deepEqual([...allKeptOnDrive(store)], [idKey(store, "IMG_00002.jpg")]);
  await b.refresh();
  const first = b.allFiles.find((f) => f.name === "IMG_00001.jpg");
  assert.ok(!b.isKept(first), "and b forgets it once it looks again");
});

test("a failing save is retried automatically and eventually lands", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const s = await open(store);
  store.failNext("createFolder", 2);
  await s.accept();
  await sleep(400);
  assert.equal(keptOf(store, "owner")?.length, 1);
});

test("a save that keeps failing tells the user once", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const s = await open(store, "owner", { saveDebounceMs: 1 });
  const errors = [];
  s.onError = (m) => errors.push(m);
  store.failNext("createFolder", 1000);
  await s.accept();
  await sleep(500);
  assert.equal(errors.length, 1);
});

test("duplicate progress folders (a creation race) converge on the lowest id", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const d1 = store.client("alice");
  const d2 = store.client("bob");
  const make = (d) => ensureNamedChild(d, "root", KEPT_DIRNAME, () => d.createFolder(KEPT_DIRNAME, "root"));
  const [x, y] = await Promise.all([make(d1), make(d2)]);
  assert.equal(x, y);
});

test("progress spread across duplicate folders is still fully read", async () => {
  const store = new FakeStore();
  store.addMany(6);
  const f1 = store.addFolder(KEPT_DIRNAME);
  const f2 = store.addFolder(KEPT_DIRNAME);
  store.addFile("k_x.json", f1, { content: JSON.stringify({ kept: ["IMG_00001.jpg"] }) });
  store.addFile("k_y.json", f2, { content: JSON.stringify({ kept: ["IMG_00002.jpg"] }) });
  const s = await open(store);
  assert.equal(s.kept.size, 2);
  assert.equal(s.queue.length, 4);
});

test("the older single shared progress file is still read, so earlier progress survives", async () => {
  const store = new FakeStore();
  store.addMany(5);
  store.addFile(".photosorter_state.json", "root", { content: JSON.stringify({ kept: ["IMG_00001.jpg", "IMG_00002.jpg"] }) });
  const s = await open(store);
  assert.equal(s.kept.size, 2);
  assert.equal(s.queue.length, 3);
  await s.accept();
  await s.flushSaves();
  assert.equal(JSON.parse(store.named("root", ".photosorter_state.json")[0].content).kept.length, 2, "the old file is never rewritten");
});

test("a corrupt progress file is treated as empty rather than crashing", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const folder = store.addFolder(KEPT_DIRNAME);
  store.addFile("k_owner.json", folder, { content: "{not json" });
  const s = await open(store);
  assert.equal(s.kept.size, 0);
  assert.equal(s.queue.length, 3);
});

test("a network error while reading progress must NOT be treated as 'nothing kept'", async () => {
  // Regression: the read error used to be swallowed into an empty set, which
  // the next save then wrote over the real progress.
  const store = new FakeStore();
  store.addMany(6);
  const s = await open(store);
  await s.accept();
  await s.accept();
  await s.flushSaves();
  assert.equal(s.kept.size, 2);
  store.failNext("readTextFile", 1, Object.assign(new Error("offline"), { status: 503 }));
  await assert.rejects(() => s.refresh());
  assert.equal(s.kept.size, 2, "local knowledge is untouched by a failed refresh");
  assert.equal(keptOf(store, "owner").length, 2);
});

test("refresh keeps our own unsaved decisions and adds what others decided", async () => {
  const store = new FakeStore();
  store.addMany(20);
  const a = await open(store, "alice");
  const b = await open(store, "bob");
  await b.accept(); // first file
  await b.flushSaves();
  await a.skipNow();
  await a.accept(); // a different file, not saved yet (debounce)
  await a.refresh();
  assert.equal(a.kept.size, 2, "its own decision and b's");
  assert.ok(a.isKept(a.allFiles.find((f) => f.name === "IMG_00001.jpg")));
});

test("two files with the same name in one folder are decided independently", async () => {
  // Regression (found by driving the real UI): progress was keyed by path, so
  // keeping one of two same-named files silently marked the other as done and
  // it was never shown. Drive allows duplicate names in one folder.
  const store = new FakeStore();
  store.addFile("IMG_0001.jpg");
  store.addFile("IMG_0001.jpg");
  store.addFile("IMG_0002.jpg");
  const s = await open(store);
  assert.equal(s.queue.length, 3);
  await s.accept();
  assert.equal(s.queue.slice(s.index).length, 2, "only the file actually kept is gone");
  assert.equal((await s.current()).name, "IMG_0001.jpg", "its same-named twin is still to be sorted");
  const twin = (await s.current()).id;
  const b = await open(store, "bob");
  await s.flushSaves();
  await b.refresh();
  assert.ok(b.queue.some((f) => f.id === twin), "and other people still see it too");
});

test("progress written by earlier versions (plain paths) is still honoured", async () => {
  const store = new FakeStore();
  store.addMany(4);
  const folder = store.addFolder(KEPT_DIRNAME);
  store.addFile("k_other.json", folder, { content: JSON.stringify({ kept: ["IMG_00003.jpg"] }) });
  const s = await open(store);
  assert.equal(s.queue.length, 3);
  assert.ok(!s.queue.some((f) => f.name === "IMG_00003.jpg"));
});

test("saves are spaced further apart as the progress file grows", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const s = await open(store, "owner", { saveDebounceMs: 1500 });
  assert.equal(s._debounceMs(), 1500);
  for (let i = 0; i < 1000; i++) s._myKept.add(`id:x${i}`);
  assert.equal(s._debounceMs(), 5500);
  for (let i = 1000; i < 5000; i++) s._myKept.add(`id:x${i}`);
  assert.equal(s._debounceMs(), 15000, "capped, so a decision is never left unsaved for long");
});

// ---------- rejects / moves ----------

test("a rejected file never comes back when the filter changes (regression)", async () => {
  const store = new FakeStore();
  store.addMany(4);
  store.addFile("clip.mp4", "root", { mimeType: "video/mp4" });
  const s = await open(store);
  const first = (await s.current()).id;
  await s.reject();
  await s._settlePendingMoves();
  await s.setFilters(["image"]);
  assert.ok(!s.queue.some((f) => f.id === first), "rejected file reappeared");
  await s.setFilters([]);
  assert.ok(!s.queue.some((f) => f.id === first), "rejected file reappeared after clearing the filter");
});

test("refresh waits for in-flight moves so a file just rejected can't reappear", async () => {
  const store = new FakeStore({ latencyMs: 5 });
  store.addMany(6);
  const s = await open(store);
  const target = (await s.current()).id;
  await s.reject(); // move is still in flight
  await s.refresh();
  s.setPresence("A", ["A"]);
  assert.ok(!s.queue.some((f) => f.id === target));
  assert.equal(store.files.get(target).parents.includes("root"), false, "the move finished before the scan");
});

test("a move that fails is reported and the file stays available", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const s = await open(store);
  const errors = [];
  s.onError = (m) => errors.push(m);
  const target = (await s.current()).id;
  store.failNext("moveFile", 1, Object.assign(new Error("Drive API 500: boom"), { status: 500 }));
  await s.reject();
  await s._settlePendingMoves();
  assert.equal(errors.length, 1);
  assert.equal(s.trashedCount, 0);
  await s.setFilters([]);
  assert.ok(s.queue.some((f) => f.id === target), "failed reject puts the file back in play");
});

test("rejecting a file someone else already trashed is not an error", async () => {
  const store = new FakeStore();
  store.strictMove = true;
  store.addMany(3);
  const a = await open(store, "alice");
  const b = await open(store, "bob");
  const errors = [];
  b.onError = (m) => errors.push(m);
  await a.reject();
  await a._settlePendingMoves();
  await b.reject(); // b still lists the same first file
  await b._settlePendingMoves();
  assert.deepEqual(errors, []);
  assert.equal(b.trashedCount, 0, "it wasn't b's move, so b doesn't count it");
});

test("undoing a reject moves the file back and restores its name", async () => {
  const store = new FakeStore();
  store.addFile("a.jpg");
  store.addFile("b.jpg");
  const s = await open(store);
  const target = (await s.current()).id;
  await s.reject();
  await s.undo();
  assert.ok(store.files.get(target).parents.includes("root"));
  assert.equal(s.trashedCount, 0);
  assert.equal((await s.current()).id, target);
});

test("undo right after reject waits for the move instead of racing it", async () => {
  const store = new FakeStore({ latencyMs: 8 });
  store.addFile("a.jpg");
  store.addFile("b.jpg");
  const s = await open(store);
  const target = (await s.current()).id;
  await s.reject();
  await s.undo();
  assert.ok(store.files.get(target).parents.includes("root"));
  assert.equal(store.named("root", "_trash").length, 1);
});

test("two rejects in a brand-new folder create a single _trash folder", async () => {
  const store = new FakeStore({ latencyMs: 3, jitterMs: 3 });
  store.addMany(4);
  const s = await open(store);
  await s.reject();
  await s.reject();
  await s._settlePendingMoves();
  assert.equal(store.named("root", "_trash").length, 1);
  assert.equal(store.children(store.named("root", "_trash")[0].id).length, 2);
});

test("colliding names in the trash folder are kept distinct", async () => {
  const store = new FakeStore();
  store.addFile("same.jpg", "root");
  store.addFile("same.jpg", "root");
  const s = await open(store);
  await s.reject();
  await s.reject();
  await s._settlePendingMoves();
  const names = store.children(store.named("root", "_trash")[0].id).map((f) => f.name).sort();
  assert.deepEqual(names, ["same (1).jpg", "same.jpg"]);
});

// ---------- loading & scanning ----------

test("internal folders and files are never offered for sorting", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const presence = store.addFolder(PRESENCE_DIRNAME);
  store.addFile(".p_abc", presence);
  const kept = store.addFolder(KEPT_DIRNAME);
  store.addFile("k_abc.json", kept, { content: "{}" });
  store.addFile(".photosorter_state.json", "root", { content: "{}" });
  store.addFile(".photosorter_presence.json", "root", { content: "{}" });
  const s = await open(store);
  assert.equal(s.queue.length, 3);
});

test("files in the trash are counted, files in subfolders are found with their path", async () => {
  const store = new FakeStore();
  const sub = store.addFolder("2019");
  store.addFile("x.jpg", sub);
  const trash = store.addFolder("_trash");
  store.addFile("old1.jpg", trash);
  store.addFile("old2.jpg", trash);
  const s = await open(store);
  assert.equal(s.trashedCount, 2);
  assert.equal(s.queue[0].rel, "2019/x.jpg");
});

test("a failed load leaves the previous folder fully intact", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const s = await open(store);
  await s.accept();
  store.failNext("listChildren", 1, Object.assign(new Error("Drive API 403: nope"), { status: 403 }));
  await assert.rejects(() => s.loadFolder("root", "again"));
  assert.equal(s.rootId, "root");
  assert.equal(s.kept.size, 1);
  assert.equal(s.queue.length, 5);
});

test("switching folder saves the progress of the one being left", async () => {
  const store = new FakeStore();
  store.addMany(4);
  const other = store.addFolder("other");
  store.addFile("z.jpg", other);
  const s = await open(store, "owner", { saveDebounceMs: 60000 });
  await s.accept();
  await s.loadFolder(other, "other");
  assert.equal(keptOf(store, "owner").length, 1, "saved into the first folder, not lost or misfiled");
  assert.equal(store.named(other, KEPT_DIRNAME).length, 0);
});

test("resetProgress clears every progress file and isn't undone by a pending save", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const a = await open(store, "alice", { saveDebounceMs: 60000 });
  await a.accept();
  await a.flushSaves();
  const b = await open(store, "bob", { saveDebounceMs: 60000 });
  await b.skipNow();
  await b.accept();
  await b.resetProgress();
  await b.flushSaves();
  assert.equal(allKeptOnDrive(store).size, 0);
  assert.equal(b.queue.length, 5);
});

test("skipping moves the file to the end and undo puts it back", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const s = await open(store);
  const first = (await s.current()).id;
  await s.skipNow();
  assert.notEqual((await s.current()).id, first);
  assert.equal(s.queue.at(-1).id, first);
  await s.undo();
  assert.equal((await s.current()).id, first);
});

test("finishing the queue reports done", async () => {
  const store = new FakeStore();
  store.addMany(2);
  const s = await open(store);
  await s.accept();
  assert.equal((await s.accept()).done, true);
});

test("peekNewFileIds reports additions without applying them", async () => {
  const store = new FakeStore();
  store.addMany(3);
  const s = await open(store);
  assert.deepEqual(await s.peekNewFileIds(), []);
  const added = store.addFile("IMG_99999.jpg");
  assert.deepEqual(await s.peekNewFileIds(), [added]);
  assert.equal(s.knowsFile(added), false);
  await s.refresh();
  assert.equal(s.knowsFile(added), true);
  assert.deepEqual(await s.peekNewFileIds(), []);
});

test("loading never downloads a whole folder listing just to find a small file", async () => {
  const store = new FakeStore();
  store.addMany(5);
  const s = await open(store);
  assert.equal(s.drive.calls.findChildren, 2, "one name lookup each for the progress folder and the legacy file");
  assert.equal(s.drive.calls.listChildren, 1, "only the scan lists children");
});

// ---------- lookahead (feeds the card drawn underneath the current one) ----------

test("upcoming() describes the next files the way the card underneath displays them", async () => {
  const store = new FakeStore();
  store.addFile("a.jpg", "root", { size: 2048 });
  store.addFile("b.mp4", "root", { size: 3 * 1024 * 1024 });
  store.addFile("c.txt", "root", { size: 10 });
  const sorter = await open(store);
  const current = await sorter.current();
  const next = sorter.upcoming(2);
  assert.equal(next.length, 2);
  assert.ok(!next.some((f) => f.id === current.id), "the current file is not part of the lookahead");
  for (const f of next) {
    const source = store.files.get(f.id);
    assert.equal(f.name, source.name);
    assert.equal(f.ext, "." + source.name.split(".").pop());
    assert.ok(f.sizeH && f.kind);
  }
});
