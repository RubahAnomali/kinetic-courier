import type { InputState } from '../game/types';

const SENS = 0.0022;
const BLOCKED = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'Tab', 'ShiftLeft', 'ShiftRight']);

/** DOM input layer: mouse-look via pointer lock, keyboard, mouse buttons and wheel. */
export class Input {
  yaw = 0;
  pitch = 0;
  locked = false;
  /** True once pointer lock has been granted at least once (so losing it can mean "pause"). */
  everLocked = false;
  onKey: ((code: string) => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  onGesture: (() => void) | null = null;

  private readonly keys = new Set<string>();
  private jump = false;
  private grapple = false;
  private grappleHeld = false;
  private rmb = false;
  private wheelT = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.listen(window, 'keydown', (e) => {
      if (BLOCKED.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jump = true;
      this.onGesture?.();
      this.onKey?.(e.code);
    });
    this.listen(window, 'keyup', (e) => this.keys.delete(e.code));
    this.listen(window, 'blur', () => {
      this.keys.clear();
      this.grappleHeld = false;
      this.rmb = false;
    });
    this.listen(window, 'mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * SENS;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * SENS));
    });
    this.listen(canvas, 'mousedown', (e) => {
      this.onGesture?.();
      if (!this.locked) return;
      if (e.button === 0) {
        this.grapple = true;
        this.grappleHeld = true;
      } else if (e.button === 2) this.rmb = true;
    });
    this.listen(window, 'mouseup', (e) => {
      if (e.button === 0) this.grappleHeld = false;
      if (e.button === 2) this.rmb = false;
    });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(canvas, 'wheel', (e) => {
      e.preventDefault();
      if (this.locked) this.wheelT = 0.25;
    });
    this.listen(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) this.everLocked = true;
      this.onLockChange?.(this.locked);
    });
  }

  requestLock(): void {
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      /* pointer lock unavailable; the game still runs with keyboard only */
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called once per rendered frame so wheel pulses decay in real time. */
  tickFrame(dt: number): void {
    this.wheelT = Math.max(0, this.wheelT - dt);
  }

  snapshot(): InputState {
    const k = this.keys;
    const moveZ = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const l = Math.hypot(moveX, moveZ) || 1;
    const s: InputState = {
      moveX: moveX / l,
      moveZ: moveZ / l,
      yaw: this.yaw,
      pitch: this.pitch,
      jumpPressed: this.jump,
      jumpHeld: k.has('Space'),
      slideHeld: k.has('KeyC') || k.has('KeyQ'),
      grapplePressed: this.grapple,
      grappleHeld: this.grappleHeld,
      reelHeld: k.has('ShiftLeft') || k.has('ShiftRight') || this.rmb || this.wheelT > 0,
    };
    this.clearEdges();
    return s;
  }

  clearEdges(): void {
    this.jump = this.grapple = false;
  }

  releaseAll(): void {
    this.keys.clear();
    this.grappleHeld = false;
    this.rmb = false;
    this.clearEdges();
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }

  private listen<K extends keyof WindowEventMap>(t: Window, type: K, fn: (e: WindowEventMap[K]) => void): void;
  private listen<K extends keyof DocumentEventMap>(t: Document, type: K, fn: (e: DocumentEventMap[K]) => void): void;
  private listen<K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void;
  private listen(t: EventTarget, type: string, fn: (e: never) => void): void {
    const handler = fn as EventListener;
    t.addEventListener(type, handler, { passive: false });
    this.cleanups.push(() => t.removeEventListener(type, handler));
  }
}
