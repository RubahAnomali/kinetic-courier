import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp, damp, DEG } from '../core/math';
import type { Box } from '../physics/Collision';
import { Player } from '../game/Player';
import type { Drone } from '../game/ai/Drone';
import type { GameEvents } from '../game/types';
import type { GrappleTarget, World } from '../game/World';
import type { GhostSample } from '../replay/Replay';
import { PLAYER } from '../game/config';
import { concreteTexture, hazardTexture, padTexture, skyTexture } from './Textures';

const ORANGE = 0xff5b14;
const INK = 0x1b1a18;
const HORIZON = 0xeac9a4;

export interface FrameInfo {
  alpha: number;
  realDt: number;
  yaw: number;
  pitch: number;
  ghost: GhostSample | null;
  aim: GrappleTarget | null;
  debug: boolean;
  time: number;
}

/** Growable line-segment buffer for 3D debug helpers. */
class DebugLines {
  readonly object: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private n = 0;
  private readonly tmp = new THREE.Color();

  constructor(private readonly max = 256) {
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.object = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.visible = false;
  }

  begin(): void {
    this.n = 0;
  }

  add(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color: number): void {
    if (this.n >= this.max) return;
    this.tmp.set(color);
    const o = this.n * 6;
    this.pos.set([x1, y1, z1, x2, y2, z2], o);
    this.col.set([this.tmp.r, this.tmp.g, this.tmp.b, this.tmp.r, this.tmp.g, this.tmp.b], o);
    this.n++;
  }

  end(): void {
    const g = this.object.geometry;
    g.setDrawRange(0, this.n * 2);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

interface DroneVisual {
  group: THREE.Group;
  eyeMat: THREE.MeshBasicMaterial;
  telegraph: THREE.Mesh;
  pulse: THREE.Mesh;
  ring: THREE.Mesh;
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 900);
  readonly debugLines = new DebugLines();

  private readonly disposables: { dispose(): void }[] = [];
  private readonly sun: THREE.DirectionalLight;
  private readonly rope: THREE.Mesh;
  private readonly ghost: THREE.Group;
  private readonly droneViews: DroneVisual[] = [];
  private readonly anchorViews: { group: THREE.Group; ax: number; ay: number; az: number }[] = [];
  private readonly gateBeams: THREE.Mesh[] = [];
  private readonly unsubs: (() => void)[] = [];
  private readonly onResize = (): void => this.resize();

  private fov = 75;
  private fovKick = 0;
  private dip = 0;
  private readonly tmpV = new THREE.Vector3();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly world: World,
    bus: EventBus<GameEvents>,
  ) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;

    const sky = skyTexture();
    this.disposables.push(sky);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(HORIZON, 60, 420);
    this.camera.rotation.order = 'YXZ';

