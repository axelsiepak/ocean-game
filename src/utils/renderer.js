import * as THREE from 'three';

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
  renderer.userData.pixelRatio = options.pixelRatio ?? 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderer.userData.pixelRatio));
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

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderer.userData.pixelRatio ?? 1.5));
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
