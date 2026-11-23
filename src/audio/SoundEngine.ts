import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../game/types';

/**
 * Procedural audio: oscillators, looped filtered noise, envelopes and biquad filters.
 * A continuous wind bed is driven every frame by the courier's speed.
 */
export class SoundEngine {
  muted = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private slideGain: GainNode | null = null;

  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const c = new Ctor();
      this.ctx = c;
      this.master = c.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      const comp = c.createDynamicsCompressor();
      this.master.connect(comp).connect(c.destination);
      const len = c.sampleRate * 2;
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startWind();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  /** Call every frame. Wind cutoff and loudness scale with speed; slide adds a scrape. */
  setMotion(speed: number, sliding: boolean, active: boolean): void {
    const c = this.ctx;
    if (!c || !this.windGain || !this.windFilter || !this.slideGain) return;
    const t = c.currentTime;
    const k = Math.min(1, Math.max(0, (speed - 2) / 34));
    this.windFilter.frequency.setTargetAtTime(220 + k * 2600, t, 0.08);
    this.windFilter.Q.setTargetAtTime(0.6 + k * 1.4, t, 0.1);
    this.windGain.gain.setTargetAtTime(active ? 0.04 + k * k * 0.55 : 0, t, 0.1);
    this.slideGain.gain.setTargetAtTime(active && sliding ? 0.16 : 0, t, 0.05);
  }

  bind(bus: EventBus<GameEvents>): void {
    bus.on('JUMPED', () => this.tone(180, 360, 0.12, 'triangle', 0.14));
    bus.on('WALL_JUMPED', () => {
      this.tone(240, 520, 0.16, 'triangle', 0.16);
      this.burst(0.12, 0.2, 'bandpass', 2200, 900, 1.2);
    });
    bus.on('LANDED', (e) => {
      const v = Math.min(1, e.impact / 22);
      this.tone(90, 40, 0.2 + v * 0.15, 'sine', 0.2 + v * 0.4);
      this.burst(0.1 + v * 0.1, 0.15 + v * 0.3, 'lowpass', 900, 150, 0.8);
    });
    bus.on('SLIDE_START', () => this.burst(0.18, 0.2, 'bandpass', 1400, 500, 1.5));
    bus.on('WALL_RUN_START', () => this.burst(0.14, 0.18, 'bandpass', 1800, 1000, 2));
    bus.on('GRAPPLE_FIRED', (e) => {
      this.burst(0.14, 0.22, 'bandpass', 600, 3200, 1.1);
      if (!e.hit) this.tone(300, 150, 0.12, 'square', 0.06, 0, 900);
    });
    bus.on('GRAPPLE_LATCHED', () => {
      this.tone(140, 60, 0.18, 'square', 0.22, 0, 700);
      this.tone(980, 980, 0.07, 'triangle', 0.1, 0.02);
    });
    bus.on('GRAPPLE_RELEASED', (e) => {
      this.burst(0.1, 0.16, 'highpass', 2500, 4500, 0.8);
      if (e.launched) this.tone(260, 700, 0.22, 'sawtooth', 0.12, 0, 1800);
    });
    bus.on('BOOST_PAD', () => {
      this.tone(120, 900, 0.5, 'sawtooth', 0.14, 0, 2400);
      this.burst(0.45, 0.28, 'bandpass', 300, 3500, 1);
    });
    bus.on('CHECKPOINT', () => {
      this.tone(659.25, 659.25, 0.18, 'triangle', 0.16);
      this.tone(880, 880, 0.3, 'triangle', 0.16, 0.09);
    });
    bus.on('RUN_STARTED', () => this.tone(440, 440, 0.1, 'square', 0.08, 0, 1800));
    bus.on('RUN_FINISHED', () => {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this.tone(f, f, 0.5, 'triangle', 0.14, i * 0.11));
      this.tone(130.8, 130.8, 1.2, 'sawtooth', 0.08, 0, 600);
    });
    bus.on('EMP_CHARGE', () => this.tone(120, 620, 1.1, 'sawtooth', 0.09, 0, 1200));
    bus.on('EMP_PULSE', () => {
      this.burst(0.5, 0.4, 'lowpass', 3000, 120, 0.7);
      this.tone(900, 70, 0.5, 'square', 0.12, 0, 1600);
    });
    bus.on('EMP_HIT', () => {
      this.tone(80, 30, 0.6, 'sawtooth', 0.28, 0, 500);
      this.burst(0.35, 0.3, 'bandpass', 4000, 300, 2);
    });
    bus.on('RESPAWN', () => this.tone(500, 120, 0.4, 'sine', 0.2));
  }

  uiClick(): void {
    this.tone(660, 880, 0.06, 'square', 0.06, 0, 2400);
  }

  // ---- internals --------------------------------------------------------------------------

  private startWind(): void {
    const c = this.ctx;
    if (!c || !this.master || !this.noise) return;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 300;
    const g = c.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this.windFilter = f;
    this.windGain = g;

    const s2 = c.createBufferSource();
    s2.buffer = this.noise;
    s2.loop = true;
    s2.playbackRate.value = 0.7;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const sg = c.createGain();
    sg.gain.value = 0;
    s2.connect(hp).connect(sg).connect(this.master);
    s2.start();
    this.slideGain = sg;
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0, lowpass = 0): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node: AudioNode = o;
    if (lowpass > 0) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node = o.connect(f);
    }
    node.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, vol: number, type: BiquadFilterType, f0: number, f1: number, q: number): void {
    const c = this.ctx;
    if (!c || !this.master || !this.noise) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(40, f0), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }
}
