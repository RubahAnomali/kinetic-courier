/** 2D overlay: radial speed lines and an edge vignette that fade in above ~18 m/s. */
export class SpeedFx {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly vignette: HTMLElement;
  private readonly lines: { a: number; r: number; len: number; w: number; ph: number }[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('2D canvas unavailable');
    this.ctx = c;
    this.vignette = document.getElementById('vignette') as HTMLElement;
    let s = 3;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 46; i++) this.lines.push({ a: rnd() * Math.PI * 2, r: 0.35 + rnd() * 0.5, len: 0.08 + rnd() * 0.2, w: 1 + rnd() * 2.5, ph: rnd() });
    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  private readonly onResize = (): void => this.resize();

  resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
  }

  update(speed: number, time: number): void {
    const k = Math.min(1, Math.max(0, (speed - 18) / 18));
    this.vignette.style.opacity = String(k * 0.9);
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (k <= 0.01) return;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.hypot(cx, cy);
    ctx.strokeStyle = '#f1e8d0';
    ctx.lineCap = 'butt';
    for (const l of this.lines) {
      const t = (time * (0.9 + k) + l.ph) % 1;
      const r0 = R * (l.r + t * 0.35);
      const r1 = r0 + R * l.len * (0.5 + k);
      ctx.globalAlpha = k * 0.35 * (1 - t);
      ctx.lineWidth = l.w;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(l.a) * r0, cy + Math.sin(l.a) * r0);
      ctx.lineTo(cx + Math.cos(l.a) * r1, cy + Math.sin(l.a) * r1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
