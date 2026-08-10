import * as THREE from 'three';

/**
 * Low-poly rider, parented to the board.
 *
 * Being a child of the board's group means every rotation the board already
 * does — pitch down the face, bank into a carve, the whole spin of an air —
 * carries the rider for free. All this class adds is what the rider does that
 * the board doesn't: stay more upright than the deck, crouch when driving hard,
 * and go limp in a wipeout.
 */
export class Surfer {
  constructor(options = {}) {
    /**
     * How much of the board's lean the rider cancels out. A surfer's head
     * stays far closer to vertical than the deck does; at 1 they'd be rigidly
     * bolted on, which reads as a shop mannequin going round a corner.
     */
    this.counterLean = options.counterLean ?? 0.55;
    /** How much of the board's pitch the rider absorbs through the knees. */
    this.counterPitch = options.counterPitch ?? 0.4;
    /** Crouch depth at full compression, as a fraction of stance height. */
    this.crouchDepth = options.crouchDepth ?? 0.22;
    /** Orientation response, per second. */
    this.responsiveness = options.responsiveness ?? 7;

    this.group = new THREE.Group();
    // Stand the feet on the deck rather than through it.
    this.group.position.y = options.footHeight ?? 0.03;
    this.body = new THREE.Group();
    this.group.add(this.body);

    this._crouch = 0;
    this._lean = 0;
    this._opacity = 1;
    this._materials = [];
    this._build();
  }

  /**
   * Fades the rider out. The POV camera sits where the head is, so from on
   * board the rider is either invisible or a torso filling the screen — but the
   * switch is a cross-fade, and a body vanishing while the camera is still
   * behind it would pop, hence a fade rather than a flag.
   *
   * At 0 the group is hidden outright, which takes its shadow with it — an
   * invisible rider casting one onto the deck would give the game away.
   */
  setOpacity(value) {
    const amount = THREE.MathUtils.clamp(value, 0, 1);
    if (amount === this._opacity) return;
    this._opacity = amount;

    this.group.visible = amount > 0.01;
    for (const material of this._materials) {
      material.transparent = amount < 1;
      material.opacity = amount;
    }
  }

  _build() {
    const wetsuit = new THREE.MeshStandardMaterial({ color: 0x1d2733, roughness: 0.72 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x2f7fa8, roughness: 0.6 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc98d64, roughness: 0.85 });
    this._materials.push(wetsuit, accent, skin);

    const parts = [];
    const limb = (radius, length) => new THREE.CapsuleGeometry(radius, length, 3, 6);

    // Surfing stance: side-on to the board, knees bent, weight low.
    const backLeg = new THREE.Mesh(limb(0.075, 0.34), wetsuit);
    backLeg.position.set(0.06, 0.3, -0.38);
    backLeg.rotation.set(0.34, 0, -0.16);

    const frontLeg = new THREE.Mesh(limb(0.075, 0.34), wetsuit);
    frontLeg.position.set(-0.05, 0.31, 0.24);
    frontLeg.rotation.set(-0.28, 0, 0.2);

    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.17, 0.24), wetsuit);
    hips.position.set(0, 0.56, -0.06);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.4, 0.22), accent);
    torso.position.set(0, 0.79, -0.02);
    torso.rotation.set(0.22, 0, 0);

    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.115, 1), skin);
    head.position.set(0, 1.06, 0.05);

    // Arms out for balance — the single strongest cue that this is a person
    // riding rather than an object glued to a plank.
    const leadArm = new THREE.Mesh(limb(0.05, 0.34), skin);
    leadArm.position.set(-0.26, 0.87, 0.18);
    leadArm.rotation.set(0.5, 0, 1.25);

    const trailArm = new THREE.Mesh(limb(0.05, 0.32), skin);
    trailArm.position.set(0.27, 0.9, -0.16);
    trailArm.rotation.set(-0.4, 0, -1.1);

    parts.push(backLeg, frontLeg, hips, torso, head, leadArm, trailArm);

    for (const part of parts) {
      part.castShadow = true;
      part.receiveShadow = true;
      this.body.add(part);
    }
  }

  /**
   * `board` is read, never written — same one-way arrangement as the spray and
   * the HUD.
   */
  update(delta, board) {
    const ease = 1 - Math.exp(-this.responsiveness * delta);

    // Compress through a hard turn or a heavy landing, and fold up completely
    // in a wipeout.
    const load = Math.min(Math.abs(board.bank) / board.maxBank, 1);
    const crouchTarget = Math.max(load * 0.7, board.wipeout);
    this._crouch += (crouchTarget - this._crouch) * ease;

    // Stand up out of the board's lean rather than going round with it.
    const leanTarget = -board.bank * this.counterLean;
    this._lean += (leanTarget - this._lean) * ease;

    this.body.rotation.z = this._lean;
    this.body.rotation.x = -board.pitch * this.counterPitch;
    this.body.position.y = -this._crouch * this.crouchDepth;

    // Airborne, the rider tucks toward the board.
    this.body.scale.setScalar(1 - this._crouch * 0.08);
  }
}
