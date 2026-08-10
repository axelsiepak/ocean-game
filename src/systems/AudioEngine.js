/**
 * All of the game's sound, synthesised.
 *
 * There are no audio files here and none are needed: surf, splash and whoosh
 * are all shaped noise, which the Web Audio API generates far more compactly
 * than any download. Two noise buffers are built once at start-up — brown for
 * the low rumble of the sea, white for spray and wind — and everything else is
 * filters and envelopes on top.
 *
 * Reads the board's public state; the surfboard knows nothing about it, the
 * same arrangement as the spray, the rider and the HUD.
 */
export class AudioEngine {
  constructor(options = {}) {
    this.masterVolume = options.masterVolume ?? 0.6;
    this.muteKey = options.muteKey ?? 'KeyM';

    /** Speed at which the whoosh starts and where it tops out, m/s. */
    this.whooshFrom = options.whooshFrom ?? 3;
    this.whooshTo = options.whooshTo ?? 13;
    /** Lateral g at which a turn's rush is at full volume. */
    this.carveFull = options.carveFull ?? 8;

    this.muted = options.muted ?? false;
    this.ready = false;

    this.context = null;
    this._nodes = null;

    this._onKeyDown = (event) => {
      if (event.code === this.muteKey) this.toggleMute();
    };
    window.addEventListener('keydown', this._onKeyDown);

    // Browsers refuse to start audio until the user has interacted with the
    // page, so the context is built on the first input rather than up front.
    this._unlock = () => this.start();
    window.addEventListener('pointerdown', this._unlock, { once: true });
    window.addEventListener('keydown', this._unlock, { once: true });
  }

  /** Builds a looping noise buffer. `brown` integrates it into a low rumble. */
  _noise(seconds, brown) {
    const { context } = this;
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
    const data = buffer.getChannelData(0);

    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;

      if (brown) {
        // Leaky integrator: the standard recipe for brown noise, which is what
        // makes it read as surf rather than as static.
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else {
        data[i] = white;
      }
    }

    return buffer;
  }

  _loop(buffer, destination) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(destination);
    source.start(this.context.currentTime + Math.random() * 0.05);
    return source;
  }

  /** Creates the graph. Safe to call repeatedly; only the first does anything. */
  start() {
    if (this.ready) {
      if (this.context.state === 'suspended') this.context.resume();
      return;
    }

    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) return;

    this.context = new Context();
    const context = this.context;

    const master = context.createGain();
    master.gain.value = this.muted ? 0 : this.masterVolume;
    master.connect(context.destination);

    // Long buffers so the loop point never becomes audible as a rhythm.
    const brown = this._noise(4, true);
    const white = this._noise(3, false);

    // --- Ambient sea -------------------------------------------------------
    const surfFilter = context.createBiquadFilter();
    surfFilter.type = 'lowpass';
    surfFilter.frequency.value = 900;
    surfFilter.Q.value = 0.7;

    const surfGain = context.createGain();
    surfGain.gain.value = 0.5;
    surfFilter.connect(surfGain);
    surfGain.connect(master);

    // Slow swell: the sea breathing rather than sitting at a constant level.
    const swell = context.createOscillator();
    swell.frequency.value = 0.07;
    const swellDepth = context.createGain();
    swellDepth.gain.value = 0.22;
    swell.connect(swellDepth);
    swellDepth.connect(surfGain.gain);
    swell.start();

    // A brighter hiss layer for the foam on top of the rumble.
    const foamFilter = context.createBiquadFilter();
    foamFilter.type = 'highpass';
    foamFilter.frequency.value = 1600;

    const foamGain = context.createGain();
    foamGain.gain.value = 0.045;
    foamFilter.connect(foamGain);
    foamGain.connect(master);

    // --- Whoosh ------------------------------------------------------------
    const whooshFilter = context.createBiquadFilter();
    whooshFilter.type = 'bandpass';
    whooshFilter.frequency.value = 400;
    whooshFilter.Q.value = 1.1;

    const whooshGain = context.createGain();
    whooshGain.gain.value = 0;
    whooshFilter.connect(whooshGain);
    whooshGain.connect(master);

    const sources = [
      this._loop(brown, surfFilter),
      this._loop(white, foamFilter),
      this._loop(white, whooshFilter),
    ];

    this._nodes = {
      master,
      surfFilter,
      surfGain,
      foamGain,
      whooshFilter,
      whooshGain,
      swell,
      sources,
      white,
    };

    this.ready = true;
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.ready) return;

    // Ramped, never assigned: a gain that jumps to zero clicks.
    const { master } = this._nodes;
    master.gain.setTargetAtTime(muted ? 0 : this.masterVolume, this.context.currentTime, 0.05);
  }

  /** One-off splash. `amount` scales both loudness and length. */
  splash(amount = 1) {
    if (!this.ready || this.muted) return;

    const context = this.context;
    const now = context.currentTime;
    const length = 0.55 * amount;

    const source = context.createBufferSource();
    source.buffer = this._nodes.white;

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(7000, now);
    // Sweeping the cut downward is what turns a noise burst into water landing
    // rather than a burst of static.
    filter.frequency.exponentialRampToValueAtTime(350, now + length);

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.55 * amount, now + 0.015);
    // Exponential ramps cannot reach zero, hence the small floor.
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this._nodes.master);

    // Random offset so repeated splashes aren't the same sample every time.
    source.start(now, Math.random() * 1.5, length + 0.05);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  update(delta, board) {
    if (!this.ready) return;

    const { surfFilter, surfGain, whooshFilter, whooshGain } = this._nodes;
    const now = this.context.currentTime;

    // Speed gives the whoosh its body, a hard turn gives it its bite.
    const fromSpeed = clamp((board.speed - this.whooshFrom) / (this.whooshTo - this.whooshFrom));
    const fromCarve = clamp(board.carve / this.carveFull);
    const level = Math.min(fromSpeed * 0.15 + fromCarve * 0.2, 0.3);

    whooshGain.gain.setTargetAtTime(level, now, 0.08);
    whooshFilter.frequency.setTargetAtTime(320 + board.speed * 70, now, 0.12);

    // Inside the tube everything is enclosed and much louder — a low, roaring
    // version of the same sea. It's the one moment the mix changes character.
    const enclosed = board.inBarrel ? 1 : 0;
    surfFilter.frequency.setTargetAtTime(enclosed ? 320 : 900, now, 0.25);
    surfGain.gain.setTargetAtTime(enclosed ? 0.85 : 0.5, now, 0.25);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('pointerdown', this._unlock);
    window.removeEventListener('keydown', this._unlock);

    if (!this.ready) return;

    for (const source of this._nodes.sources) source.stop();
    this._nodes.swell.stop();
    this.context.close();

    this.ready = false;
  }
}

function clamp(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
