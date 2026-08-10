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
a fixed surfer POV (the rider fades out of the way), `M` mutes, drag anywhere to look around, `H` toggles the ocean panel.

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

## Design notes

The physics, rendering and tuning live in [`docs/design.md`](docs/design.md) —
the update order, the Gerstner wave model, why the board gets its speed from the
wave rather than the throttle, the camera rig, tricks and scoring, and the
measurement behind each number.

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
  you. Over a session it doesn't show — see [Getting back
  up](docs/design.md#getting-back-up). The real skill it implies is
  timing the paddle to the arriving wave rather than holding it down.
- The board rides mid-face by nature, so both the lip and the barrel sit at the
  edge of where it naturally sits. Both windows are tuned against measured
  riding position rather than chosen on principle, and they'd need re-measuring
  if the board's handling changes.
- Free surf has no end condition by design; timed runs do.
- No physics engine or general collision — rocks are the only obstacle, tested
  as circles.
