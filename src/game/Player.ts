import { damp } from '../core/math';
import { HFSM, type HLeaf, type HNode } from '../core/HFSM';
import { collideSphere, newContact } from '../physics/Collision';
import { FOV, PLAYER, Tuning, WALL_ROLL_DEG } from './config';
import { emptyInput, type InputState, type LeafId, type ParentId } from './types';
import type { World } from './World';

const ALLOWED: Record<LeafId, readonly LeafId[]> = {
  Idle: ['Run', 'Jump', 'CoyoteTime', 'Swing', 'Slide'],
  Run: ['Idle', 'Slide', 'Jump', 'CoyoteTime', 'Swing'],
  Slide: ['Run', 'Idle', 'Jump', 'CoyoteTime', 'Swing'],
  Jump: ['Fall', 'Idle', 'Run', 'Slide', 'LeftWall', 'RightWall', 'Swing'],
  Fall: ['Jump', 'Idle', 'Run', 'Slide', 'LeftWall', 'RightWall', 'Swing'],
  CoyoteTime: ['Jump', 'Fall', 'Idle', 'Run', 'Slide', 'Swing', 'LeftWall', 'RightWall'],
  Swing: ['ReelIn', 'Fall', 'Jump'],
  ReelIn: ['Swing', 'Fall', 'Jump'],
  LeftWall: ['Jump', 'Fall', 'Idle', 'Run', 'Swing'],
  RightWall: ['Jump', 'Fall', 'Idle', 'Run', 'Swing'],
};

export interface Rope {
  active: boolean;
  ax: number;
  ay: number;
  az: number;
  /** Rest (taut) length. Shrinks while reeling. */
  rest: number;
  /** Current anchor distance. */
  length: number;
  /** Spring pull applied this tick (m/s^2), for telemetry. */
  tension: number;
  kind: 'anchor' | 'surface';
}

// ---- helpers --------------------------------------------------------------------------------

function wishDir(p: Player): { x: number; z: number; mag: number } {
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);
  const x = fx * p.input.moveZ + rx * p.input.moveX;
  const z = fz * p.input.moveZ + rz * p.input.moveX;
  const mag = Math.min(1, Math.hypot(x, z));
  return mag > 1e-6 ? { x: x / Math.hypot(x, z), z: z / Math.hypot(x, z), mag } : { x: 0, z: 0, mag: 0 };
}

function hSpeed(p: Player): number {
  return Math.hypot(p.vx, p.vz);
}

function approach(v: number, target: number, d: number): number {
  return v < target ? Math.min(v + d, target) : Math.max(v - d, target);
}

function gravity(p: Player, dt: number, scale = 1): void {
  p.vy -= Tuning.gravity * scale * dt;
}

function groundMove(p: Player, dt: number): void {
  const w = wishDir(p);
  const max = Tuning.runSpeed;
  const overspeed = hSpeed(p) > max * 1.1;
  const rate = w.mag > 0 ? (overspeed ? 18 : PLAYER.groundAccel) : PLAYER.groundDecel;
  p.vx = approach(p.vx, w.x * w.mag * max, rate * dt);
  p.vz = approach(p.vz, w.z * w.mag * max, rate * dt);
}

/** Quake-style air control: steer freely but never push speed past `airMaxSpeed` along the wish. */
function airMove(p: Player, dt: number, mult = 1): void {
  const w = wishDir(p);
  if (w.mag > 0) {
    const cur = p.vx * w.x + p.vz * w.z;
    const add = Math.min(PLAYER.airAccel * mult * dt, Math.max(0, PLAYER.airMaxSpeed - cur));
    p.vx += w.x * add * w.mag;
    p.vz += w.z * add * w.mag;
  }
  const drag = Math.exp(-PLAYER.airDrag * dt);
  p.vx *= drag;
  p.vz *= drag;
}

function startJump(p: Player, vy: number, cut = true): void {
  p.vy = vy;
  p.jumpBuffer = 0;
  p.jumpCutAllowed = cut;
  p.world.bus.emit('JUMPED', { x: p.x, y: p.y, z: p.z });
  p.fsm.transition('Jump');
}

function land(p: Player): void {
  if (p.jumpBuffer > 0) {
    // buffered jump: bounce straight out of the landing
    p.fsm.transition(p.slideHeld ? 'Slide' : 'Run');
    startJump(p, Tuning.jumpSpeed);
    return;
  }
  if (p.input.slideHeld && hSpeed(p) > PLAYER.slideMinSpeed) p.fsm.transition('Slide');
  else p.fsm.transition(wishDir(p).mag > 0.05 || hSpeed(p) > 0.8 ? 'Run' : 'Idle');
}

