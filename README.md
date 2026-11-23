# Kinetic Courier

A first-person, momentum-based grapple-hook time trial across a brutalist rooftop course. Built with **TypeScript, Vite and Three.js**. There are no model or texture files: geometry is procedural and every texture is drawn on a canvas at startup.

Run ten concrete slabs, swing the 20 m gaps on a spring-damper rope, wall-run the shortcuts, hit the boost pads, and stay ahead of the EMP drones. Your best run is saved and replays as a ghost.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit + production bundle
npm run typecheck
```

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Run |
| Mouse | Look (click to capture the pointer) |
| `Space` | Jump (hold for height). While hooked: launch off the rope |
| Hold `Left Mouse` | Grapple toward the aimed hook or surface. Release to let go |
| `Shift` / `Right Mouse` / Wheel | Reel in while hooked |
| `C` or `Q` | Slide |
| Forward into a wall | Wall-run. `Space` to wall-jump |
| `P` / `Esc` | Pause |
| `R` | Instant restart |
| `F1` | Debug telemetry and 3D helper lines |
| `M` | Mute |

The orange hooks have aim assist (the cone widens with distance). Any solid surface within 42 m can also be grappled.

## Architecture

```
src/
  core/      EventBus.ts, HFSM.ts, math.ts
  physics/   Collision.ts          sphere-vs-AABB resolution, ray / slab tests
  game/      pure simulation, no Three.js, DOM or WebAudio
    World.ts        time-trial state machine, gates, pads, grapple targeting
    Player.ts       courier + the HFSM
    ai/Drone.ts     Reynolds steering + velocity-leading interception
    Course.ts       procedural course generator
    config.ts       constants + live-tunable `Tuning`
  replay/    Replay.ts             recorder, ghost player, JSON validate / persist
  render/    Renderer.ts           Three.js scene, camera rig, debug lines; Textures.ts
  audio/     SoundEngine.ts        procedural WebAudio
  ui/        Input.ts, Hud.ts, SpeedFx.ts, DebugPanel.ts
  Game.ts    composition root + fixed-timestep loop
