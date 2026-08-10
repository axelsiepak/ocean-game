# Ocean Game

Browser-based 3D game scaffold: **Three.js** + **Vite**, with an atmospheric sky,
an animated ocean, and a surfboard you ride with a chase / POV camera rig.

## Running

```bash
npm install     # already done
npm run dev     # hot-reloading dev server on http://localhost:5173
npm run build   # production bundle into dist/
npm run preview # serve the built bundle
```

The dev server binds to `0.0.0.0` (`server.host: true` in `vite.config.js`), so
you can open it from another device on the same network.

**Controls:** `W` / `↑` paddle, `S` / `↓` drag a foot to slow, `A` `D` / `←` `→`
steer and carve, `Space` throws a trick. `C` switches between chase cam and
surfer POV, `M` mutes, drag anywhere to look around, `H` toggles the ocean panel.

## Hosting it

Everything is generated at runtime — no textures, no audio files, no fonts, no
CDN — so the whole game is one HTML file with nothing to fetch.

```bash
npm run build:single      # -> dist/ocean-surf.html, ~640 kB, self-contained
```

That file runs from anywhere: email it, drop it in Dropbox or Discord, or open
it straight off disk. No server needed.

**For a URL your friends can just click:**

- **GitHub Pages** — push to `main` and the included workflow does it.
  One-time setup: repository *Settings → Pages → Source: GitHub Actions*.
  Lands at `https://<you>.github.io/<repo>/`.