function tryGrapple(p: Player): void {
  if (p.grappleCd > 0 || p.empT > 0) {
    p.world.bus.emit('GRAPPLE_FIRED', { hit: false });
    return;
  }
  const look = p.lookDir();
  const eye = p.eye();
  const t = p.world.findGrappleTarget(eye.x, eye.y, eye.z, look.x, look.y, look.z);
  if (!t) {
    p.grappleCd = PLAYER.grappleCooldown;
    p.world.bus.emit('GRAPPLE_FIRED', { hit: false });
    return;
  }
  const dist = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
  p.rope = { active: true, ax: t.x, ay: t.y, az: t.z, rest: Math.max(PLAYER.minRope, dist * 0.97), length: dist, tension: 0, kind: t.kind };
  p.world.bus.emit('GRAPPLE_FIRED', { hit: true });
  p.world.bus.emit('GRAPPLE_LATCHED', { x: t.x, y: t.y, z: t.z });
  p.fsm.transition('Swing');
}

function releaseRope(p: Player, launched: boolean): void {
  if (!p.rope.active) return;
  p.rope.active = false;
  p.rope.tension = 0;
  p.world.bus.emit('GRAPPLE_RELEASED', { launched });
}

// ---- HFSM definition ------------------------------------------------------------------------

const PARENTS: Record<ParentId, HNode<Player>> = {
  Grounded: {
    update(p, dt) {
      gravity(p, dt);
      if (!p.grounded) {
        p.fsm.transition('CoyoteTime');
        return;
      }
      if (p.input.grapplePressed) tryGrapple(p);
    },
  },
  Airborne: {
    update(p, dt) {
      gravity(p, dt);
      airMove(p, dt);
      if (p.input.grapplePressed) {
        tryGrapple(p);
        if (p.fsm.parent === 'Grappling') return;
      }
      if (p.grounded && p.vy <= 0.5) {
        land(p);
        return;
      }
      if (p.wallContact && p.wallJumpLock <= 0 && p.input.moveZ > 0 && hSpeed(p) > PLAYER.wallRunMinSpeed && !p.grounded && p.vy > -22) {
        const rx = Math.cos(p.yaw);
        const rz = -Math.sin(p.yaw);
        p.fsm.transition(p.wallNx * rx + p.wallNz * rz > 0 ? 'LeftWall' : 'RightWall');
      }
    },
  },
  Grappling: {
    update(p, dt) {
      gravity(p, dt);
      airMove(p, dt, 0.5);
      const r = p.rope;
      if (!r.active) {
        p.fsm.transition('Fall');
        return;
      }
      if (p.empT > 0 || !p.input.grappleHeld) {
        releaseRope(p, false);
        p.fsm.transition('Fall');
        return;
      }
      if (p.input.jumpPressed) {
        // launch: a burst along the current heading plus lift, then a free-flight jump
        const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
        p.vx += (p.vx / sp) * PLAYER.launchBoost;
        p.vy += (p.vy / sp) * PLAYER.launchBoost + PLAYER.launchLift;
        p.vz += (p.vz / sp) * PLAYER.launchBoost;
        releaseRope(p, true);
        p.jumpBuffer = 0;
        p.jumpCutAllowed = false;
        p.world.bus.emit('JUMPED', { x: p.x, y: p.y, z: p.z });
        p.fsm.transition('Jump');
        return;
      }
      // Hooke's law with velocity damping along the tether: pull = k * stretch - c * radialVel
      const dx = r.ax - p.x;
      const dy = r.ay - p.y;
      const dz = r.az - p.z;
      const dist = Math.hypot(dx, dy, dz) || 1e-6;
      r.length = dist;
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const stretch = dist - r.rest;
      if (stretch > 0) {
        const radial = p.vx * nx + p.vy * ny + p.vz * nz; // + toward anchor, - away
        const pull = Math.max(0, Tuning.grappleK * stretch - Tuning.grappleDamping * radial);
        p.vx += nx * pull * dt;
        p.vy += ny * pull * dt;
        p.vz += nz * pull * dt;
        r.tension = pull;
      } else {
        r.tension = 0;
      }
    },
    exit(p) {
      if (p.rope.active) releaseRope(p, false);
    },
  },
  WallRunning: {
    enter(p) {
      p.wallRunT = 0;
      p.wallLostT = 0;
    },
    update(p, dt) {
      p.wallRunT += dt;
      p.vy = Math.max(p.vy - Tuning.gravity * 0.1 * dt, -3);
      // keep only the velocity along the wall, then press lightly into it so contact persists
      const into = p.vx * p.wallNx + p.vz * p.wallNz;
      p.vx -= into * p.wallNx;
      p.vz -= into * p.wallNz;
      const decay = Math.exp(-0.15 * dt);
      p.vx *= decay;
      p.vz *= decay;
      p.vx -= p.wallNx * 2.5 * dt * 60;
      p.vz -= p.wallNz * 2.5 * dt * 60;
      p.wallLostT = p.wallContact ? 0 : p.wallLostT + dt;

      if (p.grounded) {
        land(p);
        return;
      }
      if (p.input.jumpPressed) {
        const sp = hSpeed(p) || 1;
        const tx = p.vx / sp;
        const tz = p.vz / sp;
        p.vx = tx * sp * 0.85 + p.wallNx * PLAYER.wallJumpOut;
        p.vz = tz * sp * 0.85 + p.wallNz * PLAYER.wallJumpOut;
        p.vy = PLAYER.wallJumpUp;
        p.wallJumpLock = PLAYER.wallJumpLock;
        p.jumpBuffer = 0;
        p.jumpCutAllowed = false;
        p.world.bus.emit('WALL_JUMPED', { x: p.x, y: p.y, z: p.z });
        p.fsm.transition('Jump');
        return;
      }
      if (p.input.grapplePressed) {
        tryGrapple(p);
        if (p.fsm.parent === 'Grappling') return;
      }
      if (p.wallLostT > 0.12 || p.wallRunT > PLAYER.wallRunMaxTime || hSpeed(p) < 4.5) {
        p.wallJumpLock = 0.15;
        p.fsm.transition('Fall');
      }
    },
    exit(p) {
      p.rollTarget = 0;
    },
  },
};

