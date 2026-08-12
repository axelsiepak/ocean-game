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
      /**
       * Forward of the board's centre, i.e. back toward the tail. -0.6 sits over
       * the back foot (the tail pad is at -0.72) rather than mid-deck, which
       * keeps the nose and a good length of board in shot.
       */
      forward: -0.6,
      height: 1.05,
      lookAhead: 12,
      lookDrop: 1.6,
      /** How much of the board's lean and pitch the view inherits. */
      bankInfluence: 0.4,
      pitchInfluence: 0.55,
      // Near-rigid: a POV that lagged would feel like being towed, not riding.
      positionRate: 40,
      rotationRate: 22,
      /**
       * Fixed to the board: no smoothing at all once the blend is fully POV, so
       * the view is bolted to the deck rather than trailing it by a frame or
       * two. Ramped in with the blend, so the switch itself stays a cross-fade.
       */
      rigid: true,
      ...options.pov,
    };

    /**
     * Speed rush: a fixed FOV widening once the rider is genuinely up to speed,
     * not a continuous function of speed. A proportional zoom breathes with
     * every bump in the velocity; one step that latches reads as "this is fast"
     * and then stays out of the way.
     *
     * `release` below `threshold` is hysteresis, and it earns its keep — speed
     * hunts either side of 10 m/s down a face, and without a band the boost
     * sits half-applied, turning the step back into a proportional zoom.
     * Measured over 5 min of trimming: no band pulses 19.8 times a minute and
     * is at full boost only 58% of the time it is engaged; 8.5 gives 5.0/min
     * and 88.6%, with the FOV visibly moving 6.5% of the time against 24.9%.
     * Below ~7.5 it stops releasing at all (98.5% engaged) and the step no
     * longer means anything.
     *
     * A carve scrubs speed, so on speed alone the rush drops out at exactly the
     * moment the ride looks fastest. `leanDiscount` lowers the bar in
     * proportion to how far the board is over, and `leanHold` refuses to
     * release at all while it is on a rail. Neither touches trimming, where
     * lean is flat zero. Measured over 5 min per style, sampling only frames
     * where the rider is actually up (bank during a wipeout is forced to full
     * lock, so those frames are excluded):
     *
     *   style          engaged while carving   FOV pulses/min on a rail
     *   gentle ±0.35     83% -> 88%              0.8 -> 0.2
     *   hard ±0.8        45% -> 62%              0.6 -> 0.0
     *   hard quick       32% -> 55%              1.2 -> 0.8
     *   full lock ±1.0   33% -> 78%              0.8 -> 1.4
     *   trimming         94% (unchanged)         5.0 (unchanged)
     *
     * 2.0 rather than more because it puts the floor at 8 m/s, still clear of
     * the 5.1 m/s paddling tops out at: the rush keeps meaning "the wave is
     * doing the work". A discount of 3.5 does reach 87% on a hard carve, but
     * its floor of 6.5 m/s is nearly paddling pace. Simply dropping the
     * threshold to a flat 8 was the obvious alternative and is worse: trimming
     * then sits at 100% engaged and visibly zooming 0.3% of the time, i.e. the
     * step becomes a permanent FOV change and stops meaning anything. The hold
     * cannot latch the boost on at a standstill, because bank is proportional
     * to yaw rate times speed — the slowest frame ever seen on a rail was
     * 5.3 m/s.
     */
    this.getSpeed = options.getSpeed ?? null;
    /** Normalised 0..1 lean, i.e. bank as a fraction of full rail. */
    this.getLean = options.getLean ?? null;
    this.speedFov = {
      threshold: 10,
      release: 8.5,
      boost: 8,
      /** m/s knocked off the threshold at full lean. */
      leanDiscount: 2,
      /** Lean above which the boost holds rather than releasing. */
      leanHold: 0.35,
      /** Per second. Slower in than out: a rush should build and then snap back. */
      rateIn: 2.6,
      rateOut: 4.5,
      ...options.speedFov,
    };
    this._baseFov = camera.fov;
    this._fovBoost = 0;
    this._fovEngaged = false;

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

  /** How far the rig is into the POV pose, 0..1. Chase at 0, first-person at 1. */
  get povWeight() {
    return this._blend;
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

  /** Eases the speed-rush FOV step in and out. No-op without a `getSpeed`. */
  _applyFov(delta) {
    if (!this.getSpeed) return;

    const speed = this.getSpeed();
    const { threshold, release, boost, rateIn, rateOut, leanDiscount, leanHold } = this.speedFov;
    const lean = this.getLean ? this.getLean() : 0;

    // Lean lowers both ends of the band together, so the hysteresis keeps the
    // 1.5 m/s width it was tuned to at any angle.
    const engage = threshold - leanDiscount * lean;
    const drop = engage - (threshold - release);

    if (this._fovEngaged) {
      if (speed < drop && lean < leanHold) this._fovEngaged = false;
    } else if (speed >= engage) {
      this._fovEngaged = true;
    }

    const goal = this._fovEngaged ? boost : 0;
    const rate = this._fovEngaged ? rateIn : rateOut;
    this._fovBoost += (goal - this._fovBoost) * (1 - Math.exp(-rate * delta));

    // Rebuilding the projection matrix is not free, and once the step has
    // latched the boost is constant for as long as the ride lasts.
    const fov = this._baseFov + this._fovBoost;
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
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

    // Frame-rate independent smoothing on both position and orientation. In POV
    // the blend doubles as a floor on that response: at 1 the factor is 1, which
    // is a snap to the computed pose — fixed to the board, no lag. Taking the
    // larger of the two keeps it monotone through the switch, so the camera
    // never loosens off on the way in.
    const rigid = this.pov.rigid ? this._blend : 0;

    this._basePosition.lerp(this._eye, Math.max(1 - Math.exp(-rates.position * delta), rigid));

    this._lookMatrix.lookAt(this._basePosition, this._focus, this._up);
    this._targetQuat.setFromRotationMatrix(this._lookMatrix);
    this._baseQuat.slerp(this._targetQuat, Math.max(1 - Math.exp(-rates.rotation * delta), rigid));

    this.camera.position.copy(this._basePosition);
    this.camera.quaternion.copy(this._baseQuat);

    this._applyFov(delta);
    this._applyShake(delta);
  }

  /** Snap straight to the target's pose — used after a restart. */
  reset() {
    this._orbit.chase.yaw = 0;
    this._orbit.pov.yaw = 0;
    this._orbit.pov.pitch = 0;
    this.trauma = 0;
    this.sustained = 0;

    // A restart begins at a standstill, so the rush starts disengaged rather
    // than easing down from the last run's speed.
    this._fovEngaged = false;
    this._fovBoost = 0;
    if (this.camera.fov !== this._baseFov) {
      this.camera.fov = this._baseFov;
      this.camera.updateProjectionMatrix();
    }

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
