import * as THREE from 'three';

const GRAVITY = 9.8;

const vertexShader = /* glsl */ `
  attribute float aLife;

  uniform float uSize;
  uniform float uScale;

  varying float vLife;

  void main() {
    vLife = aLife;

    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;

    // Droplets spread as they break up, so grow them as they age out.
    float size = uSize * (0.55 + 0.85 * (1.0 - aLife));

    // Dead particles collapse to nothing rather than being drawn somewhere.
    gl_PointSize = aLife > 0.0 ? size * (uScale / -viewPosition.z) : 0.0;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vLife;

  void main() {
    if (vLife <= 0.0) discard;

    // Round the square point sprite off procedurally — no texture needed.
    vec2 offset = gl_PointCoord - 0.5;
    float radius = dot(offset, offset);
    if (radius > 0.25) discard;

    float edge = smoothstep(0.25, 0.02, radius);
    float fade = smoothstep(0.0, 0.3, vLife);

    gl_FragColor = vec4(uColor, edge * fade * uOpacity);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Spray thrown off a buried rail during a hard carve.
 *
 * A fixed pool of points simulated on the CPU — at a few hundred particles
 * that's far cheaper than the complexity of a GPU simulation, and it keeps the
 * emission logic readable.
 *
 * Particles are never tested against the water. They're depth-tested against
 * it instead: the ocean is opaque, so anything that falls back through the
 * surface is hidden for free.
 */
export class Spray {
  constructor(options = {}) {
    this.renderer = options.renderer ?? null;

    this.capacity = options.capacity ?? 400;
    /** Lateral acceleration (m/s²) a carve must exceed before it throws spray. */
    this.threshold = options.threshold ?? 3.5;
    /** Lateral acceleration at which emission is at full rate. */
    this.fullCarve = options.fullCarve ?? 10;
    /** Particles per second at full carve. */
    this.rate = options.rate ?? 240;
    /** Air drag on droplets, as a decay rate. */
    this.drag = options.drag ?? 1.6;
    /** Speed at which a wake starts to show, m/s. */
    this.wakeThreshold = options.wakeThreshold ?? 3.5;
    /** Speed at which the wake is at full rate, m/s. */
    this.wakeFullSpeed = options.wakeFullSpeed ?? 11;
    /** Particles per second at full speed. */
    this.wakeRate = options.wakeRate ?? 90;
    this.minLife = options.minLife ?? 0.45;
    this.maxLife = options.maxLife ?? 1.05;

    this._positions = new Float32Array(this.capacity * 3);
    this._velocities = new Float32Array(this.capacity * 3);
    this._age = new Float32Array(this.capacity);
    this._life = new Float32Array(this.capacity);
    this._remaining = new Float32Array(this.capacity);

    this._cursor = 0;
    this._pending = 0;
    this._wakePending = 0;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(this._remaining, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false, // droplets shouldn't occlude each other
      uniforms: {
        uSize: { value: options.size ?? 0.13 },
        uScale: { value: 400 },
        uColor: { value: new THREE.Color(options.color ?? 0xeaf4f8) },
        uOpacity: { value: options.opacity ?? 0.85 },
      },
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false; // positions change without bounds updates

    this._scratch = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._viewport = new THREE.Vector2();
  }

  /** World-space one-off burst. `velocity` is the mean; each droplet jitters. */
  emit(count, origin, velocity, spread = 1.4) {
    for (let i = 0; i < count; i++) {
      const p = this._cursor * 3;

      this._positions[p] = origin.x;
      this._positions[p + 1] = origin.y;
      this._positions[p + 2] = origin.z;

      this._velocities[p] = velocity.x + (Math.random() - 0.5) * spread;
      this._velocities[p + 1] = velocity.y + (Math.random() - 0.5) * spread * 0.8;
      this._velocities[p + 2] = velocity.z + (Math.random() - 0.5) * spread;

      this._age[this._cursor] = 0;
      this._life[this._cursor] = this.minLife + Math.random() * (this.maxLife - this.minLife);
      this._remaining[this._cursor] = 1;

      // Ring buffer: the oldest particle is always the one overwritten.
      this._cursor = (this._cursor + 1) % this.capacity;
    }
  }

  /**
   * Reads the board's public state and throws spray off whichever rail is
   * buried. One-directional: the surfboard knows nothing about this.
   */
  emitFromBoard(board, delta) {
    const intensity = THREE.MathUtils.clamp(
      (board.carve - this.threshold) / (this.fullCarve - this.threshold),
      0,
      1,
    );

    if (intensity <= 0) {
      this._pending = 0;
      return;
    }

    this._pending += this.rate * intensity * delta;
    const count = Math.min(Math.floor(this._pending), 24); // survive a frame spike
    if (count <= 0) return;
    this._pending -= count;

    // Positive bank means leaning right, and the board's right is -X, so the
    // buried rail is on the side opposite the lean's sign.
    const railSide = -Math.sign(board.bank) || 1;

    // Off the tail, where the rail is actually digging in.
    this._origin
      .set(railSide * 0.26, 0.03, -0.55)
      .applyQuaternion(board.group.quaternion)
      .add(board.position);

    const heading = board.heading;
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    // Board-left in world terms, then flipped to point out over the buried rail.
    const outX = Math.cos(heading) * railSide;
    const outZ = -Math.sin(heading) * railSide;

    this._scratch.set(
      outX * (1.6 + intensity * 2.2) - forwardX * 1.2 + board.velocity.x * 0.35,
      3.2 + intensity * 2.8,
      outZ * (1.6 + intensity * 2.2) - forwardZ * 1.2 + board.velocity.y * 0.35,
    );

    this.emit(count, this._origin, this._scratch, 1.2 + intensity);
  }

  /**
   * The constant trail off the tail. Quieter and finer than carve spray — this
   * is the board's wake rather than a rail throwing water — but it runs the
   * whole time you're moving, which is what stops a fast ride reading as a
   * board sliding over glass.
   */
  emitWake(board, delta) {
    const speed = board.speed;
    const intensity = THREE.MathUtils.clamp(
      (speed - this.wakeThreshold) / (this.wakeFullSpeed - this.wakeThreshold),
      0,
      1,
    );

    if (intensity <= 0 || board.airborne) {
      this._wakePending = 0;
      return;
    }

    this._wakePending += this.wakeRate * intensity * delta;
    const count = Math.min(Math.floor(this._wakePending), 8);
    if (count <= 0) return;
    this._wakePending -= count;

    this._origin
      .set(0, 0.02, -0.85)
      .applyQuaternion(board.group.quaternion)
      .add(board.position);

    const heading = board.heading;
    this._scratch.set(
      -Math.sin(heading) * 1.4 + board.velocity.x * 0.12,
      1.1 + intensity * 1.2,
      -Math.cos(heading) * 1.4 + board.velocity.y * 0.12,
    );

    this.emit(count, this._origin, this._scratch, 0.7);
  }

  /** One-off splash: a landing, a wipeout, anything with an impact. */
  burst(origin, amount = 1) {
    this._scratch.set(0, 3.4 * amount, 0);
    this.emit(Math.round(26 * amount), origin, this._scratch, 2.6 * amount);
  }

  update(delta, board) {
    if (board) {
      this.emitFromBoard(board, delta);
      this.emitWake(board, delta);
    }

    const positions = this._positions;
    const velocities = this._velocities;
    const drag = Math.exp(-this.drag * delta);

    for (let i = 0; i < this.capacity; i++) {
      if (this._remaining[i] <= 0) continue;

      this._age[i] += delta;
      if (this._age[i] >= this._life[i]) {
        this._remaining[i] = 0;
        continue;
      }

      const p = i * 3;

      velocities[p + 1] -= GRAVITY * delta;
      velocities[p] *= drag;
      velocities[p + 1] *= drag;
      velocities[p + 2] *= drag;

      positions[p] += velocities[p] * delta;
      positions[p + 1] += velocities[p + 1] * delta;
      positions[p + 2] += velocities[p + 2] * delta;

      this._remaining[i] = 1 - this._age[i] / this._life[i];
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aLife.needsUpdate = true;

    // Matches three's own point-size attenuation, and tracks window resizes.
    if (this.renderer) {
      this.renderer.getDrawingBufferSize(this._viewport);
      this.material.uniforms.uScale.value = this._viewport.y * 0.5;
    }
  }

  /** Kills every live droplet — a restart shouldn't inherit the last run's spray. */
  clear() {
    this._remaining.fill(0);
    this._age.fill(0);
    this._pending = 0;
    this._wakePending = 0;
    this.points.geometry.attributes.aLife.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
