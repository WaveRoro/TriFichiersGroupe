// Zoom and pan of the photo on screen, kept free of any page code so it can be
// tested: positions are offsets from the centre of the area the photo sits in
// (the "box"), and the photo itself is drawn centred with size `fit`.

export const MAX_SCALE = 6;
export const SNAP_BELOW = 1.04; // anything this close to 1 counts as "not zoomed"
export const TAP_ZOOM = 2.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// How far the photo may be moved from the centre at a given zoom: it can never
// be dragged so far that its edge leaves a gap inside the box. When it is
// smaller than the box in one direction it stays centred in that direction.
function limits(scale, box, fit) {
  return {
    x: Math.max(0, (fit.w * scale - box.w) / 2),
    y: Math.max(0, (fit.h * scale - box.h) / 2),
  };
}

export class Zoom {
  constructor() {
    this.reset();
  }

  reset() {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this._anchor = null;
  }

  get active() {
    return this.scale > SNAP_BELOW;
  }

  _apply(scale, x, y, box, fit) {
    const next = clamp(scale, 1, MAX_SCALE);
    const lim = limits(next, box, fit);
    this.scale = next;
    this.x = clamp(x, -lim.x, lim.x);
    this.y = clamp(y, -lim.y, lim.y);
  }

  // Two fingers went down at `focal`: remember which point of the photo lies
  // under them so it stays under them however they move.
  beginPinch(focal) {
    this._anchor = {
      scale: this.scale,
      cx: (focal.x - this.x) / this.scale,
      cy: (focal.y - this.y) / this.scale,
    };
  }

  // `ratio`: current finger distance over the distance when the pinch began.
  pinchTo(ratio, focal, box, fit) {
    if (!this._anchor) this.beginPinch(focal);
    const a = this._anchor;
    const scale = clamp(a.scale * ratio, 1, MAX_SCALE);
    this._apply(scale, focal.x - scale * a.cx, focal.y - scale * a.cy, box, fit);
  }

  endPinch() {
    this._anchor = null;
    if (!this.active) this.reset();
  }

  // Mouse wheel / trackpad pinch: zoom by `factor` keeping the point under the cursor still.
  zoomAt(factor, focal, box, fit) {
    const scale = clamp(this.scale * factor, 1, MAX_SCALE);
    const k = scale / this.scale;
    this._apply(scale, focal.x - (focal.x - this.x) * k, focal.y - (focal.y - this.y) * k, box, fit);
    if (!this.active) this.reset();
  }

  // Double click / double tap: back to normal if zoomed, otherwise in on the pointer.
  toggleAt(focal, box, fit) {
    if (this.active) this.reset();
    else this.zoomAt(TAP_ZOOM, focal, box, fit);
  }

  panBy(dx, dy, box, fit) {
    this._apply(this.scale, this.x + dx, this.y + dy, box, fit);
  }

  // The box or the photo changed size (window resized): keep the position legal.
  refit(box, fit) {
    this._apply(this.scale, this.x, this.y, box, fit);
    if (!this.active) this.reset();
  }

  css() {
    // Follows the fingers even in the first few percent of a pinch (where the
    // photo doesn't count as zoomed yet), so it doesn't jump when it does.
    if (this.scale === 1 && !this.x && !this.y) return "";
    return `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0) scale(${this.scale.toFixed(3)})`;
  }
}
