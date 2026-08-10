/** Says *why* you went down, so the failure is something you can learn from. */
const WIPEOUT_LABELS = {
  rail: 'Lost the rail',
  back: 'Off the back',
  foam: 'Caught inside',
  landing: 'Buried a rail',
  rock: 'Hit a rock',
};

/**
 * Speed and wipeout readout.
 *
 * Reads the board's public state each frame; the surfboard knows nothing about
 * it, same arrangement as the spray.
 *
 * The meter carries a tick at the wipeout threshold, which turns the HUD into
 * something you actually steer by: past the mark, slamming full lock will wash
 * you out. Without it the speed number is just trivia.
 */
export class Hud {
  constructor(options = {}) {
    /** Top of the meter's range, m/s. Above this the bar simply pins full. */
    this.maxSpeed = options.maxSpeed ?? 15;

    this.scoreboard = document.createElement('div');
    this.scoreboard.className = 'hud-score';
    this.scoreboard.innerHTML = `
      <div class="hud-score__value">0</div>
      <div class="hud-clock" hidden><span id="hud-clock-value">0:00</span></div>
      <div class="hud-combo" hidden>
        <span class="hud-combo__multiplier">x1.0</span>
        <div class="hud-combo__bar"><div class="hud-combo__fill"></div></div>
      </div>
      <div class="hud-trick" hidden><span class="hud-trick__name"></span><span class="hud-trick__points"></span></div>
      <div class="hud-muted" hidden>Muted</div>
    `;

    this._score = this.scoreboard.querySelector('.hud-score__value');
    this._combo = this.scoreboard.querySelector('.hud-combo');
    this._multiplier = this.scoreboard.querySelector('.hud-combo__multiplier');
    this._comboFill = this.scoreboard.querySelector('.hud-combo__fill');
    this._trick = this.scoreboard.querySelector('.hud-trick');
    this._trickName = this.scoreboard.querySelector('.hud-trick__name');
    this._trickPoints = this.scoreboard.querySelector('.hud-trick__points');
    this._muted = this.scoreboard.querySelector('.hud-muted');
    this._clock = this.scoreboard.querySelector('.hud-clock');
    this._clockValue = this.scoreboard.querySelector('#hud-clock-value');

    document.body.appendChild(this.scoreboard);

    this.element = document.createElement('div');
    this.element.className = 'hud-readout';
    this.element.innerHTML = `
      <div class="hud-readout__speed">
        <span class="hud-readout__value">0.0</span><span class="hud-readout__unit">m/s</span>
      </div>
      <div class="hud-meter">
        <div class="hud-meter__fill"></div>
        <div class="hud-meter__mark" hidden></div>
      </div>
      <div class="hud-pocket" hidden>
        <span class="hud-pocket__label">In the pocket</span>
        <div class="hud-pocket__bar"><div class="hud-pocket__fill"></div></div>
      </div>
      <div class="hud-status" hidden>
        <span class="hud-status__label">Wipeout</span>
        <div class="hud-status__bar"><div class="hud-status__fill"></div></div>
      </div>
    `;

    this._value = this.element.querySelector('.hud-readout__value');
    this._fill = this.element.querySelector('.hud-meter__fill');
    this._mark = this.element.querySelector('.hud-meter__mark');
    this._status = this.element.querySelector('.hud-status');
    this._statusLabel = this.element.querySelector('.hud-status__label');
    this._statusFill = this.element.querySelector('.hud-status__fill');
    this._pocket = this.element.querySelector('.hud-pocket');
    this._pocketLabel = this.element.querySelector('.hud-pocket__label');
    this._pocketFill = this.element.querySelector('.hud-pocket__fill');

    // Cached so the DOM is only touched when something actually changed —
    // otherwise this writes layout-triggering styles 60 times a second.
    this._lastText = '';
    this._lastFill = -1;
    this._lastRecovery = -1;
    this._lastFast = null;
    this._lastDown = null;
    this._lastReason = null;
    this._lastPocket = -1;
    this._lastInPocket = null;
    this._markAt = null;
    this._lastScore = '';
    this._lastCombo = null;
    this._lastMultiplier = '';
    this._lastRemaining = -1;
    this._lastBanner = undefined;
    this._lastMuted = null;
    this._lastClock = '';

    document.body.appendChild(this.element);
  }

  /**
   * The run clock. Hidden in free surf, where there isn't one, and counted in
   * whole seconds so it isn't a blur of digits.
   */
  setRun(run) {
    const show = run.playing && run.timed;

    if (show) {
      const seconds = Math.max(0, Math.ceil(run.remaining));
      const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

      if (text !== this._lastClock) {
        this._clockValue.textContent = text;
        this._lastClock = text;
      }
      this._clock.classList.toggle('is-low', seconds <= 10);
    }

    if (show !== !this._clock.hidden) this._clock.hidden = !show;
  }

