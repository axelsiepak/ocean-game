import * as THREE from 'three';

import { hashCell } from '../utils/hash.js';

/**
 * The parts a boat is made of, each with where it sits on the hull.
 *
 * Kept as data rather than as a built group because every part becomes one
 * `InstancedMesh` covering the whole fleet: five draws for any number of boats,
 * the same trade `Rocks` makes. A group per boat would be five draws *each*.
 */
function buildParts() {
  const hull = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.65, metalness: 0.05 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xd7553f, roughness: 0.5, metalness: 0.1 });
  const mast = new THREE.MeshStandardMaterial({ color: 0x6b4b32, roughness: 0.8 });
  const canvas = new THREE.MeshStandardMaterial({
    color: 0xf2c14e,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const at = (x, y, z, euler = [0, 0, 0], scale = [1, 1, 1]) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler)),
      new THREE.Vector3(...scale),
    );

  return [
    { geometry: new THREE.BoxGeometry(2.4, 1.1, 5.2), material: hull, offset: at(0, 0.35, 0) },
    {
      geometry: new THREE.ConeGeometry(1.2, 2.2, 4),
      material: accent,
      offset: at(0, 0.35, 3.6, [-Math.PI / 2, Math.PI / 4, 0], [1, 1, 0.92]),
    },
    { geometry: new THREE.BoxGeometry(1.6, 0.9, 1.8), material: accent, offset: at(0, 1.3, -0.9) },
    {
      geometry: new THREE.CylinderGeometry(0.09, 0.11, 4.4, 8),
      material: mast,
      offset: at(0, 3, 0.6),
    },
    { geometry: new THREE.PlaneGeometry(1.1, 0.6), material: canvas, offset: at(0.6, 4.7, 0.6) },
  ];
}

/**
 * Moored boats scattered across the swell.
 *
 * Same trick as the rocks: there is no list of boats, only a hash of the grid,
 * so the fleet is endless in every direction and identical every run. A pool of
 * instances is moved to whichever boats are nearest.
 *
 * They ride the swell rather than sitting at a fixed height — a boat that
 * ignored the wave it was floating on would be the one thing on screen giving
 * away that the sea is a shader. That means four surface samples each, which is
 * also what sets the pool size: everything else here is free.
 */
export class Boats {
  constructor(options = {}) {
    this.ocean = options.ocean ?? null;

    /** Grid pitch in metres — roughly the closest two boats can be. */
    this.cell = options.cell ?? 150;
    /** Fraction of cells holding a boat. Sparse: this is scenery, not traffic. */
    this.density = options.density ?? 0.4;
    /** How many cells out to look. */
    this.range = options.range ?? 2;
    this.capacity = options.poolSize ?? 6;

    /** Half-length / half-width used to sample the waves for pitch and roll. */
    this.length = 3;
    this.width = 1.4;

    this.group = new THREE.Group();
    this.active = [];

    this._parts = buildParts().map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, this.capacity);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // The pool is placed by hand each frame and always surrounds the player;
      // three's own culling would only be re-deriving that.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);

      return { mesh, offset: part.offset };
    });

    this._candidates = [];
    this._boat = new THREE.Matrix4();
    this._world = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._position = new THREE.Vector3();
    this._quaternion = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._scale = new THREE.Vector3();
  }

  /** The boat moored in this cell, or null. Pure function of the coordinates. */
  _boatAt(i, j, out) {
    if (hashCell(i, j, 11) > this.density) return null;

    out.x = (i + 0.15 + 0.7 * hashCell(i, j, 12)) * this.cell;
    out.z = (j + 0.15 + 0.7 * hashCell(i, j, 13)) * this.cell;
    out.yaw = hashCell(i, j, 14) * Math.PI * 2;
    out.scale = 0.85 + 0.5 * hashCell(i, j, 15);

    return out;
  }

  /**
   * Sits a hull on the water and tilts it along the local slope of the swell,
   * from four samples around it — the same arrangement `Player` floats on.
   */
  _float(boat) {
    if (!this.ocean) {
      this._position.set(boat.x, 0, boat.z);
      this._euler.set(0, boat.yaw, 0);
      return;
    }

    const sin = Math.sin(boat.yaw);
    const cos = Math.cos(boat.yaw);
    const reach = boat.scale;
    const sample = (forward, right) =>
      this.ocean.sampleHeight(
        boat.x + forward * sin + right * cos,
        boat.z + forward * cos - right * sin,
      );

    const fore = sample(this.length * reach, 0);
    const aft = sample(-this.length * reach, 0);
    const starboard = sample(0, this.width * reach);
    const port = sample(0, -this.width * reach);

    this._position.set(boat.x, (fore + aft + starboard + port) / 4, boat.z);
    this._euler.set(
      Math.atan2(aft - fore, this.length * 2 * reach),
      boat.yaw,
      Math.atan2(starboard - port, this.width * 2 * reach),
    );
  }

  update(delta, focus) {
    if (!focus) return;

    const centreI = Math.floor(focus.x / this.cell);
    const centreJ = Math.floor(focus.z / this.cell);

    this._candidates.length = 0;

    for (let i = centreI - this.range; i <= centreI + this.range; i++) {
      for (let j = centreJ - this.range; j <= centreJ + this.range; j++) {
        const boat = this._boatAt(i, j, {});
        if (!boat) continue;

        boat.distance = Math.hypot(boat.x - focus.x, boat.z - focus.z);
        this._candidates.push(boat);
      }
    }

    // More boats in range than instances: draw the nearest, which are the only
    // ones close enough to read as boats rather than as specks.
    this._candidates.sort((a, b) => a.distance - b.distance);
    this.active = this._candidates.slice(0, this.capacity);

    for (let slot = 0; slot < this.capacity; slot++) {
      const boat = this.active[slot];

      if (boat) {
        this._float(boat);
        this._quaternion.setFromEuler(this._euler);
        this._scale.setScalar(boat.scale);
        this._boat.compose(this._position, this._quaternion, this._scale);
      }

      for (const part of this._parts) {
        // Unused slots collapse to nothing rather than being drawn somewhere.
        if (!boat) {
          part.mesh.setMatrixAt(slot, this._hidden);
          continue;
        }

        this._world.multiplyMatrices(this._boat, part.offset);
        part.mesh.setMatrixAt(slot, this._world);
      }
    }

    for (const part of this._parts) {
      part.mesh.instanceMatrix.needsUpdate = true;
      part.mesh.count = this.capacity;
    }
  }

  dispose() {
    // Materials are shared between parts — the bow and the deck are the same
    // paint — so they're collected before being disposed of.
    const materials = new Set();

    for (const part of this._parts) {
      part.mesh.geometry.dispose();
      materials.add(part.mesh.material);
      part.mesh.dispose();
    }

    for (const material of materials) material.dispose();
  }
}
