import type { EventBus } from '../core/EventBus';
import { raycastBoxes } from '../physics/Collision';
import { Drone } from './ai/Drone';
import { PLAYER } from './config';
import { buildCourse, type CourseData } from './Course';
import { Player } from './Player';
import type { GameEvents, InputState } from './types';

export type RunState = 'ready' | 'running' | 'finished';

export interface GrappleTarget {
  x: number;
  y: number;
  z: number;
  kind: 'anchor' | 'surface';
  dist: number;
}

/**
 * Authoritative simulation: course, courier, drones and the time-trial state machine.
 * Pure logic. No Three.js, DOM or WebAudio. Stepped at a fixed 120 Hz by the game loop.
 */
export class World {
  readonly course: CourseData = buildCourse();
  readonly player: Player;
  readonly drones: Drone[];
  runState: RunState = 'ready';
  /** Seconds of simulation time since the run started. */
  runTime = 0;
  tick = 0;
  nextCheckpoint = 0;
  splits: number[] = [];
  respawns = 0;
  private respawnPoint: { x: number; y: number; z: number };
  private padCooldown = 0;

  constructor(readonly bus: EventBus<GameEvents>) {
    this.player = new Player(this);
    this.drones = this.course.droneSpawns.map((s, i) => new Drone(i, s));
    this.respawnPoint = this.course.spawn;
    this.reset();
  }

  /** Full reset: courier, drones, timers, checkpoints. No objects are recreated. */
  reset(): void {
    const s = this.course.spawn;
    this.runState = 'ready';
    this.runTime = 0;
    this.tick = 0;
    this.nextCheckpoint = 0;
    this.splits = [];
    this.respawns = 0;
    this.padCooldown = 0;
    this.respawnPoint = s;
    this.player.place(s.x, s.y, s.z, 0);
    for (const d of this.drones) d.reset();
  }

  get totalCheckpoints(): number {
    return this.course.checkpoints.length + 1; // intermediate gates + the finish
  }

  step(dt: number, input: InputState): void {
    this.tick++;
    const p = this.player;
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
    for (const d of this.drones) {
      d.px = d.x;
      d.py = d.y;
      d.pz = d.z;
    }
    if (this.runState === 'finished') return;

    if (this.runState === 'ready' && (input.moveX !== 0 || input.moveZ !== 0 || input.jumpPressed || input.grapplePressed)) {
      this.runState = 'running';
      this.bus.emit('RUN_STARTED', {});
    }

    p.update(dt, input);
    for (const d of this.drones) d.update(dt, this, this.drones);

    this.padCooldown = Math.max(0, this.padCooldown - dt);
    this.checkPads();
    this.checkGates();
    if (p.y < this.course.deathY) this.respawn();
    if (this.runState === 'running') this.runTime += dt;
  }

  /** Grapple targeting: aim-assisted anchors first, then any solid surface along the view ray. */
  findGrappleTarget(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): GrappleTarget | null {
    let best: GrappleTarget | null = null;
    let bestScore = Infinity;
    for (const a of this.course.anchors) {
      const ax = a.x - ox;
      const ay = a.y - oy;
      const az = a.z - oz;
      const t = ax * dx + ay * dy + az * dz;
      if (t < 2 || t > PLAYER.grappleRange) continue;
      const perp = Math.hypot(ax - dx * t, ay - dy * t, az - dz * t);
      const tol = 1.6 + t * 0.045;
      if (perp > tol) continue;
      const blocked = raycastBoxes(ox, oy, oz, ax / t, ay / t, az / t, t - 1, this.course.boxes);
      if (blocked) continue;
      const score = perp / tol;
      if (score < bestScore) {
        bestScore = score;
        best = { x: a.x, y: a.y, z: a.z, kind: 'anchor', dist: t };
      }
    }
    if (best) return best;
    const hit = raycastBoxes(ox, oy, oz, dx, dy, dz, PLAYER.surfaceRange, this.course.boxes);
    if (hit) return { x: ox + dx * hit.t, y: oy + dy * hit.t, z: oz + dz * hit.t, kind: 'surface', dist: hit.t };
    return null;
  }

  /** Called by a drone when its EMP shell sweeps the courier. Disrupts the grapple and drags velocity. */
  applyEmp(): void {
    const p = this.player;
    p.empT = 2;
    if (p.rope.active) {
      p.rope.active = false;
      p.rope.tension = 0;
      this.bus.emit('GRAPPLE_RELEASED', { launched: false });
      p.fsm.transition('Fall');
    }
    this.bus.emit('EMP_HIT', {});
  }

  private checkPads(): void {
    if (this.padCooldown > 0) return;
    const p = this.player;
    for (const pad of this.course.pads) {
      if (Math.abs(p.x - pad.x) > pad.w / 2 || Math.abs(p.z - pad.z) > pad.d / 2 || p.y - pad.y > 1.6 || p.y < pad.y) continue;
      const sp = Math.hypot(p.vx, p.vz);
      const out = Math.max(sp, 24);
      p.vx = pad.dirX * out;
      p.vz = pad.dirZ * out;
      p.vy = Math.max(p.vy, 3);
      this.padCooldown = 0.5;
      this.bus.emit('BOOST_PAD', { x: pad.x, y: pad.y, z: pad.z });
      return;
    }
  }

  private checkGates(): void {
    if (this.runState !== 'running') return;
    const p = this.player;
    const idx = this.nextCheckpoint;
    const gate = idx < this.course.checkpoints.length ? this.course.checkpoints[idx] : this.course.finish;
    if (Math.hypot(p.x - gate.x, p.y - gate.y, p.z - gate.z) > 5.5) return;
    const timeMs = Math.round(this.runTime * 1000);
    this.splits.push(timeMs);
    this.nextCheckpoint++;
    this.respawnPoint = gate.respawn;
    this.bus.emit('CHECKPOINT', { index: idx, timeMs, total: this.totalCheckpoints });
    if (idx >= this.course.checkpoints.length) {
      this.runState = 'finished';
      this.bus.emit('RUN_FINISHED', { timeMs });
    }
  }

  private respawn(): void {
    const r = this.respawnPoint;
    this.respawns++;
    this.player.place(r.x, r.y, r.z, 0);
    this.bus.emit('RESPAWN', { respawns: this.respawns });
  }
}
