/**
 * Dependency-free slider panel for live-tuning values.
 *
 * Each control is `{ label, min, max, step, get, set }` — it reads through the
 * getter every time it's built, so it always reflects the real current value
 * rather than a copy that can drift.
 */
export class ControlPanel {
  constructor(controls, options = {}) {
    this.controls = controls;
    this.hotkey = options.hotkey ?? 'KeyH';

    this.element = document.createElement('div');
    this.element.className = 'control-panel';
    this.element.innerHTML = `<h2>${options.title ?? 'Settings'}</h2>`;

    for (const control of controls) {
      this.element.appendChild(this._buildRow(control));
    }

    const hint = document.createElement('p');
    hint.className = 'control-panel__hint';
    hint.textContent = `${this.hotkey.replace('Key', '')} to hide`;
    this.element.appendChild(hint);

    document.body.appendChild(this.element);

    this._onKeyDown = (event) => {
      if (event.code === this.hotkey) this.toggle();
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  _buildRow(control) {
    const row = document.createElement('label');
    row.className = 'control-panel__row';

    const name = document.createElement('span');
    name.textContent = control.label;

    const readout = document.createElement('output');
    const format = (value) => Number(value).toFixed(2);
    readout.textContent = format(control.get());

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = control.min;
    slider.max = control.max;
    slider.step = control.step ?? 0.01;
    slider.value = control.get();

    slider.addEventListener('input', () => {
      const value = Number(slider.value);
      control.set(value);
      // Read back rather than echoing the slider: setters clamp, and the
      // readout should show what actually took effect.
      readout.textContent = format(control.get());
    });

    // Keep arrow keys on a focused slider from also steering the boat.
    slider.addEventListener('keydown', (event) => event.stopPropagation());

    const head = document.createElement('div');
    head.className = 'control-panel__head';
    head.append(name, readout);
    row.append(head, slider);

    return row;
  }

  toggle(visible = this.element.hidden) {
    this.element.hidden = !visible;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this.element.remove();
  }
}