const LEAVES: Record<LeafId, HLeaf<Player, ParentId>> = {
  Idle: {
    parent: 'Grounded',
    update(p, dt) {
      groundMove(p, dt);
      if (p.jumpBuffer > 0) startJump(p, Tuning.jumpSpeed);
      else if (p.input.slideHeld && hSpeed(p) > PLAYER.slideMinSpeed) p.fsm.transition('Slide');
      else if (wishDir(p).mag > 0.05) p.fsm.transition('Run');
    },
  },
  Run: {
    parent: 'Grounded',
    update(p, dt) {
      groundMove(p, dt);
      if (p.jumpBuffer > 0) startJump(p, Tuning.jumpSpeed);
      else if (p.input.slideHeld && hSpeed(p) > PLAYER.slideMinSpeed) p.fsm.transition('Slide');
      else if (wishDir(p).mag < 0.05 && hSpeed(p) < 0.6) p.fsm.transition('Idle');
    },
  },
  Slide: {
    parent: 'Grounded',
    enter(p) {
      const sp = hSpeed(p);
      if (sp > 0.1 && sp < Tuning.runSpeed * 1.4) {
        const k = Math.min(1.15, (Tuning.runSpeed * 1.4) / sp);
        p.vx *= k;
        p.vz *= k;
      }
      p.world.bus.emit('SLIDE_START', {});
    },
    update(p, dt) {
      const w = wishDir(p);
      const drag = Math.exp(-PLAYER.slideDrag * dt);
      p.vx = p.vx * drag + w.x * 5 * dt;
      p.vz = p.vz * drag + w.z * 5 * dt;
      if (p.jumpBuffer > 0) startJump(p, Tuning.jumpSpeed);
      else if (!p.input.slideHeld || hSpeed(p) < 3) p.fsm.transition(wishDir(p).mag > 0.05 ? 'Run' : 'Idle');
    },
  },
  Jump: {
    parent: 'Airborne',
    update(p) {
      if (p.jumpCutAllowed && !p.input.jumpHeld && p.vy > 2) {
        p.vy *= 0.55;
        p.jumpCutAllowed = false;
      }
      if (p.vy <= 0) p.fsm.transition('Fall');
    },
  },
  Fall: { parent: 'Airborne' },
  CoyoteTime: {
    parent: 'Airborne',
    update(p) {
      if (p.jumpBuffer > 0) startJump(p, Tuning.jumpSpeed);
      else if (p.fsm.leafTime > PLAYER.coyote) p.fsm.transition('Fall');
    },
  },
  Swing: {
    parent: 'Grappling',
    update(p) {
      if (p.input.reelHeld) p.fsm.transition('ReelIn');
    },
  },
  ReelIn: {
    parent: 'Grappling',
    update(p, dt) {
      const r = p.rope;
      if (!r.active) return;
      r.rest = Math.max(PLAYER.minRope, r.rest - Tuning.reelSpeed * dt);
      const dx = r.ax - p.x;
      const dy = r.ay - p.y;
      const dz = r.az - p.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const a = 30 * dt;
      p.vx += (dx / d) * a;
      p.vy += (dy / d) * a;
      p.vz += (dz / d) * a;
      if (!p.input.reelHeld) p.fsm.transition('Swing');
    },
  },
  LeftWall: {
    parent: 'WallRunning',
    enter(p) {
      p.rollTarget = -WALL_ROLL_DEG;
      p.world.bus.emit('WALL_RUN_START', { side: -1 });
    },
  },
  RightWall: {
    parent: 'WallRunning',
    enter(p) {
      p.rollTarget = WALL_ROLL_DEG;
      p.world.bus.emit('WALL_RUN_START', { side: 1 });
    },
  },
};

