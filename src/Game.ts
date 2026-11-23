import { SoundEngine } from './audio/SoundEngine';
import { EventBus } from './core/EventBus';
import { MAX_FRAME_DT, SUB_DT, Tuning } from './game/config';
import type { GameEvents } from './game/types';
import { World } from './game/World';
import { Renderer } from './render/Renderer';
import { GhostPlayer, loadBest, parseReplay, ReplayRecorder, saveBest, serializeReplay, type Replay } from './replay/Replay';
import { DebugPanel } from './ui/DebugPanel';
import { fmtDelta, fmtTime, Hud, type GameState } from './ui/Hud';
import { Input } from './ui/Input';
import { SpeedFx } from './ui/SpeedFx';

const MAX_SUBSTEPS = 12;

/**
 * Composition root: fixed 120 Hz physics loop, state flow (title / playing / paused / finished),
 * and wiring from simulation events to HUD, audio, replay and renderer. Every subscription is
 * registered once here, so restarting never duplicates listeners.
 */
export class Game {
  readonly bus = new EventBus<GameEvents>();
  readonly world = new World(this.bus);
  readonly sound = new SoundEngine();
  readonly input: Input;
  readonly renderer: Renderer;
  readonly hud = new Hud();
  readonly debug: DebugPanel;
  readonly speedFx: SpeedFx;
  readonly recorder = new ReplayRecorder();

  state: GameState = 'title';
  private acc = 0;
  private last = 0;
  private raf = 0;
  private fps = 60;
  private substeps = 0;
  private time = 0;
  private running = false;
  private best: Replay | null = loadBest();
  private lastReplay: Replay | null = null;
  private ghost: GhostPlayer | null = null;

  constructor(canvas: HTMLCanvasElement, fxCanvas: HTMLCanvasElement) {
    this.input = new Input(canvas);
    this.renderer = new Renderer(canvas, this.world, this.bus);
    this.speedFx = new SpeedFx(fxCanvas);
    this.debug = new DebugPanel(this.world);
    this.sound.bind(this.bus);
    this.ghost = this.best ? new GhostPlayer(this.best) : null;

    this.input.onGesture = () => this.sound.unlock();
    this.input.onKey = (code) => this.onKey(code);
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing' && this.input.everLocked) this.pause();
    };

    this.hud.onStart = () => {
      this.sound.unlock();
      this.sound.uiClick();
      this.restart();
    };
    this.hud.onResume = () => this.resume();
    this.hud.onRestart = () => this.restart();
    this.hud.onExport = () => (this.lastReplay ? serializeReplay(this.lastReplay) : '');
    this.hud.onImport = (text) => {
      const r = parseReplay(text);
      if (typeof r === 'string') return r;
      this.best = r;
      saveBest(r);
      return null;
    };

    this.bus.on('CHECKPOINT', (e) => {
      const ref = this.best?.splits[e.index];
      const label = e.index === e.total - 1 ? 'FINISH' : `GATE ${e.index + 1}`;
      this.hud.toast(ref !== undefined ? `${label}  ${fmtTime(e.timeMs)}  ${fmtDelta(e.timeMs - ref)}` : `${label}  ${fmtTime(e.timeMs)}`);
    });
    this.bus.on('RESPAWN', () => {
      this.hud.toast('RESPAWNED AT LAST GATE', 1.5);
    });
    this.bus.on('RUN_FINISHED', (e) => this.onFinished(e.timeMs));

