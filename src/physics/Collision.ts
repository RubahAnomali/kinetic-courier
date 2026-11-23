export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  kind: 'roof' | 'wall' | 'prop';
}

export function makeBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, kind: Box['kind']): Box {
  return { minX: cx - sx / 2, maxX: cx + sx / 2, minY: cy - sy / 2, maxY: cy + sy / 2, minZ: cz - sz / 2, maxZ: cz + sz / 2, kind };
}

export interface Body3 {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
}

export interface ContactInfo {
  grounded: boolean;
  wall: boolean;
  /** Horizontal wall normal (unit) when `wall` is true. */
  wnx: number;
  wnz: number;
  /** Downward speed at the moment of ground contact (m/s, >= 0). */
  impact: number;
}

export const newContact = (): ContactInfo => ({ grounded: false, wall: false, wnx: 0, wnz: 0, impact: 0 });

/**
 * Sphere vs AABB set. Pushes the body out of every box it overlaps, removes the velocity
 * component into each contact normal, and reports ground / wall contacts.
 */
export function collideSphere(b: Body3, boxes: readonly Box[], out: ContactInfo): void {
  out.grounded = false;
  out.wall = false;
  out.impact = 0;
  for (const box of boxes) {
    const cx = b.x < box.minX ? box.minX : b.x > box.maxX ? box.maxX : b.x;
    const cy = b.y < box.minY ? box.minY : b.y > box.maxY ? box.maxY : b.y;
    const cz = b.z < box.minZ ? box.minZ : b.z > box.maxZ ? box.maxZ : b.z;
    let dx = b.x - cx;
    let dy = b.y - cy;
    let dz = b.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= b.r * b.r) continue;
    let nx: number;
    let ny: number;
    let nz: number;
    let push: number;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      nx = dx / d;
      ny = dy / d;
      nz = dz / d;
      push = b.r - d;
    } else {
      // centre is inside the box: leave through the nearest face
      dx = Math.min(b.x - box.minX, box.maxX - b.x);
      dy = Math.min(b.y - box.minY, box.maxY - b.y);
      dz = Math.min(b.z - box.minZ, box.maxZ - b.z);
      nx = ny = nz = 0;
      if (dx <= dy && dx <= dz) {
        nx = b.x - box.minX < box.maxX - b.x ? -1 : 1;
        push = dx + b.r;
      } else if (dy <= dz) {
        ny = b.y - box.minY < box.maxY - b.y ? -1 : 1;
        push = dy + b.r;
      } else {
        nz = b.z - box.minZ < box.maxZ - b.z ? -1 : 1;
        push = dz + b.r;
      }
    }
    b.x += nx * push;
    b.y += ny * push;
    b.z += nz * push;
    const vn = b.vx * nx + b.vy * ny + b.vz * nz;
    if (vn < 0) {
      if (ny > 0.6) out.impact = Math.max(out.impact, -b.vy);
      b.vx -= vn * nx;
      b.vy -= vn * ny;
      b.vz -= vn * nz;
    }
    if (ny > 0.6) out.grounded = true;
    else if (Math.abs(ny) < 0.35) {
      const h = Math.hypot(nx, nz) || 1;
      out.wall = true;
      out.wnx = nx / h;
      out.wnz = nz / h;
    }
  }
}

export interface RayHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Slab test. Returns null on a miss or when the origin starts inside the box. */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, box: Box): RayHit | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [box.minX, box.minY, box.minZ];
  const hi = [box.maxX, box.maxY, box.maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    let t1 = (lo[i] - o[i]) / d[i];
    let t2 = (hi[i] - o[i]) / d[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) {
      tmin = t1;
      nx = ny = nz = 0;
      const s = d[i] > 0 ? -1 : 1;
      if (i === 0) nx = s;
      else if (i === 1) ny = s;
      else nz = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0 || tmin < 0) return null;
  return { t: tmin, nx, ny, nz };
}

export function raycastBoxes(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, boxes: readonly Box[]): RayHit | null {
  let best: RayHit | null = null;
  for (const b of boxes) {
    const h = rayBox(ox, oy, oz, dx, dy, dz, b);
    if (h && h.t <= max && (!best || h.t < best.t)) best = h;
  }
  return best;
}
