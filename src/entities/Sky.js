import * as THREE from 'three';
import { Sky as SkyShader } from 'three/addons/objects/Sky.js';

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
