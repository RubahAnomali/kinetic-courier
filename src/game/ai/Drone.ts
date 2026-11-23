import { clamp } from '../../core/math';
import { collideSphere, newContact, raycastBoxes, type Box } from '../../physics/Collision';
import { Tuning } from '../config';
import type { Vec3 } from '../Course';
import type { World } from '../World';

export type DroneState = 'Patrol' | 'Pursue' | 'Charge' | 'Recover';

const RADIUS = 0.9;
const ACCEL = 32;
const PURSUE_RANGE = 58;
const LEASH_RANGE = 95;
const EMP_TRIGGER = 26;
const CHARGE_TIME = 1.1;
const RECOVER_TIME = 1.0;
const EMP_MAX_RADIUS = 14;
const EMP_SPEED = 22;
const WHISKER_LEN = 11;
const SEPARATION_RADIUS = 9;

export class Drone {
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx = 0;
  vy = 0;
  vz = 0;
  readonly r = RADIUS;
  state: DroneState = 'Patrol';
  stateT = 0;
  cd = 2;
  /** 0..1 progress of the EMP windup (telegraph). */
  charge = 0;
  /** Current EMP shell radius while a pulse is active, else 0. */
  pulseR = 0;
  pulseHit = false;

  // debug / presentation vectors
  leadX = 0;
  leadY = 0;
  leadZ = 0;
  lookAhead = 0;

  private readonly contact = newContact();
  private t = 0;

  constructor(
    readonly index: number,
    readonly home: Vec3,
  ) {
    this.x = this.px = home.x;
    this.y = this.py = home.y;
    this.z = this.pz = home.z;
  }

  reset(): void {
    this.x = this.px = this.home.x;
    this.y = this.py = this.home.y;
    this.z = this.pz = this.home.z;
    this.vx = this.vy = this.vz = 0;
    this.state = 'Patrol';
    this.stateT = 0;
    this.cd = 2;
    this.charge = 0;
    this.pulseR = 0;
    this.pulseHit = false;
    this.t = this.index * 1.7;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  update(dt: number, w: World, drones: readonly Drone[]): void {
    this.t += dt;
    this.stateT += dt;
    this.cd = Math.max(0, this.cd - dt);
    const p = w.player;
    const dist = Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z);
    const maxSpeed = Tuning.droneSpeed;

    let tx = this.x;
    let ty = this.y;
    let tz = this.z;
    let speedMul = 1;

    switch (this.state) {
      case 'Patrol': {
        const a = this.t * 0.45 + this.index;
        tx = this.home.x + Math.cos(a) * 9;
        ty = this.home.y + Math.sin(a * 1.3) * 1.5;
        tz = this.home.z + Math.sin(a) * 9;
        speedMul = 0.5;
        if (dist < PURSUE_RANGE) this.setState('Pursue');
        break;
      }
      case 'Pursue': {
        // Velocity-leading interception: aim where the courier will be, not where they are.
        this.lookAhead = clamp(dist / Math.max(maxSpeed, 1), 0, 1.2);
        this.leadX = p.x + p.vx * this.lookAhead;
        this.leadY = p.y + p.vy * this.lookAhead * 0.5 + 1.5;
        this.leadZ = p.z + p.vz * this.lookAhead;
        tx = this.leadX;
        ty = this.leadY;
        tz = this.leadZ;
        if (dist > LEASH_RANGE) this.setState('Patrol');
        else if (dist < EMP_TRIGGER && this.cd <= 0) {
          this.setState('Charge');
          w.bus.emit('EMP_CHARGE', { drone: this.index });
        }
        break;
      }
      case 'Charge': {
        speedMul = 0.25;
        this.charge = clamp(this.stateT / CHARGE_TIME, 0, 1);
        tx = p.x;
        ty = p.y + 2;
        tz = p.z;
        if (this.stateT >= CHARGE_TIME) {
          this.setState('Recover');
          this.pulseR = 0.01;
          this.pulseHit = false;
          this.charge = 0;
          w.bus.emit('EMP_PULSE', { drone: this.index });
        }
        break;
      }
      case 'Recover': {
        speedMul = 0.35;
        tx = this.x;
        ty = this.y + 1;
        tz = this.z;
        if (this.stateT >= RECOVER_TIME) {
          this.cd = 4;
          this.setState('Pursue');
        }
        break;
      }
    }

    // Reynolds steering: seek + separation + whisker obstacle avoidance
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dz = tz - this.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const arrive = this.state === 'Patrol' ? clamp(dl / 6, 0, 1) : 1;
    const desired = maxSpeed * speedMul * arrive;
    let ax = (dx / dl) * desired - this.vx;
    let ay = (dy / dl) * desired - this.vy;
    let az = (dz / dl) * desired - this.vz;
    const al = Math.hypot(ax, ay, az);
    if (al > ACCEL) {
      ax = (ax / al) * ACCEL;
      ay = (ay / al) * ACCEL;
      az = (az / al) * ACCEL;
    }

    for (const o of drones) {
      if (o === this) continue;
      const sx = this.x - o.x;
      const sy = this.y - o.y;
      const sz = this.z - o.z;
      const sd = Math.hypot(sx, sy, sz);
      if (sd > 0.01 && sd < SEPARATION_RADIUS) {
        const f = ((SEPARATION_RADIUS - sd) / SEPARATION_RADIUS) * ACCEL * 1.2;
        ax += (sx / sd) * f;
        ay += (sy / sd) * f;
        az += (sz / sd) * f;
      }
    }

    const av = this.avoid(w.course.boxes);
    ax += av.x;
    ay += av.y;
    az += av.z;

    this.vx += ax * dt;
    this.vy += ay * dt;
    this.vz += az * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    collideSphere(this, w.course.boxes, this.contact);

    if (this.pulseR > 0) this.updatePulse(dt, w);
  }

  private setState(s: DroneState): void {
    this.state = s;
    this.stateT = 0;
  }

  /** Three whiskers (forward, +/-35 degrees yaw) plus one downward; each hit pushes along the surface normal. */
  private avoid(boxes: readonly Box[]): Vec3 {
    const out = { x: 0, y: 0, z: 0 };
    const sp = this.speed;
    if (sp < 0.5) return out;
    const fx = this.vx / sp;
    const fy = this.vy / sp;
    const fz = this.vz / sp;
    const c = Math.cos(0.61);
    const s = Math.sin(0.61);
    const dirs: [number, number, number][] = [
      [fx, fy, fz],
      [fx * c - fz * s, fy, fx * s + fz * c],
      [fx * c + fz * s, fy, -fx * s + fz * c],
      [0, -1, 0],
    ];
    for (const d of dirs) {
      const hit = raycastBoxes(this.x, this.y, this.z, d[0], d[1], d[2], WHISKER_LEN, boxes);
      if (!hit) continue;
      const k = (1 - hit.t / WHISKER_LEN) * ACCEL * 2.4;
      out.x += hit.nx * k;
      out.y += hit.ny * k;
      out.z += hit.nz * k;
    }
    return out;
  }

  private updatePulse(dt: number, w: World): void {
    const prev = this.pulseR;
    this.pulseR += EMP_SPEED * dt;
    const p = w.player;
    if (!this.pulseHit) {
      const d = Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z);
      // the player is hit when the expanding shell sweeps past them
      if (d >= prev - 0.6 && d <= this.pulseR + 0.6) {
        this.pulseHit = true;
        w.applyEmp();
      }
    }
    if (this.pulseR >= EMP_MAX_RADIUS) this.pulseR = 0;
  }
}
