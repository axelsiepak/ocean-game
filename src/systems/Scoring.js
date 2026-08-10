/**
 * Base value per trick. Ordered by what each actually costs you to pull off:
 * a hop is free, a snap costs speed, and a rotation off the lip can put you
 * on your back if you don't finish it.
 */
const TRICK_VALUES = {
  ollie: 40,
  snap: 90,
  cutback: 110,
  air: 150,
  spin: 260,
  alleyoop: 320,
};

const TRICK_NAMES = {
  ollie: 'Ollie',
  snap: 'Snap',
  cutback: 'Cutback',
  air: 'Air',
  spin: '360 Spin',
  alleyoop: 'Alley-oop',
};

/**
 * Score, combo and multiplier.
 *
 * Three things pay, and they're deliberately in tension:
 *
 * - **Tricks** pay a lump sum, but the big ones risk a wipeout.
 * - **Wave time** pays a trickle for every second actually riding, so
 *   surviving is always worth something even if you never press the button.
 * - **Combos** multiply both, and a wipeout takes the whole multiplier with
 *   it. The longer the run, the more there is to lose.
 *
 * Repeating one trick is deliberately weak: the multiplier grows on *distinct*
 * tricks as well as on count, so a varied run outscores a spammed one.
 */
export class Scoring {
  constructor(options = {}) {
    /** Points per second while riding a wave. */
    this.rideRate = options.rideRate ?? 12;
    /** Points per second while inside a barrel. The best thing in the game. */
    this.barrelRate = options.barrelRate ?? 70;
    /** Seconds after a trick before the combo lapses. */
    this.comboWindow = options.comboWindow ?? 3.5;
    /** Multiplier added per trick in the combo. */
    this.comboStep = options.comboStep ?? 0.5;
    /** Multiplier added per *distinct* trick in the combo. */
    this.varietyStep = options.varietyStep ?? 0.5;
    /** One-off bonus the first time a trick appears in a combo. */
    this.varietyBonus = options.varietyBonus ?? 75;
    this.maxMultiplier = options.maxMultiplier ?? 10;

    this.score = 0;
    this.combo = 0;
    this.best = 0;
    /** Set while a combo is live. */
    this.variety = new Set();
    /** Most recent trick, for the HUD to flash up. */
    this.lastTrick = null;
    this.lastPoints = 0;
    /** Total seconds spent inside barrels, for the run summary. */
    this.barrelTime = 0;
    /** Highest-scoring single trick of the run: { name, points }. */
    this.bestTrick = null;
    this.tricksLanded = 0;
    this.wipeouts = 0;

    this._timer = 0;
  }

  get multiplier() {
    const distinct = Math.max(this.variety.size - 1, 0);
    return Math.min(
      1 + this.combo * this.comboStep + distinct * this.varietyStep,
      this.maxMultiplier,
    );
  }

  /** Seconds of combo left, 0..1 of the window. Drives the HUD's timer bar. */
  get comboRemaining() {
    return this.combo > 0 ? Math.max(this._timer, 0) / this.comboWindow : 0;
  }

  /** Call when a trick lands cleanly. */
  land(type) {
    const base = TRICK_VALUES[type] ?? 50;
    const fresh = !this.variety.has(type);

    // Score at the multiplier *before* this trick raises it, so the reward
    // reflects the run you'd already built rather than the one it becomes.
    const points = Math.round((base + (fresh ? this.varietyBonus : 0)) * this.multiplier);

    this.score += points;
    this.combo += 1;
    this.variety.add(type);
    this._timer = this.comboWindow;

    this.lastTrick = TRICK_NAMES[type] ?? type;
    this.lastPoints = points;
    this.best = Math.max(this.best, this.combo);
    this.tricksLanded += 1;

    // Best trick is the biggest single payout, so it reflects the combo it was
    // landed in — a 360 deep in a varied run beats the same 360 cold.
    if (!this.bestTrick || points > this.bestTrick.points) {
      this.bestTrick = { name: this.lastTrick, points };
    }

    return points;
  }

  /** Call on a wipeout. The multiplier is the thing you actually lose. */
  drop(counts = false) {
    if (counts) this.wipeouts += 1;
    this.combo = 0;
    this.variety.clear();
    this._timer = 0;
    this.lastTrick = null;
    this.lastPoints = 0;
  }

  update(delta, board) {
    if (this.combo > 0) {
      this._timer -= delta;
      if (this._timer <= 0) this.drop();
    }

    // Wave time. Paid only while genuinely riding, so paddling around the flats
    // earns nothing — same judgement the board itself uses.
    if (board.riding && board.wipeout <= 0) {
      const rate = board.inBarrel ? this.barrelRate : this.rideRate;
      this.score += rate * this.multiplier * delta;

      if (board.inBarrel) this.barrelTime += delta;
    }
  }

  /** Frozen snapshot for the results screen. */
  summary() {
    return {
      score: Math.floor(this.score),
      bestTrick: this.bestTrick,
      bestCombo: this.best,
      tricksLanded: this.tricksLanded,
      barrelTime: this.barrelTime,
      wipeouts: this.wipeouts,
    };
  }

  reset() {
    this.score = 0;
    this.best = 0;
    this.barrelTime = 0;
    this.bestTrick = null;
    this.tricksLanded = 0;
    this.wipeouts = 0;
    this.drop();
  }
}
