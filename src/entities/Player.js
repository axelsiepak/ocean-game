import * as THREE from 'three';

/**
 * Placeholder player object — a blocky little boat.
 *
 * Deliberately built from primitives rather than a loaded model: swap
 * `_buildMesh()` for a glTF load when you have real art, and everything else
 * (movement, buoyancy, the camera rig) keeps working unchanged.
 */
export class Player {
  constructor(options = {}) {
    this.input = options.input ?? null;
    this.ocean = options.ocean ?? null;

    this.speed = options.speed ?? 14;
    this.turnRate = options.turnRate ?? 1.7;
    this.acceleration = options.acceleration ?? 3.5;

    /** Half-length / half-width used to sample the waves for pitch and roll. */
    this.length = 3;
    this.width = 1.4;

    this.velocity = 0;
    this.group = new THREE.Group();
    this.group.add(this._buildMesh());
  }

  get position() {
    return this.group.position;
  }

  _buildMesh() {
    const body = new THREE.Group();

    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8e2d4,
      roughness: 0.65,
      metalness: 0.05,
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: 0xd7553f,
      roughness: 0.5,
      metalness: 0.1,
    });
    const mastMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b4b32,
      roughness: 0.8,
    });

    const hull = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 5.2), hullMaterial);
    hull.position.y = 0.35;

    const bow = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.2, 4), accentMaterial);
    bow.rotation.x = -Math.PI / 2;
    bow.rotation.y = Math.PI / 4;
    bow.position.set(0, 0.35, 3.6);
    bow.scale.set(1, 1, 0.92);

    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.8), accentMaterial);
    deck.position.set(0, 1.3, -0.9);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.4, 8), mastMaterial);
    mast.position.set(0, 3, 0.6);

    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xf2c14e, side: THREE.DoubleSide, roughness: 0.9 }),
    );
    flag.position.set(0.6, 4.7, 0.6);

    for (const part of [hull, bow, deck, mast, flag]) {
      part.castShadow = true;
      part.receiveShadow = true;
      body.add(part);
    }

    return body;
  }

  /**
   * Sit the hull on the water and tilt it along the local slope of the swell.
   *
   * Reads the ocean's own wave clock rather than elapsed time, so buoyancy
   * stays glued to the surface even when `waveSpeed` changes.
   */
  _float() {
    if (!this.ocean) return;

    const { x, z } = this.group.position;
    const yaw = this.group.rotation.y;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    const sample = (forward, right) =>
      this.ocean.sampleHeight(
        x + forward * sin + right * cos,
        z + forward * cos - right * sin,
      );

    const fore = sample(this.length, 0);
    const aft = sample(-this.length, 0);
    const starboard = sample(0, this.width);
    const port = sample(0, -this.width);

    this.group.position.y = (fore + aft + starboard + port) / 4;
    this.group.rotation.x = Math.atan2(aft - fore, this.length * 2);
    this.group.rotation.z = Math.atan2(starboard - port, this.width * 2);
  }

  update(delta, elapsed) {
    if (this.input) {
      const throttle = this.input.vertical;
      const target = throttle * this.speed;

      // Ease toward the target speed so the boat has some weight to it.
      this.velocity += (target - this.velocity) * Math.min(this.acceleration * delta, 1);

      // Steering only bites when there's water moving past the rudder.
      const steerAuthority = THREE.MathUtils.clamp(Math.abs(this.velocity) / this.speed, 0, 1);
      this.group.rotation.y -= this.input.horizontal * this.turnRate * steerAuthority * delta;

      this.group.position.x += Math.sin(this.group.rotation.y) * this.velocity * delta;
      this.group.position.z += Math.cos(this.group.rotation.y) * this.velocity * delta;
    }

    this._float();
  }
}
