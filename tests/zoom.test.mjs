import { test } from "node:test";
import assert from "node:assert/strict";
import { Zoom, MAX_SCALE, TAP_ZOOM } from "../docs/zoom.js";

const box = { w: 400, h: 800 };
const fit = { w: 400, h: 600 }; // a landscape-ish photo with bars above and below
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("starts unzoomed and produces no transform", () => {
  const z = new Zoom();
  assert.equal(z.active, false);
  assert.equal(z.css(), "");
});

test("pinching keeps the point under the fingers where it was", () => {
  const z = new Zoom();
  const focal = { x: 60, y: -120 };
  z.beginPinch(focal);
  z.pinchTo(2, focal, box, fit);
  // the photo point that was at `focal` at scale 1 is at focal * 1 (offset from centre)
  // now: screen = translate + scale * content -> content = focal
  near(z.x + z.scale * focal.x, focal.x);
  near(z.y + z.scale * focal.y, focal.y);
  assert.equal(z.scale, 2);
});

test("moving the fingers while pinching pans the photo with them", () => {
  const z = new Zoom();
  z.beginPinch({ x: 0, y: 0 });
  z.pinchTo(2, { x: 0, y: 0 }, box, fit);
  const before = z.x;
  z.pinchTo(2, { x: 40, y: 0 }, box, fit);
  near(z.x - before, 40);
});

test("zoom is limited to the maximum", () => {
  const z = new Zoom();
  z.beginPinch({ x: 0, y: 0 });
  z.pinchTo(100, { x: 0, y: 0 }, box, fit);
  assert.equal(z.scale, MAX_SCALE);
});

test("the photo can't be dragged past its own edges", () => {
  const z = new Zoom();
  z.zoomAt(2, { x: 0, y: 0 }, box, fit);
  z.panBy(10_000, 10_000, box, fit);
  // scaled photo is 800 wide in a 400 box -> 200 of travel; 1200 tall in 800 -> 200
  near(z.x, 200);
  near(z.y, 200);
  z.panBy(-10_000, -10_000, box, fit);
  near(z.x, -200);
  near(z.y, -200);
});

test("a photo smaller than the box in one direction stays centred in it", () => {
  const z = new Zoom();
  z.zoomAt(1.2, { x: 0, y: 0 }, box, fit); // 720 tall in an 800 box: no vertical travel
  z.panBy(0, 500, box, fit);
  assert.equal(z.y, 0);
});

test("wheel zoom keeps the point under the cursor still", () => {
  const z = new Zoom();
  const cursor = { x: -90, y: 70 };
  z.zoomAt(1.5, cursor, box, fit);
  z.zoomAt(1.5, cursor, box, fit);
  near(z.x + z.scale * cursor.x, cursor.x, 1e-6);
});

test("zooming back out to 1 returns to the exact unzoomed state", () => {
  const z = new Zoom();
  z.zoomAt(3, { x: 100, y: 100 }, box, fit);
  z.zoomAt(1 / 3, { x: 100, y: 100 }, box, fit);
  assert.equal(z.active, false);
  assert.equal(z.x, 0);
  assert.equal(z.y, 0);
  assert.equal(z.css(), "");
});

test("a pinch that ends almost unzoomed snaps back to normal", () => {
  const z = new Zoom();
  z.beginPinch({ x: 30, y: 30 });
  z.pinchTo(1.02, { x: 30, y: 30 }, box, fit);
  z.endPinch();
  assert.equal(z.scale, 1);
  assert.equal(z.x, 0);
});

test("double tap zooms in on the spot, and a second one zooms out", () => {
  const z = new Zoom();
  z.toggleAt({ x: 50, y: 20 }, box, fit);
  assert.equal(z.scale, TAP_ZOOM);
  z.toggleAt({ x: 50, y: 20 }, box, fit);
  assert.equal(z.active, false);
});

test("refit keeps the position legal after the window shrinks", () => {
  const z = new Zoom();
  z.zoomAt(2, { x: 0, y: 0 }, box, fit);
  z.panBy(200, 200, box, fit);
  const smaller = { w: 300, h: 500 };
  z.refit(smaller, { w: 300, h: 400 });
  assert.ok(Math.abs(z.x) <= (300 * 2 - 300) / 2 + 1e-9);
  assert.ok(Math.abs(z.y) <= (400 * 2 - 500) / 2 + 1e-9);
});
