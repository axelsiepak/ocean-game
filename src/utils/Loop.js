import * as THREE from 'three';

/**
 * requestAnimationFrame loop. Anything pushed into `updatables` gets its
 * `update(delta, elapsed)` called once per frame.
 *
 * Delta is clamped so that tabbing away and back doesn't teleport entities.
 */
export class Loop {
  constructor(renderer, scene, camera, options = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.updatables = [];

    /**
     * How a frame gets drawn. Defaults to a plain render; swap in a composer's
     * render to put the frame through post-processing without the loop needing
     * to know anything about it.
     */
    this.render = options.render ?? (() => this.renderer.render(this.scene, this.camera));

    this._clock = new THREE.Clock();
    this._frame = null;
  }

  add(updatable) {
    this.updatables.push(updatable);
    return updatable;
  }

  start() {
    this._clock.start();
    const tick = () => {
      this._frame = requestAnimationFrame(tick);

      const delta = Math.min(this._clock.getDelta(), 0.1);
      const elapsed = this._clock.elapsedTime;

      for (const object of this.updatables) {
        object.update(delta, elapsed);
      }

      this.render(delta);
    };
    tick();
  }

  stop() {
    if (this._frame !== null) {
      cancelAnimationFrame(this._frame);
      this._frame = null;
    }
    this._clock.stop();
  }
}
