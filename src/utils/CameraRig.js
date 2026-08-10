import * as THREE from 'three';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const HALF_PI = Math.PI / 2;

/**
 * Smooth, deterministic noise in [-1, 1]. Three sines at unrelated frequencies
 * beat a random walk here: shake stays continuous frame to frame instead of
 * buzzing, and it costs nothing.
 */
function shakeNoise(seed, t) {
  return (
    Math.sin(t * 13.7 + seed * 1.3) * 0.5 +
    Math.sin(t * 27.1 + seed * 5.7) * 0.32 +
    Math.sin(t * 49.3 + seed * 11.1) * 0.18
  );
}

/**
 * Third-person chase camera with a switchable low "surfer POV", smoothed in
 * both position and rotation, plus trauma-driven shake.
 *
 * Rather than cutting between the two cameras, both poses are computed every
 * frame and cross-faded. A mode switch is then just easing one number, and the
 * transition comes out smooth for free.
 *
 * Rotation is slerped toward a look-at basis instead of being snapped with
 * `lookAt()` each frame, which is what lets the camera lag slightly and swing
 * through a turn rather than tracking the board rigidly.
 */
export class CameraRig {
  constructor(camera, target, options = {}) {
    this.camera = camera;
    this.target = target;

    /**
     * Where the target is facing. A target that banks must supply this: pulling
     * a yaw back out of a rolled quaternion cross-couples the axes and the
     * camera swings with the lean.
     */
    this.getHeading = options.getHeading ?? (() => this.target.rotation.y);

    /** Ignore touch drags, so touch steering doesn't also swing the camera. */
    this.ignoreTouch = options.ignoreTouch ?? false;
    /** Optional floor, e.g. the water surface, so the camera never dips under. */
    this.getMinHeight = options.getMinHeight ?? null;

    this.chase = {
      distance: 7.5,
      height: 2.2,
      lookHeight: 0.6,
      /** Response rates, per second. Higher is tighter. */
      positionRate: 6,
      rotationRate: 10,
      ...options.chase,
    };

    this.pov = {
      /** Forward of the board's centre — behind the nose, where a surfer stands. */
      forward: -0.15,
      height: 1.05,
      lookAhead: 12,
      lookDrop: 1.6,
      /** How much of the board's lean and pitch the view inherits. */
      bankInfluence: 0.4,
      pitchInfluence: 0.55,
      // Near-rigid: a POV that lagged would feel like being towed, not riding.
      positionRate: 40,
      rotationRate: 22,
      ...options.pov,
    };

    this.mode = options.mode === 'pov' ? 'pov' : 'chase';
    /** 0 = fully chase, 1 = fully POV. */
    this._blend = this.mode === 'pov' ? 1 : 0;
    this.blendRate = options.blendRate ?? 2.4;

    // Each mode keeps its own drag state, so orbiting the chase cam doesn't
    // leave the POV staring off sideways when you switch.
    this._orbit = {
      chase: { yaw: 0, pitch: 0.22 },
      pov: { yaw: 0, pitch: 0 },
    };
    this.recenter = options.recenter ?? 0.6;

    // --- shake ---
    /** Decaying impulse component, 0..1. */
    this.trauma = 0;
    /** Continuous component, set fresh each frame by the caller. */
    this.sustained = 0;
    this.traumaDecay = options.traumaDecay ?? 1.1;
    this.shakeTranslation = options.shakeTranslation ?? 0.35;
    this.shakeRotation = options.shakeRotation ?? 0.07;
    this._shakeTime = 0;

    // The smoothed pose, kept free of shake. Shake is a pure overlay applied
    // to the camera afterwards: fold it into the smoothed state instead and
    // each frame damps toward an already-shaken position, so the jolt feeds
    // back on itself, grows well past its nominal amplitude, and drags the
    // camera off its line.
    this._basePosition = new THREE.Vector3();
    this._baseQuat = new THREE.Quaternion();

    this.toggleKey = options.toggleKey ?? 'KeyC';

    this._eye = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._chaseEye = new THREE.Vector3();
    this._chaseFocus = new THREE.Vector3();
    this._chaseUp = new THREE.Vector3();
    this._povEye = new THREE.Vector3();
    this._povFocus = new THREE.Vector3();
    this._povUp = new THREE.Vector3();
    this._forwardAxis = new THREE.Vector3();
    this._lookMatrix = new THREE.Matrix4();
    this._targetQuat = new THREE.Quaternion();

    this._dragging = false;
    this._lastPointer = { x: 0, y: 0 };
    this._bindInput(options.domElement ?? document.body);

    this._composePose(this._blend);
    this._basePosition.copy(this._eye);
    this._lookMatrix.lookAt(this._eye, this._focus, this._up);
    this._baseQuat.setFromRotationMatrix(this._lookMatrix);
    this.camera.position.copy(this._basePosition);
    this.camera.quaternion.copy(this._baseQuat);
  }