    const hemi = new THREE.HemisphereLight(0xb7c4d4, 0x7a6858, 1.15);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffe2b8, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 10;
    sc.far = 260;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun, this.sun.target);

    this.buildCourse();
    this.buildSkyline();

    const ropeGeo = new THREE.BoxGeometry(1, 1, 1);
    const ropeMat = new THREE.MeshBasicMaterial({ color: INK });
    this.disposables.push(ropeGeo, ropeMat);
    this.rope = new THREE.Mesh(ropeGeo, ropeMat);
    this.rope.visible = false;
    this.rope.frustumCulled = false;
    this.scene.add(this.rope);

    this.ghost = this.buildGhost();
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    for (const d of world.drones) this.droneViews.push(this.buildDrone(d));
    this.scene.add(this.debugLines.object);

    this.unsubs.push(
      bus.on('LANDED', (e) => {
        this.dip = Math.max(this.dip, Math.min(0.4, e.impact * 0.022));
      }),
      bus.on('GRAPPLE_LATCHED', () => {
        this.fovKick = 7;
      }),
      bus.on('BOOST_PAD', () => {
        this.fovKick = 12;
      }),
      bus.on('RESPAWN', () => {
        this.dip = 0;
        this.fovKick = 0;
      }),
    );

    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    for (const u of this.unsubs) u();
    this.debugLines.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.gl.dispose();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Counts of live GPU resources, for the leak check in the debug panel. */
  get memory(): { geometries: number; textures: number } {
    return { geometries: this.gl.info.memory.geometries, textures: this.gl.info.memory.textures };
  }

  render(f: FrameInfo): void {
    const w = this.world;
    const p = w.player;
    const px = p.px + (p.x - p.px) * f.alpha;
    const py = p.py + (p.y - p.py) * f.alpha;
    const pz = p.pz + (p.z - p.pz) * f.alpha;

    // camera rig: speed-reactive FOV, landing dip, wall-run roll, grapple/boost kick
    this.dip = damp(this.dip, 0, 9, f.realDt);
    this.fovKick = damp(this.fovKick, 0, 6, f.realDt);
    this.fov = damp(this.fov, Player.fovFor(p.speed) + this.fovKick, 6, f.realDt);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(px, py + PLAYER.eye - this.dip, pz);
    this.camera.rotation.set(f.pitch, f.yaw, p.roll * DEG);

    this.sun.position.set(px - 55, py + 85, pz + 40);
    this.sun.target.position.set(px, py, pz);

    this.updateRope(f);
    this.updateDrones(f);
    this.updateAnchors(f);
    this.updateGhost(f);
    for (let i = 0; i < this.gateBeams.length; i++) {
      const passed = i < w.nextCheckpoint;
      (this.gateBeams[i].material as THREE.MeshBasicMaterial).color.setHex(passed ? 0xe9e0c8 : 0xffffff);
    }
    this.updateDebug(f, px, py, pz);
    this.gl.render(this.scene, this.camera);
  }

  // ---- scene construction -----------------------------------------------------------------

  private scaledBox(b: Box, mats: THREE.Material[]): THREE.Mesh {
    const sx = b.maxX - b.minX;
    const sy = b.maxY - b.minY;
    const sz = b.maxZ - b.minZ;
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    // faces: +x, -x, +y, -y, +z, -z; 4 vertices each. World-scale the UVs so texel size is uniform (8 m tile).
    const dims: [number, number][] = [
      [sz, sy],
      [sz, sy],
      [sx, sz],
      [sx, sz],
      [sx, sy],
      [sx, sy],
    ];
    for (let f = 0; f < 6; f++) {
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, (uv.getX(i) * dims[f][0]) / 8, (uv.getY(i) * dims[f][1]) / 8);
      }
    }
    const m = new THREE.Mesh(g, mats);
    m.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  private buildCourse(): void {
    const c = this.world.course;
    const bases = ['#b7b0a2', '#aca597', '#c0b9aa'];
    const sideTex = bases.map((b) => concreteTexture(b));
    const topTex = concreteTexture('#c9c2b2');
    const wallTex = concreteTexture('#8d877c');
    const hazard = hazardTexture();
    const pad = padTexture();
    this.disposables.push(...sideTex, topTex, wallTex, hazard, pad);

    const topMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: 1 });
    const sideMats = sideTex.map((t) => new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 1 });
    const propMat = new THREE.MeshStandardMaterial({ map: sideTex[1], roughness: 1, color: 0xd9d2c3 });
    this.disposables.push(topMat, wallMat, propMat, ...sideMats);

    c.boxes.forEach((b) => {
      let mats: THREE.Material[];
      if (b.kind === 'roof') {
        const s = sideMats[Math.floor(Math.abs(b.minX * 7 + b.minZ)) % sideMats.length];
        mats = [s, s, topMat, s, s, s];
      } else if (b.kind === 'wall') mats = Array(6).fill(wallMat) as THREE.Material[];
      else mats = Array(6).fill(propMat) as THREE.Material[];
      this.scene.add(this.scaledBox(b, mats));
    });

    // hazard-stripe edge markers on the lip of every roof, facing the gaps
    const stripeMat = new THREE.MeshBasicMaterial({ map: hazard });
    this.disposables.push(stripeMat);
    for (const r of c.roofs) {
      for (const zEdge of [r.maxZ - 0.5, r.minZ + 0.5]) {
        const g = new THREE.BoxGeometry(r.maxX - r.minX - 0.6, 0.08, 0.7);
        const uv = g.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ((r.maxX - r.minX) / 2), uv.getY(i));
        const m = new THREE.Mesh(g, stripeMat);
        m.position.set((r.minX + r.maxX) / 2, r.maxY + 0.04, zEdge);
        this.scene.add(m);
      }
    }

    for (const p of c.pads) {
      const g = new THREE.PlaneGeometry(p.w, p.d);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: pad }));
      m.position.set(p.x, p.y + 0.05, p.z);
      m.receiveShadow = true;
      this.scene.add(m);
    }

    // anchors: orange crane hooks hanging from thin cables
    const hookGeo = new THREE.SphereGeometry(0.7, 20, 14);
    const hookMat = new THREE.MeshBasicMaterial({ color: ORANGE });
    const ringGeo = new THREE.TorusGeometry(1.5, 0.12, 8, 28);
    const darkMat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.9 });
    const cableGeo = new THREE.BoxGeometry(0.12, 80, 0.12);
    this.disposables.push(hookGeo, hookMat, ringGeo, darkMat, cableGeo);
    for (const a of c.anchors) {
      const g = new THREE.Group();
      g.position.set(a.x, a.y, a.z);
      const hook = new THREE.Mesh(hookGeo, hookMat);
      const ring = new THREE.Mesh(ringGeo, darkMat);
      const cable = new THREE.Mesh(cableGeo, darkMat);
      cable.position.y = 40;
      g.add(hook, ring, cable);
      this.scene.add(g);
      this.anchorViews.push({ group: g, ax: a.x, ay: a.y, az: a.z });
    }

    // gates: two concrete posts and a hazard-striped beam (the last one is the finish)
    const postGeo = new THREE.BoxGeometry(1.2, 8, 1.2);
    const beamGeo = new THREE.BoxGeometry(11.2, 1.1, 1.2);
    this.disposables.push(postGeo, beamGeo);
    [...c.checkpoints, c.finish].forEach((gate, i, all) => {
      const finish = i === all.length - 1;
      const w = finish ? 1.7 : 1;
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, wallMat);
        post.position.set(gate.x + s * 5.6 * w, gate.y - 3.5 + 4, gate.z);
        post.castShadow = true;
        this.scene.add(post);
      }
      const beamMat = new THREE.MeshBasicMaterial({ map: hazard });
      this.disposables.push(beamMat);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.scale.x = w;
      beam.position.set(gate.x, gate.y + 4.5, gate.z);
      this.scene.add(beam);
      this.gateBeams.push(beam);
    });
  }

  private buildSkyline(): void {
    const mat = new THREE.MeshLambertMaterial({ color: 0x8a93a0 });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.disposables.push(mat, geo);
    let s = 5;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 90; i++) {
      const x = (rnd() - 0.5) * 900;
      const z = -190 + (rnd() - 0.5) * 900;
      if (Math.abs(x) < 70 && z > -460 && z < 60) continue;
      const w = 14 + rnd() * 34;
      const h = 30 + rnd() * 150;
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(w, h, 14 + rnd() * 34);
      m.position.set(x, h / 2 - 40, z);
      this.scene.add(m);
    }
  }

  private buildGhost(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xf3ecd8, transparent: true, opacity: 0.4, depthWrite: false });
    const geo = new THREE.CapsuleGeometry(0.38, 0.7, 4, 10);
    const stripe = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.7, depthWrite: false });
    const stripeGeo = new THREE.TorusGeometry(0.4, 0.05, 6, 16);
    this.disposables.push(mat, geo, stripe, stripeGeo);
    const body = new THREE.Mesh(geo, mat);
    const ring = new THREE.Mesh(stripeGeo, stripe);
    ring.rotation.x = Math.PI / 2;
    g.add(body, ring);
    return g;
  }

  private buildDrone(d: Drone): DroneVisual {
    const group = new THREE.Group();
    const bodyGeo = new THREE.OctahedronGeometry(1, 0);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2926, roughness: 0.8, flatShading: true });
    const eyeGeo = new THREE.SphereGeometry(0.3, 12, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: ORANGE });
    const ringGeo = new THREE.TorusGeometry(1.35, 0.06, 6, 28);
    const ringMat = new THREE.MeshBasicMaterial({ color: INK });
    const shellGeo = new THREE.SphereGeometry(1, 28, 16);
    const telMat = new THREE.MeshBasicMaterial({ color: ORANGE, wireframe: true, transparent: true, opacity: 0 });
    const pulseMat = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false });
    this.disposables.push(bodyGeo, bodyMat, eyeGeo, eyeMat, ringGeo, ringMat, shellGeo, telMat, pulseMat);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.scale.set(1, 0.55, 1);
    body.castShadow = true;
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(0, 0, -0.85);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    group.add(body, eye, ring);
    const telegraph = new THREE.Mesh(shellGeo, telMat);
    const pulse = new THREE.Mesh(shellGeo, pulseMat);
    telegraph.visible = false;
    pulse.visible = false;
    this.scene.add(group, telegraph, pulse);
    group.position.set(d.x, d.y, d.z);
    return { group, eyeMat, telegraph, pulse, ring };
  }

  // ---- per-frame updates ------------------------------------------------------------------

  private updateRope(f: FrameInfo): void {
    const p = this.world.player;
    const r = p.rope;
    if (!r.active) {
      this.rope.visible = false;
      return;
    }
    const q = this.camera.quaternion;
    const hand = this.tmpV.set(0.28, -0.24, -0.45).applyQuaternion(q).add(this.camera.position);
    const dx = r.ax - hand.x;
    const dy = r.ay - hand.y;
    const dz = r.az - hand.z;
    const len = Math.hypot(dx, dy, dz);
    const taut = clamp(r.tension / 40, 0, 1);
    const thick = 0.05 - taut * 0.02;
    this.rope.visible = true;
    this.rope.scale.set(thick, thick, len);
    this.rope.position.set(hand.x + dx / 2, hand.y + dy / 2, hand.z + dz / 2);
    this.rope.lookAt(r.ax, r.ay, r.az);
    void f;
  }

  private updateDrones(f: FrameInfo): void {
    this.world.drones.forEach((d, i) => {
      const v = this.droneViews[i];
      const x = d.px + (d.x - d.px) * f.alpha;
      const y = d.py + (d.y - d.py) * f.alpha;
      const z = d.pz + (d.z - d.pz) * f.alpha;
      v.group.position.set(x, y, z);
      if (d.speed > 0.5) v.group.lookAt(x + d.vx, y + d.vy * 0.3, z + d.vz);
      v.ring.rotation.z = f.time * 3 + i;
      v.eyeMat.color.setHex(d.state === 'Charge' ? (Math.floor(f.time * 14) % 2 ? 0xffffff : ORANGE) : d.state === 'Pursue' ? ORANGE : 0x8a5a3c);
      v.telegraph.visible = d.state === 'Charge';
      if (v.telegraph.visible) {
        v.telegraph.position.set(x, y, z);
        v.telegraph.scale.setScalar(14);
        (v.telegraph.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.4 * d.charge;
      }
      v.pulse.visible = d.pulseR > 0;
      if (v.pulse.visible) {
        v.pulse.position.set(d.x, d.y, d.z);
        v.pulse.scale.setScalar(d.pulseR);
        (v.pulse.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - d.pulseR / 14);
      }
    });
  }

  private updateAnchors(f: FrameInfo): void {
    for (const a of this.anchorViews) {
      const aimed = !!f.aim && f.aim.kind === 'anchor' && Math.abs(f.aim.x - a.ax) < 0.01 && Math.abs(f.aim.y - a.ay) < 0.01 && Math.abs(f.aim.z - a.az) < 0.01;
      const s = aimed ? 1.35 + Math.sin(f.time * 12) * 0.12 : 1;
      a.group.scale.setScalar(s);
      a.group.rotation.y = f.time * 0.6;
    }
  }

  private updateGhost(f: FrameInfo): void {
    const g = f.ghost;
    this.ghost.visible = !!g;
    if (g) {
      this.ghost.position.set(g.x, g.y, g.z);
      this.ghost.rotation.y = g.yaw;
    }
  }

  private updateDebug(f: FrameInfo, px: number, py: number, pz: number): void {
    const dl = this.debugLines;
    dl.object.visible = f.debug;
    if (!f.debug) return;
    const w = this.world;
    const p = w.player;
    dl.begin();
    const look = p.lookDir();
    const ex = px;
    const ey = py + PLAYER.eye;
    const ez = pz;
    const hit = f.aim;
    const len = hit ? hit.dist : 12;
    dl.add(ex, ey - 0.15, ez, ex + look.x * len, ey - 0.15 + look.y * len, ez + look.z * len, hit ? 0x33e0ff : 0xff3b3b);
    if (p.rope.active) dl.add(px, py, pz, p.rope.ax, p.rope.ay, p.rope.az, 0xffa030);
    if (p.wallContact) dl.add(px, py, pz, px + p.wallNx * 3, py, pz + p.wallNz * 3, 0x44ff66);
    dl.add(px, py, pz, px + p.vx * 0.3, py + p.vy * 0.3, pz + p.vz * 0.3, 0xffee33);
    for (const d of w.drones) {
      dl.add(d.x, d.y, d.z, d.x + d.vx * 0.4, d.y + d.vy * 0.4, d.z + d.vz * 0.4, 0xffffff);
      if (d.state === 'Pursue' || d.state === 'Charge') {
        dl.add(d.x, d.y, d.z, d.leadX, d.leadY, d.leadZ, 0xff44cc);
        dl.add(d.leadX - 0.6, d.leadY, d.leadZ, d.leadX + 0.6, d.leadY, d.leadZ, 0xff44cc);
        dl.add(d.leadX, d.leadY - 0.6, d.leadZ, d.leadX, d.leadY + 0.6, d.leadZ, 0xff44cc);
        dl.add(d.leadX, d.leadY, d.leadZ - 0.6, d.leadX, d.leadY, d.leadZ + 0.6, 0xff44cc);
      }
    }
    dl.end();
  }
}
