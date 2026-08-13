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

/**
 * The beach, as one piece of GLSL pasted into every shader that needs it and
 * mirrored by `Ocean._shoreProfile()` in JS.
 *
 * This is the whole world model. Everything about the wave — how tall it is,
 * where it throws, where it turns to whitewater, where the sand is — is a
 * function of one number: how deep the water is under that point.
 *
 * `tanh` is written out rather than called: the default shader language here is
 * GLSL ES 1.00, which doesn't have it. Only the d >= 0 branch is ever wanted, so
 * the exp(-2x) form is the stable one.
 */
const SHORE_GLSL = /* glsl */ `
  float shoreTanh(float x) {
    float e = exp(-2.0 * max(x, 0.0));
    return (1.0 - e) / (1.0 + e);
  }

  /**
   * Still-water depth, in metres. Zero at the waterline and rising out to sea.
   *
   * A plane beach of gradient uBeachSlope rolled off to uDeepDepth with a
   * tanh, which is linear near the shore — the part that matters, since the
   * breaking depth is what sets where the surf zone is — and flattens into deep
   * water without a knee for the shoaling term below to catch on.
   */
  float shoreDepth(vec2 p) {
    float d = uShoreLine - dot(p, uShoreAxis);
    float h = uDeepDepth * shoreTanh(d * uBeachSlope / uDeepDepth);

    // Sandbars. Without them a straight beach breaks in one endless line at a
    // fixed distance out, so every wave is the same wave; bars are what give a
    // beach break its peaks and channels. Faded out with depth because a bar is
    // a shallow-water feature — exp() rather than a window so there's no edge
    // for the break line to kink along.
    float t = dot(p, vec2(-uShoreAxis.y, uShoreAxis.x));
    float bar = sin(t * 0.0131 + 2.4) * 0.55 + sin(t * 0.0074 + 5.1) * 0.45;
    h *= 1.0 - uBarAmount * bar * exp(-h / uBarDepth);

    return max(h, 0.0);
  }

  /**
   * What the wave is doing here: x = amplitude multiplier, y = how much of a
   * barrel is throwing, z = how thoroughly it has turned to whitewater.
   *
   * Two competing effects, and the smaller wins:
   *
   * - **Shoaling.** As the water shallows the wave slows, its energy packs into
   *   a shorter length, and it grows. Green's law, H ~ h^-1/4.
   * - **Breaking.** Water can only hold a wave so tall for its depth. Past the
   *   McCowan limit H = 0.78h the crest outruns its own base and throws
   *   forward, and from there the wave is depth-limited: it can only be as big
   *   as the water is deep, so it shrinks steadily to nothing at the sand.
   *
   * b is the ratio between the two — under 1 the wave is still building, over
   * 1 it has broken. That single number places the barrel (just past 1, where
   * the lip is pitching but the face is still clean) and the whitewater
   * (further in, where it's all foam).
   *
   * MUST match Ocean._shoreProfile() in JS exactly. Gameplay reads that copy to
   * decide where the barrels and the whitewater are, and the two disagreeing
   * means riding a barrel that isn't drawn, or drowning in clean water.
   */
  vec3 shoreProfile(vec2 p, out float depth) {
    float h = shoreDepth(p);
    depth = h;

    float shoal = max(1.0, pow(uShoalRefDepth / max(h, 0.05), 0.25));
    float limit = uBreakerIndex * h / (2.0 * uDeepAmplitude);

    float gain = min(shoal, limit);
    float b = shoal / max(limit, 1e-4);

    float barrel = smoothstep(1.02, 1.14, b) * (1.0 - smoothstep(1.32, 1.58, b));
    float white = smoothstep(1.15, 2.0, b);

    return vec3(gain, barrel, white);
  }
`;

/**
 * The bed carried above the waterline, for the dry beach. Kept out of
 * SHORE_GLSL so the water shader doesn't have to declare uniforms it will never
 * read.
 */
const BEACH_GLSL = /* glsl */ `
  uniform float uDrySlope;
  uniform float uDuneHeight;

  float shoreBed(vec2 p) {
    float d = uShoreLine - dot(p, uShoreAxis);
    if (d >= 0.0) return -shoreDepth(p);

    // Above the waterline the sand is steeper than the bed under the water and
    // flattens off into dunes. The kink right at the waterline is not an
    // artefact — a real beach has a berm there for exactly this reason.
    return uDuneHeight * shoreTanh(-d * uDrySlope / uDuneHeight);
  }
`;