  _bindInput(element) {
    this._element = element;

    this._onPointerDown = (event) => {
      // On a phone a drag is the steering stick, not a camera orbit.
      if (this.ignoreTouch && event.pointerType === 'touch') return;
      this._dragging = true;
      this._lastPointer = { x: event.clientX, y: event.clientY };
      element.setPointerCapture?.(event.pointerId);
    };

    this._onPointerMove = (event) => {
      if (!this._dragging) return;
      const dx = event.clientX - this._lastPointer.x;
      const dy = event.clientY - this._lastPointer.y;
      this._lastPointer = { x: event.clientX, y: event.clientY };

      const orbit = this._orbit[this.mode];
      orbit.yaw -= dx * 0.005;
      orbit.pitch = THREE.MathUtils.clamp(
        orbit.pitch + dy * 0.003,
        this.mode === 'pov' ? -0.5 : -0.15,
        this.mode === 'pov' ? 0.5 : HALF_PI - 0.1,
      );
    };

    this._onPointerUp = (event) => {
      this._dragging = false;
      element.releasePointerCapture?.(event.pointerId);
    };

    this._onKeyDown = (event) => {
      if (event.code === this.toggleKey) this.toggle();
    };

    element.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    this.setMode(this.mode === 'chase' ? 'pov' : 'chase');
  }

  setMode(mode) {
    this.mode = mode === 'pov' ? 'pov' : 'chase';
  }

  /** One-off jolt: an impact, a wipeout. Accumulates, then decays. */
  addTrauma(amount) {
    this.trauma = THREE.MathUtils.clamp(this.trauma + amount, 0, 1);
  }

  /** Continuous rumble, e.g. from a hard carve. Set every frame; not decayed. */
  setSustained(amount) {
    this.sustained = THREE.MathUtils.clamp(amount, 0, 1);
  }

  _computeChase(eye, focus, up) {
    const orbit = this._orbit.chase;
    const position = this.target.position;
    const angle = this.getHeading() + orbit.yaw;
    const horizontal = Math.cos(orbit.pitch) * this.chase.distance;

    // Negated: the target's forward is (sin yaw, cos yaw), and the camera
    // belongs the other way, behind it.
    eye.set(
      position.x - Math.sin(angle) * horizontal,
      position.y + this.chase.height + Math.sin(orbit.pitch) * this.chase.distance,
      position.z - Math.cos(angle) * horizontal,
    );

    focus.set(position.x, position.y + this.chase.lookHeight, position.z);
    up.copy(WORLD_UP);
  }

  _computePov(eye, focus, up) {
    const orbit = this._orbit.pov;
    const position = this.target.position;
    const heading = this.getHeading() + orbit.yaw;

    const sin = Math.sin(heading);
    const cos = Math.cos(heading);

    eye.set(
      position.x + sin * this.pov.forward,
      position.y + this.pov.height,
      position.z + cos * this.pov.forward,
    );

    // Nose-down pitch tips the view down the face; drag adds to it.
    const pitch = (this.target.pitch ?? 0) * this.pov.pitchInfluence + orbit.pitch;
    const reach = Math.cos(pitch) * this.pov.lookAhead;

    focus.set(
      eye.x + sin * reach,
      eye.y - Math.sin(pitch) * this.pov.lookAhead - this.pov.lookDrop,
      eye.z + cos * reach,
    );

    // Roll the horizon with the board. This is most of what sells a carve from
    // on board — but only a fraction of it, because a surfer's head stays far
    // more level than the deck does.
    const bank = (this.target.bank ?? 0) * this.pov.bankInfluence;
    this._forwardAxis.set(sin, 0, cos);
    up.copy(WORLD_UP).applyAxisAngle(this._forwardAxis, bank);
  }

