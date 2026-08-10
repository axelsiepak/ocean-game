import * as THREE from 'three';

const DEFAULT_PIXEL_RATIO = 1.5;

/**
 * The pixel-ratio ceiling currently in force for a renderer.
 *
 * It lives here rather than on the renderer because `WebGLRenderer` is not an
 * `Object3D` and has no `userData` to hang it off — writing to one threw before
 * the game had drawn a single frame. A WeakMap keeps the association without
 * reaching into three's object at all, and lets the renderer be collected.
 */
const pixelRatioCaps = new WeakMap();

/** Caps the device pixel ratio, remembering the cap for later resizes. */
export function capPixelRatio(renderer, cap = DEFAULT_PIXEL_RATIO) {
  pixelRatioCaps.set(renderer, cap);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
}

/** The cap in force, for callers that want to re-apply it. */
export function pixelRatioCap(renderer) {
  return pixelRatioCaps.get(renderer) ?? DEFAULT_PIXEL_RATIO;
}

/**
 * Creates the WebGL renderer bound to the given canvas, with sane defaults for
 * an outdoor daylight scene (tone mapping + sRGB output).
 */
export function createRenderer(canvas, options = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });

  // Capped well below the device's own ratio on purpose. Every fullscreen
  // post pass costs the square of this, and at ratio 2 the thirteen of them
  // come to ~108M fragment-passes a frame against ~27M at ratio 1.
  capPixelRatio(renderer, options.pixelRatio ?? DEFAULT_PIXEL_RATIO);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  return renderer;
}

/**
 * Keeps renderer + camera in sync with the window size. Returns a disposer.
 */
export function handleResize(renderer, camera, onChange) {
  const onResize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Re-applied rather than left alone: devicePixelRatio changes under us when
    // a window moves between monitors, and the cap has to be re-imposed on it.
    capPixelRatio(renderer, pixelRatioCap(renderer));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // Anything with its own render targets — the composer — has to follow.
    if (onChange) onChange(width, height);
  };

  window.addEventListener('resize', onResize);
  onResize();

  return () => window.removeEventListener('resize', onResize);
}