const beachVertexShader = /* glsl */ `
  uniform vec2 uShoreAxis;
  uniform float uShoreLine;
  uniform float uBeachSlope;
  uniform float uDeepDepth;
  uniform float uBarAmount;
  uniform float uBarDepth;
  uniform float uCrossSize;
  uniform float uSeawardEdge;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vBed;

  ${SHORE_GLSL}
  ${BEACH_GLSL}

  void main() {
    // The plane is authored in the shore's own frame — x runs along the beach,
    // z across it — and mapped into the world here. That way the one place the
    // shore's direction is defined stays the axis uniform, and the mesh doesn't
    // have to be rebuilt if it changes.
    float along = position.x;
    float d = uSeawardEdge - (position.z + uCrossSize * 0.5);

    vec2 perp = vec2(-uShoreAxis.y, uShoreAxis.x);
    vec2 world = uShoreAxis * (uShoreLine - d) + perp * along;

    float bed = shoreBed(world);

    // Finite-differenced rather than analytic: the bed is a tanh of a sum of
    // sines through a reciprocal exponential, and two extra evaluations per
    // vertex is far cheaper than getting that derivative right. 4 m is under a
    // third of the cross-shore vertex spacing, so it measures this cell's slope
    // and not the next one's.
    float step = 4.0;
    float bx = shoreBed(world + perp * step) - shoreBed(world - perp * step);
    float bz = shoreBed(world + uShoreAxis * step) - shoreBed(world - uShoreAxis * step);
    // The two differences are along the shore frame's axes, so they have to be
    // rotated back into world XZ before they describe a gradient there.
    vNormal = normalize(vec3(
      -(bx * perp.x + bz * uShoreAxis.x) / (2.0 * step),
      1.0,
      -(bx * perp.y + bz * uShoreAxis.y) / (2.0 * step)
    ));

    vBed = bed;
    vWorldPosition = vec3(world.x, bed, world.y);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

const beachFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uWetSandColor;
  uniform vec3 uDrySandColor;
  uniform vec3 uFoamColor;
  uniform vec3 uHorizonColor;
  uniform float uFadeDistance;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vBed;

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 sunDir = normalize(uSunDirection);

    // Sand darkens where it's wet, and the wet line is where the water has just
    // been. Everything above about a metre has dried out.
    float wet = 1.0 - smoothstep(0.0, 1.0, vBed);
    vec3 sand = mix(uDrySandColor, uWetSandColor, wet);

    // Swash. The waterline is not a line — it surges up the sand and drains
    // back, and a beach with a static edge reads as a painted backdrop. One
    // slow sine plus a faster one so the run-up doesn't tick like a metronome.
    float reach = 0.55 + 0.42 * sin(uTime * 0.31) + 0.16 * sin(uTime * 0.83 + 1.9);
    float swash = 1.0 - smoothstep(reach - 0.12, reach + 0.10, vBed);
    sand = mix(sand, uFoamColor, swash * 0.75 * step(0.0, vBed));

    // Lambert against the same sun everything else here uses, with a flat ambient
    // term so the dunes don't go black at sunset.
    float light = 0.35 + 0.65 * max(dot(normal, sunDir), 0.0);
    vec3 color = sand * light;
    color += uSunColor * pow(max(dot(normal, sunDir), 0.0), 6.0) * 0.06;

    // Same fade the water uses, to the same colour, so the two meet the horizon
    // together instead of one of them ending in a visible edge.
    float viewDistance = length(cameraPosition - vWorldPosition);
    color = mix(color, uHorizonColor, smoothstep(uFadeDistance * 0.45, uFadeDistance * 1.6, viewDistance));

    gl_FragColor = vec4(color, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec2 uOffset;
  uniform vec4 uWaves[NUM_WAVES];
  uniform float uWaveScale[NUM_WAVES];
  uniform float uWaveHeight;
  uniform float uChoppiness;
  uniform float uFoamAmount;
  uniform float uFoamReference;
  uniform vec2 uShoreAxis;
  uniform float uShoreLine;
  uniform float uBeachSlope;
  uniform float uDeepDepth;
  uniform float uBarAmount;
  uniform float uBarDepth;
  uniform float uDeepAmplitude;
  uniform float uShoalRefDepth;
  uniform float uBreakerIndex;
  uniform float uBarrelChop;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vFoam;
  varying float vHeight;
  varying float vDepth;

  ${SHORE_GLSL}


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

    // Sampled once per vertex and treated as locally constant. The beach
    // profile runs over hundreds of metres while the waves themselves are
    // 16-78 m, so the derivative of the modulation is small next to the wave's
    // own — ignoring it leaves the normals very slightly off across the surf
    // zone and nowhere else.
    float depth;
    vec3 shore = shoreProfile(origin, depth);
    float steepMul = shore.x;
    float chopMul = 1.0 + uBarrelChop * shore.y;
    vDepth = depth;
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
    //
    // The shoaling gain *is* divided back out, though, and that is a different
    // question from the one above. This term is whitecaps, which are a property
    // of the swell; a wave standing up over a shallowing bottom is not
    // whitecapping, it is on its way to breaking, and breaking has its own term
    // below. Leaving the gain in double-counted it — at the lineup, in 8 m of
    // water, the gain of 1.25 was enough to put the take-off spot over the
    // wipeout threshold for 22% of every wave cycle, so sitting still waiting
    // for a wave could drown you.
    float fold = (1.0 - jacobian) / (uFoamReference * max(steepMul, 0.05));

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

    // Whitewater. Past the break the crest isn't a crest any more, it's a
    // moving pile of aerated water — so this ignores uFoamAmount entirely.
    // That slider is about whitecaps on open water; a broken wave is white
    // because it has broken.
    //
    // Gated on height within the wave, and that gate is not cosmetic. Painting
    // the whole broken zone white says the entire inside half of the beach is
    // whitewater, which is both wrong — the trough between two broken waves is
    // disturbed, not white — and unplayable: gameplay reads this value, so it
    // made any turn at all in the surf zone an instant wipeout.
    vFoam = max(vFoam, shore.z * smoothstep(-0.15, 0.45, vHeight));

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

  uniform vec3 uSandColor;
  uniform float uShallowDepth;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vFoam;
  varying float vHeight;
  varying float vDepth;

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

    // Over a shallow bottom you are looking at the sand through the water, not
    // into the dark. This is most of what makes a beach read as a beach from
    // out the back: the break line shows up as a band of pale green long before
    // any foam appears on it. Squared so the sand comes up quickly in the last
    // couple of metres rather than washing the whole surf zone out.
    float shallow = 1.0 - smoothstep(0.0, uShallowDepth, vDepth);
    water = mix(water, uSandColor, shallow * shallow * 0.85);

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

    /**
     * The beach. Distances are along the swell's direction of travel, which is
     * the shore normal — waves march straight at the sand, and `shoreLine` is
     * how far the waterline sits from the origin the run starts at.
     *
     * `beachSlope` is what sets the size of the game. The surf zone runs from
     * the breaking depth to the sand, so a gentler beach is a longer ride: at
     * 1:80 the wave breaks 578 m out and the rideable part of it lasts about
     * 44 s at trim speed, which is a long ride by the standards of the real
     * thing and about right for a 120 s run.
     */
    this.shoreLine = options.shoreLine ?? 640;
    this.beachSlope = options.beachSlope ?? 0.0125;
    this.deepDepth = options.deepDepth ?? 45;
    /** How much of the depth a sandbar takes out, and how deep bars reach. */
    this.barAmount = options.barAmount ?? 0.35;
    this.barDepth = options.barDepth ?? 10;
    /** McCowan's breaking limit: a wave can be 0.78 of the depth it stands in. */
    this.breakerIndex = options.breakerIndex ?? 0.78;
    /** Dry beach above the waterline — steeper than the bed, as a real berm is. */
    this.drySlope = options.drySlope ?? 0.06;
    this.duneHeight = options.duneHeight ?? 9;

    /**
     * Wave height at which the ride is over, in metres.
     *
     * Measured rather than chosen: riding the default beach in on a neutral
     * input, the board holds the pocket down to about d = 237 m and then loses
     * it inside four seconds — the face is still there but it can no longer
     * push a board at the swell's 11 m/s, so the wave overtakes you and the
     * whitewater has you. The height there is 2.33 m, so 2.4 m ends the wave
     * one beat before it would collapse on its own, which is a kick-out rather
     * than a wipeout.
     */
    this.rideEndHeight = options.rideEndHeight ?? 2.4;

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
        uBarrelChop: { value: options.barrelChop ?? 2.2 },
        uRippleStrength: { value: options.rippleStrength ?? 1 },

        // --- the beach ---
        uShoreAxis: { value: new THREE.Vector2(0, 1) },
        uShoreLine: { value: this.shoreLine },
        uBeachSlope: { value: this.beachSlope },
        uDeepDepth: { value: this.deepDepth },
        uBarAmount: { value: this.barAmount },
        uBarDepth: { value: this.barDepth },
        uShoalRefDepth: { value: 1 },
        uBreakerIndex: { value: this.breakerIndex },
        uDeepAmplitude: { value: 1 },
        uShallowDepth: { value: options.shallowDepth ?? 6 },
        uSandColor: { value: new THREE.Color(options.sandColor ?? 0x9fb08a) },

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

    /**
     * The depth at which the swell starts to feel the bottom, a quarter of the
     * dominant wavelength — the textbook figure, and it lands in the right place
     * here: 19.5 m for the 78 m swell, which is well outside the 578 m surf zone,
     * so the wave is already growing by the time it gets there.
     *
     * From the authored wavelength, not the scaled one: which wave is "the
     * swell" is a property of the wave set, and so is where it starts to shoal.
     */
    this._shoalRefDepth = this.dominantWave.w / 4;
    this.material.uniforms.uShoalRefDepth.value = this._shoalRefDepth;
    this.material.uniforms.uShoreAxis.value.copy(this.sectionAxis);

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

    this._buildBeach(options);
    this.group.add(this.mesh, this.backdrop, this.beach);
  }

  /**
   * The sand. A plane authored in the shore's own frame and displaced to the
   * same bed the water's depth comes from, so the beach and the surf zone are
   * two views of one surface and cannot disagree about where the sea ends.
   *
   * Deliberately static, unlike the water: the beach is a place, and having it
   * slide along under the camera the way the ocean plane does would be visible
   * the moment you looked at the bars. It's sized to cover instead — 6 km of
   * coast is more than a 120 s run can travel along.
   */
  _buildBeach(options) {
    const alongSize = options.beachAlongSize ?? 6000;
    const crossSize = options.beachCrossSize ?? 1600;
    // Seaward edge is set past where the water ever gets thin enough to see the
    // bottom through, so the sand's own far fade is never what ends it.
    const seawardEdge = options.beachSeawardEdge ?? 700;

    // Cross-shore resolution is what matters: it carries the waterline. 8.3 m
    // cells there against 62 m along the beach, where the only feature is the
    // bars and their shortest period is 480 m.
    const geometry = new THREE.PlaneGeometry(alongSize, crossSize, 96, 192);
    geometry.rotateX(-Math.PI / 2);

    this.beachMaterial = new THREE.ShaderMaterial({
      vertexShader: beachVertexShader,
      fragmentShader: beachFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uShoreAxis: { value: this.material.uniforms.uShoreAxis.value },
        uShoreLine: { value: this.shoreLine },
        uBeachSlope: { value: this.beachSlope },
        uDeepDepth: { value: this.deepDepth },
        uBarAmount: { value: this.barAmount },
        uBarDepth: { value: this.barDepth },
        uDrySlope: { value: this.drySlope },
        uDuneHeight: { value: this.duneHeight },
        uCrossSize: { value: crossSize },
        uSeawardEdge: { value: seawardEdge },
        uSunDirection: { value: this.material.uniforms.uSunDirection.value },
        uSunColor: { value: this.material.uniforms.uSunColor.value },
        uFoamColor: { value: this.material.uniforms.uFoamColor.value },
        uHorizonColor: { value: this.material.uniforms.uHorizonColor.value },
        uWetSandColor: { value: new THREE.Color(options.wetSandColor ?? 0x7a6a58) },
        uDrySandColor: { value: new THREE.Color(options.drySandColor ?? 0xd9c2a0) },
        uFadeDistance: { value: this.size * 0.42 },
      },
    });

    this.beach = new THREE.Mesh(geometry, this.beachMaterial);
    this.beach.frustumCulled = false;
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

    // Deep-water amplitude of the whole sea, which is what the breaking limit is
    // measured against. It has to follow `waveHeight`: a bigger swell has to
    // break in deeper water and further out, and that falls out of this one
    // number rather than needing a second set of tuning.
    let amplitude = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const wave = this.waves[i];
      amplitude += (wave.z * this._waveScales[i] * wave.w) / TWO_PI;
    }
    this._deepAmplitude = Math.max(amplitude, 1e-4);
    this.material.uniforms.uDeepAmplitude.value = this._deepAmplitude;

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
    // The shoaling gain has no closed-form maximum — it's the crossover between
    // a rising curve and a falling one, and where they meet moves with
    // `waveHeight`. Sweeping the depth range is exact enough and only happens
    // when the swell changes. 0.05 m steps put the sampled peak within 0.1% of
    // the analytic crossover across the whole 0-3 slider.
    let ceiling = 1;
    for (let h = 0.05; h <= this.deepDepth; h += 0.05) {
      const shoal = Math.max(1, (this._shoalRefDepth / h) ** 0.25);
      const gain = Math.min(shoal, (this.breakerIndex * h) / (2 * this._deepAmplitude));
      if (gain > ceiling) ceiling = gain;
    }

    this._backdropDepth = -(this._deepAmplitude * ceiling + this.backdropClearance);
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
    }
    return this._axis;
  }

  /**
   * Still-water depth at a world position, in metres. 0 at the waterline.
   *
   * MUST stay identical to shoreDepth() in SHORE_GLSL, including the hand-rolled
   * tanh — `Math.tanh` is not guaranteed to agree with `(1-e)/(1+e)` to the last
   * bit, and this value decides where the board is allowed to be.
   */
  depthAt(x, z) {
    const axis = this.sectionAxis;
    const d = this.shoreLine - (x * axis.x + z * axis.y);

    const e = Math.exp(-2 * Math.max((d * this.beachSlope) / this.deepDepth, 0));
    let h = this.deepDepth * ((1 - e) / (1 + e));

    const t = x * -axis.y + z * axis.x;
    const bar = Math.sin(t * 0.0131 + 2.4) * 0.55 + Math.sin(t * 0.0074 + 5.1) * 0.45;
    h *= 1 - this.barAmount * bar * Math.exp(-h / this.barDepth);

    return Math.max(h, 0);
  }

  /** Metres of water between the waterline and a point. Negative up the sand. */
  shoreDistance(x, z) {
    const axis = this.sectionAxis;
    return this.shoreLine - (x * axis.x + z * axis.y);
  }

  /**
   * Bed elevation relative to still water — negative offshore, positive up the
   * dry beach. The dry side is steeper than the bed and flattens into dunes,
   * which is the shape a real berm has; the kink at the waterline is real too.
   */
  bedHeight(x, z) {
    const d = this.shoreDistance(x, z);
    if (d >= 0) return -this.depthAt(x, z);

    const e = Math.exp(-2 * ((-d * this.drySlope) / this.duneHeight));
    return this.duneHeight * ((1 - e) / (1 + e));
  }

  /**
   * The wave's character at a point: how much the shoaling bottom has grown it,
   * whether it's throwing a barrel, and how far past breaking it is.
   *
   * MUST stay identical to shoreProfile() in SHORE_GLSL. Gameplay reads this
   * copy to decide where barrels and whitewater are; if the two drift apart the
   * player rides a barrel that isn't drawn, or drowns in clean water.
   */
  sampleSection(x, z, target = { steep: 1, barrel: 0, white: 0, depth: 0 }) {
    const h = this.depthAt(x, z);

    const shoal = Math.max(1, (this._shoalRefDepth / Math.max(h, 0.05)) ** 0.25);
    const limit = (this.breakerIndex * h) / (2 * this._deepAmplitude);
    const b = shoal / Math.max(limit, 1e-4);

    target.depth = h;
    target.steep = Math.min(shoal, limit);
    target.barrel =
      THREE.MathUtils.smoothstep(b, 1.02, 1.14) * (1 - THREE.MathUtils.smoothstep(b, 1.32, 1.58));
    target.white = THREE.MathUtils.smoothstep(b, 1.15, 2.0);

    return target;
  }

  /**
   * Wave height (crest to trough) the beach can support at a point. This is what
   * "the wave" means once it's breaking — past the limit it is only ever as big
   * as the water is deep, so it thins out to nothing at the sand, and that decay
   * is what ends a ride.
   */
  waveHeightAt(x, z) {
    return 2 * this._deepAmplitude * this.sampleSection(x, z, this._section).steep;
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

    // Shoaling divided back out — see the long note in the vertex shader, which
    // does the same thing for the same reason.
    const fold =
      (1 - (tangentX * binormalZ - tangentZ * binormalX)) /
      (this.material.uniforms.uFoamReference.value * Math.max(section.steep, 0.05));
    const relativeHeight = THREE.MathUtils.clamp(height / Math.max(totalAmplitude, 0.001), -1, 1);

    // Whitewater wins outright over the whitecap term — see the note in the
    // vertex shader, which does the same thing with the same value, including
    // the gate on height within the wave.
    target.foam = Math.max(
      this._foamAt(fold, relativeHeight, waveHeight),
      section.white * THREE.MathUtils.smoothstep(relativeHeight, -0.15, 0.45),
    );
    target.barrel = section.barrel;
    target.steep = section.steep;
    target.white = section.white;
    target.depth = section.depth;

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
    // Same clock, so the swash on the sand keeps step with the surf that feeds
    // it — and so a paused game stops the waterline moving too.
    this.beachMaterial.uniforms.uTime.value = this._waveTime;

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