```

`src/game` and `src/physics` never import Three.js, so the whole simulation can be driven headlessly, for example by calling `world.step(1/120, input)` from the browser console.

## 120 Hz physics

`Game.frame` accumulates real time (clamped to 0.05 s, so tab-switches never produce a huge step) and calls `world.step(SUB_DT = 1/120, input)` as many times as fit, with a hard cap of 12 sub-steps. The renderer interpolates the courier and drones between the previous and current tick, so motion stays smooth at any refresh rate. Camera yaw and pitch come straight from the mouse each frame rather than from the sim, so look latency is not tied to the physics rate.

**Collision.** The courier is a sphere (r = 0.45 m). Every sub-step, each AABB finds the closest point to the sphere centre and pushes the sphere out along that normal, and the velocity component into the surface is removed. A normal with `ny > 0.6` counts as ground, `|ny| < 0.35` as wall. A centre buried inside a box leaves through the nearest face. At the 40 m/s top speed one sub-step moves 0.33 m, which is under the sphere radius, so walls cannot be tunnelled.

**Spring-damper grapple.** With the anchor `A`, courier `P`, `d = |A - P|`, tether direction `n = (A - P) / d`, rest length `L` and `stretch = d - L`:

```
radial = v . n                       (+ toward the anchor, - away)
pull   = max(0, k * stretch - c * radial)     only while stretch > 0 (rope taut)
v     += n * pull * dt
```

This is Hooke's law plus damping along the tether, with the pull clamped at zero because a rope cannot push. Defaults are `k = 45`, `c = 5`, tunable live from `F1`. `k * dt^2` is about 0.003, comfortably stable at 120 Hz. On latch the rest length is 97% of the current distance, so the rope bites immediately. Reeling shrinks `L` at 16 m/s (minimum 3 m) and adds a 30 m/s^2 pull toward the anchor.

**Air control.** Quake-style: the player can steer freely but cannot add speed past 12 m/s along the wish direction, so momentum from swings, pads and launches is preserved. A very small air drag (0.06/s) stops energy growing without bound.

## HFSM

`core/HFSM.ts` is a two-level hierarchical machine. Each tick runs `parent.update` then `leaf.update`. A transition inside one parent only exits and enters leaves. Crossing parents also exits the old parent and enters the new one. Transitions are checked against an adjacency table, and rejected requests are counted (visible in the debug panel).

```
Grounded     Idle, Run, Slide
Airborne     Jump, Fall, CoyoteTime
Grappling    Swing, ReelIn
WallRunning  LeftWall, RightWall
```

- **Coyote time:** walking off a ledge enters `CoyoteTime` for 120 ms, during which a jump still works.
- **Jump buffer:** a jump pressed up to 120 ms before landing fires on touchdown.
- **Wall-run:** needs airborne contact with a near-vertical surface, forward input and more than 7 m/s horizontal speed. Gravity is reduced to 10%, velocity is projected onto the wall tangent, and the camera rolls plus or minus 12 degrees away from the wall. `Space` kicks the courier out along the normal (7.5 m/s) and up (9 m/s), with a 0.3 s lock so you cannot re-stick instantly.
- **Variable jump:** releasing `Space` early cuts upward speed. Launches and wall-jumps are exempt.

## Pursuit drones

Each drone runs `Patrol -> Pursue -> Charge -> Recover`.

- **Interception.** While pursuing, the drone aims at `target + targetVel * lookAhead`, with `lookAhead = clamp(distance / maxSpeed, 0, 1.2)` (the vertical lead is halved), so it cuts across a swing arc instead of tailing it.
- **Steering.** The result is seek, plus separation from other drones (9 m radius), plus whisker obstacle avoidance. Whiskers are three forward rays (centre and plus or minus 35 degrees) and one downward ray of 11 m; each hit pushes along the surface normal, scaled by how close the hit is.
- **EMP.** Inside 26 m the drone enters `Charge`: it slows to 25% speed, flashes, and shows a wireframe sphere of the danger zone. After 1.1 s it releases a shockwave that expands at 22 m/s up to 14 m. If the shell sweeps the courier, the grapple is cut and disabled and all velocity is dragged down for 2 s. This is a disruption, not a kill, so there is no instant death.

## Ghost replay

The recorder samples at 30 Hz while the run is live:

```jsonc
{
  "v": 1,
  "hz": 30,
  "timeMs": 33700,
  "splits": [10975, 22783, 33700],
  "frames": [[t, x, y, z, vx, vy, vz, yaw, pitch, stateIndex], ...]
}
```

`stateIndex` indexes a fixed list of leaf states (`Idle, Run, Slide, Jump, Fall, CoyoteTime, Swing, ReelIn, LeftWall, RightWall`; append-only, so old replays stay valid). Values are rounded to 3 decimals, so a 34 s run is about 56 KB.

- **Persistence.** The personal best is stored in `localStorage` (guarded by try/catch) and the ghost races you on every later run, shown as a translucent capsule with an orange band. Gate splits show a delta against the ghost.
- **Export and import.** The finish screen has Copy ghost and Import ghost. Import validates untrusted JSON: version, sample rate, finite numeric frames of the right shape, and a frame-count cap. It reports an error string instead of throwing.

## Look and feel

- Warm dusk sky gradient, fog, flat shaded board-formed concrete with a world-scale UV tile, hazard-striped roof lips and safety-orange hooks, pads and gates. There is no bloom and no neon.
- Speed-reactive FOV (75 to 105 degrees), a landing camera dip, FOV kicks on latch and boost pad, speed lines and a vignette above about 18 m/s, and a taut-rope thickness change.
- Procedural audio: a wind bed whose band-pass cutoff and gain follow speed, plus grapple fire, latch and release, jump and wall-jump, slide scrape, landing thud, boost surge, gate chimes, a finish fanfare and EMP charge, pulse and hit. Press `M` to mute.

## Debug (`F1`)

Shows FPS, substeps per frame, speed, velocity vector, the HFSM parent and leaf with its history, grapple length, rest length, stretch and tension, per-drone state and look-ahead, replay and ghost status, and GPU geometry and texture counts. In the 3D view it draws the grapple ray (cyan on a valid target, red otherwise), the tether, wall normals, the velocity vector, drone velocities and each drone's interception point. Sliders tune run speed, gravity, jump, rope stiffness and damping, reel speed, drone speed and time scale.

## Verification and known limits

- Typecheck and production build pass.
- A scripted bot completes the whole course (three gates and the finish), and wall-run, wall-jump, coyote time, jump buffer, slide, the EMP and drone steering behave as described.
- Restarting five times leaves GPU geometry (62) and texture (11) counts, and the event-listener count, unchanged.
- That bot only grapples and reels, so it does not exercise the wall-run shortcuts end to end. Its clean 33.7 s run is a baseline, not a par time.
- Pointer lock and the feel of the controls are not covered by the scripted tests.
- Not done: gamepad support, a proper capsule collider (the sphere can catch on box edges), and automated tests.
