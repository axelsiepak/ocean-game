/**
 * What the game is currently doing, and how a session ends.
 *
 * Until now there was no such thing as a run: the loop started surfing
 * immediately and never stopped, which is fine for a sandbox but leaves
 * nothing to put on a results screen. A run gives the session a shape —
 * a beginning, a clock, and a final number.
 */
export const State = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  RESULTS: 'results',
};

export class Run {
  constructor(options = {}) {
    /** Seconds in a timed run. */
    this.duration = options.duration ?? 120;
    this.state = State.MENU;
    /** Null in free surf, where there's no clock. */
    this.remaining = null;
    this.results = null;

    this.onStateChange = options.onStateChange ?? null;
  }

  get playing() {
    return this.state === State.PLAYING;
  }

  /** True when the world should keep animating — menus play over a live sea. */
  get animating() {
    return this.state === State.MENU || this.state === State.PLAYING;
  }

  get timed() {
    return this.remaining !== null;
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    if (this.onStateChange) this.onStateChange(state, this);
  }

  begin({ timed = true } = {}) {
    this.remaining = timed ? this.duration : null;
    this.results = null;
    this._set(State.PLAYING);
  }

  pause() {
    if (this.state === State.PLAYING) this._set(State.PAUSED);
  }

  resume() {
    if (this.state === State.PAUSED) this._set(State.PLAYING);
  }

  togglePause() {
    if (this.state === State.PLAYING) this.pause();
    else if (this.state === State.PAUSED) this.resume();
  }

  /** Ends the run and freezes a summary for the results screen. */
  finish(scoring) {
    if (this.state === State.RESULTS) return;

    this.results = scoring.summary();
    this.results.elapsed = this.timed ? this.duration - Math.max(this.remaining, 0) : null;
    this._set(State.RESULTS);
  }

  toMenu() {
    this.remaining = null;
    this._set(State.MENU);
  }

  update(delta, scoring) {
    if (this.state !== State.PLAYING || !this.timed) return;

    this.remaining -= delta;
    if (this.remaining <= 0) {
      this.remaining = 0;
      this.finish(scoring);
    }
  }
}
