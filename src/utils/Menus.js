import { State } from '../systems/Run.js';

const formatScore = (value) => Math.floor(value).toLocaleString('en-US');

/**
 * Main menu, pause menu and results screen.
 *
 * All three are one overlay whose contents swap, because they're the same
 * thing from the player's side: the game has stopped and is asking what next.
 * Owning its own DOM keeps it consistent with the HUD and the control panel.
 */
export class Menus {
  constructor(handlers = {}) {
    this.handlers = handlers;

    this.element = document.createElement('div');
    this.element.className = 'menu';
    this.element.innerHTML = `
      <div class="menu__card" role="dialog" aria-modal="true" aria-labelledby="menu-title">
        <p class="menu__eyebrow" id="menu-eyebrow" hidden></p>
        <h1 class="menu__title" id="menu-title">Ocean Surf</h1>
        <p class="menu__lede" id="menu-lede"></p>
        <dl class="menu__stats" id="menu-stats" hidden></dl>
        <div class="menu__actions" id="menu-actions"></div>
        <label class="menu__volume">
          <span>Volume</span>
          <input type="range" id="menu-volume" min="0" max="1" step="0.05" />
          <output id="menu-volume-value"></output>
        </label>
        <p class="menu__hint" id="menu-hint"></p>
      </div>
    `;

    this._eyebrow = this.element.querySelector('#menu-eyebrow');
    this._title = this.element.querySelector('#menu-title');
    this._lede = this.element.querySelector('#menu-lede');
    this._stats = this.element.querySelector('#menu-stats');
    this._actions = this.element.querySelector('#menu-actions');
    this._hint = this.element.querySelector('#menu-hint');
    this._volume = this.element.querySelector('#menu-volume');
    this._volumeValue = this.element.querySelector('#menu-volume-value');

    this._volume.addEventListener('input', () => {
      this.handlers.onVolume?.(Number(this._volume.value));
      // Read back through the getter rather than trusting the slider: the
      // engine clamps, and zero there means muted, so the readout should show
      // what actually took effect.
      this.syncVolume();
    });

    // A pause control that works without a keyboard.
    this.pauseButton = document.createElement('button');
    this.pauseButton.className = 'pause-button';
    this.pauseButton.type = 'button';
    this.pauseButton.textContent = 'Pause';
    this.pauseButton.hidden = true;
    this.pauseButton.addEventListener('click', () => this.handlers.onPause?.());

    document.body.append(this.element, this.pauseButton);
  }

  _button(label, action, primary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'menu__button menu__button--primary' : 'menu__button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  /**
   * Puts the slider where the volume actually is. Called whenever a menu opens
   * and whenever the engine reports a change, so muting with M mid-run leaves
   * the slider agreeing with what you can hear.
   */
  syncVolume() {
    const volume = this.handlers.getVolume?.() ?? 0;
    this._volume.value = String(volume);
    this._volumeValue.textContent = volume === 0 ? 'Muted' : `${Math.round(volume * 100)}%`;
  }

  /**
   * Sets the heading. The eyebrow is a label above the title — "Paused", "Run
   * over" — and hides itself when a screen has nothing to put there, so the
   * card's flex gap doesn't leave a hole where it would have been.
   */
  _setHeading(eyebrow, title) {
    this._eyebrow.textContent = eyebrow;
    this._eyebrow.hidden = !eyebrow;
    this._title.textContent = title;
  }

  _stat(term, value) {
    const wrap = document.createElement('div');
    wrap.className = 'menu__stat';
    wrap.innerHTML = `<dt>${term}</dt><dd>${value}</dd>`;
    return wrap;
  }

  show(state, { results, touch } = {}) {
    const { handlers } = this;

    this._actions.replaceChildren();
    this._stats.replaceChildren();
    this._stats.hidden = true;
    this.element.hidden = state === State.PLAYING;
    this.pauseButton.hidden = state !== State.PLAYING;

    document.body.dataset.state = state;

    if (state === State.PLAYING) return;

    this.syncVolume();

    if (state === State.MENU) {
      // The game's name is one thing, set as one heading, rather than split
      // across the eyebrow and the title at two different sizes.
      this._setHeading('', 'Ocean Surf');
      this._lede.textContent =
        'Catch a wave, hold the pocket, and stay there. The wave is what makes you fast — the paddle only gets you onto it.';
      this._actions.append(
        this._button('Start run', () => handlers.onStart?.({ timed: true }), true),
        this._button('Free surf', () => handlers.onStart?.({ timed: false })),
      );
      this._hint.textContent = touch
        ? 'Drag to steer and paddle · tap to trick'
        : 'W paddle · A/D carve · Space trick · C camera · M mute';
      return;
    }

    if (state === State.PAUSED) {
      this._setHeading('Paused', 'Take a breath');
      this._lede.textContent = 'The sea will wait.';
      this._actions.append(
        this._button('Resume', () => handlers.onResume?.(), true),
        this._button('Restart', () => handlers.onRestart?.()),
        this._button('End run', () => handlers.onFinish?.()),
      );
      this._hint.textContent = touch ? '' : 'Esc to resume';
      return;
    }

    // Results.
    const best = results?.bestTrick;
    this._setHeading('Run over', formatScore(results?.score ?? 0));
    const article = best && /^[aeiou]/i.test(best.name) ? 'an' : 'a';
    this._lede.textContent = best
      ? `Your best was ${article} ${best.name.toLowerCase()} for ${formatScore(best.points)}.`
      : 'No tricks landed this run — the wave time alone got you there.';

    this._stats.append(
      this._stat('Best trick', best ? `${best.name} · ${formatScore(best.points)}` : '—'),
      this._stat('Longest combo', results?.bestCombo ? `${results.bestCombo} tricks` : '—'),
      this._stat('Tricks landed', String(results?.tricksLanded ?? 0)),
      this._stat('Barrel time', `${(results?.barrelTime ?? 0).toFixed(1)}s`),
      this._stat('Waves ridden', String(results?.wavesRidden ?? 0)),
      this._stat('Longest wave', `${(results?.longestWave ?? 0).toFixed(1)}s`),
      this._stat('Wipeouts', String(results?.wipeouts ?? 0)),
    );
    this._stats.hidden = false;

    this._actions.append(
      this._button('Surf again', () => handlers.onRestart?.(), true),
      this._button('Main menu', () => handlers.onMenu?.()),
    );
    this._hint.textContent = '';
  }

  dispose() {
    this.element.remove();
    this.pauseButton.remove();
    delete document.body.dataset.state;
  }
}