    this.hud.setState('title');
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.input.dispose();
    this.renderer.dispose();
    this.speedFx.dispose();
    this.debug.dispose();
    this.bus.clear();
  }

  /** Clean restart: sim, replay recorder, ghost cursor, look angles, timers and latched input. */
  restart(): void {
    this.world.reset();
    this.recorder.reset();
    this.ghost = this.best ? new GhostPlayer(this.best) : null;
    this.input.yaw = 0;
    this.input.pitch = 0;
    this.input.releaseAll();
    this.acc = 0;
    this.state = 'playing';
    this.hud.setState('playing');
    this.input.requestLock();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.releaseAll();
    this.input.exitLock();
    this.hud.setState('paused');
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.acc = 0;
    this.hud.setState('playing');
    this.input.requestLock();
  }

  private onKey(code: string): void {
    if (code === 'F1') return void this.debug.toggle();
    if (code === 'KeyM') return void this.sound.toggleMute();
    if (code === 'KeyR' && this.state !== 'title') return this.restart();
    if (this.state === 'title' && (code === 'Enter' || code === 'Space')) return this.hud.onStart?.();
    if (code === 'KeyP' || code === 'Escape') {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
    }
  }

  private onFinished(timeMs: number): void {
    const replay = this.recorder.finish(this.world, timeMs);
    const prev = this.best;
    const isPB = !prev || timeMs < prev.timeMs;
    this.lastReplay = replay;
    if (isPB) {
      this.best = replay;
      saveBest(replay);
    }
    this.state = 'finished';
    this.input.releaseAll();
    this.input.exitLock();
    this.hud.showFinish({
      timeMs,
      splits: this.world.splits,
      bestSplits: prev?.splits ?? null,
      isPB,
      prevBestMs: prev?.timeMs ?? null,
      respawns: this.world.respawns,
    });
    this.hud.setState('finished');
  }

  private frame(now: number): void {
    if (!this.running) return;
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(Math.max(raw, 0), MAX_FRAME_DT);
    if (raw > 0) this.fps += (1 / raw - this.fps) * 0.1;
    this.time += dt;
    this.input.tickFrame(dt);

    this.substeps = 0;
    if (this.state === 'playing') {
      this.acc += dt * Tuning.timeScale;
      while (this.acc >= SUB_DT && this.substeps < MAX_SUBSTEPS) {
        this.world.step(SUB_DT, this.input.snapshot());
        this.recorder.update(this.world);
        this.acc -= SUB_DT;
        this.substeps++;
      }
      if (this.substeps === MAX_SUBSTEPS) this.acc = 0;
    }

    const w = this.world;
    const p = w.player;
    const cp = Math.cos(this.input.pitch);
    const eye = p.eye();
    const aim = this.state === 'playing' ? w.findGrappleTarget(eye.x, eye.y, eye.z, -Math.sin(this.input.yaw) * cp, Math.sin(this.input.pitch), -Math.cos(this.input.yaw) * cp) : null;
    const ghost = this.ghost && this.state !== 'title' ? this.ghost.sample(w.runState === 'ready' ? 0 : w.runTime) : null;

    this.renderer.render({
      alpha: this.state === 'playing' ? this.acc / SUB_DT : 1,
      realDt: dt,
      yaw: this.input.yaw,
      pitch: this.input.pitch,
      ghost,
      aim,
      debug: this.debug.visible,
      time: this.time,
    });

    this.sound.setMotion(p.speed, p.fsm.leaf === 'Slide', this.state === 'playing');
    this.speedFx.update(this.state === 'playing' ? p.speed : 0, this.time);
    this.hud.update(dt, {
      timeMs: Math.round(w.runTime * 1000),
      speed: p.speed,
      bestMs: this.best?.timeMs ?? null,
      checkpoint: w.nextCheckpoint,
      total: w.totalCheckpoints,
      state: `${p.fsm.parent} / ${p.fsm.leaf}`,
      respawns: w.respawns,
      lockOn: !!aim && p.grappleCd <= 0 && p.empT <= 0,
      empActive: p.empT > 0,
    });
    this.debug.update(
      {
        fps: this.fps,
        frameMs: raw * 1000,
        substeps: this.substeps,
        state: this.state,
        ghost: this.ghost,
        recorderFrames: this.recorder.frameCount,
        gpu: this.renderer.memory,
      },
      now,
    );
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }
}
