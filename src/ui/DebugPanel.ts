import { Tuning, TuningRanges } from '../game/config';
import type { World } from '../game/World';
import type { GhostPlayer } from '../replay/Replay';
import type { GameState } from './Hud';

export interface DebugInfo {
  fps: number;
  frameMs: number;
  substeps: number;
  state: GameState;
  ghost: GhostPlayer | null;
  recorderFrames: number;
  gpu: { geometries: number; textures: number };
}

/** F1 panel: telemetry text plus live-tuning sliders. 3D helper lines are drawn by the Renderer. */
export class DebugPanel {
  visible = false;
  private readonly root: HTMLElement;
  private readonly out: HTMLPreElement;
  private last = 0;

  constructor(private readonly world: World) {
    this.root = document.getElementById('debug') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'debug' }));
    for (const ev of ['mousedown', 'mouseup', 'click', 'wheel', 'keydown']) this.root.addEventListener(ev, (e) => e.stopPropagation());
    this.out = document.createElement('pre');
    this.root.appendChild(this.out);
    const legend = document.createElement('div');
    legend.textContent = 'lines: cyan/red = grapple ray · orange = tether · green = wall normal · yellow = velocity · white = drone vel · magenta = interception';
    legend.style.cssText = 'opacity:.7;margin-bottom:6px';
    this.root.appendChild(legend);
    for (const key of Object.keys(Tuning) as (keyof typeof Tuning)[]) this.root.appendChild(this.slider(key));
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? 'block' : 'none';
  }

  dispose(): void {
    this.root.remove();
  }

  update(info: DebugInfo, now: number): void {
    if (!this.visible || now - this.last < 100) return;
    this.last = now;
    const w = this.world;
    const p = w.player;
    const f = p.fsm;
    const r = p.rope;
    const lines = [
      `FPS ${info.fps.toFixed(0)} (${info.frameMs.toFixed(1)} ms)  substeps/frame ${info.substeps}  state ${info.state}`,
      `tick ${w.tick}  run ${w.runTime.toFixed(2)}s  ${w.runState}  respawns ${w.respawns}`,
      `GPU geometries ${info.gpu.geometries}  textures ${info.gpu.textures}`,
      '',
      `SPEED ${p.speed.toFixed(1)} m/s  (horizontal ${Math.hypot(p.vx, p.vz).toFixed(1)})`,
      `VEL (${p.vx.toFixed(1)}, ${p.vy.toFixed(1)}, ${p.vz.toFixed(1)})`,
      `POS (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`,
      '',
      `HFSM  ${f.parent} > ${f.leaf}   (leaf ${f.leafTime.toFixed(2)}s, parent ${f.parentTime.toFixed(2)}s)`,
      `  history ${f.history.join(' > ') || '-'}`,
      `  rejected transitions ${f.rejected}`,
      `  grounded ${p.grounded}  wall ${p.wallContact}  jumpBuf ${p.jumpBuffer.toFixed(2)}  wallLock ${p.wallJumpLock.toFixed(2)}`,
      `  empT ${p.empT.toFixed(2)}  grappleCd ${p.grappleCd.toFixed(2)}`,
      '',
      r.active
        ? `GRAPPLE ${r.kind}: length ${r.length.toFixed(1)} m  rest ${r.rest.toFixed(1)} m  stretch ${(r.length - r.rest).toFixed(2)}  tension ${r.tension.toFixed(1)}`
        : 'GRAPPLE: idle',
      '',
      `DRONES`,
      ...w.drones.map((d) => `  #${d.index} ${d.state.padEnd(7)} spd ${d.speed.toFixed(1)}  lookAhead ${d.lookAhead.toFixed(2)}s  cd ${d.cd.toFixed(1)}`),
      '',
      `REPLAY recorded frames ${info.recorderFrames}  ghost ${info.ghost ? `${info.ghost.duration.toFixed(1)}s` : 'none'}`,
    ];
    this.out.textContent = lines.join('\n');
  }

  private slider(key: keyof typeof Tuning): HTMLLabelElement {
    const [min, max, step] = TuningRanges[key];
    const l = document.createElement('label');
    const name = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Tuning[key]);
    const sync = (): void => {
      name.textContent = `${key}: ${Tuning[key]}`;
    };
    input.addEventListener('input', () => {
      Tuning[key] = Number(input.value);
      sync();
    });
    sync();
    l.append(name, input);
    return l;
  }
}
