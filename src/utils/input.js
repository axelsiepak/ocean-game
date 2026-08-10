/**
 * Minimal keyboard state tracker. Reads as an axis pair so entities don't have
 * to care which physical keys are bound.
 */
const KEY_MAP = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'trick',
};

export class Input {
  constructor(target = window) {
    this.pressed = new Set();
    /** Actions pressed since they were last consumed — see wasPressed(). */
    this._edge = new Set();

    /**
     * Axes contributed by something other than the keyboard — touch, a gamepad,
     * a replay. Summed with the keys, so both work at once and nothing
     * downstream has to know which is driving.
     */
    this.external = { horizontal: 0, vertical: 0 };
    /** Cleared while the game isn't taking input, e.g. in a menu. */
    this.enabled = true;

    this._onKeyDown = (event) => {
      const action = KEY_MAP[event.code];
      if (action) {
        // Ignore the OS key-repeat storm: a held key is one press, not thirty.
        if (!event.repeat) this._edge.add(action);
        this.pressed.add(action);
        event.preventDefault();
      }
    };
    this._onKeyUp = (event) => {
      const action = KEY_MAP[event.code];
      if (action) this.pressed.delete(action);
    };
    this._onBlur = () => {
      this.pressed.clear();
      this._edge.clear();
    };

    this._target = target;
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  isDown(action) {
    return this.pressed.has(action);
  }

  /**
   * True once per physical press, then false until the key is released and hit
   * again. For one-shot actions like firing a trick, where `isDown` would
   * retrigger every frame the key is held.
   */
  wasPressed(action) {
    if (!this.enabled) return false;
    return this._edge.delete(action);
  }

  /** -1 (left) .. 1 (right) */
  get horizontal() {
    if (!this.enabled) return 0;
    const keys = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    return clamp(keys + this.external.horizontal);
  }

  /** -1 (back) .. 1 (forward) */
  get vertical() {
    if (!this.enabled) return 0;
    const keys = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);
    return clamp(keys + this.external.vertical);
  }

  /** Queues a one-shot from a non-keyboard source. */
  pressExternal(action) {
    if (this.enabled) this._edge.add(action);
  }

  /** Drops everything held — call when handing control to a menu. */
  clear() {
    this.pressed.clear();
    this._edge.clear();
    this.external.horizontal = 0;
    this.external.vertical = 0;
  }

  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }
}

function clamp(value) {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}
