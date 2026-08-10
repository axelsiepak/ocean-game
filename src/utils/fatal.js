/**
 * The last resort when the game can't start.
 *
 * Boot is a single unguarded top-level pass, so every way it can fail looks
 * identical from the player's side: a black canvas and nothing else. A missing
 * WebGL context, a shader that won't compile on some driver, and an outright
 * bug are three very different problems that all render as the same void. This
 * funnels them into one panel that says which of them happened.
 */

/**
 * Why WebGL 2 can't be used here, or `null` if it can.
 *
 * WebGL 2 rather than 1 because three dropped WebGL 1 in r163, so there is no
 * fallback path to offer. The interesting case is the second one: the browser
 * ships the API but hands back no context, which on desktop Firefox usually
 * means hardware acceleration is switched off or the driver is blocklisted.
 */
export function detectWebGL() {
  if (typeof WebGL2RenderingContext === 'undefined') {
    return 'This browser does not support WebGL 2, which the game needs in order to draw anything.';
  }

  let gl = null;
  try {
    gl = document.createElement('canvas').getContext('webgl2');
  } catch (error) {
    return `Starting WebGL 2 threw: ${error.message}`;
  }

  if (!gl) {
    return (
      'WebGL 2 exists in this browser but it refused to create a context. ' +
      'That is usually hardware acceleration being switched off, or a graphics driver on the browser blocklist.'
    );
  }

  // Hand the context straight back. This was only ever a question, and a
  // browser will only keep a handful of live contexts before dropping the
  // oldest — which would be the game's own.
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  return null;
}

/**
 * Replaces the black screen with something that explains itself.
 *
 * `summary` is for the player and says what to try; `error` is for whoever has
 * to fix it and is shown verbatim, because a message paraphrased into
 * friendliness is a message nobody can search for.
 */
export function showFatalError(summary, error = null) {
  // Whatever went wrong, an empty canvas behind the panel only muddies it.
  const canvas = document.getElementById('game');
  if (canvas) canvas.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'fatal';
  panel.setAttribute('role', 'alert');

  const card = document.createElement('div');
  card.className = 'fatal__card';

  const title = document.createElement('h1');
  title.className = 'fatal__title';
  title.textContent = "The game couldn't start";

  const lede = document.createElement('p');
  lede.className = 'fatal__lede';
  lede.textContent = summary;

  card.append(title, lede);

  if (error) {
    const detail = document.createElement('pre');
    detail.className = 'fatal__detail';
    // The stack is worth more than the message alone, but only the top of it —
    // the rest is minified bundle internals that tell a player nothing.
    const stack = typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 4).join('\n') : '';
    detail.textContent = stack || String(error.message ?? error);
    card.append(detail);
  }

  const hint = document.createElement('p');
  hint.className = 'fatal__hint';
  hint.textContent =
    'Try another browser, or check that hardware acceleration is enabled in your browser settings. ' +
    'In Firefox that is Settings → General → Performance.';
  card.append(hint);

  panel.append(card);
  document.body.append(panel);

  return panel;
}
