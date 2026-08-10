# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # vite dev server, bound to the LAN, http://localhost:5173
npm run build          # production bundle into dist/
npm run preview        # serve the built bundle
npm run build:single   # build + scripts/bundle-single.mjs -> dist/ocean-surf.html (one file, ~640 kB)
```

There is no test runner, no linter and no formatter configured. Deployment is
Netlify (`netlify.toml`, auto on push); `.github/workflows/deploy.yml` publishes
to GitHub Pages but is `workflow_dispatch` only, deliberately, so it doesn't run
alongside every Netlify build.

## Verifying changes without a GPU

Nothing here can be rendered in this environment, so gameplay and physics claims
must be **measured by simulation in Node**, never eyeballed. The simulation-facing
modules — `Ocean`, `Surfboard`, `Rocks`, `Scoring`, `Run` — are pure of DOM and of
WebGL: they build `three` objects but never touch a renderer or a canvas, so they
import and step straight from Node. `Input`, `Hud`, `Menus`, `Spray`,
`CameraRig` and `postprocessing` do need a DOM or a renderer; substitute a stub
for `Input` (`{ horizontal, vertical, isDown(), wasPressed() }`) and skip the rest.

The pattern behind every measured number in `docs/design.md`:

```js
const ocean = new Ocean({ segments: 64, size: 400 });
const board = new Surfboard({ input: stubInput, ocean });
board.heading = Math.atan2(ocean.sectionAxis.x, ocean.sectionAxis.y);
board.position.y = ocean.sampleHeight(0, 0) + board.rideHeight;

for (let i = 0; i < 60 * 60; i++) {   // fixed 1/60 steps
  ocean.update(dt, i * dt, board.position);   // ocean first — see update order below
  board.update(dt, i * dt);
}
```

Bare `three` imports resolve from the importing source file, so a scratch script
can live outside the repo as long as it imports `src/**` by absolute path.
Statistics worth reporting are the ones the design doc already tracks: % riding
time, speed distribution, barrel entries per 5 min, wipeouts per run, score.

Runs are **deterministic**: `MainScene.reset()` rewinds the wave clock, and
identical input reproduces identical positions to the millimetre. That property
is load-bearing for A/B measurement and is easy to break — the wave coupling is
chaotic enough that advancing the board a single extra frame before a run begins
makes two runs diverge completely (measured 7,732 vs 9,157 points over 90 s).

## Architecture

`main.js` knows only about `MainScene`, `Loop`, `Run`, `Menus`, `Quality` and the
renderer. Everything world-shaped lives behind `MainScene`, which owns the
entities and fans one `update(delta, elapsed)` out to them.

**Update order in `MainScene.update()` is deliberate and commented in place.**
Ocean before board (buoyancy would trail the water by a frame), spray after the
board (it leaves the rail from this frame's pose), rocks tested after the board
has moved, camera last. Anything with an `update(delta, elapsed)` method can be
handed to `Loop.add()`.

Key couplings that span files:

- **One sun.** `Sky` owns `sunDirection`; the sky shader, the directional light
  and the ocean's analytic sky reflection all read it. Change elevation through
  `MainScene._setSunElevation()`, which also debounces the PMREM re-bake.
- **The ocean is the physics API.** `sampleHeight`, `sampleSurface` (height +
  analytic slope + the same foam value the shader paints), `sampleWaveFrame`
  (phase relative to the crest) and `sampleSection` (steepness / barrel-ness
  along the swell's direction of travel). `Ocean._foamAt()` mirrors the tail of
  the vertex shader's `main()` by hand — **retune the foam thresholds in the
  GLSL and you must change it there too**, or the board wipes out on water that
  looks clean.
- **The board is not self-propelled.** Speed comes from gravity down the wave
  face plus a pocket boost; the throttle only paddles. Any change that lets
  paddling out-run the wave removes the game. `paddlePower` past ~6 does exactly
  that.
- **Quality tiers** (`systems/Quality.js`) feed `oceanSegments`, `oceanSize`,
  `sprayCapacity`, `rockPool`, pixel ratio, bloom and shadows. `AdaptiveQuality`
  then claws back the most expensive thing first at runtime. The frame cost here
  is fragments, not triangles — pixel ratio and bloom are the only levers that
  matter.
- **Ocean LOD.** Lowering `segments` requires dropping the shortest waves with
  it (the shader keeps ≥4 samples per wave); below that they alias into crawling
  shimmer. Per-pixel `addRipples()` covers the lost scale.
- **Orientation is quaternions**, never Euler — at a 40° lean XYZ order
  cross-couples pitch and roll. For the same reason `CameraRig` takes an explicit
  `getHeading` callback rather than reading `rotation.y`.
- **Post-processing order** (`utils/postprocessing.js`): scene → bloom → grade →
  `OutputPass`. Everything the composer sees is linear HDR, which is what makes
  bloom pick out genuinely bright things; the grade therefore uses only
  operations safe on unbounded input (no `(c - 0.5) * contrast + 0.5`).

## Conventions

- No assets of any kind — no textures, audio files, fonts or CDN references.
  Geometry is built in code, sound is synthesised in `AudioEngine`. This is what
  makes `build:single` possible; keep it true.
- Comments explain *why*, and tuned constants cite the measurement that produced
  them. Match that: if you change a number, re-measure and update the number in
  the comment and in `docs/design.md`.
- `docs/design.md` is the real spec — the wave model, the core loop, tricks,
  scoring, wipeouts, and the reasoning behind each tuned value. Read the relevant
  section before touching physics, and keep it in sync afterwards.
- `main.js` disposes the whole world on Vite HMR; new listeners, timers or GPU
  resources need a matching teardown in `dispose()`.
