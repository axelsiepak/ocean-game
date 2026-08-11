import * as THREE from 'three';

const TWO_PI = Math.PI * 2;
const GRAVITY = 9.8;

/**
 * Each wave is (directionX, directionZ, steepness, wavelength).
 *
 * Wavelengths are all comfortably above twice the vertex spacing (see
 * `size` / `segments` below) — shorter waves than that alias into a
 * shimmering mess as the mesh moves. Detail finer than the grid can resolve is
 * added per-pixel by the ripple normals in the fragment shader instead.
 *
 * Steepness sums to ~0.3, so `waveHeight` can go to ~3 before the sum exceeds
 * 1.0 and the crests start folding through themselves.
 */
const DEFAULT_WAVES = [
  new THREE.Vector4(1.0, 0.3, 0.1, 78),
  new THREE.Vector4(-0.75, 0.85, 0.08, 43),
  new THREE.Vector4(0.4, -1.0, 0.07, 26),
  new THREE.Vector4(-1.0, -0.35, 0.045, 16),
];

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec2 uOffset;
  uniform vec4 uWaves[NUM_WAVES];
  uniform float uWaveScale[NUM_WAVES];
  uniform float uWaveHeight;
  uniform float uChoppiness;
  uniform float uFoamAmount;
  uniform float uFoamReference;
  uniform vec2 uSectionAxis;
  uniform float uSectionStrength;
  uniform float uBarrelChop;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vFoam;
  varying float vHeight;

  /**
   * Character of the wave at a point along the line you ride. x = steepness
   * multiplier, y = how much of a barrel is throwing here.
   *
   * The axis is the swell's direction of travel, not its crest. That's both
   * what the player actually moves along — ride the wave and your position
   * across the crest barely changes, so sections laid out that way would never
   * arrive — and what real waves do: a swell shoaling toward the beach steepens
   * and starts to barrel as it goes.
   *
   * MUST match Ocean.sampleSection() in JS exactly — gameplay reads that copy
   * to decide where the barrels are, and the two disagreeing means riding a
   * barrel that isn't drawn.
   *
   * Summed sines rather than value noise: identical in GLSL and JS to the last
   * bit, endless in both directions, and no texture to sample.
   */
  vec2 sectionProfile(vec2 worldXZ) {
    float s = dot(worldXZ, uSectionAxis);

    float n1 = sin(s * 0.0520 + 1.7) * 0.50
             + sin(s * 0.1050 + 4.2) * 0.33
             + sin(s * 0.1400 + 0.9) * 0.17;
    float n2 = sin(s * 0.0740 + 2.4) * 0.55
             + sin(s * 0.1310 + 5.1) * 0.45;

    float barrel = smoothstep(0.35, 0.85, n2);
    float steep = 1.0 + uSectionStrength * (0.45 * n1 + 0.55 * barrel);

    return vec2(steep, barrel);
  }

  /**
   * A Gerstner wave moves each point in a circle rather than straight up and
   * down, which is what gives real swell its sharp crests and broad troughs.
   *
   * Accumulates the two surface derivatives as it goes: their cross product is
   * the normal, and the determinant of their horizontal part tells us how much
   * the surface is being pinched together (see the Jacobian below).
   */
  vec3 gerstnerWave(vec4 wave, float scale, vec2 p, float steepMul, float chopMul, inout vec3 tangent, inout vec3 binormal) {
    float steepness = wave.z * scale * steepMul;
    float wavelength = wave.w;

    float k = ${TWO_PI.toFixed(8)} / wavelength;
    float c = sqrt(${GRAVITY.toFixed(1)} / k); // deep-water phase speed
    vec2 d = normalize(wave.xy);
    float f = k * (dot(d, p) - c * uTime);
    float a = steepness / k;

    float sinF = sin(f);
    float cosF = cos(f);

    // Horizontal motion is what sharpens the crests, so it gets its own knob.
    // In a barrel section this is driven hard: pushing chop * steepness past 1
    // is what makes the crest genuinely overhang instead of merely leaning.
    float chop = uChoppiness * chopMul;

    tangent += vec3(
      -chop * d.x * d.x * steepness * sinF,
       d.x * steepness * cosF,
      -chop * d.x * d.y * steepness * sinF
    );
    binormal += vec3(
      -chop * d.x * d.y * steepness * sinF,
       d.y * steepness * cosF,
      -chop * d.y * d.y * steepness * sinF
    );

    return vec3(
      chop * d.x * a * cosF,
      a * sinF,
      chop * d.y * a * cosF
    );
  }

  void main() {
    // The mesh slides along with the camera; uOffset re-anchors the wave phase
    // to world space so the swell doesn't drift around with us.
    vec2 origin = position.xz + uOffset;

    // Sampled once per vertex and treated as locally constant. Sections run
    // over 45-120 m while the waves themselves are 16-78 m, so the derivative
    // of the modulation is small next to the wave's own — ignoring it leaves
    // the normals very slightly off at section boundaries and nowhere else.
    vec2 section = sectionProfile(origin);
    float steepMul = section.x;
    float chopMul = 1.0 + uBarrelChop * section.y;
    vec3 displaced = vec3(origin.x, 0.0, origin.y);

    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);

    float totalAmplitude = 0.0;

    for (int i = 0; i < NUM_WAVES; i++) {
      displaced += gerstnerWave(uWaves[i], uWaveScale[i], origin, steepMul, chopMul, tangent, binormal);
      totalAmplitude += (uWaves[i].z * uWaveScale[i] * steepMul) * uWaves[i].w / ${TWO_PI.toFixed(8)};
    }

    vNormal = normalize(cross(binormal, tangent));
    vWorldPosition = displaced;
    vHeight = clamp(displaced.y / max(totalAmplitude, 0.001), -1.0, 1.0);

    // Determinant of the horizontal displacement's Jacobian. It sits at 1.0 on
    // undisturbed water and drops toward (or below) 0 where neighbouring points
    // are squeezed together — which is exactly where a real wave breaks. That
    // makes it a far better whitecap signal than height alone, because it puts
    // foam on the steep leading face of a crest rather than ringing the peak.
    float jacobian = tangent.x * binormal.z - tangent.z * binormal.x;

    // Scaled against a *fixed* reference (the wave set's steepness at
    // waveHeight 1), never against the current settings. Normalising by the
    // live values would make foam scale-invariant — raising the swell would
    // leave whitecap coverage flat, or even shrink it, which is backwards.
    // Against a fixed reference, taller and choppier seas foam more.
    float fold = (1.0 - jacobian) / uFoamReference;

    // Calibrated against the measured distribution of fold. The exponent
    // straightens out that distribution's skew, so the slider gives a roughly
    // even progression in coverage — about 2% / 9% / 20% / 32% of the surface
    // at quarter steps — instead of doing nothing until it's most of the way up.
    // The max() only keeps pow() away from a zero base on fussy drivers; at 0
    // the threshold still lands above the highest fold value, so foam is off.
    float threshold = mix(0.95, 0.05, pow(max(uFoamAmount, 0.0001), 0.6));
    vFoam = smoothstep(threshold, threshold + 0.3, fold);

    // A little foam on the very tops too, so tall crests still streak white
    // even when they aren't steep enough to be genuinely breaking. Faded out
    // on small swell, which shouldn't be producing whitecaps at all.
    float crest = smoothstep(0.72, 1.0, vHeight) * clamp(uWaveHeight - 0.5, 0.0, 1.0);
    vFoam = max(vFoam, crest * uFoamAmount * 0.7);

    vec3 localPosition = vec3(displaced.x - uOffset.x, displaced.y, displaced.z - uOffset.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(localPosition, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uScatterColor;
  uniform vec3 uZenithColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uFoamColor;
  uniform float uRippleStrength;
  uniform float uShininess;
  uniform float uFadeDistance;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vFoam;
  varying float vHeight;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;

    for (int i = 0; i < 3; i++) {
      value += amplitude * valueNoise(p);
      p *= 2.03;
      amplitude *= 0.5;
    }

    return value;
  }

  /**
   * Sub-grid ripples, as a normal perturbation only. Adding these to the
   * geometry instead would alias badly — the vertex grid can't resolve them —
   * but per-pixel they cost three cosines and give the surface its fine texture.
   */
  vec3 addRipples(vec3 normal, vec2 p, float strength) {
    vec2 d1 = vec2(0.80, 0.60);
    vec2 d2 = vec2(-0.48, 0.88);
    vec2 d3 = vec2(0.31, -0.95);

    float r1 = cos(dot(d1, p) * 1.70 + uTime * 2.3);
    float r2 = cos(dot(d2, p) * 2.90 + uTime * 3.1);
    float r3 = cos(dot(d3, p) * 4.60 + uTime * 4.2);

    vec2 slope =
      d1 * (1.70 * 0.030 * r1) +
      d2 * (2.90 * 0.014 * r2) +
      d3 * (4.60 * 0.007 * r3);

    return normalize(normal + vec3(-slope.x, 0.0, -slope.y) * strength);
  }

  /**
   * Analytic stand-in for the sky dome: a horizon-to-zenith gradient plus the
   * sun's disc and glow. Cheap, and it stays in step with the real sky because
   * both are driven from the same sun direction and palette.
   */
  vec3 sampleSky(vec3 direction, vec3 sunDir) {
    float height = clamp(direction.y, 0.0, 1.0);
    vec3 color = mix(uHorizonColor, uZenithColor, pow(height, 0.55));

    float sun = max(dot(direction, sunDir), 0.0);
    color += uSunColor * pow(sun, 220.0) * 6.0; // disc
    color += uSunColor * pow(sun, 8.0) * 0.18;  // haze around it

    return color;
  }

  void main() {
    vec3 viewVector = cameraPosition - vWorldPosition;
    float viewDistance = length(viewVector);
    vec3 viewDir = viewVector / viewDistance;
    vec3 sunDir = normalize(uSunDirection);

    // Far from the camera, many waves fall inside one pixel. Easing the normal
    // back toward flat (and the ripples out entirely) trades a little detail
    // for a horizon that doesn't crawl with sparkle noise.
    float detail = 1.0 - smoothstep(120.0, 0.55 * uFadeDistance, viewDistance);

    vec3 normal = normalize(vNormal);
    normal = normalize(mix(vec3(0.0, 1.0, 0.0), normal, 0.15 + 0.85 * detail));
    normal = addRipples(normal, vWorldPosition.xz, uRippleStrength * detail);

    // Schlick, with water's real normal-incidence reflectance of ~2%. Almost
    // all of the ocean's brightness at a distance is this term.
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);

    vec3 reflected = reflect(-viewDir, normal);
    reflected.y = abs(reflected.y); // never sample below the horizon
    vec3 skyColor = sampleSky(reflected, sunDir);

    // Body colour: deep where we see straight down into it, shallower on the
    // faces, with light bleeding through crests when we look toward the sun.
    float facing = clamp(dot(normal, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
    vec3 water = mix(uDeepColor, uShallowColor, facing * 0.65);

    float scatter = pow(max(dot(viewDir, -sunDir), 0.0), 3.0) * max(vHeight, 0.0);
    water += uScatterColor * scatter * 0.5;
    water *= 0.5 + 0.5 * max(dot(normal, sunDir), 0.0);

    vec3 color = mix(water, skyColor, fresnel);

    // Sun glitter. Weighted by fresnel so it fades out where we're looking
    // straight down and blazes at grazing angles, like the real thing.
    vec3 halfway = normalize(sunDir + viewDir);
    float specular = pow(max(dot(normal, halfway), 0.0), uShininess);
    color += uSunColor * specular * fresnel * 14.0;

    if (vFoam > 0.001) {
      // Break the foam mask up with drifting noise so crests read as scattered
      // bubbles instead of a clean painted band.
      vec2 foamUv = vWorldPosition.xz * 0.28;
      float coarse = fbm(foamUv + vec2(uTime * 0.09, uTime * -0.06));
      float fine = valueNoise(foamUv * 3.7 - vec2(uTime * 0.22, uTime * 0.15));
      float foamTexture = mix(0.5, coarse * 0.75 + fine * 0.45, detail);

      float foam = smoothstep(0.34, 0.78, vFoam * (0.45 + 1.25 * foamTexture));
      color = mix(color, uFoamColor, clamp(foam, 0.0, 1.0));
    }

    // Haze the far edge into the horizon so the plane's rim is never visible.
    color = mix(color, uHorizonColor, smoothstep(uFadeDistance * 0.3, uFadeDistance, viewDistance));

    gl_FragColor = vec4(color, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Ocean {
  constructor(options = {}) {
    const waves = options.waves ?? DEFAULT_WAVES;

    // Vertex spacing is size/segments ≈ 3.6 units; keep wavelengths above ~2x
    // that or the swell aliases.
    this.size = options.size ?? 800;
    this.segments = options.segments ?? 200;

    // Level of detail, done where it actually belongs. Lowering the segment
    // count coarsens the grid, and a grid can only carry waves longer than a
    // few times its spacing — below that they alias into crawling shimmer
    // rather than adding detail. So a coarser ocean drops its shortest waves
    // instead of rendering them wrongly; the fragment shader's ripples already
    // cover that scale per-pixel, which is what they were added for.
    const spacing = this.size / this.segments;
    const resolvable = waves.filter((wave) => wave.w >= spacing * (options.minSamples ?? 3.5));

    /** The waves this grid can actually carry. Never empty. */
    this.waves = resolvable.length > 0 ? resolvable : [waves[0]];
    /** Waves dropped as unresolvable at this detail level. */
    this.dropped = waves.length - this.waves.length;

    /**
     * How much of its size a wave keeps as the swell drops, as an exponent on
     * `waveHeight`. 1 is proportional — the old behaviour, where turning the
     * swell down shrank the entire sea uniformly and left it glassy. Short
     * waves are wind chop, and chop doesn't leave with the swell: the sea gets
     * *smaller*, not *smoother*.
     *
     * Graded by wavelength across the authored set rather than the surviving
     * one, so a wave's persistence is a property of the wave and not of the
     * quality tier that may have dropped its neighbour.
     */
    this.chopPersistence = options.chopPersistence ?? 0.45;

    /** Metres of water kept between the deepest possible trough and the backdrop. */
    this.backdropClearance = options.backdropClearance ?? 1.5;

    const lengths = waves.map((wave) => wave.w);
    const shortest = Math.min(...lengths);
    const span = Math.max(...lengths) - shortest;
    this._persistence = this.waves.map((wave) =>
      span > 0
        ? THREE.MathUtils.lerp(this.chopPersistence, 1, (wave.w - shortest) / span)
        : 1,
    );
    this._waveScales = new Float32Array(this.waves.length);

    this.group = new THREE.Group();
    this._waveTime = 0;
    this._section = { steep: 1, barrel: 0 };

    const geometry = new THREE.PlaneGeometry(this.size, this.size, this.segments, this.segments);
    geometry.rotateX(-Math.PI / 2); // author the plane directly in XZ

    const horizonColor = new THREE.Color(options.horizonColor ?? 0xb8d3e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      defines: { NUM_WAVES: this.waves.length },
      uniforms: {
        uTime: { value: 0 },
        uOffset: { value: new THREE.Vector2() },
        uWaves: { value: this.waves },
        uWaveScale: { value: this._waveScales },

        // --- the configurable knobs ---
        uWaveHeight: { value: options.waveHeight ?? 1 },
        uChoppiness: { value: options.choppiness ?? 1 },
        uFoamAmount: { value: options.foamAmount ?? 0.5 },
        uFoamReference: { value: this.waves.reduce((total, w) => total + w.z, 0) || 1 },
        uSectionAxis: { value: new THREE.Vector2(0, 1) },
        uSectionStrength: { value: options.sectionStrength ?? 0.7 },
        uBarrelChop: { value: options.barrelChop ?? 2.2 },
        uRippleStrength: { value: options.rippleStrength ?? 1 },

        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(options.sunColor ?? 0xfff1d6) },
        uDeepColor: { value: new THREE.Color(options.deepColor ?? 0x05202f) },
        uShallowColor: { value: new THREE.Color(options.shallowColor ?? 0x1a6f88) },
        uScatterColor: { value: new THREE.Color(options.scatterColor ?? 0x2fa88f) },
        uZenithColor: { value: new THREE.Color(options.zenithColor ?? 0x3f7fc4) },
        uHorizonColor: { value: horizonColor },
        uFoamColor: { value: new THREE.Color(options.foamColor ?? 0xf2f7fa) },
        uShininess: { value: options.shininess ?? 220 },
        uFadeDistance: { value: this.size * 0.42 },
      },
    });

    this._updateWaveScales();

    /**
     * Rate the wave clock advances. 1 is the physically correct deep-water
     * speed for each wavelength; lower reads as heavy, slow swell.
     * Not a uniform — see the note in `update()`.
     */
    this.waveSpeed = options.waveSpeed ?? 1;

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false; // it always surrounds the camera

    // Flat backdrop filling the gap between the detailed plane and the true
    // horizon, so the world reads as open sea in every direction.
    this.backdrop = new THREE.Mesh(
      new THREE.CircleGeometry(20000, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: horizonColor }),
    );
    this.backdrop.position.y = this._backdropDepth;
    this.backdrop.frustumCulled = false;

    this.group.add(this.mesh, this.backdrop);
  }

  /** Overall wave amplitude. 0 is a millpond; above ~3 the crests self-intersect. */
  get waveHeight() {
    return this.material.uniforms.uWaveHeight.value;
  }

  set waveHeight(value) {
    this.material.uniforms.uWaveHeight.value = Math.max(0, value);
    this._updateWaveScales();
  }

  /**
   * The height multiplier each wave actually gets, written in place so the
   * shader's uniform array and the physics below read the same numbers — the
   * one source of truth, rather than a formula duplicated into GLSL.
   *
   * Only the way *down* is graded. At and above 1 every wave scales together,
   * exactly as before, so the sea the whole game is tuned against — and every
   * measurement taken of it — is untouched. Below 1 the short waves fall off
   * more slowly, so a small swell still has texture on it instead of turning
   * to glass. 0 is still a millpond: `0^p` is 0 for any positive exponent.
   */
  _updateWaveScales() {
    const height = this.material.uniforms.uWaveHeight.value;

    for (let i = 0; i < this._waveScales.length; i++) {
      this._waveScales[i] = height >= 1 ? height : height ** this._persistence[i];
    }

    this._updateBackdropDepth();
  }

  /**
   * Sinks the backdrop below the deepest trough the swell can dig.
   *
   * The backdrop is opaque geometry, not a background — it has to write depth
   * or the sky dome, which renders at the far plane with its depth test on,
   * paints straight over it. So anywhere the water falls below it, it is the
   * nearer surface, wins the depth test, and leaves a flat horizon-coloured
   * hole exactly where the wave is lowest. At the fixed -2 m it used to sit at,
   * that was 1.6% of the sea at the default swell and 20% at waveHeight 2.
   *
   * Vertical displacement is the plain amplitude sum — choppiness only moves
   * points sideways — and the section profile multiplies it, its own ceiling
   * being 1 + sectionStrength with both terms of the profile at full tilt.
   *
   * Dropping it costs nothing to look at: the water is faded to exactly
   * `horizonColor` well before the plane ends, and the backdrop *is*
   * `horizonColor`, so the step at the seam is between two identical colours.
   */
  _updateBackdropDepth() {
    const steepCeiling = 1 + this.material.uniforms.uSectionStrength.value;

    let amplitude = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const wave = this.waves[i];
      amplitude += (wave.z * this._waveScales[i] * wave.w) / TWO_PI;
    }

    this._backdropDepth = -(amplitude * steepCeiling + this.backdropClearance);
  }

  /**
   * How sharp the crests are, independent of height. 0 gives rounded sine
   * swell; 1 is physically correct; above that the peaks pinch into spikes.
   */
  get choppiness() {
    return this.material.uniforms.uChoppiness.value;
  }

  set choppiness(value) {
    this.material.uniforms.uChoppiness.value = Math.max(0, value);
  }

  /** 0 = no whitecaps, 1 = foam on nearly every crest. */
  get foamAmount() {
    return this.material.uniforms.uFoamAmount.value;
  }

  set foamAmount(value) {
    this.material.uniforms.uFoamAmount.value = THREE.MathUtils.clamp(value, 0, 1);
  }

  /** Strength of the per-pixel surface ripples. */
  get rippleStrength() {
    return this.material.uniforms.uRippleStrength.value;
  }

  set rippleStrength(value) {
    this.material.uniforms.uRippleStrength.value = Math.max(0, value);
  }

  /** Point the reflected sun and its highlight at the sky's actual sun. */
  setSunDirection(direction) {
    this.material.uniforms.uSunDirection.value.copy(direction);
  }

  /**
   * Point the reflection at the sky that's actually overhead.
   *
   * These two colours were authored by hand, which is fine until the sky
   * changes — and then the sea is reflecting one sky while the player is
   * looking at another. Measured against the sky as it now stands, the hand
   * values were 1.8x too dark at the zenith and the wrong hue at the horizon:
   * the sea faded to a burnt orange (#b97e4b) under a warm grey sky (#b3968f),
   * where Fresnel at grazing incidence is ~0.95 and the two should very nearly
   * match. That mismatch is most of what makes water read as painted.
   *
   * Radiance, not a swatch — the values run above 1, which is what lets a
   * distant sea be as bright as the sky it mirrors.
   */
  setSkyPalette(zenith, horizon) {
    this.material.uniforms.uZenithColor.value.copy(zenith);
    this.material.uniforms.uHorizonColor.value.copy(horizon);

    // The far fade and the backdrop are both the horizon colour: they are the
    // same surface as far as the eye is concerned, and the seam only stays
    // invisible while all three agree.
    this.backdrop.material.color.copy(horizon);
  }

  /**
   * Approximate surface height at a world position, mirroring the shader's
   * vertical term (and its `waveHeight` scaling).
   *
   * Gerstner waves displace horizontally as well, so the point that actually
   * lands above (x, z) started somewhere slightly else — this is a close
   * approximation, good enough to float things on, not an exact intersection.
   */
  /**
   * Unit vector the wave sections run along — the swell's direction of travel,
   * which is the line the player rides down.
   */
  get sectionAxis() {
    if (!this._axis) {
      const wave = this.dominantWave;
      const length = Math.hypot(wave.x, wave.y) || 1;
      this._axis = new THREE.Vector2(wave.x / length, wave.y / length);
      this.material.uniforms.uSectionAxis.value.copy(this._axis);
    }
    return this._axis;
  }

  /**
   * The wave's character at a point: how steep it is here, and whether it's
   * throwing a barrel.
   *
   * MUST stay identical to sectionProfile() in the vertex shader. Gameplay
   * reads this copy to decide where barrels are and how the board behaves;
   * if the two drift apart the player rides a barrel that isn't drawn.
   */
  sampleSection(x, z, target = { steep: 1, barrel: 0 }) {
    const axis = this.sectionAxis;
    const s = x * axis.x + z * axis.y;

    const n1 =
      Math.sin(s * 0.052 + 1.7) * 0.5 +
      Math.sin(s * 0.105 + 4.2) * 0.33 +
      Math.sin(s * 0.14 + 0.9) * 0.17;
    const n2 = Math.sin(s * 0.074 + 2.4) * 0.55 + Math.sin(s * 0.131 + 5.1) * 0.45;

    const barrel = THREE.MathUtils.smoothstep(n2, 0.35, 0.85);

    target.barrel = barrel;
    target.steep = 1 + this.sectionStrength * (0.45 * n1 + 0.55 * barrel);

    return target;
  }

  get sectionStrength() {
    return this.material.uniforms.uSectionStrength.value;
  }

  set sectionStrength(value) {
    this.material.uniforms.uSectionStrength.value = Math.max(0, value);
  }

  get barrelChop() {
    return this.material.uniforms.uBarrelChop.value;
  }

  set barrelChop(value) {
    this.material.uniforms.uBarrelChop.value = Math.max(0, value);
  }

  sampleHeight(x, z, time = this._waveTime) {
    let height = 0;
    const steep = this.sampleSection(x, z, this._section).steep;

    for (let i = 0; i < this.waves.length; i++) {
      const wave = this.waves[i];
      const k = TWO_PI / wave.w;
      const speed = Math.sqrt(GRAVITY / k);
      const length = Math.hypot(wave.x, wave.y) || 1;
      const dirX = wave.x / length;
      const dirZ = wave.y / length;

      // Per-wave scale, not the raw waveHeight — see _updateWaveScales().
      const amplitude = (wave.z * this._waveScales[i] * steep) / k;
      height += amplitude * Math.sin(k * (dirX * x + dirZ * z - speed * time));
    }

    return height;
  }

  /**
   * Height *and* the analytic slope of the surface at a world position, in one
   * pass. Writes into `target` so this can be called every frame without
   * allocating.
   *
   * The slope is the exact derivative of the height sum, not a finite
   * difference: d/dx of `a·sin(k(d·p - ct))` is `a·k·d.x·cos(...)`, and `a·k`
   * is just the wave's steepness. That makes the gradient cheaper *and* more
   * accurate than sampling neighbouring points.
   *
   * Same caveat as `sampleHeight`: this is the vertical term only, so it
   * ignores the Gerstner horizontal displacement. Good enough to ride on.
   */
  sampleSurface(
    x,
    z,
    target = { height: 0, slopeX: 0, slopeZ: 0, foam: 0 },
    time = this._waveTime,
  ) {
    let height = 0;
    let slopeX = 0;
    let slopeZ = 0;

    // Surface derivatives, for the same Jacobian the vertex shader uses to
    // decide where foam goes.
    let tangentX = 1;
    let tangentZ = 0;
    let binormalX = 0;
    let binormalZ = 1;
    let totalAmplitude = 0;

    const section = this.sampleSection(x, z, this._section);
    // Only the crest-foam term below wants the overall height; the waves
    // themselves are scaled individually inside the loop.
    const waveHeight = this.waveHeight * section.steep;
    const choppiness = this.choppiness * (1 + this.barrelChop * section.barrel);

    for (let i = 0; i < this.waves.length; i++) {
      const wave = this.waves[i];
      const k = TWO_PI / wave.w;
      const speed = Math.sqrt(GRAVITY / k);
      const length = Math.hypot(wave.x, wave.y) || 1;
      const dirX = wave.x / length;
      const dirZ = wave.y / length;

      const steepness = wave.z * this._waveScales[i] * section.steep;
      const phase = k * (dirX * x + dirZ * z - speed * time);
      const sin = Math.sin(phase);
      const cos = Math.cos(phase);

      height += (steepness / k) * sin;

      const gradient = steepness * cos;
      slopeX += gradient * dirX;
      slopeZ += gradient * dirZ;

      const pinch = choppiness * steepness * sin;
      tangentX -= pinch * dirX * dirX;
      tangentZ -= pinch * dirX * dirZ;
      binormalX -= pinch * dirX * dirZ;
      binormalZ -= pinch * dirZ * dirZ;

      totalAmplitude += (steepness * wave.w) / TWO_PI;
    }

    target.height = height;
    target.slopeX = slopeX;
    target.slopeZ = slopeZ;

    const fold =
      (1 - (tangentX * binormalZ - tangentZ * binormalX)) /
      this.material.uniforms.uFoamReference.value;
    const relativeHeight = THREE.MathUtils.clamp(height / Math.max(totalAmplitude, 0.001), -1, 1);

    target.foam = this._foamAt(fold, relativeHeight, waveHeight);
    target.barrel = section.barrel;
    target.steep = section.steep;

    return target;
  }

  /**
   * Foam coverage at a point, 0..1.
   *
   * NOTE: this deliberately mirrors the tail of the vertex shader's main().
   * Gameplay reads it to decide when the whitewater has you, so the two must
   * agree — if you retune the foam thresholds in the shader, change them here
   * too, or the board will wipe out on water that looks perfectly clean.
   */
  _foamAt(fold, relativeHeight, waveHeight) {
    const foamAmount = this.foamAmount;

    const threshold = THREE.MathUtils.lerp(
      0.95,
      0.05,
      Math.pow(Math.max(foamAmount, 0.0001), 0.6),
    );
    const breaking = THREE.MathUtils.smoothstep(fold, threshold, threshold + 0.3);
    const crest =
      THREE.MathUtils.smoothstep(relativeHeight, 0.72, 1.0) *
      THREE.MathUtils.clamp(waveHeight - 0.5, 0, 1);

    return Math.max(breaking, crest * foamAmount * 0.7);
  }

  /**
   * The wave that dominates the surface — the one worth riding. Amplitude is
   * steepness x wavelength, so it isn't simply the steepest entry.
   */
  get dominantWave() {
    if (!this._dominant) {
      // Authored amplitude, deliberately ignoring the per-wave height scaling:
      // which wave is "the swell" is a property of the wave set. Letting it
      // depend on `waveHeight` would hand the ride — and the section axis
      // baked from it — to a different wave partway down the slider.
      this._dominantIndex = this.waves.reduce(
        (best, wave, index) => (wave.z * wave.w > this.waves[best].z * this.waves[best].w ? index : best),
        0,
      );
      this._dominant = this.waves[this._dominantIndex];
    }
    return this._dominant;
  }

  /**
   * Where a point sits within the dominant wave, in that wave's own frame.
   *
   * `offset` is the phase measured from the crest, wrapped to [-pi, pi]:
   * 0 is right on the crest, positive is *ahead* of it — the advancing face
   * you ride — and negative is behind, the back of the wave. A board slower
   * than `phaseSpeed` drifts steadily toward negative as the wave overtakes it.
   */
  sampleWaveFrame(
    x,
    z,
    target = { offset: 0, dirX: 0, dirZ: 1, phaseSpeed: 0, steepness: 0 },
    time = this._waveTime,
  ) {
    const wave = this.dominantWave;
    const k = TWO_PI / wave.w;
    const length = Math.hypot(wave.x, wave.y) || 1;

    const dirX = wave.x / length;
    const dirZ = wave.y / length;
    const phaseSpeed = Math.sqrt(GRAVITY / k);
    const phase = k * (dirX * x + dirZ * z - phaseSpeed * time) - Math.PI / 2;

    target.offset = Math.atan2(Math.sin(phase), Math.cos(phase)); // wrap to [-pi, pi]
    target.dirX = dirX;
    target.dirZ = dirZ;
    target.phaseSpeed = phaseSpeed;
    target.steepness = wave.z * this._waveScales[this._dominantIndex];

    return target;
  }

  update(delta, elapsed, focus) {
    // The wave clock is accumulated rather than derived from total elapsed
    // time: multiplying elapsed by waveSpeed would jump the whole swell to a
    // new phase the instant the speed changed.
    this._waveTime += delta * this.waveSpeed;
    this.material.uniforms.uTime.value = this._waveTime;

    if (focus) {
      // Snap to the vertex grid: sliding by whole quads keeps the wave
      // silhouettes stable instead of shimmering as we move.
      const step = this.size / this.segments;
      const x = Math.round(focus.x / step) * step;
      const z = Math.round(focus.z / step) * step;

      this.mesh.position.set(x, 0, z);
      this.material.uniforms.uOffset.value.set(x, z);
      this.backdrop.position.set(focus.x, this._backdropDepth, focus.z);
    }
  }
}