  /** Blends the two poses and returns the matching response rates. */
  _composePose(blend) {
    this._computeChase(this._chaseEye, this._chaseFocus, this._chaseUp);
    this._computePov(this._povEye, this._povFocus, this._povUp);

    this._eye.copy(this._chaseEye).lerp(this._povEye, blend);
    this._focus.copy(this._chaseFocus).lerp(this._povFocus, blend);
    this._up.copy(this._chaseUp).lerp(this._povUp, blend).normalize();

    return {
      position: THREE.MathUtils.lerp(this.chase.positionRate, this.pov.positionRate, blend),
      rotation: THREE.MathUtils.lerp(this.chase.rotationRate, this.pov.rotationRate, blend),
    };
  }

  _applyShake(delta) {
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * delta);

    const level = Math.min(1, this.trauma + this.sustained);
    if (level <= 0.001) return;

    // Squared, so shake falls away sharply rather than lingering as a wobble.
    const amount = level * level;
    this._shakeTime += delta;

    const t = this._shakeTime;
    this.camera.translateX(shakeNoise(1, t) * this.shakeTranslation * amount);
    this.camera.translateY(shakeNoise(2, t) * this.shakeTranslation * amount);
    this.camera.rotateZ(shakeNoise(3, t) * this.shakeRotation * amount);
    this.camera.rotateX(shakeNoise(4, t) * this.shakeRotation * amount * 0.7);
    this.camera.rotateY(shakeNoise(5, t) * this.shakeRotation * amount * 0.7);
  }

  update(delta) {
    // Ease the manual look back to neutral once the pointer is released.
    if (!this._dragging) {
      const decay = 1 - Math.min(this.recenter * delta, 1);
      for (const orbit of [this._orbit.chase, this._orbit.pov]) {
        orbit.yaw *= decay;
        if (Math.abs(orbit.yaw) < 1e-4) orbit.yaw = 0;
      }
      this._orbit.pov.pitch *= decay;
    }

    const goal = this.mode === 'pov' ? 1 : 0;
    this._blend += (goal - this._blend) * (1 - Math.exp(-this.blendRate * delta));

    const rates = this._composePose(this._blend);

    if (this.getMinHeight) {
      const floor = this.getMinHeight(this._eye.x, this._eye.z);
      if (this._eye.y < floor) this._eye.y = floor;
    }

    // Frame-rate independent smoothing on both position and orientation.
    this._basePosition.lerp(this._eye, 1 - Math.exp(-rates.position * delta));

    this._lookMatrix.lookAt(this._basePosition, this._focus, this._up);
    this._targetQuat.setFromRotationMatrix(this._lookMatrix);
    this._baseQuat.slerp(this._targetQuat, 1 - Math.exp(-rates.rotation * delta));

    this.camera.position.copy(this._basePosition);
    this.camera.quaternion.copy(this._baseQuat);

    this._applyShake(delta);
  }

  /** Snap straight to the target's pose — used after a restart. */
  reset() {
    this._orbit.chase.yaw = 0;
    this._orbit.pov.yaw = 0;
    this._orbit.pov.pitch = 0;
    this.trauma = 0;
    this.sustained = 0;

    this._composePose(this._blend);
    this._basePosition.copy(this._eye);
    this._lookMatrix.lookAt(this._eye, this._focus, this._up);
    this._baseQuat.setFromRotationMatrix(this._lookMatrix);
    this.camera.position.copy(this._basePosition);
    this.camera.quaternion.copy(this._baseQuat);
  }

  dispose() {
    this._element.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
  }
}