  /** Score, multiplier and the trick banner. Same change-guarded writes. */
  _updateScore(scoring) {
    const score = Math.floor(scoring.score).toLocaleString('en-US');
    if (score !== this._lastScore) {
      this._score.textContent = score;
      this._lastScore = score;
    }

    const live = scoring.combo > 0;
    if (live !== this._lastCombo) {
      this._combo.hidden = !live;
      this._lastCombo = live;
    }

    if (live) {
      const multiplier = `x${scoring.multiplier.toFixed(1)}`;
      if (multiplier !== this._lastMultiplier) {
        this._multiplier.textContent = multiplier;
        this._lastMultiplier = multiplier;
      }

      // Draining bar: how long is left to land the next one.
      const remaining = Math.round(scoring.comboRemaining * 100);
      if (remaining !== this._lastRemaining) {
        this._comboFill.style.width = `${remaining}%`;
        this._lastRemaining = remaining;
      }
    }

    const banner = scoring.lastTrick;
    if (banner !== this._lastBanner) {
      this._trick.hidden = !banner;
      if (banner) {
        this._trickName.textContent = banner;
        this._trickPoints.textContent = `+${scoring.lastPoints}`;
      }
      this._lastBanner = banner;
    }
  }

  update(board, scoring, audio) {
    if (scoring) this._updateScore(scoring);

    if (audio && audio.muted !== this._lastMuted) {
      this._muted.hidden = !audio.muted;
      this._lastMuted = audio.muted;
    }

    const speed = board.speed;

    const text = speed.toFixed(1);
    if (text !== this._lastText) {
      this._value.textContent = text;
      this._lastText = text;
    }

    // Rounded to whole percent: sub-pixel bar changes aren't visible, and this
    // keeps the style write out of most frames.
    const fill = Math.round(Math.min(speed / this.maxSpeed, 1) * 100);
    if (fill !== this._lastFill) {
      this._fill.style.width = `${fill}%`;
      this._lastFill = fill;
    }

    // Amber past the point where a hard turn becomes a wipeout.
    const threshold = board.wipeoutsEnabled ? board.wipeoutMinSpeed : Infinity;
    const fast = speed >= threshold;
    if (fast !== this._lastFast) {
      this.element.classList.toggle('is-fast', fast);
      this._lastFast = fast;
    }

    if (this._markAt !== threshold) {
      this._markAt = threshold;
      const visible = Number.isFinite(threshold) && threshold < this.maxSpeed;
      this._mark.hidden = !visible;
      if (visible) this._mark.style.left = `${(threshold / this.maxSpeed) * 100}%`;
    }

    // Pocket meter. Only shown once there's something to show, so it doesn't
    // sit at zero nagging you while you're paddling out.
    // One row, two states. A barrel outranks the pocket — you're always in the
    // pocket when you're in a barrel, and only one of them is worth saying.
    const inPocket = board.pocket > 0.15 && board.wipeout <= 0;
    const inBarrel = Boolean(board.inBarrel) && board.wipeout <= 0;
    const state = inBarrel ? 'barrel' : inPocket ? 'pocket' : 'none';

    if (state !== this._lastInPocket) {
      this._pocket.hidden = state === 'none';
      this._pocketLabel.textContent = inBarrel ? 'In the barrel' : 'In the pocket';
      this._pocket.classList.toggle('is-barrel', inBarrel);
      this._lastInPocket = state;
    }

    if (state !== 'none') {
      const engagement = Math.round((inBarrel ? board.barrel : board.pocket) * 100);
      if (engagement !== this._lastPocket) {
        this._pocketFill.style.width = `${engagement}%`;
        this._lastPocket = engagement;
      }
    }

    const down = board.wipeout > 0;
    if (down !== this._lastDown) {
      this._status.hidden = !down;
      this.element.classList.toggle('is-down', down);
      this._lastDown = down;
    }

    if (down && board.wipeoutReason !== this._lastReason) {
      this._statusLabel.textContent = WIPEOUT_LABELS[board.wipeoutReason] ?? 'Wipeout';
      this._lastReason = board.wipeoutReason;
    }

    if (down) {
      // Counts up as the board recovers, so the bar reads as "getting back up"
      // rather than as a timer running out.
      const recovery = Math.round((1 - board.wipeout) * 100);
      if (recovery !== this._lastRecovery) {
        this._statusFill.style.width = `${recovery}%`;
        this._lastRecovery = recovery;
      }
    }
  }

  dispose() {
    this.element.remove();
    this.scoreboard.remove();
  }
}
