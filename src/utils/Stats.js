/**
 * Frame profiler. Toggle with F.
 *
 * Reads `renderer.info`, which is three's own counter of what it actually
 * submitted — so the draw call and triangle numbers are measured, not assumed.
 * Frame time is a rolling median, because a mean is dragged around by single
 * hitches and what you want to know is the typical frame.
 */
export class Stats {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.toggleKey = options.toggleKey ?? 'KeyF';
    this.visible = options.visible ?? false;

    this._samples = [];
    this._last = '';

    this.element = document.createElement('div');
    this.element.className = 'stats';
    this.element.hidden = !this.visible;
    document.body.appendChild(this.element);

    this._onKeyDown = (event) => {
      if (event.code !== this.toggleKey) return;
      this.visible = !this.visible;
      this.element.hidden = !this.visible;
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  get frameTime() {
    if (this._samples.length === 0) return 0;
    const sorted = [...this._samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  update(delta, quality) {
    this._samples.push(delta * 1000);
    if (this._samples.length > 60) this._samples.shift();
    if (!this.visible) return;

    const ms = this.frameTime;
    const fps = ms > 0 ? 1000 / ms : 0;
    const { render, memory, programs } = this.renderer.info;

    const text = [
      `${fps.toFixed(0).padStart(3)} fps   ${ms.toFixed(1)} ms`,
      `draws  ${render.calls}`,
      `tris   ${render.triangles.toLocaleString('en-US')}`,
      `progs  ${programs ? programs.length : 0}`,
      `geo/tex ${memory.geometries}/${memory.textures}`,
      `pixel  ${this.renderer.getPixelRatio().toFixed(2)}x`,
      quality?.applied?.length ? `dropped: ${quality.applied.join(', ')}` : 'quality: full',
    ].join('\n');

    // The DOM is only touched when a line actually changes; at 60fps the
    // profiler shouldn't be a meaningful part of what it's measuring.
    if (text !== this._last) {
      this.element.textContent = text;
      this._last = text;
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this.element.remove();
  }
}
