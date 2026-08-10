import * as THREE from 'three';

/**
 * Deterministic hash of a grid cell to [0, 1). Integer mixing rather than
 * sin-based hashing so the same cell gives the same rock forever, at any
 * distance from the origin, with no float precision drift.
 */
function hashCell(i, j, salt) {
  let n = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791);
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  n = Math.imul(n ^ (n >>> 13), 3266489917);
  return ((n ^ (n >>> 16)) >>> 8) / 16777216;
}

/**
 * Rocks scattered through the line-up.
 *
 * There is no list of rocks anywhere — the world is a hash. Every grid cell
 * either holds a rock or doesn't, decided by hashing its coordinates, so the
 * field is endless in every direction, identical every run, and costs no
 * memory. A pool of meshes is moved to whichever rocks are currently near.
 */
export class Rocks {
  constructor(options = {}) {
    /** Grid pitch in metres — roughly the closest two rocks can be. */
    this.cell = options.cell ?? 45;
    /**
     * Fraction of cells holding a rock. Sparse on purpose: at ~11 m/s the board
     * sweeps roughly a 4 m corridor, which works out at about one strike per
     * five minutes of riding. Denser than this and the ride never gets going,
     * because recovering from a knockdown is hard (see the README).
     */
    this.density = options.density ?? 0.18;
    /** How many cells out to look. */
    this.range = options.range ?? 3;
    this.minRadius = options.minRadius ?? 1;
    this.maxRadius = options.maxRadius ?? 2.4;

    this.group = new THREE.Group();
    this.active = [];

    const geometry = new THREE.IcosahedronGeometry(1, 1);
    this._roughen(geometry);

    const material = new THREE.MeshStandardMaterial({
      color: 0x4b5259,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
    });

    // One instanced draw for the whole field rather than one per rock. The
    // saving is modest here — this was 7 draws of 28 — but it costs nothing and
    // it stops the count growing with `poolSize`.
    this.capacity = options.poolSize ?? 28;
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.mesh);

    this._candidates = [];
    this._matrix = new THREE.Matrix4();
    this._position = new THREE.Vector3();
    this._quaternion = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._scale = new THREE.Vector3();
  }

  /** Pushes the vertices about so they don't read as a row of identical balls. */
  _roughen(geometry) {
    const position = geometry.attributes.position;
    const vertex = new THREE.Vector3();

    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i);
      const wobble =
        0.78 +
        0.3 * Math.sin(vertex.x * 4.1 + vertex.y * 2.7) +
        0.18 * Math.sin(vertex.z * 6.3 - vertex.x * 3.2);
      vertex.multiplyScalar(wobble);
      position.setXYZ(i, vertex.x, vertex.y * 0.8, vertex.z);
    }

    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  /** The rock in this cell, or null. Pure function of the cell coordinates. */
  _rockAt(i, j, out) {
    if (hashCell(i, j, 0) > this.density) return null;

    out.radius = this.minRadius + (this.maxRadius - this.minRadius) * hashCell(i, j, 3);
    out.x = (i + 0.2 + 0.6 * hashCell(i, j, 1)) * this.cell;
    out.z = (j + 0.2 + 0.6 * hashCell(i, j, 2)) * this.cell;
    // Anchored to the seabed, so they sit at a fixed height and let the swell
    // wash over them rather than bobbing along with it.
    out.y = -out.radius * 0.45;
    out.spin = hashCell(i, j, 4) * Math.PI * 2;
    out.tilt = (hashCell(i, j, 5) - 0.5) * 0.7;

    return out;
  }

  update(delta, focus) {
    if (!focus) return;

    const centreI = Math.floor(focus.x / this.cell);
    const centreJ = Math.floor(focus.z / this.cell);

    this._candidates.length = 0;

    for (let i = centreI - this.range; i <= centreI + this.range; i++) {
      for (let j = centreJ - this.range; j <= centreJ + this.range; j++) {
        const rock = this._rockAt(i, j, {});
        if (!rock) continue;

        rock.distance = Math.hypot(rock.x - focus.x, rock.z - focus.z);
        this._candidates.push(rock);
      }
    }

    // More rocks in range than meshes: draw the nearest, which are the only
    // ones close enough to matter or to be seen clearly.
    this._candidates.sort((a, b) => a.distance - b.distance);
    this.active = this._candidates.slice(0, this.capacity);

    for (let i = 0; i < this.capacity; i++) {
      const rock = this.active[i];

      if (!rock) {
        // Unused slots collapse to nothing rather than being drawn somewhere.
        this._matrix.makeScale(0, 0, 0);
      } else {
        this._position.set(rock.x, rock.y, rock.z);
        this._euler.set(rock.tilt, rock.spin, rock.tilt * 0.5);
        this._quaternion.setFromEuler(this._euler);
        this._scale.setScalar(rock.radius);
        this._matrix.compose(this._position, this._quaternion, this._scale);
      }

      this.mesh.setMatrixAt(i, this._matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = this.capacity;
  }

  /**
   * Nearest rock actually being struck, or null.
   *
   * Height matters: a board that cleared the top of a rock has jumped it, which
   * makes an air off the lip a way through a rock field rather than only a way
   * to score.
   */
  hitTest(x, z, y, boardRadius = 0.5) {
    for (const rock of this.active) {
      const reach = rock.radius * 0.85 + boardRadius;
      if (Math.hypot(rock.x - x, rock.z - z) > reach) continue;
      if (y > rock.y + rock.radius) continue;

      return rock;
    }

    return null;
  }
}