// ---- Player ---------------------------------------------------------------------------------

export class Player {
  x = 0;
  y = 0;
  z = 0;
  px = 0;
  py = 0;
  pz = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  readonly r = PLAYER.radius;
  yaw = 0;
  pitch = 0;
  input: InputState = emptyInput();

  grounded = false;
  wallContact = false;
  wallNx = 0;
  wallNz = 0;
  wallRunT = 0;
  wallLostT = 0;
  jumpBuffer = 0;
  wallJumpLock = 0;
  grappleCd = 0;
  empT = 0;
  jumpCutAllowed = true;
  rollTarget = 0;
  /** Smoothed camera roll in degrees. */
  roll = 0;
  rope: Rope = { active: false, ax: 0, ay: 0, az: 0, rest: 0, length: 0, tension: 0, kind: 'anchor' };

  private readonly contact = newContact();
  readonly fsm: HFSM<Player, LeafId, ParentId>;

  constructor(readonly world: World) {
    this.fsm = new HFSM<Player, LeafId, ParentId>(this, PARENTS, LEAVES, ALLOWED, 'Fall');
  }

  get slideHeld(): boolean {
    return this.input.slideHeld;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  /** Teleport and clear all motion / state (used for start, restart and checkpoint respawn). */
  place(x: number, y: number, z: number, yaw: number): void {
    this.x = this.px = x;
    this.y = this.py = y;
    this.z = this.pz = z;
    this.vx = this.vy = this.vz = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.wallContact = false;
    this.wallRunT = this.wallLostT = 0;
    this.jumpBuffer = this.wallJumpLock = this.grappleCd = this.empT = 0;
    this.jumpCutAllowed = true;
    this.rollTarget = this.roll = 0;
    this.rope.active = false;
    this.rope.tension = 0;
    this.fsm.reset();
  }

  eye(): { x: number; y: number; z: number } {
    return { x: this.x, y: this.y + PLAYER.eye, z: this.z };
  }

  lookDir(): { x: number; y: number; z: number } {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  update(dt: number, input: InputState): void {
    this.input = input;
    this.yaw = input.yaw;
    this.pitch = input.pitch;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.wallJumpLock = Math.max(0, this.wallJumpLock - dt);
    this.grappleCd = Math.max(0, this.grappleCd - dt);
    this.empT = Math.max(0, this.empT - dt);
    if (input.jumpPressed) this.jumpBuffer = PLAYER.jumpBuffer;

    this.fsm.update(dt);

    if (this.empT > 0) {
      // EMP disruption: heavy drag on the whole velocity
      const d = Math.exp(-1.6 * dt);
      this.vx *= d;
      this.vy *= d;
      this.vz *= d;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    const wasGrounded = this.grounded;
    collideSphere(this, this.world.course.boxes, this.contact);
    this.grounded = this.contact.grounded;
    this.wallContact = this.contact.wall;
    if (this.contact.wall) {
      this.wallNx = this.contact.wnx;
      this.wallNz = this.contact.wnz;
    }
    if (!wasGrounded && this.grounded && this.contact.impact > 5) this.world.bus.emit('LANDED', { impact: this.contact.impact });
    this.roll = damp(this.roll, this.rollTarget, 10, dt);
  }

  /** Target FOV for the camera rig, derived from speed. */
  static fovFor(speed: number): number {
    const t = Math.min(1, Math.max(0, (speed - FOV.slowSpeed) / (FOV.fastSpeed - FOV.slowSpeed)));
    return FOV.min + (FOV.max - FOV.min) * t;
  }
}
