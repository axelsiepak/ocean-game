import * as THREE from 'three';

const GRAVITY = 9.8;
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/** Nose and tail lift, the way a real board is shaped. */
function rockerAt(z) {
  return 0.075 * z * z * (z > 0 ? 1.35 : 1.0);
}

/**
 * A surfboard that rides the ocean surface.
 *
 * The thing that makes this feel like surfing rather than driving is that the
 * board is not self-propelled: most of its speed comes from gravity pulling it
 * down the face of a wave. The throttle only paddles. Point down a steep face
 * and you accelerate; sit in a trough and you stall.
 *
 * Because of that, the ocean's own settings are the difficulty dial — raising
 * `waveHeight` steepens the faces and makes the board genuinely faster.
 *
 * Conventions: XZ vectors are `Vector2` with `.x` = world X and `.y` = world Z.
 * Forward is +Z at heading 0, and +X is the board's *left*.
 */
export class Surfboard {
  constructor(options = {}) {
    this.input = options.input ?? null;
    this.ocean = options.ocean ?? null;

    /**
     * Acceleration from paddling, m/s². Deliberately modest: it's meant to get
     * you onto a wave, not to be the way you go fast. Raise it much past 6 and
     * it drowns out the wave entirely — paddling into the swell becomes as
     * quick as riding it, and the surfing goes out of the game.
     */
    this.paddlePower = options.paddlePower ?? 4.5;
    /** How hard dragging back scrubs speed, as a decay rate. */
    this.brakePower = options.brakePower ?? 2.5;
    /**
     * Speed the drag curve is balanced around, m/s. Quadratic drag is scaled
     * by `paddlePower`, so the two stay in proportion and changing the paddle
     * strength doesn't quietly move the top speed. Waves can and should push
     * the board past this.
     */
    this.maxSpeed = options.maxSpeed ?? 12;
    /** Linear drag, so the board eventually coasts to a stop. */
    this.linearDrag = options.linearDrag ?? 0.25;
    /** Yaw rate at full grip, rad/s. */
    this.turnRate = options.turnRate ?? 2.2;
    /** Speed at which the rails bite fully, m/s. */
    this.gripSpeed = options.gripSpeed ?? 6;
    /** How fast the velocity swings into line behind the board. */
    this.railGrip = options.railGrip ?? 4.5;
    /**
     * Hardest sideways acceleration the fins can hold, m/s². Caps the turn
     * rate at speed, so the radius opens up instead of collapsing.
     */
    this.maxLateralAccel = options.maxLateralAccel ?? 11.8;
    /**
     * How strongly the wave face pulls the board along. 1 is literal gravity;
     * the default exaggerates it, because real waves steepen and break and
     * these are smooth swell. This is the single knob that decides whether the
     * board is a jet ski or a surfboard — at 4, riding with the swell sustains
     * roughly twice the speed of fighting it.
     */
    this.slopeResponse = options.slopeResponse ?? 4;
    /**
     * Speed cost of a hard carve, as a drag coefficient on lateral
     * acceleration. Tuned so a sustained full-lock carve holds about 75% of
     * straight-line speed — enough to feel like a decision, not a handbrake.
     * Set to 0 for free turns.
     */
    this.carveDrag = options.carveDrag ?? 0.25;
    /** Lean limit, radians. */
    this.maxBank = options.maxBank ?? 0.9;
    /** Fraction of the physically correct lean angle to actually apply. */
    this.bankScale = options.bankScale ?? 0.8;
    /** How proud of the surface the board floats. */
    this.rideHeight = options.rideHeight ?? 0.05;
    /** Orientation response, per second. Higher is twitchier. */
    this.responsiveness = options.responsiveness ?? 8;

    // --- Reading the wave ---------------------------------------------------
    /**
     * Extra drive in the pocket, m/s². Not physics — gravity down the face
     * already covers that. This is the arcade reward for finding the spot.
     */
    this.pocketBoost = options.pocketBoost ?? 5.5;
    /**
     * Where the pocket sits, as phase measured ahead of the crest. The face
     * runs 0 (crest) to pi (trough) and is steepest at pi/2; the pocket is set
     * a little above that, up toward the curl where the wave has most to give.
     */
    this.pocketCentre = options.pocketCentre ?? 1.15;
    this.pocketWidth = options.pocketWidth ?? 0.8;
    /**
     * Extra drag on flat water, as a coefficient on speed. The board coming
     * off its plane once there's no face under it.
     */
    this.flatDrag = options.flatDrag ?? 0.5;
    /** Slope at which the surface stops counting as flat. */
    this.flatSlope = options.flatSlope ?? 0.13;
    /** Section barrel value above which you're in a barrelling section. */
    this.barrelLevel = options.barrelLevel ?? 0.5;
    /**
     * How near the crest you must be to be inside the tube, in wave phase.
     *
     * Set just tighter than where the board naturally rides (measured: median
     * 1.70, p10 1.52, p90 1.83), so holding a better line than average is what
     * gets you barrelled. Tucking deliberately deeper isn't the move — steering
     * up the face scrubs the speed that keeps you in the pocket at all — so the
     * skill here is the core one: hold position while a barrel section arrives.
     */
    this.barrelWindow = options.barrelWindow ?? 1.75;
    /** Extra drive from the barrel pushing you along, m/s². */
    this.barrelBoost = options.barrelBoost ?? 3;

    // --- Tricks -------------------------------------------------------------
    /** How close to the crest counts as the lip, in wave phase. */
    this.lipWindow = options.lipWindow ?? 0.6;
    /**
     * Speed needed to launch off the lip, m/s. Low, because getting to the lip
     * means turning up the face, and that turn spends most of your speed —
     * measured arrival is 3-5 m/s. The pop comes from `climbRate`, not this.
     */
    this.airMinSpeed = options.airMinSpeed ?? 3.5;
    /** Speed needed for any trick at all. */
    this.trickMinSpeed = options.trickMinSpeed ?? 3.5;
    /**
     * Baseline pop off the lip, m/s. Frankly arcade, and it has to be: a crest
     * is by definition where the surface's vertical motion is near zero, so the
     * measured climb into a lip is only ~0.5 m/s — nowhere near enough to throw
     * a board into the air. The physical terms below add to this, they don't
     * carry it.
     */
    this.basePop = options.basePop ?? 3.5;
    /** Fraction of the climb up the face converted into pop. */
    this.climbFactor = options.climbFactor ?? 0.95;
    /** Fraction of forward speed that also feeds the launch. */
    this.launchFactor = options.launchFactor ?? 0.25;
    this.maxLaunchSpeed = options.maxLaunchSpeed ?? 7.5;
    /** A flat-water hop is a fraction of a real launch. */
    this.ollieFactor = options.ollieFactor ?? 0.35;
    /** Air drag while off the water — much lower than through it. */
    this.airDrag = options.airDrag ?? 0.12;
    /**
     * Fraction of the expected airtime a rotation is paced to finish in. Under
     * 1 on purpose: the water rises and falls under you, so real airtime never
     * matches the flat-water prediction. Finishing early means the board is
     * squared up and *waiting* by touchdown, and only a badly mistimed launch
     * still has it turning.
     */
    this.spinPace = options.spinPace ?? 0.78;
    /** Seconds a grounded carve trick takes. */
    this.carveTrickDuration = options.carveTrickDuration ?? 0.5;
    /** Speed kept after a clean landing. */
    this.landingSpeedKeep = options.landingSpeedKeep ?? 0.92;
    /**
     * How far the spin may be from square-to-the-water on touchdown, radians.
     * Miss by more and you bury a rail.
     *
     * Forgiving by design: at the defaults a rotation lands cleanly ~9 times
     * in 10, because the difficulty of an air is meant to sit in *reaching*
     * the lip — which costs you your speed and risks the wave leaving without
     * you — rather than in a dice roll at the end of it. Push `spinPace`
     * toward 1 if you want the landing itself to be the gamble.
     */
    this.landingTolerance = options.landingTolerance ?? 0.7;
    /** Called with (board, type) when a trick completes cleanly. */
    this.onTrick = options.onTrick ?? null;

    /** Null, or { type, elapsed, duration, spin, dir }. */
    this.trick = null;
    this.airborne = false;
    this._verticalSpeed = 0;
    this._trickYaw = 0;
    this._trickPitch = 0;
    this._trickRoll = 0;
    /** Vertical speed of the water carrying the board, m/s. */
    this.climbRate = 0;

    // --- Wipeouts -----------------------------------------------------------
    // The turn rate is already capped by fin grip, so on its own the board can
    // never lose control. This lets it: ask for far more turn than the rails
    // can hold, fast enough, and they let go.
    this.wipeoutsEnabled = options.wipeoutsEnabled ?? true;
    /** How far past the grip limit the demand must go. Rules out gentle steering. */
    this.wipeoutMargin = options.wipeoutMargin ?? 1.5;
    /**
     * Speed gate, m/s. The real trigger, and placed against the measured speed
     * distribution: riding the swell sits around 11.0-11.8, while a sustained
     * carve never gets past 10.5. So slamming full lock washes you out only
     * when you're genuinely up to speed, and a carve can never retrigger one.
     */
    this.wipeoutMinSpeed = options.wipeoutMinSpeed ?? 11.3;
    this.wipeoutDuration = options.wipeoutDuration ?? 1.6;
    /** Speed kept at the moment the rail lets go. */
    this.wipeoutSpeedLoss = options.wipeoutSpeedLoss ?? 0.45;
    this.wipeoutSpin = options.wipeoutSpin ?? 3.4;
    this.wipeoutDrag = options.wipeoutDrag ?? 1.4;
    /** Pocket engagement needed before you count as riding the wave. */
    this.rideEnter = options.rideEnter ?? 0.45;
    /** And the speed. Below this you're bobbing, not riding. */
    this.rideMinSpeed = options.rideMinSpeed ?? 5;
    /** Turn this far off the wave and you've kicked out; no penalty. */
    this.rideExitAlignment = options.rideExitAlignment ?? 0.25;
    /** How far behind the crest counts as having lost it. */
    this.backThreshold = options.backThreshold ?? -0.2;
    /** Foam coverage that counts as being in the whitewater. */
    this.foamGrabLevel = options.foamGrabLevel ?? 0.72;
    /** Seconds in the whitewater before it takes you down. */
    this.foamGrabTime = options.foamGrabTime ?? 1.2;
    /**
     * Seconds of immunity after getting back up, m/s.
     *
     * Not a nicety — without it the game death-spirals. Everything that ends a
     * ride leaves the board slow and out of position, which is precisely the
     * state that triggers the whitewater and off-the-back wipeouts, so one rock
     * measurably cascaded into 24 more over five minutes. The grace gives you
     * the room to paddle back onto the wave.
     */
    this.wipeoutGrace = options.wipeoutGrace ?? 2.5;
    /** Along-wave speed paddling aims for, as a multiple of the wave's own. */
    this.catchTarget = options.catchTarget ?? 1;
    /** Below this speed the paddle always works, regardless of wave phase. */
    this.paddleAssistSpeed = options.paddleAssistSpeed ?? 6;
    /** How far the paddle target shifts to chase the pocket, as a fraction of c. */
    this.catchUrgency = options.catchUrgency ?? 0.9;
    /** How fast the nose swings back to the swell while recovering, per second. */
    this.recoverySteer = options.recoverySteer ?? 2.5;
    /** Pocket engagement that keeps you ahead of the whitewater. */
    this.foamShelterPocket = options.foamShelterPocket ?? 0.4;
    /** How fast that exposure clears once you're out, as a multiple of real time. */
    this.foamRecoveryRate = options.foamRecoveryRate ?? 3;

    /** Called once when a wipeout starts, as (board, reason). */
    this.onWipeout = options.onWipeout ?? null;

    /** 1 at the moment of a wipeout, easing to 0 as the board recovers. */
    this.wipeout = 0;
    /** 'rail' | 'back' | 'foam', or null if the board has never gone down. */
    this.wipeoutReason = null;
    this._wipeoutDir = 1;
    this._foamExposure = 0;
    this._grace = 0;

    /** 0..1 engagement with the wave's power pocket. */
    this.pocket = 0;
    /** True while committed to a wave — set this down and you fall off the back. */
    this.riding = false;
    /** How strongly the section under the board is barrelling, 0..1. */
    this.barrel = 0;
    /** True while actually inside the tube. */
    this.inBarrel = false;

    this.heading = options.heading ?? 0;
    /** World-space XZ velocity. */
    this.velocity = new THREE.Vector2();

    this.group = new THREE.Group();
    this.group.add(this._buildMesh());

    // Live state, exposed because a HUD or spray effect will want it.
    this.bank = 0;
    this.pitch = 0;
    this.surfaceRoll = 0;
    this.carve = 0;

    // Per-frame scratch, reused so update() allocates nothing.
    this._surface = { height: 0, slopeX: 0, slopeZ: 0, foam: 0 };
    this._wave = { offset: 0, dirX: 0, dirZ: 1, phaseSpeed: 0, steepness: 0 };
    this._forward = new THREE.Vector2();
    this._left = new THREE.Vector2();
    this._yawQuat = new THREE.Quaternion();
    this._pitchQuat = new THREE.Quaternion();
    this._rollQuat = new THREE.Quaternion();
  }

