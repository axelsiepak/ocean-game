import * as THREE from 'three';

import { Ocean } from '../entities/Ocean.js';
import { Player } from '../entities/Player.js';
import { Sky } from '../entities/Sky.js';
import { Rocks } from '../entities/Rocks.js';
import { Spray } from '../entities/Spray.js';
import { Surfboard } from '../entities/Surfboard.js';
import { Surfer } from '../entities/Surfer.js';
import { AudioEngine } from '../systems/AudioEngine.js';
import { Scoring } from '../systems/Scoring.js';
import { CameraRig } from '../utils/CameraRig.js';
import { ControlPanel } from '../utils/ControlPanel.js';
import { Hud } from '../utils/Hud.js';
import { Input } from '../utils/input.js';

/**
 * Owns everything in the world: what exists, how it's wired together, and what
 * needs updating each frame. `main.js` only knows about this class.
 */
export class MainScene {
  constructor(renderer, tier = {}) {
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      50000,
    );

    this.input = new Input();

    // Sunset. Low sun with heavy Rayleigh scattering for the reddening, and a
    // warm key light against a cool sky bounce — most of what sells the time of
    // day is that contrast rather than the sky colour itself.
    this.sky = new Sky({
      // Measured: at 0.055 the sun sits so low that most of the dome falls off
      // the bottom of the exposure. Lifting it to 0.12 — still under seven
      // degrees, still sunset — is on its own worth a third of the colour.
      elevation: 0.12,
      azimuth: 2.4,
      turbidity: 6,
      rayleigh: 3.1,
      mieCoefficient: 0.006,
      mieDirectionalG: 0.86,
      sunColor: 0xffb583,
      sunIntensity: 2.1,
      ambientSky: 0xffcaa4,
      ambientGround: 0x24374f,
      ambientIntensity: 0.55,
    });

    // The water's palette has to be authored against the sky it reflects, so
    // these move with the sun above.
    this.ocean = new Ocean({
      waveHeight: 1,
      waveSpeed: 1,
      choppiness: 1,
      foamAmount: 0.5,
      size: tier.oceanSize,
      segments: tier.oceanSegments,
      deepColor: 0x04121e,
      shallowColor: 0x155066,
      scatterColor: 0x3f8f84,
      zenithColor: 0x2b5a8c,
      horizonColor: 0xe8a878,
      foamColor: 0xffeadb,
      sunColor: 0xffb070,
    });
    this.surfboard = new Surfboard({ input: this.input, ocean: this.ocean });

    // The boat keeps its old job minus the controls: anchored scenery, and a
    // useful sense of scale next to a 2 m board.
    this.boat = new Player({ ocean: this.ocean });
    this.boat.position.set(26, 0, -34);

    // Bigger pool now that the wake runs continuously alongside carve spray.
    this.spray = new Spray({ renderer, capacity: tier.sprayCapacity ?? 700 });

    this.surfer = new Surfer();
    this.surfboard.group.add(this.surfer.group);
    this.rocks = new Rocks({ poolSize: tier.rockPool });

    this.ocean.setSunDirection(this.sky.sunDirection);
    this._matchWaterToSky();
    this.scene.add(
      this.sky.group,
      this.ocean.group,
      this.surfboard.group,
      this.boat.group,
      this.spray.points,
      this.rocks.group,
    );
    this.sky.applyEnvironment(renderer, this.scene);

    this.cameraRig = new CameraRig(this.camera, this.surfboard.group, {
      domElement: renderer.domElement,
      getHeading: () => this.surfboard.heading,
      // First-person is the default view; C falls back to the chase cam.
      mode: 'pov',
      // Widen the view once the rider is genuinely up to speed. 10 m/s is above
      // anything paddling can reach (5.1 max), so it only ever means the wave
      // is doing the work.
      getSpeed: () => this.surfboard.speed,
      // Carving costs speed, so on speed alone the rush cuts out mid-turn. Lean
      // buys back some of the threshold. Zero during a wipeout: bank is forced
      // to full lock on the way down, which would otherwise hold the boost on
      // through the crash.
      getLean: () =>
        this.surfboard.wipeout > 0
          ? 0
          : Math.min(1, Math.abs(this.surfboard.bank) / this.surfboard.maxBank),
      // Tight and low: a surfboard is a tenth the size of the boat, and sitting
      // near the water sells the wave motion far better than looking down on it.
      chase: { distance: 7.5, height: 2.2, lookHeight: 0.6 },
      // Keep the chase cam off the water — in a trough it would otherwise dip
      // under the surface, and the ocean is opaque.
      getMinHeight: (x, z) => this.ocean.sampleHeight(x, z) + 0.6,
    });

