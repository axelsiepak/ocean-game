/**
 * Touch steering.
 *
 * One gesture does both axes: where your thumb sits relative to where it landed
 * is the stick. Sideways steers, up paddles, down drags a foot. A touch that
 * ends quickly without travelling is a tap, and taps throw a trick.
 *
 * Feeds the same axes the keyboard does, so nothing downstream knows or cares
 * which one is driving.
 */
export class TouchControls {
  constructor(input, options = {}) {
    this.input = input;
    /** Drag *past the dead zone*, in px, that gives full deflection. */
    this.range = options.range ?? 90;
    /** Movement under this, released quickly, is a tap rather than a drag. */
    this.tapSlop = options.tapSlop ?? 14;
    this.tapTime = options.tapTime ?? 250;
    /** Dead zone so resting a thumb doesn't creep the board sideways. */
    this.deadZone = options.deadZone ?? 8;

    this.element = options.element ?? document.body;
    this.enabled = options.enabled ?? true;

    this._pointer = null;

    this._onDown = (event) => {
      if (!this.enabled || event.pointerType !== 'touch' || this._pointer !== null) return;

      this._pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: performance.now(),
        moved: 0,
      };
      this.element.setPointerCapture?.(event.pointerId);
    };

    this._onMove = (event) => {
      const pointer = this._pointer;
      if (!pointer || event.pointerId !== pointer.id) return;

      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer.moved = Math.max(pointer.moved, Math.hypot(dx, dy));

      this.input.external.horizontal = this._axis(dx);
      // Screen Y grows downward; dragging up should paddle.
      this.input.external.vertical = this._axis(-dy);
    };

    this._onUp = (event) => {
      const pointer = this._pointer;
      if (!pointer || event.pointerId !== pointer.id) return;

      const quick = performance.now() - pointer.at < this.tapTime;
      if (quick && pointer.moved < this.tapSlop) this.input.pressExternal('trick');

      this.input.external.horizontal = 0;
      this.input.external.vertical = 0;
      this._pointer = null;
      this.element.releasePointerCapture?.(event.pointerId);
    };

    this.element.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  _axis(distance) {
    const past = Math.abs(distance) - this.deadZone;
    if (past <= 0) return 0;

    const magnitude = Math.min(past / this.range, 1);
    return Math.sign(distance) * magnitude;
  }

  /** Drops any held deflection — used when the game leaves the playing state. */
  release() {
    this._pointer = null;
    this.input.external.horizontal = 0;
    this.input.external.vertical = 0;
  }

  dispose() {
    this.element.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
  }
}

/** True on phones and tablets — anything whose primary pointer isn't precise. */
export function isTouchDevice() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
