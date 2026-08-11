import * as THREE from 'three';
import { Sky as SkyShader } from 'three/addons/objects/Sky.js';

// Preetham's constants, lifted from the addon's shader so `sampleColor()` below
// can evaluate the same model on the CPU.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const CUTOFF_ANGLE = 1.6110731556870734;
const SUN_STEEPNESS = 1.5;

function sunIntensity(zenithAngleCos) {
  const cos = THREE.MathUtils.clamp(zenithAngleCos, -1, 1);
  return 1000 * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(cos)) / SUN_STEEPNESS)));
}

/**
 * Atmospheric sky dome + the sun light that matches it.
 *
 * The sun position is the single source of truth: the sky shader, the
 * directional light and the ocean's specular highlight all read `sunDirection`
 * so they can never drift out of agreement.
 */
export class Sky {
  constructor(options = {}) {
    /** Sun height above the horizon, in radians (0 = horizon). */
    this.elevation = options.elevation ?? 0.16;
    /** Compass direction of the sun, in radians. */
    this.azimuth = options.azimuth ?? 2.4;

    this.group = new THREE.Group();
    this.sunDirection = new THREE.Vector3();

    this.mesh = new SkyShader();
    this.mesh.scale.setScalar(45000);

    const uniforms = this.mesh.material.uniforms;
    uniforms.turbidity.value = options.turbidity ?? 8;
    uniforms.rayleigh.value = options.rayleigh ?? 2.2;
    uniforms.mieCoefficient.value = options.mieCoefficient ?? 0.004;
    uniforms.mieDirectionalG.value = options.mieDirectionalG ?? 0.8;

    // The addon's clouds are unlit at a low sun — their colour ends up
    // multiplied by the sun intensity, which near the horizon is a fiftieth of
    // its noon value. All they can do at sunset is darken the sky: measured,
    // full cover takes the dome from 0.518 mean chroma to 0.427 and eats the
    // colour rather than adding any. Off unless a caller wants them.
    uniforms.cloudCoverage.value = options.cloudCoverage ?? 0;

    this._compressRange(options);

    this.sun = new THREE.DirectionalLight(
      options.sunColor ?? 0xfff2e0,
      options.sunIntensity ?? 2.4,
    );
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 120;
    this.sun.shadow.camera.left = -30;
    this.sun.shadow.camera.right = 30;
    this.sun.shadow.camera.top = 30;
    this.sun.shadow.camera.bottom = -30;

    // Cheap stand-in for sky bounce light, so shadowed sides aren't black.
    this.ambient = new THREE.HemisphereLight(
      options.ambientSky ?? 0xbfd9ff,
      options.ambientGround ?? 0x1c4a63,
      options.ambientIntensity ?? 0.6,
    );

    this.group.add(this.mesh, this.sun, this.sun.target, this.ambient);
    this.setSunPosition(this.elevation, this.azimuth);
  }

  /**
   * Brings the dome into a range one exposure can actually show.
   *
   * Preetham's output spans about 100:1 from the sun's side of the sky to the
   * far side, and the frame has a single exposure to spend on all of it. At the
   * game's 0.5 that meant the sunward half clipped to paper white — measured
   * (255, 255, 249) ten degrees above the sun — while the rest crushed toward
   * black, 8.9% of the dome below level 60. Both ends lose their colour: white
   * is white and black is black however saturated the model says they are.
   *
   * So the sky rolls its own highlights off before the frame's tone mapper sees
   * them, and puts back the saturation that convergence costs. Measured across
   * the dome, mean chroma goes 0.273 -> 0.518, nothing crushes, and the range of
   * hues on show widens from 232 to 248 degrees.
   *
   * Done by patching the addon's shader because it has no hook for this. The
   * marker is checked rather than assumed: a three upgrade that renames it
   * should leave a note in the console, not silently drop the correction.
   */
  _compressRange(options) {
    const material = this.mesh.material;

    material.uniforms.skyHighlight = { value: options.skyHighlight ?? 4 };
    material.uniforms.skySaturation = { value: options.skySaturation ?? 1.6 };

    const marker = 'gl_FragColor = vec4( texColor, 1.0 );';
    if (!material.fragmentShader.includes(marker)) {
      console.warn('Sky: shader marker not found, leaving the dome uncompressed.');
      return;
    }

    material.fragmentShader = material.fragmentShader.replace(
      marker,
      /* glsl */ `
      texColor = texColor / (1.0 + texColor / skyHighlight);
      float skyLuminance = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
      texColor = mix(vec3(skyLuminance), texColor, skySaturation);

      ${marker}`,
    );

    material.fragmentShader = `uniform float skyHighlight;\nuniform float skySaturation;\n${material.fragmentShader}`;
  }

