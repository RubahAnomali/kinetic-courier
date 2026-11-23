import { LEAF_IDS } from '../game/types';
import type { World } from '../game/World';

/**
 * Compact replay: one frame per 1/HZ seconds.
 * frame = [t, x, y, z, vx, vy, vz, yaw, pitch, stateIndex]  (t in seconds, state = index into LEAF_IDS)
 */
export type Frame = [number, number, number, number, number, number, number, number, number, number];

export interface Replay {
  v: 1;
  hz: number;
  timeMs: number;
  splits: number[];
  frames: Frame[];
}

export const REPLAY_HZ = 30;
const STORAGE_KEY = 'kinetic-courier:pb:v1';

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Samples the simulation at a fixed cadence while a run is live. */
export class ReplayRecorder {
  private frames: Frame[] = [];
  private next = 0;

  reset(): void {
    this.frames = [];
    this.next = 0;
  }

  /** Call after every simulation step. */
  update(world: World): void {
    if (world.runState === 'ready') return;
    while (world.runTime >= this.next) {
      const p = world.player;
      this.frames.push([
        r3(this.next),
        r3(p.x),
        r3(p.y),
        r3(p.z),
        r3(p.vx),
        r3(p.vy),
        r3(p.vz),
        r3(p.yaw),
        r3(p.pitch),
        LEAF_IDS.indexOf(p.fsm.leaf),
      ]);
      this.next += 1 / REPLAY_HZ;
    }
  }

  finish(world: World, timeMs: number): Replay {
    return { v: 1, hz: REPLAY_HZ, timeMs, splits: [...world.splits], frames: this.frames.slice() };
  }

  get frameCount(): number {
    return this.frames.length;
  }
}

export interface GhostSample {
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: string;
}

/** Plays a recorded run back by interpolating between frames at the current run time. */
export class GhostPlayer {
  private i = 0;

  constructor(readonly replay: Replay) {}

  reset(): void {
    this.i = 0;
  }

  get duration(): number {
    const f = this.replay.frames;
    return f.length ? f[f.length - 1][0] : 0;
  }

  sample(t: number): GhostSample | null {
    const f = this.replay.frames;
    if (f.length < 2 || t > this.duration + 0.5) return null;
    if (t < f[this.i][0]) this.i = 0;
    while (this.i < f.length - 2 && f[this.i + 1][0] <= t) this.i++;
    const a = f[this.i];
    const b = f[this.i + 1];
    const k = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    return {
      x: a[1] + (b[1] - a[1]) * k,
      y: a[2] + (b[2] - a[2]) * k,
      z: a[3] + (b[3] - a[3]) * k,
      yaw: a[7] + (b[7] - a[7]) * k,
      state: LEAF_IDS[a[9]] ?? 'Fall',
    };
  }
}

// ---- persistence + import/export ------------------------------------------------------------

export function serializeReplay(r: Replay): string {
  return JSON.stringify(r);
}

/** Validates untrusted JSON. Returns the replay, or an error string. */
export function parseReplay(text: string): Replay | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'Not valid JSON.';
  }
  if (typeof data !== 'object' || data === null) return 'Replay must be an object.';
  const r = data as Partial<Replay>;
  if (r.v !== 1) return 'Unsupported replay version.';
  if (typeof r.hz !== 'number' || r.hz <= 0 || r.hz > 240) return 'Bad sample rate.';
  if (typeof r.timeMs !== 'number' || !(r.timeMs > 0)) return 'Bad run time.';
  if (!Array.isArray(r.splits) || !r.splits.every((n) => typeof n === 'number')) return 'Bad splits.';
  if (!Array.isArray(r.frames) || r.frames.length < 2 || r.frames.length > 60000) return 'Bad frame list.';
  for (const f of r.frames) {
    if (!Array.isArray(f) || f.length !== 10 || !f.every((n) => typeof n === 'number' && Number.isFinite(n))) return 'Corrupt frame data.';
  }
  return { v: 1, hz: r.hz, timeMs: r.timeMs, splits: r.splits as number[], frames: r.frames as Frame[] };
}

export function loadBest(): Replay | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const r = parseReplay(raw);
    return typeof r === 'string' ? null : r;
  } catch {
    return null;
  }
}

export function saveBest(r: Replay): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, serializeReplay(r));
    return true;
  } catch {
    return false;
  }
}
