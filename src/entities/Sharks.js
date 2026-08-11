import * as THREE from 'three';

import { hashCell } from '../utils/hash.js';

/**
 * Fins working the line-up.
 *
 * Atmosphere rather than hazard: nothing here touches the board. A shark that
 * could end a ride would be a fifth way to wipe out and would need balancing
 * against the four that exist — see the note at the end of this file for what
 * that would take.
 *
 * The whole thing leans on the water being opaque. A shark is a fin, a tail tip
 * and a back; when it dives, it simply sinks, and the sea hides it for free —
 * no fading, no visibility toggling, and it reappears through the surface of a
 * trough exactly as it should.
 *
 * Three of them, two or three parts each, so a group apiece is the simpler
 * shape here — unlike the boats, where instancing saves a draw per hull.
 */
export class Sharks {
  constructor(options = {}) {
    this.ocean = options.ocean ?? null;
    this.count = options.count ?? 3;

    /** Band, in metres, the pack works within. */
    this.minRadius = options.minRadius ?? 22;
    this.maxRadius = options.maxRadius ?? 70;
    /** Closer than this and one dives rather than swimming through the board. */
    this.clearance = options.clearance ?? 12;

    this.group = new THREE.Group();
    this.sharks = [];

    const skin = new THREE.MeshStandardMaterial({ color: 0x4a5a68, roughness: 0.55 });
    const belly = new THREE.MeshStandardMaterial({ color: 0x5f707d, roughness: 0.6 });

    for (let i = 0; i < this.count; i++) {
      const body = new THREE.Group();

      // A dorsal fin is a swept triangle, so: a four-sided cone squashed flat
      // and raked back. It is the whole silhouette, and worth the care.
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.05, 4), skin);
      fin.scale.set(0.34, 1, 1);
      fin.rotation.set(-0.22, Math.PI / 4, 0);
      fin.position.set(0, 0.42, 0);

      // The tail breaks the surface a body-length behind the fin, which is what
      // makes it read as an animal rather than as a floating triangle.
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.62, 4), skin);
      tail.scale.set(0.3, 1, 1);
      tail.rotation.set(0.4, Math.PI / 4, 0);
      tail.position.set(0, 0.16, -1.9);

      // Just under the waterline, so it shows through the face of a trough.
      const back = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), belly);
      back.scale.set(0.62, 0.34, 2.5);
      back.position.set(0, -0.16, -0.5);

      for (const part of [fin, tail, back]) {
        part.castShadow = true;
        body.add(part);
      }

      this.group.add(body);

      // Each shark gets its own orbit, phase and pace out of the hash, so the
      // pack never falls into formation and every run is the same run.
      this.sharks.push({
        body,
        radius: this.minRadius + (this.maxRadius - this.minRadius) * hashCell(i, 7, 21),
        phase: hashCell(i, 7, 22) * Math.PI * 2,
        pace: (0.1 + 0.16 * hashCell(i, 7, 23)) * (hashCell(i, 7, 24) < 0.5 ? -1 : 1),
        breath: 0.55 + 0.5 * hashCell(i, 7, 25),
        sink: hashCell(i, 7, 26) * Math.PI * 2,
        dive: 0,
        heading: 0,
        position: new THREE.Vector3(),
      });
    }

    /** Where the pack thinks you are. Eased, so sprinting off drops them behind. */
    this._home = new THREE.Vector2();
    this._homed = false;
    this._clock = 0;
    this._surface = { height: 0, slopeX: 0, slopeZ: 0, foam: 0 };
  }

  /**
   * Own clock rather than the frame's elapsed time, so a restart puts the pack
   * back where it started along with everything else.
   */
  reset() {
    this._clock = 0;
    this._homed = false;

    for (const shark of this.sharks) shark.dive = 0;
  }

  update(delta, focus) {
    if (!focus) return;

    this._clock += delta;

    // The pack follows rather than keeps station: pinned to the player exactly,
    // three fins would track a board doing 11 m/s in perfect formation, which
    // reads as furniture bolted to the camera.
    if (!this._homed) {
      this._home.set(focus.x, focus.z);
      this._homed = true;
    } else {
      const follow = 1 - Math.exp(-0.55 * delta);
      this._home.x += (focus.x - this._home.x) * follow;
      this._home.y += (focus.z - this._home.y) * follow;
    }

    for (const shark of this.sharks) {
      const angle = shark.phase + this._clock * shark.pace;
      // The orbit breathes in and out, so they close in and drift off again
      // instead of circling at one distance forever.
      const radius = shark.radius * (0.75 + 0.25 * Math.sin(this._clock * 0.11 * shark.breath));

      const x = this._home.x + Math.sin(angle) * radius;
      const z = this._home.y + Math.cos(angle) * radius;

      // Dive when the board gets close — a shark that swam through the surfer
      // would be a bug, and one that swam under him is a moment. On top of a
      // slow cycle of its own, so fins come and go rather than always being up.
      const range = Math.hypot(x - focus.x, z - focus.z);
      const crowded = 1 - THREE.MathUtils.smoothstep(range, this.clearance, this.clearance * 2.2);
      const cycle = THREE.MathUtils.smoothstep(Math.sin(this._clock * 0.07 + shark.sink), 0.55, 0.9);
      const target = Math.max(crowded, cycle);
      shark.dive += (target - shark.dive) * (1 - Math.exp(-1.3 * delta));

      let height = 0;
      let slopeX = 0;
      let slopeZ = 0;

      if (this.ocean) {
        this.ocean.sampleSurface(x, z, this._surface);
        height = this._surface.height;
        slopeX = this._surface.slopeX;
        slopeZ = this._surface.slopeZ;
      }

      // 1.6 m is enough to put the fin under the surface, and the sea is opaque.
      shark.body.position.set(x, height - shark.dive * 1.6, z);

      // Heading comes from the orbit's own tangent, so it always faces the way
      // it is going, and the tail follows the fin round a turn.
      shark.heading = angle + (shark.pace > 0 ? Math.PI / 2 : -Math.PI / 2);
      shark.body.rotation.set(
        // Nose up the face it is climbing, and lean into the slope across it.
        -Math.atan(slopeX * Math.sin(shark.heading) + slopeZ * Math.cos(shark.heading)),
        shark.heading,
        Math.atan(slopeX * Math.cos(shark.heading) - slopeZ * Math.sin(shark.heading)),
        'YXZ',
      );

      shark.position.copy(shark.body.position);
    }
  }

  dispose() {
    // One skin and one belly across the whole pack, so materials are collected
    // before being disposed of rather than disposed of once per shark.
    const materials = new Set();

    for (const shark of this.sharks) {
      for (const part of shark.body.children) {
        part.geometry.dispose();
        materials.add(part.material);
      }
    }

    for (const material of materials) material.dispose();
  }
}

/*
 * Making them dangerous, if you ever want to: `Surfboard.crash(reason)` already
 * takes any reason, so a proximity test here calling `crash('shark')` is most of
 * it. The rest is a label in `Hud`'s wipeout map, a jolt weight in `MainScene`,
 * and — the real work — re-measuring riding time, because the rocks are already
 * tuned to about one strike per five minutes and a second hazard changes that
 * budget rather than adding to it.
 */
