import type { Replay } from '../replay/Replay';

export type GameState = 'title' | 'playing' | 'paused' | 'finished';

export function fmtTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function fmtDelta(ms: number): string {
  const sign = ms <= 0 ? '-' : '+';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(2)}`;
}

export interface HudInfo {
  timeMs: number;
  speed: number;
  bestMs: number | null;
  checkpoint: number;
  total: number;
  state: string;
  respawns: number;
  lockOn: boolean;
  empActive: boolean;
}

export interface FinishInfo {
  timeMs: number;
  splits: number[];
  bestSplits: number[] | null;
  isPB: boolean;
  prevBestMs: number | null;
  respawns: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** DOM HUD and menu screens (title / pause / finish with ghost export + import). */
export class Hud {
  onStart: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onExport: (() => string) | null = null;
  onImport: ((text: string) => string | null) | null = null;

  private readonly hud: HTMLElement;
  private readonly timer = el('div', 'chip');
  private readonly best = el('div', 'chip');
  private readonly speed = el('div', 'chip');
  private readonly progress = el('div', 'chip');
  private readonly toastEl = el('div', 'chip');
  private readonly stateEl = el('div', 'chip');
  private readonly empEl = el('div', 'chip', 'EMP — GRAPPLE OFFLINE');
  private readonly cross = el('div');
  private readonly title: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly finish: HTMLElement;
  private readonly finishBody = el('div');
  private toastT = 0;

  constructor() {
    this.hud = document.getElementById('hud') as HTMLElement;
    this.timer.id = 'timer';
    this.best.id = 'best';
    this.speed.id = 'speed';
    this.progress.id = 'progress';
    this.toastEl.id = 'toast';
    this.stateEl.id = 'state';
    this.empEl.id = 'emp';
    this.cross.id = 'cross';
    this.cross.innerHTML = '<i class="dot"></i><i class="h l"></i><i class="h r"></i><i class="v t"></i><i class="v b"></i>';
    this.hud.append(this.timer, this.best, this.speed, this.progress, this.toastEl, this.stateEl, this.empEl, this.cross);

    const screens = document.getElementById('screens') as HTMLElement;
    this.title = this.buildTitle();
    this.pause = this.buildPause();
    this.finish = el('div', 'screen');
    const fc = el('div', 'card');
    fc.append(this.finishBody);
    this.finish.append(fc);
    screens.append(this.title, this.pause, this.finish);
    // clicks on menus must not leak to the game canvas
    for (const s of [this.title, this.pause, this.finish]) {
      s.addEventListener('mousedown', (e) => e.stopPropagation());
      s.addEventListener('keydown', (e) => e.stopPropagation());
    }
  }

  setState(s: GameState): void {
    this.hud.classList.toggle('on', s === 'playing' || s === 'paused' || s === 'finished');
    this.title.classList.toggle('on', s === 'title');
    this.pause.classList.toggle('on', s === 'paused');
    this.finish.classList.toggle('on', s === 'finished');
  }

  toast(text: string, seconds = 2.2): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    this.toastT = seconds;
  }

  update(dt: number, i: HudInfo): void {
    this.timer.textContent = fmtTime(i.timeMs);
    this.best.textContent = i.bestMs ? `GHOST ${fmtTime(i.bestMs)}` : 'NO GHOST YET';
    this.speed.innerHTML = `${Math.round(i.speed)}<small>M/S</small>`;
    this.progress.textContent = `GATE ${i.checkpoint}/${i.total}`;
    this.stateEl.textContent = i.state;
    this.empEl.classList.toggle('on', i.empActive);
    this.cross.classList.toggle('lock', i.lockOn);
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toastEl.classList.remove('on');
    }
  }

  showFinish(f: FinishInfo): void {
    this.finishBody.replaceChildren();
    const h = el('h2', '', f.isPB ? 'New personal best' : 'Run complete');
    const big = el('div');
    big.style.cssText = 'font:900 64px var(--head);letter-spacing:-1px';
    big.textContent = fmtTime(f.timeMs);
    const sub = el('p');
    sub.textContent = f.prevBestMs
      ? `Previous best ${fmtTime(f.prevBestMs)} (${fmtDelta(f.timeMs - f.prevBestMs)}s)  ·  ${f.respawns} respawn${f.respawns === 1 ? '' : 's'}`
      : `First recorded run  ·  ${f.respawns} respawn${f.respawns === 1 ? '' : 's'}`;
    const table = el('table', 'splits');
    f.splits.forEach((t, i) => {
      const row = el('tr');
      const label = i === f.splits.length - 1 ? 'FINISH' : `GATE ${i + 1}`;
      const best = f.bestSplits?.[i];
      const d = el('td');
      if (best !== undefined) {
        d.textContent = `${fmtDelta(t - best)}s`;
        d.className = t <= best ? 'good' : 'bad';
      }
      row.append(el('td', '', label), el('td', '', fmtTime(t)), d);
      table.append(row);
    });

    const msg = el('div', 'msg');
    const area = el('textarea');
    area.placeholder = 'Paste a ghost replay JSON here, then press Import.';
    const copy = el('div', 'btn alt', 'Copy ghost');
    copy.onclick = () => {
      const json = this.onExport?.() ?? '';
      area.value = json;
      area.select();
      void navigator.clipboard?.writeText(json).then(
        () => (msg.textContent = 'Replay copied to clipboard.'),
        () => (msg.textContent = 'Replay placed in the box below: copy it manually.'),
      );
    };
    const imp = el('div', 'btn alt', 'Import ghost');
    imp.onclick = () => {
      const err = this.onImport?.(area.value.trim()) ?? 'Import unavailable.';
      msg.textContent = err ?? 'Ghost imported. It will race you on the next run.';
      msg.className = err ? 'msg bad' : 'msg good';
    };
    const retry = el('div', 'btn', 'Retry (R)');
    retry.onclick = () => this.onRestart?.();
    this.finishBody.append(h, big, sub, table, retry, copy, imp, area, msg);
  }

  private buildTitle(): HTMLElement {
    const s = el('div', 'screen on');
    const c = el('div', 'card');
    c.innerHTML = `
      <h1>Kinetic<br><span>Courier</span></h1>
      <p>Rooftop time trial. Carry momentum across ten slabs, three gates, and a few angry drones.</p>
      <div class="keys">
        <b>W A S D</b><span>Run</span>
        <b>Mouse</b><span>Look</span>
        <b>Space</b><span>Jump (hold for height) / launch off the rope</span>
        <b>Left mouse</b><span>Hold to grapple: aim at the orange hooks. Release to let go</span>
        <b>Shift / Right mouse / Wheel</b><span>Reel in while hooked</span>
        <b>C or Q</b><span>Slide</span>
        <b>Forward into a wall</b><span>Wall-run; Space to wall-jump</span>
        <b>P / Esc</b><span>Pause</span>
        <b>R</b><span>Instant restart</span>
        <b>F1</b><span>Debug · <b>M</b> mute</span>
      </div>
      <p>Your best run is saved as a ghost. Orange pads add speed.</p>`;
    const go = el('div', 'btn', 'Click to start');
    go.onclick = () => this.onStart?.();
    c.append(go);
    s.append(c);
    return s;
  }

  private buildPause(): HTMLElement {
    const s = el('div', 'screen');
    const c = el('div', 'card');
    c.append(el('h2', '', 'Paused'));
    const resume = el('div', 'btn', 'Resume');
    resume.onclick = () => this.onResume?.();
    const restart = el('div', 'btn alt', 'Restart (R)');
    restart.onclick = () => this.onRestart?.();
    c.append(resume, restart);
    s.append(c);
    return s;
  }
}

export function replaySummary(r: Replay): string {
  return `${fmtTime(r.timeMs)} · ${r.frames.length} frames`;
}
