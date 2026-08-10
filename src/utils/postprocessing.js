import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * Colour grade.
 *
 * Runs *before* OutputPass, so it sees linear values that routinely exceed 1 —
 * sun glitter and foam are far brighter than white. Every operation here is
 * therefore one that behaves sensibly on unbounded input: multiplies, a power
 * curve, a lerp toward luminance. The usual `(c - 0.5) * contrast + 0.5` trick
 * is not one of those; in linear HDR it pivots around a value that isn't
 * middle grey and clips the highlights that make the bloom.
 */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uShadowTint: { value: new THREE.Color(0.86, 0.92, 1.08) },
    uHighlightTint: { value: new THREE.Color(1.12, 1.02, 0.9) },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.12 },
    uVignette: { value: 0.34 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;

    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = max(texel.rgb, 0.0);

      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));

      // Split tone: cool the shadows, warm the highlights. On a sunset that
      // reads as blue water under an orange sun rather than an orange wash.
      float weight = luminance / (luminance + 0.6);
      color *= mix(uShadowTint, uHighlightTint, weight);

      // Gamma-style contrast: safe above 1, unlike a pivot around 0.5.
      color = pow(color, vec3(uContrast));
      color = mix(vec3(luminance), color, uSaturation);

      vec2 offset = vUv - 0.5;
      color *= 1.0 - uVignette * dot(offset, offset) * 1.6;

      gl_FragColor = vec4(max(color, 0.0), texel.a);
    }
  `,
};

/**
 * Builds the render chain: scene -> bloom -> grade -> tone map.
 *
 * The ordering matters and is not arbitrary. Three disables a material's own
 * tone mapping whenever it renders into a render target, so everything the
 * composer sees is linear HDR — which is exactly what bloom needs to pick out
 * genuinely bright things rather than merely pale ones. `OutputPass` then does
 * the tone mapping and sRGB conversion once, at the very end. Putting a
 * tone-mapped image into the bloom instead gives you a flat, uniformly hazy
 * picture, because after tone mapping nothing is brighter than white any more.
 */
export function createComposer(renderer, scene, camera, options = {}) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Bloom renders at half resolution. It's a blur — the extra detail of a
  // full-resolution pass is invisible, and it is by a wide margin the most
  // expensive thing in the chain, being roughly ten of the thirteen fullscreen
  // passes.
  const bloomScale = options.bloomScale ?? 0.5;
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * bloomScale, size.y * bloomScale),
    options.bloomStrength ?? 0.42,
    options.bloomRadius ?? 0.55,
    // In linear space most of the scene sits well below 1, so a threshold near
    // it confines the glow to sun glitter, foam and spray.
    options.bloomThreshold ?? 0.9,
  );
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  composer.addPass(new OutputPass());

  bloom.enabled = options.bloom ?? true;

  return {
    composer,
    bloom,
    grade,
    render: (delta) => composer.render(delta),
    setSize: (width, height) => composer.setSize(width, height),
    setBloom: (enabled) => {
      bloom.enabled = enabled;
    },
  };
}
