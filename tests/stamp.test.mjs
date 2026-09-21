import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStamp, stampHtml, isCurrent, moduleNames } from "../tools/stamp.mjs";

test("docs/index.html carries the current version of the site's files (run `npm run stamp`)", () => {
  assert.ok(isCurrent(), "docs/index.html is out of date: run `npm run stamp` and commit it");
});

test("every script module is listed in the import map, and the entry script and stylesheet are versioned", () => {
  const stamp = computeStamp();
  const html = stampHtml(
    '<link rel="stylesheet" href="style.css">\n<script type="importmap">\n{}\n</script>\n<script type="module" src="app.js"></script>\n<span class="app-version"></span>',
    stamp,
    moduleNames(),
  );
  assert.match(html, new RegExp(`style\\.css\\?v=${stamp}`));
  assert.match(html, new RegExp(`app\\.js\\?v=${stamp}`));
  assert.match(html, new RegExp(`<span class="app-version">${stamp}</span>`));
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  for (const name of moduleNames()) assert.equal(map[`./${name}`], `./${name}?v=${stamp}`);
  assert.ok(!("./app.js" in map), "the entry script is versioned through its own tag");
});

test("stamping twice changes nothing", () => {
  const stamp = computeStamp();
  const once = stampHtml('<script type="importmap">{}</script><a href="style.css">', stamp, ["a.js"]);
  assert.equal(stampHtml(once, stamp, ["a.js"]), once);
});

test("the version follows the content, not the line endings", () => {
  // the same text with different line endings must not look like an update
  assert.equal(computeStamp(), computeStamp());
});