  /**
   * The dome's colour in a given direction, in linear radiance — the same
   * numbers the shader produces, evaluated on the CPU.
   *
   * This exists so the water can reflect the sky it is actually under. The
   * ocean's reflection is analytic and was authored by hand against one
   * particular sky; anything that moved the sun or the atmosphere left the two
   * disagreeing, which reads as painted water under an unrelated sky.
   *
   * NOTE: mirrors the addon's shader and `_compressRange()` above. Same rule as
   * `Ocean._foamAt()` — if one changes, so must the other, or the sea will
   * quietly go back to reflecting a sky that isn't there.
   */
  sampleColor(direction, target = new THREE.Color()) {
    const sun = this.sunDirection;
    const sunE = sunIntensity(sun.y);
    const sunfade = 1 - THREE.MathUtils.clamp(1 - Math.exp(sun.y / 450000), 0, 1);

    const uniforms = this.mesh.material.uniforms;
    const rayleighCoefficient = uniforms.rayleigh.value - (1 - sunfade);
    const betaR = TOTAL_RAYLEIGH.map((v) => v * rayleighCoefficient);
    const c = 0.2 * uniforms.turbidity.value * 10e-18;
    const betaM = MIE_CONST.map((v) => 0.434 * c * v * uniforms.mieCoefficient.value);

    const zenithAngle = Math.acos(Math.max(0, direction.y));
    const inverse =
      1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
    const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
    const sM = MIE_ZENITH_LENGTH * inverse;
    const Fex = [0, 1, 2].map((i) => Math.exp(-(betaR[i] * sR + betaM[i] * sM)));

    const cosTheta = direction.dot(sun);
    const rPhase = 0.05968310365946075 * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
    const g = uniforms.mieDirectionalG.value;
    const mPhase =
      0.07957747154594767 * ((1 - g * g) / Math.pow(1 - 2 * g * cosTheta + g * g, 1.5));

    const ratio = [0, 1, 2].map(
      (i) => (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]),
    );
    const nearHorizon = THREE.MathUtils.clamp(Math.pow(1 - sun.y, 5), 0, 1);
    const Lin = [0, 1, 2].map((i) => {
      const base = Math.pow(sunE * ratio[i] * (1 - Fex[i]), 1.5);
      return base * THREE.MathUtils.lerp(1, Math.sqrt(sunE * ratio[i] * Fex[i]), nearHorizon);
    });

    // The sun's disc is deliberately absent: this is what the sky *is*, and
    // the ocean draws the sun's own reflection itself.
    const rgb = [0, 1, 2].map((i) => (Lin[i] + 0.1 * Fex[i]) * 0.04 + [0, 0.0003, 0.00075][i]);

    const highlight = uniforms.skyHighlight.value;
    const rolled = rgb.map((v) => v / (1 + v / highlight));
    const luminance = 0.2126 * rolled[0] + 0.7152 * rolled[1] + 0.0722 * rolled[2];
    const saturation = uniforms.skySaturation.value;

    return target.setRGB(
      ...rolled.map((v) => Math.max(0, luminance + (v - luminance) * saturation)),
      THREE.LinearSRGBColorSpace,
    );
  }

  /**
   * What the dome averages to just above the horizon, around the whole compass.
   *
   * The water's analytic sky varies only with elevation, so the band it spends
   * most of its reflections on has to be collapsed to one colour. Sampling the
   * ring rather than picking a direction keeps it honest: at sunset the sky
   * behind you is nothing like the sky in front.
   *
   * Per-channel *median*, not mean. The ring spans an order of magnitude at a
   * low sun, so an average is dragged up by the few directions near the sun and
   * ends up brighter than almost the entire sky — measured, it stands 100% off
   * the typical direction against 41% for the median. The sunward excess is
   * better left to the ocean shader's own sun-glow term, which is aimed at the
   * sun and therefore puts the brightness where it belongs.
   */
  horizonColor(elevation = 0.07, samples = 24, target = new THREE.Color()) {
    const direction = new THREE.Vector3();
    const sample = new THREE.Color();
    const channels = [[], [], []];

    for (let i = 0; i < samples; i++) {
      const azimuth = (i / samples) * Math.PI * 2;
      direction.set(
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth),
      );
      this.sampleColor(direction, sample);
      channels[0].push(sample.r);
      channels[1].push(sample.g);
      channels[2].push(sample.b);
    }

    const middle = channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);

    return target.setRGB(...middle, THREE.LinearSRGBColorSpace);
  }

  setSunPosition(elevation, azimuth) {
    this.elevation = elevation;
    this.azimuth = azimuth;

    // Spherical -> cartesian, with elevation measured up from the horizon.
    this.sunDirection.set(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );

    this.mesh.material.uniforms.sunPosition.value.copy(this.sunDirection);
    this.sun.position.copy(this.sunDirection).multiplyScalar(80);
  }

  /**
   * Renders the sky once into an environment map so PBR materials pick up
   * realistic reflections. Call after the renderer exists.
   */
  applyEnvironment(renderer, scene) {
    const pmrem = new THREE.PMREMGenerator(renderer);

    // Render the dome on its own — `fromScene` renders whatever it's handed,
    // so the boat would otherwise be baked into the reflections.
    const envScene = new THREE.Scene();
    envScene.add(this.mesh);

    this._envTarget?.dispose();
    this._envTarget = pmrem.fromScene(envScene);
    scene.environment = this._envTarget.texture;

    this.group.add(this.mesh); // re-parent; add() detaches from envScene
    pmrem.dispose();
  }

  /**
   * Follows whatever we're tracking: the shadow camera only covers a small
   * area, and the dome has to stay centred or a far-travelling player sails
   * out of it.
   */
  update(delta, elapsed, focus) {
    if (!focus) return;
    this.mesh.position.set(focus.x, 0, focus.z);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDirection, 80);
  }
}
