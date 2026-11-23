import { makeBox, type Box } from '../physics/Collision';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Pad {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  dirX: number;
  dirZ: number;
}

export interface Checkpoint {
  x: number;
  y: number;
  z: number;
  /** Where the player respawns when falling after passing this gate. */
  respawn: Vec3;
}

export interface CourseData {
  boxes: Box[];
  /** Main rooftop slabs (subset of `boxes`), used for visuals. */
  roofs: Box[];
  anchors: Vec3[];
  pads: Pad[];
  checkpoints: Checkpoint[];
  finish: Checkpoint;
  spawn: Vec3;
  droneSpawns: Vec3[];
  deathY: number;
}

const ROOF_X = [0, 9, -7, 8, -10, 5, -8, 6, -4, 0];
const ROOF_TOP = [12, 12, 16, 16, 22, 20, 26, 26, 30, 30];
const ROOF_W = 24;
const ROOF_D = 24;
const GAP = 20;
const ANCHOR_LIFT = 9;
const CHECKPOINT_ROOFS = [3, 6];

/**
 * Procedural brutalist rooftop course: ten slabs separated by 20 m gaps. Every gap is
 * crossable with a grapple anchor; wall panels beside alternate gaps offer wall-run shortcuts
 * and boost pads reward carrying speed across the roof.
 */
export function buildCourse(): CourseData {
  const boxes: Box[] = [];
  const roofs: Box[] = [];
  const anchors: Vec3[] = [];
  const pads: Pad[] = [];
  const checkpoints: Checkpoint[] = [];
  const droneSpawns: Vec3[] = [];
  const zs: number[] = [];

  for (let i = 0; i < ROOF_TOP.length; i++) {
    const z = -i * (ROOF_D + GAP);
    zs.push(z);
    const top = ROOF_TOP[i];
    const depth = i === ROOF_TOP.length - 1 ? 34 : ROOF_D;
    const roof = makeBox(ROOF_X[i], top - 25, z, ROOF_W, 50, z === 0 ? ROOF_D : depth, 'roof');
    boxes.push(roof);
    roofs.push(roof);
    // rooftop clutter off the racing line: stairwell blocks double as wall-run surfaces
    if (i > 0 && i < ROOF_TOP.length - 1) {
      const side = i % 2 === 0 ? 1 : -1;
      const prop = makeBox(ROOF_X[i] + side * 8, top + 1.6, z + 4, 4, 3.2, 4, 'prop');
      boxes.push(prop);
    }
    if (i % 2 === 1 && i < ROOF_TOP.length - 1) {
      pads.push({ x: ROOF_X[i], y: top, z: z - 8, w: 5, d: 5, dirX: 0, dirZ: -1 });
    }
    if (CHECKPOINT_ROOFS.includes(i)) {
      checkpoints.push({ x: ROOF_X[i], y: top + 3.5, z, respawn: { x: ROOF_X[i], y: top + 1, z: z + 2 } });
    }
    if (i === 4 || i === 6 || i === 8) droneSpawns.push({ x: ROOF_X[i], y: top + 15, z });
  }

  for (let i = 0; i < ROOF_TOP.length - 1; i++) {
    const midX = (ROOF_X[i] + ROOF_X[i + 1]) / 2;
    const midZ = (zs[i] + zs[i + 1]) / 2;
    const topMax = Math.max(ROOF_TOP[i], ROOF_TOP[i + 1]);
    anchors.push({ x: midX, y: topMax + ANCHOR_LIFT, z: midZ });
    if (i % 2 === 1) {
      const side = i % 4 === 1 ? 1 : -1;
      const h = topMax + 14;
      boxes.push(makeBox(midX + side * 16, h / 2 - 20, midZ, 2.5, h + 40, GAP + 10, 'wall'));
    }
  }

  const last = ROOF_TOP.length - 1;
  const finish: Checkpoint = {
    x: ROOF_X[last],
    y: ROOF_TOP[last] + 3.5,
    z: zs[last],
    respawn: { x: ROOF_X[last], y: ROOF_TOP[last] + 1, z: zs[last] + 2 },
  };

  return {
    boxes,
    roofs,
    anchors,
    pads,
    checkpoints,
    finish,
    spawn: { x: 0, y: ROOF_TOP[0] + 1, z: 4 },
    droneSpawns,
    deathY: -30,
  };
}
