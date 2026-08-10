import './style.css';

import { MainScene } from './scenes/MainScene.js';
import { AdaptiveQuality, TIERS, pickTier } from './systems/Quality.js';
import { Run, State } from './systems/Run.js';
import { Loop } from './utils/Loop.js';
import { Menus } from './utils/Menus.js';
import { Stats } from './utils/Stats.js';
import { TouchControls, isTouchDevice } from './utils/TouchControls.js';
import { detectWebGL, showFatalError } from './utils/fatal.js';
import { createComposer } from './utils/postprocessing.js';
import { createRenderer, handleResize } from './utils/renderer.js';

/**
 * Builds the world and starts it running. Returns the teardown.
 *
 * This is a function rather than the top level of the module so that the whole
 * of it sits inside one `try` below — every line here can throw on hardware we
 * can't see, and an uncaught throw at module scope is a black screen with no
 * explanation.
 */
function boot() {
  const tier = TIERS[pickTier()];

  const canvas = document.getElementById('game');
  const renderer = createRenderer(canvas, { pixelRatio: tier.pixelRatio });
  renderer.shadowMap.enabled = tier.shadows;

  const world = new MainScene(renderer, tier);
  const post = createComposer(renderer, world.scene, world.camera, { bloom: tier.bloom });
  const stats = new Stats(renderer);

  // No fixed setting can promise a frame rate on hardware we can't see, so the
  // budget is measured and the most expensive thing is given back first.
  const quality = new AdaptiveQuality({
    setBloom: (on) => post.setBloom(on),
    setShadows: (on) => {
      renderer.shadowMap.enabled = on;
      world.sky.sun.castShadow = on;
    },
    setPixelRatio: (value) => {
      renderer.userData.pixelRatio = value;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, value));
      post.setSize(window.innerWidth, window.innerHeight);
    },
  });
  const stopResizing = handleResize(renderer, world.camera, post.setSize);

  const touch = isTouchDevice();
  if (touch) {
    world.cameraRig.ignoreTouch = true;

    const hint = document.getElementById('hud');
    if (hint) hint.textContent = 'Drag to steer and paddle · tap to trick';
  }

  const touchControls = touch
    ? new TouchControls(world.input, { element: renderer.domElement })
    : null;

  const run = new Run({
    duration: 120,
    onStateChange: (state) => {
      // Input is live only while surfing, so a menu button press can't also
      // steer, and a held key doesn't carry through a pause.
      world.input.enabled = state === State.PLAYING;
      if (state !== State.PLAYING) {
        world.input.clear();
        touchControls?.release();
      }
      menus.show(state, { results: run.results, touch });
    },
  });

  const menus = new Menus({
    onStart: ({ timed }) => {
      world.reset();
      run.begin({ timed });
    },
    onPause: () => run.pause(),
    onResume: () => run.resume(),
    onRestart: () => {
      world.reset();
      // Keep whichever mode the run was in: `timed` is false only in free surf.
      run.begin({ timed: run.timed });
    },
    onFinish: () => run.finish(world.scoring),
    onMenu: () => run.toMenu(),
  });

  // Esc and P pause; the on-screen button covers devices without either.
  const onKeyDown = (event) => {
    if (event.code === 'Escape' || event.code === 'KeyP') run.togglePause();
  };
  window.addEventListener('keydown', onKeyDown);

  menus.show(run.state, { touch });

  const loop = new Loop(renderer, world.scene, world.camera, { render: post.render });
  loop.add({
    update: (delta, elapsed) => {
      quality.update(delta);
      stats.update(delta, quality);
      run.update(delta, world.scoring);
      // Menus play over a living sea; a pause genuinely stops the world.
      if (run.animating) world.update(delta, elapsed);
      world.hud.setRun(run);
    },
  });
  loop.start();

  return () => {
    loop.stop();
    stopResizing();
    window.removeEventListener('keydown', onKeyDown);
    world.dispose();
    menus.dispose();
    stats.dispose();
    touchControls?.dispose();
    post.composer.dispose();
    renderer.dispose();
  };
}

// Asked before booting rather than after catching, because "your browser has no
// WebGL" is a different message from "the game crashed" and the player can act
// on the first one.
const unsupported = detectWebGL();

if (unsupported) {
  showFatalError(unsupported);
} else {
  try {
    const dispose = boot();

    // Vite hot-reload: tear the old world down before the new module builds one,
    // otherwise every edit leaks a render loop and a set of event listeners.
    if (import.meta.hot) import.meta.hot.dispose(dispose);
  } catch (error) {
    // Still worth the console: the panel shows the top of the stack, but the
    // full trace and any preceding WebGL warnings only live here.
    console.error('Ocean Game failed to start.', error);
    showFatalError(
      'Something went wrong while starting the game up. The details below are the place to start.',
      error,
    );
  }
}