    // A wipeout is the one moment worth a real jolt — scaled by how violent it
    // is. Getting hammered by whitewater deserves more than the wave quietly
    // leaving without you.
    const jolt = { foam: 1, rail: 0.85, back: 0.5, landing: 0.9, rock: 1 };
    this.surfboard.onWipeout = (_, reason) => {
      this.cameraRig.addTrauma(jolt[reason] ?? 0.85);
      // Going down costs you the multiplier, not just the speed.
      this.scoring.drop(true);
      this.spray.burst(this.surfboard.position, 1.3);
      this.audio.splash(1.3);
    };

    this.audio = new AudioEngine();
    this.scoring = new Scoring();
    this.surfboard.onTrick = (_, type) => {
      this.scoring.land(type);
      // A landing throws water; a carve on the water already has its own spray.
      if (type !== 'snap' && type !== 'cutback') {
        this.spray.burst(this.surfboard.position, 0.8);
        this.audio.splash(0.6);
      }
    };

    this.hud = new Hud();

    this.panel = new ControlPanel(
      [
        {
          label: 'Wave height',
          min: 0,
          max: 3,
          get: () => this.ocean.waveHeight,
          set: (v) => (this.ocean.waveHeight = v),
        },
        {
          label: 'Wave speed',
          min: 0,
          max: 3,
          get: () => this.ocean.waveSpeed,
          set: (v) => (this.ocean.waveSpeed = v),
        },
        {
          label: 'Choppiness',
          min: 0,
          max: 2,
          get: () => this.ocean.choppiness,
          set: (v) => (this.ocean.choppiness = v),
        },
        {
          label: 'Foam',
          min: 0,
          max: 1,
          get: () => this.ocean.foamAmount,
          set: (v) => (this.ocean.foamAmount = v),
        },
        {
          label: 'Ripples',
          min: 0,
          max: 3,
          get: () => this.ocean.rippleStrength,
          set: (v) => (this.ocean.rippleStrength = v),
        },
        {
          label: 'Sun elevation',
          min: 0.02,
          max: 1.4,
          get: () => this.sky.elevation,
          set: (v) => this._setSunElevation(v),
        },
      ],
      { title: 'Ocean' },
    );
  }

  /**
   * Puts the world back to how a run starts. Rebuilding the scene instead would
   * mean regenerating a 49k-vertex ocean and re-baking the environment map on
   * every restart, which is a visible stall for no benefit.
   */
  reset() {
    const board = this.surfboard;

    board.position.set(0, 0, 0);
    board.velocity.set(0, 0);
    board.heading = Math.atan2(this.ocean.sectionAxis.x, this.ocean.sectionAxis.y);
    board.wipeout = 0;
    board.wipeoutReason = null;
    board.riding = false;
    board.pocket = 0;
    board.barrel = 0;
    board.inBarrel = false;
    board.trick = null;
    board.airborne = false;
    board.bank = 0;
    board.pitch = 0;
    board.surfaceRoll = 0;
    board.carve = 0;
    board._grace = 0;
    board._foamExposure = 0;
    board._verticalSpeed = 0;
    board._trickYaw = 0;
    board._trickPitch = 0;
    board._trickRoll = 0;

    // Restart the swell too, so every run meets the same sequence of steep
    // sections and barrels from the same starting point.
    this.ocean._waveTime = 0;

    this.scoring.reset();
    this.spray.clear();
    this.input.clear();

    // Seat the board on the water directly rather than running an update to do
    // it. A whole update would advance the board a frame before the run has
    // begun, and the wave coupling is chaotic enough that the frame is the
    // difference between two runs matching and drifting apart entirely.
    board.position.y = this.ocean.sampleHeight(0, 0) + board.rideHeight;
    this.cameraRig.reset();
  }

  /**
   * Hands the water the sky's own colours, so the reflection is of the sky
   * that's actually up there rather than of one authored months ago. Cheap
   * enough to redo whenever the sun moves: 25 evaluations of an analytic model.
   */
  _matchWaterToSky() {
    this._skyUp ??= new THREE.Vector3(0, 1, 0);
    this.ocean.setSkyPalette(this.sky.sampleColor(this._skyUp), this.sky.horizonColor());
  }

  _setSunElevation(elevation) {
    this.sky.setSunPosition(elevation, this.sky.azimuth);
    this.ocean.setSunDirection(this.sky.sunDirection);
    this._matchWaterToSky();

    // The environment map is a full re-render of the sky through PMREM, which
    // is far too costly to redo on every slider tick. The sky dome, the sun
    // light and the ocean's reflection all respond immediately above; only the
    // boat's reflections wait for the drag to settle, which nobody can see.
    clearTimeout(this._envTimer);
    this._envTimer = setTimeout(() => {
      this.sky.applyEnvironment(this.renderer, this.scene);
    }, 150);
  }

  /**
   * Order matters. The ocean goes first so its wave clock is current before the
   * player samples the surface to float on it — otherwise buoyancy trails the
   * water by a frame and the boat visibly sinks into crests at high wave speed.
   *
   * The cost is that the ocean re-centres on last frame's player position, which
   * is invisible: that position is snapped to a multi-metre vertex grid anyway.
   */
  update(delta, elapsed) {
    const focus = this.surfboard.position;

    this.ocean.update(delta, elapsed, focus);
    this.surfboard.update(delta, elapsed);
    // After the board, so spray leaves the rail from this frame's pose.
    this.spray.update(delta, this.surfboard);
    this.surfer.update(delta, this.surfboard);
    this.boat.update(delta, elapsed);
    this.rocks.update(delta, focus);

    // Rocks are checked after the board has moved, against where it ended up.
    if (this.surfboard.vulnerable) {
      const struck = this.rocks.hitTest(focus.x, focus.z, focus.y);
      if (struck) this.surfboard.crash('rock');
    }
    this.sky.update(delta, elapsed, focus);

    // Turning rumbles continuously, keyed off the lateral g-force the fins are
    // holding — the same quantity that sets the lean angle, so the shake always
    // agrees with how hard the board *looks* like it's turning. Note that means
    // a fast committed turn shakes more than a slow full-lock one, which is
    // correct: it's pulling more g. Going straight pulls none, so straight-line
    // riding is perfectly steady.
    //
    // The range starts just above where spray does, so shake reads as the board
    // being pushed past comfortable rather than as noise on every twitch.
    this.cameraRig.setSustained(
      THREE.MathUtils.clamp((this.surfboard.carve - 4.0) / 2.5, 0, 1) * 0.58,
    );
    this.cameraRig.update(delta);

    // The rider goes with the camera: POV puts the eye at head height on the
    // deck, so the mannequin would be the view. Keyed off the blend rather than
    // the mode, and deliberately early in it — the fade runs between 8.6 m and
    // 5.6 m of camera distance, where the rider is 8-12 degrees of a 60 degree
    // view. Fading it later means dissolving a body across half the screen.
    this.surfer.setOpacity(1 - THREE.MathUtils.smoothstep(this.cameraRig.povWeight, 0.05, 0.4));
    this.scoring.update(delta, this.surfboard);
    this.audio.update(delta, this.surfboard);
    this.hud.update(this.surfboard, this.scoring, this.audio);
  }

  dispose() {
    clearTimeout(this._envTimer);
    this.input.dispose();
    this.cameraRig.dispose();
    this.panel.dispose();
    this.hud.dispose();
    this.audio.dispose();
    this.spray.dispose();
  }
}