- **Netlify / Vercel / Cloudflare Pages** — connect the repo; build command
  `npm run build`, publish directory `dist`. Or drag `dist/` onto
  [Netlify Drop](https://app.netlify.com/drop) with no account at all.
- **itch.io** — zip the contents of `dist/` and upload as an HTML5 project.
  This is the one worth using if you want feedback from strangers rather than
  friends.

`base: './'` in `vite.config.js` keeps asset paths relative, so a build works
from a subdirectory without being told the repository name.

**Testing on your phone right now:** `npm run dev` already binds to your LAN
(`server.host: true`), so any device on the same wifi can open
`http://<your-laptop-ip>:5173`.

## Layout

```
index.html            entry document
vite.config.js        dev server + build config
src/
  main.js             bootstraps renderer, scene and loop; handles HMR teardown
  style.css
  scenes/
    MainScene.js      owns the world and the per-frame update order
  systems/
    Quality.js        tiers + adaptive frame-rate guard
    Run.js            game state, run clock, results
    Scoring.js        score, combo, multiplier
    AudioEngine.js    synthesised surf, splash and whoosh
  entities/
    Sky.js            sky dome, sun light, environment map
    Ocean.js          Gerstner-wave water + horizon backdrop
    Surfboard.js      the player: wave-driven surfing, carving, banking
    Spray.js          pooled particle spray thrown off a buried rail
    Rocks.js          hashed, endless obstacle field
    Surfer.js         low-poly rider, parented to the board
    Player.js         boat, now anchored scenery (keeps its controls if wanted)
  utils/
    renderer.js       WebGL renderer setup + resize handling
    Loop.js           rAF loop; calls update(delta, elapsed) on registered objects
    CameraRig.js      chase + POV cameras, smoothing, shake
    postprocessing.js bloom + colour grade + tone map chain
    ControlPanel.js   dependency-free slider panel for live tuning
    Hud.js            speed, score and wipeout readout
    Menus.js          main menu, pause, results
    Stats.js          frame profiler overlay (F)
    TouchControls.js  swipe to steer, tap to trick
    input.js          keyboard state as axes
```

### How it fits together

Anything with an `update(delta, elapsed)` method can be handed to `Loop.add()`.
`MainScene` is itself such an object — it fans the update out to its entities in
a deliberate order (player moves → world re-centres on the player → camera
reacts), so nothing renders a frame behind.

The ocean is a single plane that slides along with the player, snapped to its own
vertex grid. Its `uOffset` uniform re-anchors the wave phase to world space, so
the swell stays put while the mesh follows you — you get infinite-looking water
out of ~37k vertices.

The sun is defined once, in `Sky`. The sky shader, the directional light, and the
ocean's specular highlight all read the same `sunDirection` vector, so changing
`elevation` / `azimuth` in `MainScene` moves all three together.

## Performance

**Press `F` for the profiler** — fps, frame time, draw calls, triangles, pixel
ratio, and anything adaptive quality has given back. It reads `renderer.info`,
so the draw and triangle counts are what three actually submitted rather than an
estimate.

### Where the time actually goes

Measured statically before optimising: 101,530 triangles across 28 draw calls.
That is nothing — no laptop GPU built this decade will notice it. The ocean's
vertex shader runs about 0.6M trig calls a frame, which is likewise noise.

The cost is **fragments**. There are thirteen fullscreen post-processing passes,
and at device pixel ratio 2 on a 1080p screen that came to roughly **108M
fragment-passes per frame**. So the levers, in order of what they're worth:

1. **Pixel ratio** — every fullscreen pass costs its square. Capped at 1.5.
2. **Bloom** — about ten of those thirteen passes. Now rendered at half
   resolution, which costs a quarter as much and looks identical, because it's
   a blur.
3. The ocean's per-pixel work.
4. Vertex count and draw calls — worth doing, worth almost nothing.

| | before | low | medium | high |
| --- | --- | --- | --- | --- |
| Triangles | 101,530 | 27,810 | 49,090 | 84,730 |
| Draw calls | 28 | 22 | 22 | 22 |
| Pixel ratio | 2 | 1 | 1.25 | 1.5 |
| Fragment-passes/frame | ~108M | ~6M | ~18M | ~26M |

**4.2x less fragment work at the top tier**, and gameplay is untouched — 98%
riding time at all three, with the low tier carrying a 2.08 m swell against
2.19 m.

### Ocean level of detail

Lowering the segment count coarsens the grid, and a grid can only carry waves
longer than a few times its spacing — below that they alias into crawling
shimmer rather than adding detail. So `Ocean` **drops its shortest waves when
the grid can't resolve them**, keeping at least 4 samples per wave at every
tier, and lets the fragment shader's ripples cover that scale per-pixel, which
is what they were added for. Detail degrades instead of breaking.

The grid stays uniform on purpose. A radially graded mesh would put vertices
where they matter, but the ocean slides with the player and snaps to whole quads
so wave silhouettes stay stable — non-uniform spacing breaks that property and
the shimmer comes back.

### Instancing

The rock field is one `InstancedMesh` rather than a mesh per rock. The saving is
modest — it was 7 draws of a 28-slot pool — but it costs nothing and stops the
count growing with the pool size.

### Ensuring the frame rate

No fixed setting can promise 60fps on hardware you can't see, so it's enforced
rather than assumed. `AdaptiveQuality` watches a rolling *median* frame time (a
mean gets dragged around by single hitches) and, after 2.5 s over an 18 ms
budget, gives back the most expensive thing first: bloom, then pixel ratio, then
shadows, then pixel ratio again. The starting tier is a coarse guess from core
count and pointer type that the adaptive pass is expected to correct within a
few seconds.

## Runs and menus

`systems/Run.js` holds the state — menu, playing, paused, results — and the run
clock. Until now there was no such thing as a run: the loop started surfing
immediately and never stopped, which is fine for a sandbox but leaves nothing to
put on a results screen.

- **Start run** is timed (120 s by default). **Free surf** has no clock; end it
  from the pause menu.
- **Esc**, **P** or the on-screen button pauses. Pausing genuinely stops the
  world; the main menu doesn't, so it plays over a living sea rather than a
  frozen frame.
- **Results** show the score, the best single trick, longest combo, tricks
  landed, barrel time and wipeouts. Best trick is the biggest single *payout*,
  so it reflects the combo it was landed in — a 360 deep in a varied run beats
  the same 360 cold.

`MainScene.reset()` restores the world in place rather than rebuilding it:
regenerating a 49k-vertex ocean and re-baking the environment map on every
restart would be a visible stall for no benefit. It also rewinds the wave clock,
so every run meets the same sequence of steep sections and barrels from the same
start — verified exact, with three runs on identical input producing identical
scores and positions to the millimetre.

That exactness needed care. Seating the board on the water by running one update
advances it a frame before the run begins, and the wave coupling is chaotic
enough that a single frame is the difference between two runs matching and
drifting apart completely (measured 7,732 against 9,157 over 90 s). It now sets
the height directly instead.

## Touch and small screens

`utils/TouchControls.js`. One gesture does both axes: where your thumb sits
relative to where it landed is the stick — sideways steers, up paddles, down
drags a foot. A touch that ends quickly without travelling is a tap, and taps
throw a trick. It feeds the same axes the keyboard does, summed and clamped, so
nothing downstream knows which is driving and both work at once.

The camera's orbit drag would otherwise fight the steering, so on a coarse
pointer the rig ignores touch entirely and orbit stays a mouse gesture.

Layout adapts under 640 px — HUD scales down, the dev panel hides, and menu stats
go single-column. Buttons are 48 px tall, comfortably past the 44 px touch
target. There's also a short-viewport rule for landscape phones.

## Sound

`systems/AudioEngine.js`. **There are no audio files and none are needed** —
surf, splash and whoosh are all shaped noise, which the Web Audio API generates
far more compactly than any download and with no loading to wait on. Two noise
buffers are built once at start-up and everything else is filters and envelopes.

- **The sea** is brown noise — white noise through a leaky integrator, which is
  what makes it read as surf rather than as static — under a lowpass, with a
  0.07 Hz oscillator wired into its gain so the sea breathes instead of sitting
  at a constant level. A brighter highpassed layer sits on top for foam.
- **The whoosh** is white noise through a bandpass. Speed gives it body (gain
  and centre frequency, 320–1230 Hz across the speed range) and a hard turn
  gives it bite; the two sum to a capped 0.3.
- **A splash** is a noise burst with a lowpass sweeping from 7 kHz down to 350.
  The downward sweep is what makes it water landing rather than a burst of
  static. Fired on wipeouts and on trick landings, at different weights.
- **In the barrel** the mix changes character: the surf lowpass drops from 900 Hz
  to 320 and its gain goes up, so the sea becomes an enclosed roar. It's the one
  moment the soundscape tells you something the visuals don't.

`M` mutes, ramped rather than assigned — a gain that jumps to zero clicks.

Browsers refuse to start audio before the user has interacted with the page, so
no context is created until the first pointer or key event; everything is inert
and safe to call until then.

## Look

**Sunset.** A low sun (elevation 0.055) with heavy Rayleigh scattering for the
reddening, a warm key light against a cool sky bounce. Most of what sells the
time of day is that contrast rather than the sky colour itself. The ocean's
palette is authored against the sky it reflects, so both moved together — the
analytic sky reflection in the water shader shares the sun direction with the
real dome, which is what keeps them in step.

**Post-processing** — `utils/postprocessing.js`, chained scene → bloom → grade →
tone map.

The ordering is not arbitrary and is the one thing worth understanding here.
Three disables a material's own tone mapping whenever it renders into a render
target (`WebGLRenderer`, the `currentRenderTarget === null` check), so
everything the composer sees is **linear HDR**. That's exactly what bloom needs:
it can pick out things that are genuinely bright — sun glitter, foam, spray —
rather than merely pale. `OutputPass` then applies tone mapping and the sRGB
conversion once, at the very end. Feed bloom a tone-mapped image instead and you
get a flat, uniformly hazy picture, because after tone mapping nothing is
brighter than white any more.

For the same reason the colour grade only uses operations that behave on
unbounded input: multiplies, a power curve, a lerp toward luminance. The usual
`(c - 0.5) * contrast + 0.5` is deliberately absent — in linear HDR it pivots
around a value that isn't middle grey and clips the very highlights the bloom
feeds on. The grade is a split tone (cool shadows, warm highlights), a gentle
gamma contrast, a saturation lift and a vignette.

Tune via `bloomStrength` / `bloomRadius` / `bloomThreshold` on `createComposer`,
and the `grade.uniforms`. Bloom is the expensive pass; drop its strength to 0 or
remove the pass entirely if the frame rate needs it.

**The rider** — `entities/Surfer.js`, parented to the board's group, so every
rotation the board already does carries it for free. All it adds is what a rider
does that a board doesn't: counter-lean to stay more upright than the deck
(measured to lean opposite the board's bank), compress through hard turns, and
fold up in a wipeout. Arms out for balance is the single strongest cue that this
is a person riding rather than an object glued to a plank.

**Spray** now has three sources sharing one 700-particle pool: the carve spray
off a buried rail, a continuous wake off the tail scaled by speed, and one-off
bursts on landings and wipeouts. Measured peak in play is about 100 particles,
252 under sustained carving — plenty of headroom.

## The water

Everything below is one `ShaderMaterial` in `entities/Ocean.js`.

**Geometry — Gerstner waves.** Four waves are summed in the vertex shader. Unlike
a sine, a Gerstner wave moves each point in a *circle*, bunching points toward the
peaks: that's what produces sharp crests over broad troughs instead of a rolling
sine. Each wave's speed comes from the deep-water relation `c = sqrt(g/k)`, so
long swell outruns short chop on its own.

The shader accumulates the two surface derivatives as it sums, giving exact
analytic normals — no finite differencing, no normal map.

Wavelengths are all kept above ~2x the vertex spacing. Shorter waves can't be
resolved by the grid and turn into crawling shimmer, so sub-grid detail is added
per-pixel by `addRipples()` instead (three cosines, faded out with distance).

**Foam.** The signal is the determinant of the horizontal displacement's
Jacobian, which the vertex shader gets almost free from the derivatives it's
already accumulating. It sits at 1.0 on flat water and falls as neighbouring
points get squeezed together — physically, where a wave is about to break. That
puts foam on the steep leading face of a crest, which is where it belongs, rather
than ringing every peak the way a height threshold does.

It's scaled against a *fixed* reference steepness rather than the live settings,
so raising `waveHeight` genuinely produces more whitecaps. The fragment shader
then breaks the mask up with two octaves of drifting value noise so foam reads as
scattered bubbles instead of a painted band.

The `foamAmount` response curve is calibrated against the measured distribution
of that fold value — quarter steps on the slider give roughly 2% / 9% / 20% / 32%
surface coverage. (Real open ocean is nearer the low end; the default of 0.5 is
tuned to be clearly visible rather than strictly accurate.)

**Shading.** Schlick fresnel using water's real 2% normal-incidence reflectance —
at a distance, nearly all the ocean's brightness is this term. It mixes between a
depth-tinted body colour and a reflected sky. Sub-surface scattering brightens
crests when you look toward the sun through them, and a Blinn-Phong lobe weighted
by fresnel gives the sun glitter.

The reflected sky is computed analytically (horizon-to-zenith gradient plus the
sun's disc and glow) rather than sampled from the environment map. It's driven
from the same sun direction as the real sky, so the two stay in step. To sample
the actual PMREM map instead, set `material.envMap` to `scene.environment` —
three only injects the `CUBEUV_*` defines that `textureCubeUV()` needs when that
property is set — then `#include <cube_uv_reflection_fragment>` and replace
`sampleSky()` with `textureCubeUV(envMap, reflected, 0.05).rgb`. That picks up
real sky detail at the cost of coupling the shader to three's program internals.

### Tuning it

Press `H` for sliders, or set any of these at construction / at runtime:

| Property | Default | Effect |
| --- | --- | --- |
| `waveHeight` | 1 | Amplitude, and crest sharpness with it. Above ~3 the summed steepness exceeds 1 and crests fold through themselves. |
| `waveSpeed` | 1 | Rate the wave clock advances. 1 is the physically correct speed. |
| `choppiness` | 1 | Crest sharpness independent of height. 0 gives rounded sine swell. |
| `foamAmount` | 0.5 | 0 for no whitecaps, 1 for foam on most crests. |
| `rippleStrength` | 1 | Strength of the per-pixel sub-grid ripples. |

```js
ocean.waveHeight = 2.2;   // heavy weather
ocean.waveSpeed = 0.6;    // slow, ponderous swell
ocean.foamAmount = 0.8;
```

`waveSpeed` is deliberately not a uniform. The wave clock is accumulated as
`time += delta * waveSpeed`, because multiplying total elapsed time by the speed
would snap the entire sea to a new phase the moment you moved the slider.

Colours (`deepColor`, `shallowColor`, `scatterColor`, `zenithColor`,
`horizonColor`, `foamColor`) are constructor options. The defaults are authored
for a low-to-mid sun; if you park the sun near the zenith you'll want to retune
`zenithColor` / `horizonColor` to match the sky.

## The surfboard

`entities/Surfboard.js`. The board is **not self-propelled** — that's the whole
design. Most of its speed comes from gravity pulling it down a wave face, and
the throttle only paddles. Point down a steep face and you accelerate; sit in a
trough and you stall. Catching a wave and then *letting go of W* is the fastest
way to travel, and the ocean's own `waveHeight` is effectively the difficulty
dial, because it steepens the faces.

### The core loop

Four things decide how fast you go, and all of them are about *where on the wave
you are* rather than which key you hold.

**Down the face.** Gravity along the wave slope. Steep face, speed; trough,
nothing.

**The flats.** Off the face the board comes off its plane and speed bleeds away
(`flatDrag`). This is what makes the face worth finding: on dead-flat water
paddling flat out tops out at **5.1 m/s**, against **11.0** with the drag
removed. On a face it costs almost nothing (11.0 vs 11.1) — the penalty is
specific to flat water, not a general tax.

**The pocket.** Just ahead of the crest, on the steep part of the advancing
face, `Ocean.sampleWaveFrame()` locates you within the dominant wave — `offset`
is your phase measured from the crest, positive ahead of it. The pocket sits at
1.15 rad, a little above the steepest point, up toward the curl. Sitting there
adds `pocketBoost` on top of gravity.

The measured effect is large: **coasting in the pocket with no input at all
sustains 11.1 m/s indefinitely**, where coasting used to bleed down to ~6. That
is the game — find the spot, stop paddling, stay there.

**Trimming.** Because holding the pocket at an angle needs `v·cos(θ) = c`, you
can beat the wave's own speed by angling across the face. This wasn't designed
in, it falls out of the model: 15° off the wave direction sustains **11.4 m/s**
against 11.1 straight, with better pocket engagement. Past 30° you lose the wave
and drop to ~3.

**Riding the surface.** Position comes straight from `ocean.sampleSurface()`,
which returns height and the analytic slope in one pass. Pitch and roll come
from projecting that slope onto the board's own axes, so the nose drops going
down a face and the board rolls with the wave under it. Both are eased rather
than snapped, so the board carries a little inertia.

**Steering and carving.** Grip arrives with speed — a board with no water moving
over it barely turns. Turn rate is capped by `maxLateralAccel`, the hardest
sideways push the fins can hold, so the radius *opens up* as you go faster
(measured: 5.9 m at 3 m/s, 12.2 m at 9 m/s) instead of collapsing to something
no board could hold. A sustained full-lock carve keeps about 70% of straight-line
speed, so carving is a real decision.

**Banking** falls out of the physics rather than being animated: the lean for a
banked turn is `tan θ = v·ω/g`, so the board leans harder the faster it carves,
and the lateral-acceleration cap makes it saturate near 40° on its own.

Orientation is composed as quaternions, not Euler angles — at a 40° lean the XYZ
Euler order cross-couples pitch and roll and the board wobbles. For the same
reason `CameraRig` takes an explicit `getHeading` callback: recovering a yaw from
a rolled quaternion cross-couples the axes and swings the camera with the lean.

### Spray

`entities/Spray.js` keys off the surfboard's `carve` — the lateral acceleration
the fins are holding — so spray appears exactly when the board is working hard
enough to throw water, and never while paddling in a straight line. Emission
ramps from nothing at 3.5 m/s² to full rate at 10.

Droplets leave the *buried* rail near the tail (which side that is comes from the
sign of the bank), throwing up and out with some of the board's own velocity
carried over, then fall under gravity and air drag.

It's a fixed pool of 400 points in a ring buffer, simulated on the CPU. Nothing
is allocated per frame and the oldest droplet is always the one recycled. At full
carve about 190 are alive at once, so there's plenty of headroom.

Particles are never tested against the water surface — they're depth-tested
against it. The ocean is opaque, so droplets that fall back through it are hidden
for free.

Tune via constructor options: `rate`, `threshold`, `fullCarve`, `capacity`,
`size`, `color`, `opacity`, `drag`, `minLife` / `maxLife`. `spray.emit(count,
origin, velocity)` is public if you want bursts from anything else — a wipeout,
the boat's bow, a breaching whale.

### Tuning it

| Property | Default | Effect |
| --- | --- | --- |
| `paddlePower` | 4.5 | Paddle acceleration, m/s². Past ~6 it drowns the wave out and the surfing goes out of the game. |
| `slopeResponse` | 4 | How hard the wave face pulls. 1 is literal gravity. The single knob that decides jet ski vs. surfboard. |
| `turnRate` | 2.2 | Yaw rate at full grip, rad/s. |
| `maxLateralAccel` | 11.8 | Hardest sideways push the fins hold, m/s². Sets how the turn radius opens with speed. |
| `carveDrag` | 0.25 | Speed cost of carving. 0 for free turns. |
| `railGrip` | 4.5 | How fast the velocity swings into line behind the board. |
| `gripSpeed` | 6 | Speed at which the rails bite fully, m/s. |
| `bankScale` / `maxBank` | 0.8 / 0.9 | Lean scale and limit. |

## The camera

`utils/CameraRig.js`. Two cameras, cross-faded rather than cut between: the chase
pose and the POV pose are both computed every frame and blended by one number, so
switching modes (`C`) is just easing that number and the transition is smooth for
free. Each mode keeps its own drag state, so orbiting the chase cam doesn't leave
the POV staring sideways after a switch.

**Chase** sits behind and above, loosely damped (6/s position, 10/s rotation) so
it swings through turns rather than tracking rigidly. It's clamped above the
water via a `getMinHeight` callback — the ocean is opaque, so a camera that dipped
into a trough would black out the screen.

**POV** rides just behind the nose at about head height, near-rigidly (40/s), and
inherits a fraction of the board's pitch and lean — 40% of the bank rolls the
horizon, which is most of what sells a carve from on board. A surfer's head stays
far more level than the deck, so taking all of it would be sickening.

Rotation is **slerped toward a look-at basis** rather than snapped with `lookAt()`
every frame. That's what produces the lag through a turn (measured: peaks around
2.9°/frame, no discontinuities).

### Shake

Trauma-based, with two inputs. `addTrauma(x)` is a decaying impulse for events;
`setSustained(x)` is a continuous level the caller sets each frame. Both feed a
squared falloff so shake drops away sharply instead of lingering as a wobble.
Offsets come from summed sines rather than random values, so it stays smooth
frame to frame instead of buzzing.

Shake is applied as a **pure overlay** on top of a separately-tracked smoothed
pose. Folding it into the smoothed state instead — the obvious way — means each
frame damps toward an already-shaken position, so the jolt feeds back on itself
and grows well past its nominal amplitude (measured 1.2 m against an intended
0.64 m) while dragging the camera off its line.

Measured magnitudes against an identical un-shaken rig:

| Source | Displacement | Rotation |
| --- | --- | --- |
| Turning hard at speed | 0.11–0.14 m | 0.9–1.4° |
| Wipeout | 0.19 m | 2.2° |

Scale both with `shakeTranslation` / `shakeRotation`. Note that shake keys off
lateral g-force, the same quantity that sets the lean angle — so a fast committed
turn shakes more than a slow full-lock one, because it's pulling more g. Going
straight pulls none, so straight-line riding is perfectly steady.

## The wave line

The swell is no longer uniform. `Ocean.sampleSection()` modulates steepness and
"barrel-ness" along an axis, giving an endless procedural run of sections:
mellow shoulders, steep faces, and barrels. It's summed sines rather than value
noise so the GLSL and JS versions agree bit for bit, it needs no texture, and it
runs forever in both directions with no seed to store.

**The axis is the swell's direction of travel, not its crest.** That's the
non-obvious part, and getting it wrong the first time made the whole feature
invisible: ride a wave and your position *across* the crest barely changes, so
sections laid out along the crest never arrive — measured 0 barrels in 400 s.
Laid out along the direction you travel, a new section arrives every few
seconds. It's also what real waves do, since a swell shoaling toward the beach
steepens and starts to barrel as it goes.

Measured: steepness runs **0.70x to 1.69x**, and barrels cover **14.3%** of the
line.

**Barrels** are made by driving choppiness hard (`barrelChop`), not by making the
wave taller. Pushing `choppiness * steepness` past 1 is what makes a Gerstner
crest genuinely overhang instead of merely leaning — the same self-intersection
the rest of the code is careful to avoid, used deliberately.

You're **in** the barrel when a barrelling section arrives while you're riding
and holding a tight line. The window is set just tighter than where the board
naturally sits (measured median phase 1.70, p10 1.52, p90 1.83), so riding
better than average is what gets you tubed. Tucking deliberately deeper isn't
the move — steering up the face scrubs the speed that keeps you in the pocket at
all — so the skill is the core one: hold position while the section runs through.

It pays 70 pts/s against 12 for ordinary wave time, boosts your speed, and
exempts you from the whitewater wipeout. That last one is not a nicety: a
barrelling section is drowning in foam by construction, so without it the best
thing in the game would be an instant wipeout.

Measured on a clean ride: **23 barrel entries and 20 s of tube time per 5
minutes**, at 6.7% of riding time.

## Getting back up

Everything that ends a ride leaves you slow and turned around, and for a while
that was close to unrecoverable — paddling was *strictly worse* than doing
nothing (measured: 39% riding time when never paddling, 2% when paddling
whenever not riding).

The cause turned out to have nothing to do with speed. **The tumble spins the
board about 157 degrees**, so it stands up facing back out to sea, and paddling
from there put thrust at −92% along the wave — actively driving you away from
the wave you were trying to catch. Two fixes:

**The nose comes back round.** During the grace window after getting up, the
heading eases back toward the swell (`recoverySteer`). Touching the steering
overrides it immediately, so it never fights you.

**The paddle aims at the pocket, not just forward.** Thrust now tapers as the
board's speed *along the swell* approaches a target, and that target shifts by
the shortest way round to the pocket — so the paddle drives hard when forward is
the way there, and gets out of the way when the shorter route is to let the wave
roll through and come to you. Below `paddleAssistSpeed` it always bites, so you
can still paddle from a standstill at any phase.

This also matches the design everywhere else here: the paddle is for catching a
wave, not for going fast once you're on one.

Measured over 5 minutes with rocks live, all three paddle policies now come out
the same — **95–96% riding time**, same score, same wipeout count:

| Policy | Riding | Before |
| --- | --- | --- |
| Never paddle | 96% | 39% |
| Hold paddle always | 95% | — |
| Paddle when not riding | 95% | 2% |

## Rocks

`entities/Rocks.js`. There is no list of rocks anywhere — **the world is a
hash**. Every grid cell either holds one or doesn't, decided by hashing its
coordinates, so the field is endless in every direction, identical every run,
and costs no memory. A pool of 28 meshes is moved to whichever rocks are near.

Height matters in the hit test, so **clearing a rock with an air off the lip
works** — which makes tricks a way through a rock field, not just a way to
score. Verified: at water level a hit, 1.2 m up still a hit on the largest
rocks, 3 m up clean.

Density is deliberately sparse — about **one strike per five minutes** of
riding. See below for why.

## Tricks

`Space`. What you get depends on where you are and what you're holding:

| Where | Steer | Trick | Points |
| --- | --- | --- | --- |
| At the lip (`\|offset\| < 0.6`) | — | Air | 150 |
| At the lip | right | 360 Spin | 260 |
| At the lip | left | Alley-oop | 320 |
| Anywhere | right | Snap | 90 |
| Anywhere | left | Cutback | 110 |
| Anywhere | — | Ollie (small hop) | 40 |

Trick type keys off the **steer direction**, not off the board's angle to the
wave. The obvious "is this turning into the wave or away from it?" test is
degenerate exactly when it matters: riding well means sitting nearly *on* the
wave's line, and from there a turn either way leads away from it equally. Steer
direction is also the thing a player can actually aim, which matters when the
scoring pays for variety.

**Getting air.** The lip is the crest, and the board naturally rides at phase
~1.7 — mid-face. Reaching the lip means easing up the face, which costs most of
your speed (measured arrival: 3–5 m/s) and walks you toward falling off the
back. That approach *is* the difficulty of an air.

The pop is largely arcade (`basePop`), and it has to be: a crest is by definition
where the surface's vertical motion is near zero, so the real climb into a lip is
only ~0.5 m/s — nowhere near enough to launch a board. `climbRate` and speed add
to that baseline rather than carrying it. The result is about **1.2 m of air over
1.05 s**.

Rotations are paced to finish at 78% of the predicted airtime (`spinPace`), not
100%, because the water rises and falls under you and real airtime never matches
the flat-water prediction. Finishing early means the board is squared up and
*waiting* at touchdown. At the defaults a rotation lands cleanly about 9 times in
10; push `spinPace` toward 1 if you want the landing itself to be the gamble
rather than the approach.

## Scoring

`systems/Scoring.js`. Three sources, deliberately in tension:

- **Tricks** pay a lump sum, but the good ones need lip position you have to
  give up speed to get.
- **Wave time** pays 12 pts/s while genuinely `riding` — the same judgement the
  board uses — so surviving is worth something even if you never press Space.
  Paddling the flats earns nothing.
- **Combos** multiply both and lapse after 3.5 s, so the clock is always running.

The multiplier grows on **distinct** tricks as well as on count
(`1 + 0.5·combo + 0.5·(distinct−1)`, capped at x10), plus a one-off +75 the first
time each trick appears in a run. Measured: six different tricks scores **4,590**
against **1,290** for the same trick six times — a **3.6x** advantage for variety.

A wipeout — any of the four — takes the whole multiplier with it. The longer the
run, the more there is to lose.

## HUD

`utils/Hud.js`. Top left: score, the live combo multiplier with a draining timer
bar, and a banner naming the last trick and what it paid. Bottom left: current
speed, a meter, and a wipeout badge with a recovery bar that fills as the board
gets back up.

A green **pocket meter** appears when you're in the sweet spot and scales with
engagement, so the spot is something you can hunt for rather than guess at. The
wipeout badge names the cause — "Lost the rail", "Off the back", "Caught inside"
— so a failure teaches you something.

The meter carries a tick at `wipeoutMinSpeed`, and the readout goes amber past
it. That's what makes the HUD worth having — past the mark, slamming full lock
washes you out, so the speed number becomes something you steer by rather than
trivia. The tick hides itself if wipeouts are disabled.

It reads the board's public state and writes to the DOM only when a displayed
value actually changes (bar widths rounded to whole percent). Measured over an
hour of simulated play that's 0.51 DOM writes per frame against ~6 unthrottled.

## Wipeouts

Three ways to go down. `onWipeout(board, reason)` fires once per event and
`board.wipeoutReason` holds the cause; `wipeoutsEnabled: false` removes all of
them. In every case the board spins the way it was going, loses steering
authority and most of its rail grip, drags heavily, and recovers over 1.6 s.

**`rail` — lost the rail.** Demanding far more turn than the fins can hold while
genuinely up to speed: full lock above 11.3 m/s. That number sits against the
measured speed distribution — riding the swell is 11.0–11.8, a sustained carve
never exceeds 10.5 — so you can only wash out at full flight, and a wipeout can
never cause another, having cost you the speed needed for one.

**`back` — off the back.** The wave moves at `phaseSpeed` (11.0 m/s for the
dominant swell). Ride slower and it overtakes you: your phase slides back toward
the crest and past it. Once you're behind the crest the wave has gone without
you. Braking out of the pocket drops you off the back in about 3 s.

Only applies while `riding` — set once you've settled into the pocket with speed
under you. Turning off the wave clears it, so **kicking out deliberately is
always safe**; only failing to keep up is punished.

**`rock` — hit a rock.** Struck a rock at or below its waterline.

**`landing` — buried a rail.** Touched down with a rotation still part-finished.
Rare at the defaults (see `spinPace`).

**`foam` — caught inside.** `sampleSurface()` returns the same foam value the
shader paints with, so the whitewater that grabs you is whitewater you can
actually see. It takes a sustained dose (`foamGrabTime`, 1.2 s) — clipping the
edge of a whitecap shouldn't end a ride. Effectively a big-surf hazard: zero
wipeouts per 120 s up to waveHeight 2, about 3 at waveHeight 3.

Note that `Ocean._foamAt()` deliberately mirrors the tail of the vertex shader's
`main()`. If you retune the foam thresholds in the shader, change them there too,
or the board will start wiping out on water that looks perfectly clean.

A nose-dive ("pearling") trigger off `pitch` and speed would be the natural
fourth to add.

## Extending it

- **Real art:** replace `Surfboard._buildMesh()` (or `Player._buildMesh()`) with
  a `GLTFLoader` call. The physics and camera rig work off `.group` and don't
  care what's inside it. There's no rider on the board — a rigged character is
  the obvious next thing, and `bank` / `pitch` / `carve` are exposed on the
  surfboard to drive its lean.
- **Driving the boat again:** it's still a complete entity, just built without
  an `input` in `MainScene`. Hand it `this.input` and point `CameraRig` at it to
  swap back — the rig falls back to reading `rotation.y` when no `getHeading` is
  supplied, so it works unchanged.
- **Floating other things:** call `ocean.sampleHeight(x, z)`. It mirrors the
  shader's vertical term, including `waveHeight`, and reads the ocean's own wave
  clock so buoyancy stays glued to the surface when `waveSpeed` changes.
  (Gerstner waves also displace horizontally, so it's an approximation, not an
  exact surface intersection — fine for buoyancy, not for precise collision.)
- **More scenes:** add them under `src/scenes/` with the same
  `constructor(renderer)` / `update()` / `dispose()` shape and swap which one
  `main.js` instantiates.

## Known limitations

- The ocean uses a custom `ShaderMaterial` with hand-written lighting, so it does
  **not** receive shadows. The boat self-shadows, but casts nothing onto the
  water. Wiring that up means integrating three's shadow chunks into the ocean
  shader.
- No screen-space reflections or refraction — the water is opaque, so there's no
  hull visible below the waterline and no wake.
- The surface is ~49k vertices. Drop `Ocean`'s `segments` on weaker GPUs; raise
  the shortest wavelengths to match if you do, or the swell will alias.
- Paddling to recover is now reliable but still marginally slower than simply
  coasting (10.2 s against 8.0 s to get riding again). That difference is
  inherent rather than a bug: paddling raises your speed, which *lowers* your
  speed relative to the wave train, so the next pocket takes longer to reach
  you. Over a session it doesn't show — see below. The real skill it implies is
  timing the paddle to the arriving wave rather than holding it down.
- The board rides mid-face by nature, so both the lip and the barrel sit at the
  edge of where it naturally sits. Both windows are tuned against measured
  riding position rather than chosen on principle, and they'd need re-measuring
  if the board's handling changes.
- Free surf has no end condition by design; timed runs do.
- No physics engine or general collision — rocks are the only obstacle, tested
  as circles.
