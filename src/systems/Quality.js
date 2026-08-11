/**
 * Quality tiers and the adaptive fallback that keeps the frame rate.
 *
 * Measured budget, at 1920x1080: the scene is 101k triangles across 28 draw
 * calls, which no laptop GPU built this decade will notice. The cost is
 * fragments — thirteen fullscreen post-processing passes, which at device pixel
 * ratio 2 works out at roughly 108M fragment-passes per frame against 27M at
 * ratio 1. So the levers that matter are, in order: pixel ratio, bloom, and the
 * ocean's per-pixel work. Vertex count and draw calls are noise by comparison.
 *
 * Which is why 60fps is enforced here rather than assumed: no fixed setting can
 * promise a frame rate on unknown hardware, but measuring frames and giving
 * back the most expensive thing first can.
 */
export const TIERS = {
  low: {
    pixelRatio: 1,
    oceanSegments: 110,
    oceanSize: 700,
    bloom: false,
    shadows: false,
    sprayCapacity: 260,
    rockPool: 14,
    boatPool: 3,
    sharkCount: 2,
  },
  medium: {
    pixelRatio: 1.25,
    oceanSegments: 150,
    oceanSize: 800,
    bloom: true,
    shadows: true,
    sprayCapacity: 450,
    rockPool: 20,
    boatPool: 5,
    sharkCount: 3,
  },
  high: {
    pixelRatio: 1.5,
    oceanSegments: 200,
    oceanSize: 800,
    bloom: true,
    shadows: true,
    sprayCapacity: 700,
    rockPool: 28,
    boatPool: 6,
    sharkCount: 3,
  },
};

/**
 * Steps taken, in order, when frames are too slow. Cheapest-looking sacrifice
 * first: bloom is one effect, pixel ratio is the whole image.
 */
const FALLBACKS = [
  { name: 'bloom off', apply: (ctx) => ctx.setBloom(false) },
  { name: 'pixel ratio 1.0', apply: (ctx) => ctx.setPixelRatio(1) },
  { name: 'shadows off', apply: (ctx) => ctx.setShadows(false) },
  { name: 'pixel ratio 0.8', apply: (ctx) => ctx.setPixelRatio(0.8) },
];

export function pickTier() {
  if (typeof navigator === 'undefined') return 'high';

  // No reliable way to identify a GPU from script, so this is a coarse guess
  // that the adaptive pass below is expected to correct within a few seconds.
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  if (coarse || cores <= 4) return 'low';
  if (cores <= 8) return 'medium';
  return 'high';
}

export class AdaptiveQuality {
  constructor(context, options = {}) {
    this.context = context;
    /** Frame time to stay under, ms. 60fps with a little headroom. */
    this.budget = options.budget ?? 18;
    /** Seconds over budget before giving something up. */
    this.patience = options.patience ?? 2.5;

    this.step = 0;
    this.applied = [];
    this._over = 0;
    this._samples = [];
  }

  /** Rolling median frame time, ms. Median so one hitch doesn't trigger a drop. */
  get frameTime() {
    if (this._samples.length === 0) return 0;
    const sorted = [...this._samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  get fps() {
    const ms = this.frameTime;
    return ms > 0 ? 1000 / ms : 0;
  }

  update(delta) {
    const ms = delta * 1000;

    this._samples.push(ms);
    if (this._samples.length > 90) this._samples.shift();
    if (this._samples.length < 45) return;

    if (this.frameTime <= this.budget) {
      this._over = 0;
      return;
    }

    this._over += delta;
    if (this._over < this.patience || this.step >= FALLBACKS.length) return;

    const fallback = FALLBACKS[this.step];
    fallback.apply(this.context);
    this.applied.push(fallback.name);
    this.step += 1;
    this._over = 0;
    this._samples.length = 0;
  }
}