  get position() {
    return this.group.position;
  }

  get speed() {
    return this.velocity.length();
  }

  /** 0 on a steep face, 1 on water with nothing left to give. */
  _flatness(surface) {
    const slope = Math.hypot(surface.slopeX, surface.slopeZ);
    return 1 - Math.min(slope / this.flatSlope, 1);
  }

  _buildBoardGeometry() {
    // Half-length and half-width of a shortboard, in metres.
    const L = 1.1;
    const W = 0.28;

    const shape = new THREE.Shape();
    shape.moveTo(0, L);
    shape.bezierCurveTo(W * 0.55, L * 0.72, W, L * 0.28, W, 0);
    shape.bezierCurveTo(W, -L * 0.42, W * 0.72, -L * 0.78, W * 0.42, -L * 0.95);
    shape.bezierCurveTo(W * 0.2, -L * 1.03, -W * 0.2, -L * 1.03, -W * 0.42, -L * 0.95);
    shape.bezierCurveTo(-W * 0.72, -L * 0.78, -W, -L * 0.42, -W, 0);
    shape.bezierCurveTo(-W, L * 0.28, -W * 0.55, L * 0.72, 0, L);

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.055,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.018,
      bevelSegments: 3,
      curveSegments: 24,
    });

    // The shape is authored in XY and extruded along Z; stand it up so length
    // runs along +Z (nose forward) and thickness along Y.
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0.0275, 0);

    // Bend in the rocker after the fact — far simpler than trying to author a
    // curved solid, and it keeps the outline exactly as drawn above.
    const position = geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, position.getY(i) + rockerAt(position.getZ(i)));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();

    return geometry;
  }

  _buildMesh() {
    const board = new THREE.Group();

    const boardMaterial = new THREE.MeshStandardMaterial({
      color: 0xf6f4ee,
      roughness: 0.28,
      metalness: 0.05,
    });
    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0xe4483a,
      roughness: 0.3,
      metalness: 0.05,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x24303a,
      roughness: 0.85,
    });

    // ExtrudeGeometry emits two groups: the flat caps, then the side walls.
    const deck = new THREE.Mesh(this._buildBoardGeometry(), [boardMaterial, railMaterial]);

    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.018, 0.42), darkMaterial);
    pad.position.set(0, 0.055 + rockerAt(-0.72), -0.72);

    const parts = [deck, pad];

    // Thruster fins: flattened cones, close enough at any distance you'll see
    // them from.
    const finGeometry = new THREE.ConeGeometry(0.075, 0.18, 4);
    finGeometry.rotateX(Math.PI); // point downward
    finGeometry.scale(0.24, 1, 1); // flatten into a blade

    for (const [x, z] of [
      [0, -0.92],
      [0.19, -0.74],
      [-0.19, -0.74],
    ]) {
      const fin = new THREE.Mesh(finGeometry, darkMaterial);
      fin.position.set(x, -0.03 + rockerAt(z) - 0.09, z);
      parts.push(fin);
    }

    for (const part of parts) {
      part.castShadow = true;
      part.receiveShadow = true;
      board.add(part);
    }

    return board;
  }

  /**
   * Puts the board down. `reason` is one of 'rail', 'back' or 'foam'; `spin`
   * is which way it tumbles.
   */
  _startWipeout(reason, spin) {
    if (!this.wipeoutsEnabled || this.wipeout > 0) return;

    this.wipeout = 1;
    this._grace = this.wipeoutGrace;
    this.wipeoutReason = reason;
    this._wipeoutDir = spin || 1;
    this._foamExposure = 0;
    this.riding = false;

    // Whatever was in progress is over.
    this.trick = null;
    this.airborne = false;
    this._verticalSpeed = 0;
    this._trickYaw = 0;
    this._trickPitch = 0;
    this._trickRoll = 0;
    this.velocity.multiplyScalar(this.wipeoutSpeedLoss);

    if (this.onWipeout) this.onWipeout(this, reason);
  }

  // Which trick a direction gives. Keyed off the steer input rather than off
  // the board's angle to the wave: riding well means sitting nearly *on* the
  // wave's line, and from there a turn either way leads away from it equally,
  // so any "into the wave or away" test is degenerate exactly when it matters
  // most. Steer direction is also the thing the player can actually aim, which
  // matters when the scoring pays for variety.
  static AIR_TRICKS = { right: 'spin', left: 'alleyoop', none: 'air' };
  static CARVE_TRICKS = { right: 'snap', left: 'cutback' };

  _trickFor(steer, airborne) {
    const table = airborne ? Surfboard.AIR_TRICKS : Surfboard.CARVE_TRICKS;
    if (steer > 0) return table.right;
    if (steer < 0) return table.left;
    return table.none;
  }

  /**
   * Fires a trick if the board is in a position to do one. Off the lip with
   * speed you get air; anywhere else you get a turn or a hop.
   */
  _tryTrick(steer, wave, speed) {
    if (this.trick || this.airborne || this.wipeout > 0) return;
    if (speed < this.trickMinSpeed) return;

    const atLip = wave && Math.abs(wave.offset) < this.lipWindow;
    const dir = Math.sign(steer) || 1;

    if (atLip && speed >= this.airMinSpeed) {
      const pop =
        this.basePop + Math.max(this.climbRate, 0) * this.climbFactor + speed * this.launchFactor;
      this._launch(
        this._trickFor(steer, true),
        Math.min(pop, this.maxLaunchSpeed),
        steer ? 1 : 0,
        dir,
      );
      return;
    }

    if (steer) {
      // Grounded: a turn hard enough to be worth naming. It costs a little
      // speed, the way throwing the tail out actually does.
      this.velocity.multiplyScalar(0.94);
      this.trick = {
        type: this._trickFor(steer, false),
        elapsed: 0,
        duration: this.carveTrickDuration,
        spin: 0,
        dir,
      };
      return;
    }

    // Nothing under you and nothing held: a hop, so the key always does
    // *something*. Worth very little.
    this._launch('ollie', speed * this.ollieFactor, 0, dir);
  }

  _launch(type, verticalSpeed, spin, dir) {
    this.airborne = true;
    this._verticalSpeed = verticalSpeed;

    // Ballistic flight time, so a rotation is paced to finish exactly as the
    // board comes back down. Land early or late and it's still turning.
    const airtime = Math.max((2 * verticalSpeed) / GRAVITY, 0.12);

    this.trick = { type, elapsed: 0, duration: airtime * this.spinPace, spin, dir };
  }

  /** Ends a trick. Grounded ones always stick; air has to be squared up. */
  _finishTrick(clean) {
    const trick = this.trick;
    this.trick = null;
    this._trickYaw = 0;
    this._trickPitch = 0;
    this._trickRoll = 0;

    if (!trick) return;

    if (clean) {
      this.velocity.multiplyScalar(this.landingSpeedKeep);
      if (this.onTrick) this.onTrick(this, trick.type);
    } else {
      this._startWipeout('landing', trick.dir);
    }
  }

  /** Drives the trick animation and the spin the landing is judged against. */
  _advanceTrick(delta) {
    const trick = this.trick;
    if (!trick) return;

    trick.elapsed += delta;
    const progress = THREE.MathUtils.clamp(trick.elapsed / trick.duration, 0, 1);

    if (this.airborne) {
      this._trickYaw = trick.dir * trick.spin * Math.PI * 2 * progress;
      // Nose lifts through the arc and settles; a little roll for style.
      this._trickPitch = -Math.sin(progress * Math.PI) * 0.3;
      this._trickRoll = trick.dir * Math.sin(progress * Math.PI) * 0.35;
    } else {
      // A snap is a hard pivot with the board thrown on its rail.
      const swing = Math.sin(progress * Math.PI);
      this._trickYaw = trick.dir * swing * 0.45;
      this._trickRoll = trick.dir * swing * 0.7;
      this._trickPitch = swing * 0.12;

      if (progress >= 1) this._finishTrick(true);
    }
  }

  /** False while down, and for a moment after, so hazards can't chain. */
  get vulnerable() {
    return this.wipeout <= 0 && this._grace <= 0;
  }

  /** Put the board down from outside — an obstacle, a script, a test. */
  crash(reason = 'rock') {
    if (!this.vulnerable) return;
    this._startWipeout(reason, 1);
  }

  update(delta) {
    const input = this.input;
    const steer = input ? input.horizontal : 0;
    const throttle = input ? input.vertical : 0;
    const position = this.group.position;

    // Where we sit in the dominant wave. Sampled up front because recovery
    // steering needs the swell's direction before the heading is touched; the
    // pocket and barrel below reuse the same reading.
    const wave = this.ocean
      ? this.ocean.sampleWaveFrame(position.x, position.z, this._wave)
      : null;

    // --- Steering -----------------------------------------------------------
    // A board with no water flowing over it barely turns; grip arrives with
    // speed. The floor leaves just enough authority to pivot while paddling.
    const entrySpeed = this.velocity.length();

    // A washed-out board has no steering authority until it settles.
    const control = 1 - this.wipeout;
    const grip = (0.25 + 0.75 * Math.min(entrySpeed / this.gripSpeed, 1)) * control;

    // Fins can only push sideways so hard. Holding the turn rate under that
    // limit means the radius opens up with speed instead of collapsing to
    // something no board could hold, and it lets the bank angle below saturate
    // on its own rather than needing to be clamped by eye.
    const yawLimit = this.maxLateralAccel / Math.max(entrySpeed, 0.5);
    const demandedYaw = -steer * this.turnRate * grip;
    const yawRate = THREE.MathUtils.clamp(demandedYaw, -yawLimit, yawLimit);
    this.heading += yawRate * delta;

    // How much more turn was asked for than the rails can hold. Past the
    // margin they let go. Because a wipeout zeroes `control` and therefore
    // `demandedYaw`, this can't retrigger while one is already in progress.
    const overload = Math.abs(demandedYaw) / Math.max(yawLimit, 1e-4);
    if (
      this.wipeoutsEnabled &&
      this.wipeout <= 0 &&
      overload > this.wipeoutMargin &&
      entrySpeed > this.wipeoutMinSpeed
    ) {
      this._startWipeout('rail', Math.sign(steer) || 1);
    }

    if (this.wipeout > 0) {
      // Keep spinning the way the turn was going, and slacken off as it settles.
      this.heading -= this._wipeoutDir * this.wipeoutSpin * this.wipeout * delta;
      this.wipeout = Math.max(0, this.wipeout - delta / this.wipeoutDuration);
    } else if (this._grace > 0) {
      this._grace = Math.max(0, this._grace - delta);

      // Point the nose back at the swell while getting up.
      //
      // The tumble spins the board about 157 degrees, so it stands up facing
      // out to sea. Paddling from there thrusts at -92% along the wave — it
      // drives you *away* from the wave you're trying to catch, which is why
      // holding the paddle used to make recovery strictly worse than doing
      // nothing. Steering yourself overrides this immediately.
      if (wave && steer === 0) {
        const waveHeading = Math.atan2(wave.dirX, wave.dirZ);
        const offBy = waveHeading - this.heading;
        const wrapped = Math.atan2(Math.sin(offBy), Math.cos(offBy));

        this.heading += wrapped * (1 - Math.exp(-this.recoverySteer * delta));
      }
    }

    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    this._forward.set(sin, cos);
    this._left.set(cos, -sin);

    // --- Forces -------------------------------------------------------------
    const surface = this.ocean
      ? this.ocean.sampleSurface(position.x, position.z, this._surface)
      : this._surface;

    // In the air none of the water forces apply — no face to be pulled down,
    // no rail to hold a line, no plane to fall off. Only gravity and drag.
    const waterborne = !this.airborne;

    if (waterborne) {
      // Gravity along the wave face. This is the whole game: it's what turns a
      // steep face into speed and a flat trough into a stall.
      this.velocity.x -= GRAVITY * surface.slopeX * this.slopeResponse * delta;
      this.velocity.y -= GRAVITY * surface.slopeZ * this.slopeResponse * delta;
    }

    // --- The pocket ---------------------------------------------------------
    // Where you sit within the dominant wave. Just ahead of the crest, on the
    // steep part of the advancing face, is the pocket: the wave is doing the
    // most work there, and it's the only place you can hold position without
    // paddling. Gravity alone already rewards the steep face; this is the
    // frankly arcade bonus on top that makes the spot worth hunting for.
    let alignment = 0;
    if (wave) {
      alignment = this._forward.x * wave.dirX + this._forward.y * wave.dirZ;

      const fromCentre = (wave.offset - this.pocketCentre) / this.pocketWidth;
      this.pocket = Math.exp(-fromCentre * fromCentre) * Math.max(alignment, 0);

      if (waterborne) {
        this.velocity.addScaledVector(this._forward, this.pocketBoost * this.pocket * delta);
      }
    } else {
      this.pocket = 0;
    }

    // --- The barrel ---------------------------------------------------------
    // Inside the tube: a barrelling section, tucked up near the crest, riding.
    // The lip is throwing over you rather than onto you, and the wave is
    // pushing hard, so it pays in speed as well as in points.
    this.barrel = surface.barrel ?? 0;
    this.inBarrel =
      this.barrel > this.barrelLevel &&
      wave !== null &&
      Math.abs(wave.offset) < this.barrelWindow &&
      this.riding &&
      !this.airborne;

    if (this.inBarrel) {
      this.velocity.addScaledVector(this._forward, this.barrelBoost * this.barrel * delta);
    }

    // --- Tricks -------------------------------------------------------------
    if (input && input.wasPressed('trick')) {
      this._tryTrick(steer, wave, entrySpeed);
    }
    this._advanceTrick(delta);

    if (throttle > 0) {
      // Paddling matches the wave rather than outrunning it: thrust fades out
      // as the board's speed *along the swell* reaches the wave's own.
      //
      // Without this, holding the paddle drives you straight past the pocket
      // and parks you down the face ahead of it (measured: settling at phase
      // 2.3 against a pocket at 1.15, engagement 0.1), so paddling to recover
      // left you permanently just off the wave. It also matches the design
      // everywhere else here — the paddle is for catching a wave, not for
      // going fast once you're on one.
      let thrust = this.paddlePower * throttle;

      if (wave) {
        // Aim at the pocket, not merely at the wave. Matching the wave's speed
        // exactly freezes your phase wherever you happen to be, so a board
        // stranded behind the crest just stays there — which is why holding the
        // paddle recovered more slowly than doing nothing at all. Steering the
        // target by the shortest way round to the pocket means the paddle
        // drives forward when forward is the way, and gets out of the way when
        // the shorter route is to let the wave roll through and come to you.
        const toPocket = this.pocketCentre - wave.offset;
        const shortest = Math.atan2(Math.sin(toPocket), Math.cos(toPocket)) / Math.PI;

        const target =
          wave.phaseSpeed * (this.catchTarget + this.catchUrgency * shortest);
        const alongWave = this.velocity.x * wave.dirX + this.velocity.y * wave.dirZ;
        const deficit = (target - alongWave) / wave.phaseSpeed;

        // Below `paddleAssistSpeed` the paddle always bites, whatever the phase
        // logic thinks — otherwise a board sitting still at an awkward point in
        // the wave can't paddle at all, which is the one moment you certainly
        // should be able to.
        const stranded = THREE.MathUtils.clamp(1 - entrySpeed / this.paddleAssistSpeed, 0, 1);

        thrust *= Math.max(THREE.MathUtils.clamp(deficit, 0, 1), stranded);
      }

      this.velocity.addScaledVector(this._forward, thrust * delta);
    } else if (throttle < 0) {
      // Dragging a foot: bleeds speed rather than driving the board backwards.
      this.velocity.multiplyScalar(Math.exp(this.brakePower * throttle * delta));
    }

    // --- Rail grip ----------------------------------------------------------
    // Swing the velocity round toward where the board points, keeping its
    // magnitude. A rail supplies centripetal force, and a centripetal force
    // does no work — it redirects momentum rather than destroying it. Damping
    // the sideways component instead (the obvious way to write this) silently
    // turns every turn into a brake: it bled roughly two thirds of the board's
    // speed away in a sustained carve, no matter how the drag was tuned.
    const carried = this.velocity.length();
    if (waterborne && carried > 1e-4) {
      const velocityAngle = Math.atan2(this.velocity.x, this.velocity.y);
      const offset = this.heading - velocityAngle;
      // Wrap to [-pi, pi] so the board never takes the long way round.
      const wrapped = Math.atan2(Math.sin(offset), Math.cos(offset));
      // A washed-out rail barely redirects anything; the board just slides.
      const railGrip = this.railGrip * (0.15 + 0.85 * control);
      const aligned = velocityAngle + wrapped * (1 - Math.exp(-railGrip * delta));

      this.velocity.set(Math.sin(aligned) * carried, Math.cos(aligned) * carried);
    }

    // --- Drag and carve cost ------------------------------------------------
    // Quadratic drag balanced so full paddle tops out near maxSpeed, plus a
    // linear term so the board actually coasts to rest.
    const forwardSpeed = this.velocity.dot(this._forward);
    const speed = this.velocity.length();
    this.carve = Math.abs(yawRate) * Math.max(forwardSpeed, 0);

    const deceleration = this.airborne
      ? this.airDrag * speed
      : this.paddlePower * (speed / this.maxSpeed) ** 2 +
      this.linearDrag * speed +
      // Burying a rail costs speed. Without this a hard carve is free, and the
      // whole trade-off at the heart of surfing disappears.
      this.carveDrag * this.carve +
      // Sideways through the water costs a great deal more.
      this.wipeoutDrag * this.wipeout * speed +
      // Flat water gives nothing back. Off the face, the board settles off its
      // plane and the speed bleeds away — which is what makes the difference
      // between the face and the flats something you can feel rather than just
      // an absence of acceleration.
      this.flatDrag * this._flatness(surface) * speed;

    const scrubbed = Math.max(0, speed - deceleration * delta);
    if (speed > 1e-5) this.velocity.multiplyScalar(scrubbed / speed);

    position.x += this.velocity.x * delta;
    position.z += this.velocity.y * delta;

    // --- Ride the surface ---------------------------------------------------
    const ride = this.ocean
      ? this.ocean.sampleSurface(position.x, position.z, this._surface)
      : this._surface;

    const deck = ride.height + this.rideHeight;

    if (this.airborne) {
      this._verticalSpeed -= GRAVITY * delta;
      position.y += this._verticalSpeed * delta;

      // Touchdown. The water can rise to meet you, so this tests against the
      // live surface rather than the height launched from.
      if (position.y <= deck && this._verticalSpeed < 0) {
        position.y = deck;
        this.airborne = false;
        this._verticalSpeed = 0;

        // Square to the water, or close enough? A rotation left part-finished
        // catches a rail. A straight air has nothing to get wrong.
        const residual = Math.atan2(Math.sin(this._trickYaw), Math.cos(this._trickYaw));
        this._finishTrick(Math.abs(residual) < this.landingTolerance);
      }
    } else {
      // How fast the board is being carried up the face. Driving up toward the
      // crest is what actually launches you off a lip, so this is what the
      // trick uses for pop — not raw speed, which a hard turn up the face has
      // mostly spent by the time you get there.
      this.climbRate = THREE.MathUtils.clamp((deck - position.y) / Math.max(delta, 1e-4), -12, 12);
      position.y = deck;
    }

    // Project the surface gradient onto the board's own axes. Downhill ahead
    // drops the nose; a higher left rail rolls the board right.
    const slopeAlongBoard = ride.slopeX * this._forward.x + ride.slopeZ * this._forward.y;
    const slopeAcrossBoard = ride.slopeX * this._left.x + ride.slopeZ * this._left.y;

    // Airborne, the water below is irrelevant — level out and let the trick
    // animation own the orientation.
    const pitchTarget = this.airborne ? 0 : -Math.atan(slopeAlongBoard);
    const surfaceRollTarget = this.airborne ? 0 : Math.atan(slopeAcrossBoard);

    // Lean angle for a banked turn: tan(theta) = v * omega / g. Falling out of
    // the real physics means the board leans harder the faster it's carving,
    // without any of that needing to be hand-tuned.
    let bankTarget = THREE.MathUtils.clamp(
      Math.atan2(-yawRate * Math.max(forwardSpeed, 0), GRAVITY) * this.bankScale,
      -this.maxBank,
      this.maxBank,
    );

    // Mid-wipeout the board is over on its rail rather than driving a turn.
    if (this.wipeout > 0) {
      bankTarget = this._wipeoutDir * this.maxBank * this.wipeout;
    }

    // --- Losing the wave ----------------------------------------------------
    // Suspended mid-air: you can't be overtaken by a wave or held under by
    // foam while you're above both of them.
    if (wave && this.wipeoutsEnabled && this.vulnerable && !this.airborne) {
      // You count as riding once you've settled into the pocket with some
      // speed under you. Turning off the wave clears it, so kicking out
      // deliberately is always safe — only failing to keep up is punished.
      if (this.pocket > this.rideEnter && speed > this.rideMinSpeed) this.riding = true;
      if (alignment < this.rideExitAlignment) this.riding = false;

      // The wave travels at `phaseSpeed`. Ride slower than that and it steadily
      // overtakes you: your position in its frame slides back toward the crest,
      // then past it. Once the crest is behind you the wave has gone without
      // you, and you're off the back.
      //
      // The lower bound matters. `offset` wraps at +/-pi, so a board that
      // *outran* the wave and shot off the front reappears at -pi — which
      // without this would be reported as falling off the back, the opposite
      // mistake. Genuinely losing it means being just behind the crest.
      const justBehindCrest =
        wave.offset < this.backThreshold && wave.offset > -Math.PI * 0.75;

      if (this.riding && justBehindCrest) {
        this._startWipeout('back', Math.sign(this._left.x) || 1);
      }

      // Whitewater. `surface.foam` is the same value the shader paints with, so
      // this only grabs you on water that visibly has foam on it. It needs a
      // sustained dose — clipping the edge of a whitecap shouldn't end a ride.
      if (this.vulnerable) {
        // Foam only takes you once you've lost your place on the wave. Sitting
        // in the pocket means you're on the clean face ahead of the break, and
        // a barrel is foam by construction — it's the lip throwing over you.
        // Without both exemptions, steep sections foam so heavily that being
        // "caught inside" fires constantly while you're riding perfectly well.
        const exposed = !this.inBarrel && this.pocket < this.foamShelterPocket;
        const inWhitewater = surface.foam > this.foamGrabLevel && exposed;

        this._foamExposure = inWhitewater
          ? this._foamExposure + delta
          : Math.max(0, this._foamExposure - delta * this.foamRecoveryRate);

        if (this._foamExposure > this.foamGrabTime) {
          this._startWipeout('foam', Math.sign(this._left.x) || 1);
        }
      }
    }

    const ease = 1 - Math.exp(-this.responsiveness * delta);
    this.pitch += (pitchTarget - this.pitch) * ease;
    this.surfaceRoll += (surfaceRollTarget - this.surfaceRoll) * ease;
    this.bank += (bankTarget - this.bank) * ease;

    // Composed as quaternions rather than set as Euler angles: at a 50° lean
    // the XYZ Euler order cross-couples pitch and roll and the board wobbles.
    this._yawQuat.setFromAxisAngle(UP, this.heading + this._trickYaw);
    this._pitchQuat.setFromAxisAngle(AXIS_X, this.pitch + this._trickPitch);
    this._rollQuat.setFromAxisAngle(AXIS_Z, this.surfaceRoll + this.bank + this._trickRoll);

    this.group.quaternion
      .copy(this._yawQuat)
      .multiply(this._pitchQuat)
      .multiply(this._rollQuat);
  }
}
