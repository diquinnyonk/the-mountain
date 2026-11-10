import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface ClimberLook {
  suit: number;
  pack: number;
  helmet: number;
  /** 0 slim, 1 average, 2 broad. Picked from the colours when not given, so it is stable. */
  build?: number;
}

export type ClimberPose = 'walk' | 'sit' | 'lie' | 'jumar';

// ---------------------------------------------------------------------------
// The suit is one continuous skinned surface, lofted from cross-sections and
// bent by the skeleton below, so there are no gaps at the hips, knees or elbows.
// Boots, mittens, the head and the pack are rigid parts on their bones.
// Bone order used by the skin weights:
const B = { hips: 0, spine: 1, neck: 2, thighL: 3, kneeL: 4, ankleL: 5, thighR: 6, kneeR: 7, ankleR: 8, shoulderL: 9, elbowL: 10, shoulderR: 11, elbowR: 12 } as const;
const BONES = 13;

// Rest-pose layout (metres, body space), matching the group positions in the constructor.
const HIPS_Y = 0.97, HIP_X = 0.1, HIP_DROP = 0.02, LEG_SEG = 0.44;
const SPINE_UP = 0.06, SHOULDER_X = 0.218, SHOULDER_UP = 0.43, NECK_UP = 0.56, ELBOW_DROP = 0.29;

interface Key { y: number; rx: number; zf?: number; zb?: number; w: [number, number][]; shade?: number }

/**
 * Loft a closed tube up the y axis through elliptical cross-sections (front and
 * back depths can differ), sampled every `step` metres. Down baffles are a small
 * ripple in the radius. Each vertex carries up to three bone weights.
 */
function loft(keys: Key[], o: { cx: number; cz?: number; seg: number; step: number; baffle: number; amp: number; girth: number }) {
  keys = [...keys].sort((a, b) => a.y - b.y);
  const pos: number[] = [], col: number[] = [], si: number[] = [], sw: number[] = [], idx: number[] = [];
  const cz = o.cz ?? 0;
  const y0 = keys[0].y, y1 = keys[keys.length - 1].y;
  const n = Math.max(2, Math.round((y1 - y0) / o.step));
  const at = (y: number) => {
    let i = 0;
    while (i < keys.length - 2 && y > keys[i + 1].y) i++;
    const a = keys[i], b = keys[i + 1];
    const t0 = THREE.MathUtils.clamp((y - a.y) / (b.y - a.y || 1), 0, 1);
    const t = t0 * t0 * (3 - 2 * t0);
    const lerp = (p: number, q: number) => p + (q - p) * t;
    const w = new Map<number, number>();
    for (const [bi, v] of a.w) w.set(bi, (w.get(bi) ?? 0) + v * (1 - t0));
    for (const [bi, v] of b.w) w.set(bi, (w.get(bi) ?? 0) + v * t0);
    return {
      rx: lerp(a.rx, b.rx), zf: lerp(a.zf ?? a.rx, b.zf ?? b.rx), zb: lerp(a.zb ?? a.rx, b.zb ?? b.rx),
      shade: lerp(a.shade ?? 1, b.shade ?? 1), w: [...w.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4),
    };
  };
  const pushV = (x: number, y: number, z: number, shade: number, w: [number, number][]) => {
    pos.push(x, y, z);
    col.push(shade, shade, shade);
    const total = w.reduce((s, [, v]) => s + v, 0) || 1;
    for (let k = 0; k < 4; k++) {
      si.push(w[k]?.[0] ?? 0);
      sw.push((w[k]?.[1] ?? 0) / total);
    }
  };
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    const r = at(y);
    // Baffles: soft ridges, fading out at the ends of the tube.
    const ends = Math.min(1, (y - y0) / 0.05, (y1 - y) / 0.05);
    const ripple = 1 + o.amp * ends * (Math.cos((2 * Math.PI * (y - y0)) / o.baffle) * 0.5 + 0.5) ** 2;
    for (let j = 0; j < o.seg; j++) {
      const th = (j / o.seg) * Math.PI * 2;
      const c = Math.cos(th);
      pushV(o.cx + Math.sin(th) * r.rx * o.girth * ripple, y, cz + c * (c > 0 ? r.zf : r.zb) * o.girth * ripple, r.shade, r.w);
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < o.seg; j++) {
      const a = i * o.seg + j, b = i * o.seg + ((j + 1) % o.seg), c = a + o.seg, d = b + o.seg;
      idx.push(a, b, c, b, d, c);
    }
  }
  // End caps.
  for (const [ring, y, flip] of [[0, y0, true], [n, y1, false]] as [number, number, boolean][]) {
    const r = at(y);
    const centre = pos.length / 3;
    pushV(o.cx, y, cz, r.shade, r.w);
    for (let j = 0; j < o.seg; j++) {
      const a = ring * o.seg + j, b = ring * o.seg + ((j + 1) % o.seg);
      if (flip) idx.push(centre, b, a);
      else idx.push(centre, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  return g;
}

/** The down suit (torso, legs, arms) and the boot gaiters, for one build. */
function buildSuit(girth: number) {
  const parts: THREE.BufferGeometry[] = [];
  const DARK = 0.1; // shoulder yoke and cuffs, a darker panel as on real 8,000 m suits
  // Torso, crotch to neck.
  parts.push(loft([
    { y: 0.83, rx: 0.1, zf: 0.09, zb: 0.09, w: [[B.hips, 1]] },
    { y: 0.9, rx: 0.165, zf: 0.115, zb: 0.125, w: [[B.hips, 1]] },
    { y: 0.99, rx: 0.183, zf: 0.122, zb: 0.13, w: [[B.hips, 1]] },
    { y: 1.07, rx: 0.185, zf: 0.125, zb: 0.125, w: [[B.hips, 0.6], [B.spine, 0.4]] },
    { y: 1.15, rx: 0.182, zf: 0.13, zb: 0.12, w: [[B.spine, 1]] },
    { y: 1.25, rx: 0.186, zf: 0.145, zb: 0.125, w: [[B.spine, 1]] },
    { y: 1.35, rx: 0.198, zf: 0.15, zb: 0.13, w: [[B.spine, 1]] },
    { y: 1.405, rx: 0.205, zf: 0.147, zb: 0.128, w: [[B.spine, 1]], shade: 1 },
    { y: 1.415, rx: 0.207, zf: 0.145, zb: 0.127, w: [[B.spine, 1]], shade: DARK },
    { y: 1.45, rx: 0.21, zf: 0.138, zb: 0.122, w: [[B.spine, 1]], shade: DARK },
    { y: 1.49, rx: 0.19, zf: 0.12, zb: 0.11, w: [[B.spine, 1]], shade: DARK },
    { y: 1.53, rx: 0.14, zf: 0.1, zb: 0.098, w: [[B.spine, 1]], shade: DARK },
    { y: 1.58, rx: 0.085, zf: 0.075, zb: 0.075, w: [[B.spine, 0.5], [B.neck, 0.5]], shade: DARK },
    { y: 1.66, rx: 0.07, zf: 0.065, zb: 0.065, w: [[B.neck, 1]], shade: DARK },
  ], { cx: 0, seg: 22, step: 0.014, baffle: 0.1, amp: 0.028, girth }));
  const gaiters: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const T = side < 0 ? B.thighL : B.thighR, K = side < 0 ? B.kneeL : B.kneeR, A = side < 0 ? B.ankleL : B.ankleR;
    const top = HIPS_Y - HIP_DROP;
    const k = (dy: number, rx: number, w: [number, number][], zf?: number, zb?: number): Key => ({ y: top + dy, rx, zf, zb, w });
    parts.push(loft([
      k(0.09, 0.06, [[B.hips, 0.85], [T, 0.15]]),
      k(0.04, 0.095, [[B.hips, 0.65], [T, 0.35]]),
      k(0, 0.112, [[B.hips, 0.45], [T, 0.55]]),
      k(-0.08, 0.118, [[T, 1]]),
      k(-0.2, 0.104, [[T, 1]], 0.11),
      k(-0.32, 0.094, [[T, 1]]),
      k(-0.4, 0.086, [[T, 0.75], [K, 0.25]]),
      k(-0.44, 0.084, [[T, 0.5], [K, 0.5]], 0.09),
      k(-0.48, 0.083, [[T, 0.2], [K, 0.8]]),
      k(-0.56, 0.08, [[K, 1]], 0.078, 0.088),
      k(-0.66, 0.072, [[K, 1]]),
      k(-0.72, 0.064, [[K, 1]]),
    ], { cx: side * HIP_X, seg: 18, step: 0.014, baffle: 0.09, amp: 0.022, girth }));
    // Yellow insulated gaiter of the double boot, from mid-shin to the ankle.
    gaiters.push(loft([
      k(-0.63, 0.07, [[K, 1]]),
      k(-0.64, 0.08, [[K, 1]]),
      k(-0.72, 0.078, [[K, 1]], 0.076, 0.082),
      k(-0.8, 0.076, [[K, 0.65], [A, 0.35]], 0.08, 0.08),
      k(-0.85, 0.074, [[K, 0.3], [A, 0.7]], 0.08, 0.078),
      k(-0.89, 0.07, [[A, 1]]),
    ], { cx: side * HIP_X, seg: 18, step: 0.02, baffle: 0.05, amp: 0.012, girth: 1 }));
  }
  for (const side of [-1, 1]) {
    const S = side < 0 ? B.shoulderL : B.shoulderR, E = side < 0 ? B.elbowL : B.elbowR;
    const top = HIPS_Y + SPINE_UP + SHOULDER_UP;
    const k = (dy: number, rx: number, w: [number, number][], shade = 1, zb?: number): Key => ({ y: top + dy, rx, zb, w, shade });
    parts.push(loft([
      k(0.05, 0.02, [[B.spine, 0.7], [S, 0.3]], DARK),
      k(0.04, 0.055, [[B.spine, 0.65], [S, 0.35]], DARK),
      k(0.02, 0.076, [[B.spine, 0.5], [S, 0.5]], DARK),
      k(-0.01, 0.084, [[B.spine, 0.3], [S, 0.7]], DARK),
      k(-0.05, 0.081, [[S, 1]], DARK),
      k(-0.06, 0.08, [[S, 1]]),
      k(-0.17, 0.072, [[S, 1]]),
      k(-0.25, 0.066, [[S, 0.75], [E, 0.25]]),
      k(-0.29, 0.065, [[S, 0.5], [E, 0.5]], 1, 0.07),
      k(-0.33, 0.064, [[S, 0.2], [E, 0.8]]),
      k(-0.42, 0.06, [[E, 1]]),
      k(-0.49, 0.057, [[E, 1]]),
      k(-0.495, 0.058, [[E, 1]]),
      k(-0.5, 0.06, [[E, 1]], DARK),
      k(-0.56, 0.058, [[E, 1]], DARK),
    ], { cx: side * SHOULDER_X, seg: 14, step: 0.014, baffle: 0.075, amp: 0.02, girth: 0.6 + 0.4 * girth }));
  }
  const suit = mergeGeometries(parts), boots = mergeGeometries(gaiters);
  suit.computeVertexNormals();
  boots.computeVertexNormals();
  return { suit, gaiters: boots };
}

const suitCache = new Map<number, { suit: THREE.BufferGeometry; gaiters: THREE.BufferGeometry }>();
const suitFor = (girth: number) => {
  let s = suitCache.get(girth);
  if (!s) suitCache.set(girth, (s = buildSuit(girth)));
  return s;
};

// Shared rigid parts: every climber reuses these; only materials differ.
const G = (() => {
  const ring = (r: number, t: number) => new THREE.TorusGeometry(r, t, 6, 28).rotateX(Math.PI / 2);
  const tube = (pts: number[][], r: number) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]))), 16, r, 5);
  const strap = (side: number) => tube([[0.1 * side, 0.5, -0.12], [0.13 * side, 0.555, 0], [0.12 * side, 0.5, 0.125], [0.11 * side, 0.38, 0.158], [0.1 * side, 0.22, 0.16]], 0.016);
  return {
    harness: ring(1, 0.11),
    legLoop: ring(0.125, 0.016),
    // Double boot: a rounded black shell with a defined toe and heel, sole and crampon.
    boot: new RoundedBoxGeometry(0.128, 0.13, 0.29, 2, 0.045).translate(0, -0.03, 0.045),
    welt: new RoundedBoxGeometry(0.135, 0.028, 0.305, 2, 0.012).translate(0, -0.09, 0.045),
    crampon: new THREE.BoxGeometry(0.115, 0.018, 0.28).translate(0, -0.112, 0.045),
    // Big down mitten with a separate thumb.
    mitten: new THREE.SphereGeometry(1, 14, 10).scale(0.058, 0.088, 0.07).translate(0, -0.33, 0.012),
    thumb: new THREE.CapsuleGeometry(0.022, 0.04, 3, 8).rotateX(-0.5).translate(0, -0.3, 0.065),
    head: new THREE.SphereGeometry(0.095, 16, 12).translate(0, 0.11, 0.01),
    face: new THREE.SphereGeometry(0.093, 12, 8, -1, 2, 0.95, 1.1).translate(0, 0.11, 0.016),
    hood: new THREE.SphereGeometry(0.125, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.7).scale(1.02, 1.06, 1.06).translate(0, 0.1, -0.018),
    ruff: new THREE.TorusGeometry(0.09, 0.018, 6, 22).scale(1, 1.15, 0.5).translate(0, 0.1, 0.082),
    helmet: new THREE.SphereGeometry(0.13, 20, 8, 0, Math.PI * 2, 0, Math.PI * 0.45).scale(1, 0.95, 1.06).translate(0, 0.133, -0.004),
    goggles: new THREE.CylinderGeometry(0.105, 0.105, 0.055, 20, 1, true, -1.05, 2.1).translate(0, 0.128, 0.014),
    gStrap: new THREE.TorusGeometry(0.131, 0.008, 4, 28).rotateX(Math.PI / 2).translate(0, 0.145, -0.004),
    mask: new THREE.SphereGeometry(0.05, 12, 8).scale(1, 0.95, 0.85).translate(0, 0.063, 0.097),
    lamp: new THREE.BoxGeometry(0.045, 0.032, 0.028).translate(0, 0.188, 0.125),
    pack: new RoundedBoxGeometry(0.3, 0.5, 0.19, 3, 0.06),
    lid: new RoundedBoxGeometry(0.27, 0.08, 0.17, 2, 0.035),
    packBand: new THREE.BoxGeometry(0.31, 0.022, 0.02),
    strapL: strap(-1),
    strapR: strap(1),
    sternum: new THREE.BoxGeometry(0.2, 0.02, 0.012),
    bottle: new THREE.CylinderGeometry(0.052, 0.052, 0.5, 14),
    regulator: new THREE.CylinderGeometry(0.02, 0.02, 0.07, 8),
    hose: tube([[0.1, 0.67, -0.21], [0.2, 0.66, -0.08], [0.16, 0.62, 0.08], [0.03, 0.625, 0.12]], 0.011),
    axeShaft: new THREE.CylinderGeometry(0.012, 0.012, 0.62, 6).translate(0, -0.27, 0),
    axeHead: new THREE.BoxGeometry(0.04, 0.03, 0.26).translate(0, 0.03, 0.03),
    pole: new THREE.CylinderGeometry(0.009, 0.007, 1.1, 5).translate(0, -0.5, 0),
    basket: new THREE.CylinderGeometry(0.04, 0.04, 0.008, 8).translate(0, -0.97, 0),
  };
})();

const damp = (cur: number, target: number, k: number) => cur + (target - cur) * k;

/** Joint angles (radians) that make up a pose; blended toward each frame. */
interface Joints {
  hipsY: number; hipsYaw: number; hipsRoll: number;
  spineX: number; spineYaw: number; neckX: number; neckYaw: number; hipsX: number; heave: number;
  thighL: number; thighR: number; kneeL: number; kneeR: number; ankleL: number; ankleR: number;
  shoulderL: number; shoulderR: number; elbowL: number; elbowR: number; armOutL: number; armOutR: number;
  lie: number;
}

const zeroJoints = (): Joints => ({
  hipsY: HIPS_Y, hipsYaw: 0, hipsRoll: 0, spineX: 0.05, spineYaw: 0, neckX: 0, neckYaw: 0, hipsX: 0, heave: 0,
  thighL: 0, thighR: 0, kneeL: 0.05, kneeR: 0.05, ankleL: 0, ankleR: 0,
  shoulderL: 0, shoulderR: 0, elbowL: -0.3, elbowR: -0.3, armOutL: 0.12, armOutR: 0.12, lie: 0,
});

/**
 * A high-altitude climber with a proper skeleton (hips, spine, neck, two-bone
 * legs and arms) dressed for 8,000 m: baffled down suit, fur-ruffed hood, helmet,
 * goggles, oxygen mask and hose, harness, pack and cylinder, double boots with
 * crampons, mittens, ice axe and trekking pole.
 */
export class ClimberModel {
  readonly root = new THREE.Group();
  readonly headlamp: THREE.SpotLight | null;
  private body = new THREE.Group();
  private hips = new THREE.Group();
  private spine = new THREE.Group();
  private neck = new THREE.Group();
  private legs: { thigh: THREE.Group; knee: THREE.Group; ankle: THREE.Group }[] = [];
  private arms: { shoulder: THREE.Group; elbow: THREE.Group }[] = [];
  private o2Parts: THREE.Object3D[] = [];
  private detail: THREE.Object3D[] = [];
  private lampMat: THREE.MeshStandardMaterial;
  private materials: THREE.MeshStandardMaterial[] = [];
  private phase = Math.random() * Math.PI * 2;
  private breath = Math.random() * 6;
  private walkBlend = 0;
  private j = zeroJoints();
  private yawInit = false;
  private flinchT = 0;
  private idleT = Math.random() * 100;
  private ground: ((x: number, z: number) => number) | null = null;
  /** Off on ladders (nothing under the feet) and for distant climbers. */
  groundEnabled = true;
  private tmp = new THREE.Vector3();
  private pole: THREE.Group | null = null;

  constructor(look: ClimberLook, withLight = false) {
    const mat = (color: number, roughness = 0.7, metalness = 0) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      this.materials.push(m);
      return m;
    };
    const suit = mat(look.suit, 0.5);
    const black = mat(0x1c1d21, 0.8);
    const sole = mat(0x2a2b2f, 0.9);
    const bootYellow = mat(0xf2b705, 0.45);
    const metal = mat(0xaab0b8, 0.35, 0.8);
    const fur = mat(0x5f554b, 1);
    const skin = mat(0x7d5540, 0.8);
    const lens = mat(0x2a3d55, 0.08, 0.4);
    const helmet = mat(look.helmet, 0.35);
    const packM = mat(look.pack, 0.75);
    const orange = mat(0xe8711e, 0.4, 0.2);
    const harness = mat(0x2b4a7a, 0.7);
    this.lampMat = mat(0x333333, 0.3);

    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, opts: { pos?: number[]; scale?: number[]; rot?: number[]; detail?: boolean; shadow?: boolean } = {}) => {
      const mesh = new THREE.Mesh(geo, m);
      if (opts.pos) mesh.position.set(opts.pos[0], opts.pos[1], opts.pos[2]);
      if (opts.scale) mesh.scale.set(opts.scale[0], opts.scale[1], opts.scale[2]);
      if (opts.rot) mesh.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
      mesh.castShadow = opts.shadow ?? !opts.detail;
      parent.add(mesh);
      if (opts.detail) this.detail.push(mesh);
      return mesh;
    };

    this.root.add(this.body);
    this.body.add(this.hips);
    this.hips.position.y = HIPS_Y;
    add(this.hips, G.harness, harness, { pos: [0, 0.02, 0], scale: [0.2, 0.2, 0.142], detail: true });

    // Legs: hip > knee > ankle.
    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.set(HIP_X * side, -HIP_DROP, 0);
      this.hips.add(thigh);
      add(thigh, G.legLoop, harness, { pos: [0, -0.08, 0], detail: true });
      const knee = new THREE.Group();
      knee.position.y = -LEG_SEG;
      thigh.add(knee);
      const ankle = new THREE.Group();
      ankle.position.y = -LEG_SEG;
      knee.add(ankle);
      add(ankle, G.boot, black);
      add(ankle, G.welt, sole, { detail: true });
      add(ankle, G.crampon, metal, { detail: true });
      this.legs.push({ thigh, knee, ankle });
    }

    // Torso: pack, cylinder and harness straps.
    this.hips.add(this.spine);
    this.spine.position.y = SPINE_UP;
    add(this.spine, G.pack, packM, { pos: [0, 0.27, -0.21] });
    add(this.spine, G.lid, packM, { pos: [0, 0.54, -0.21] });
    for (const y of [0.14, 0.36]) add(this.spine, G.packBand, black, { pos: [0, y, -0.21], scale: [1, 1, 10.2], detail: true });
    add(this.spine, G.strapL, black, { detail: true });
    add(this.spine, G.strapR, black, { detail: true });
    add(this.spine, G.sternum, black, { pos: [0, 0.33, 0.163], detail: true });
    const bottle = add(this.spine, G.bottle, orange, { pos: [0.1, 0.38, -0.21] });
    const reg = add(this.spine, G.regulator, metal, { pos: [0.1, 0.645, -0.21], detail: true });
    const hose = add(this.spine, G.hose, black, { detail: true });
    this.o2Parts.push(bottle, reg, hose);

    // Head: hood, fur ruff, helmet, goggles, mask, headlamp.
    this.neck.position.y = NECK_UP;
    this.spine.add(this.neck);
    add(this.neck, G.head, skin, { shadow: true });
    add(this.neck, G.face, skin, { detail: true });
    add(this.neck, G.hood, suit);
    add(this.neck, G.ruff, fur, { detail: true });
    add(this.neck, G.helmet, helmet);
    add(this.neck, G.goggles, lens);
    add(this.neck, G.gStrap, black, { detail: true });
    const mask = add(this.neck, G.mask, black);
    this.o2Parts.push(mask);
    add(this.neck, G.lamp, this.lampMat, { detail: true });

    // Arms: shoulder > elbow; ice axe in the right hand, trekking pole in the left.
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(SHOULDER_X * side, SHOULDER_UP, 0);
      this.spine.add(shoulder);
      const elbow = new THREE.Group();
      elbow.position.y = -ELBOW_DROP;
      shoulder.add(elbow);
      add(elbow, G.mitten, black);
      add(elbow, G.thumb, black, { pos: [-0.012 * side, 0, 0], detail: true });
      if (side === 1) {
        const axe = new THREE.Group();
        axe.position.set(0, -0.31, 0.02);
        axe.rotation.x = 0.25;
        elbow.add(axe);
        add(axe, G.axeShaft, metal);
        add(axe, G.axeHead, metal, { detail: true });
      } else {
        const pole = new THREE.Group();
        pole.position.set(0, -0.31, 0.02);
        pole.rotation.x = 0.35;
        elbow.add(pole);
        this.pole = pole;
        add(pole, G.pole, metal, { shadow: false });
        add(pole, G.basket, black, { detail: true });
      }
      this.arms.push({ shoulder, elbow });
    }

    // Skin the suit to the skeleton, in the rest pose.
    const [lL, lR] = this.legs, [aL, aR] = this.arms;
    const groups = [this.hips, this.spine, this.neck, lL.thigh, lL.knee, lL.ankle, lR.thigh, lR.knee, lR.ankle, aL.shoulder, aL.elbow, aR.shoulder, aR.elbow];
    const bones = groups.map((g) => {
      const bone = new THREE.Bone();
      g.add(bone);
      return bone;
    });
    if (bones.length !== BONES) throw new Error('climber skeleton mismatch');
    this.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    const build = look.build ?? ((look.suit ^ (look.pack >> 3) ^ (look.helmet >> 7)) >>> 0) % 3;
    const geo = suitFor([0.94, 1, 1.07][build] ?? 1);
    const suitSkin = mat(look.suit, 0.5);
    suitSkin.vertexColors = true;
    for (const [g, m] of [[geo.suit, suitSkin], [geo.gaiters, bootYellow]] as const) {
      const mesh = new THREE.SkinnedMesh(g, m);
      mesh.castShadow = true;
      this.body.add(mesh);
      mesh.bind(skeleton);
      // Generous fixed bounds: the pose changes far more than the bind-pose box allows for.
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
    }

    if (withLight) {
      const spot = new THREE.SpotLight(0xfff3dc, 0, 70, 0.45, 0.5, 1.2);
      spot.position.set(0, 0.2, 0.15);
      spot.target.position.set(0, -0.6, 8);
      this.neck.add(spot, spot.target);
      this.headlamp = spot;
    } else {
      this.headlamp = null;
    }
  }

  setOxygen(on: boolean) {
    for (const o of this.o2Parts) o.visible = on && (!this.detail.includes(o) || this.detailOn);
  }

  private detailOn = true;
  /** Hide small parts on distant climbers. */
  setDetail(on: boolean) {
    if (on === this.detailOn) return;
    this.detailOn = on;
    for (const o of this.detail) o.visible = on;
  }

  setLamp(on: boolean, power = 1) {
    this.lampMat.emissive.setHex(on ? 0xfff6d8 : 0x000000);
    this.lampMat.emissiveIntensity = on ? 2 : 0;
    if (this.headlamp) this.headlamp.intensity = on ? 40 * power : 0;
  }

  /** Ghostly look for hallucinations. */
  setGhost(opacity: number) {
    for (const m of this.materials) {
      m.transparent = true;
      m.opacity = opacity;
      m.depthWrite = opacity > 0.9;
    }
  }

  /** Terrain height lookup, so each foot is placed on the ground under it. */
  setGround(fn: (x: number, z: number) => number) {
    this.ground = fn;
  }

  /** A stumble or a gust: knees buckle, arms fly out, then recover. */
  flinch() {
    this.flinchT = 1;
  }

  /** Turn smoothly to face a heading (radians, 0 = +z). */
  face(heading: number, dt: number) {
    if (!this.yawInit) {
      this.root.rotation.y = heading;
      this.yawInit = true;
      return;
    }
    let d = heading - this.root.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.root.rotation.y += d * Math.min(1, dt * 8);
  }

  /**
   * speed: on-screen walking speed (m/s). lean: slope along the heading (0 flat,
   * ~0.5 steep uphill). effort: 0 fresh .. 1 spent at extreme altitude, which
   * shortens the stride, bends the climber over and adds a pause to each step.
   */
  animate(dt: number, speed: number, lean: number, pose: ClimberPose = 'walk', effort = 0) {
    const moving = speed > 0.05 && (pose === 'walk' || pose === 'jumar');
    // The pole hand is on the ascender when jumaring.
    if (this.pole) this.pole.visible = pose !== 'jumar';
    this.walkBlend = damp(this.walkBlend, moving ? 1 : 0, Math.min(1, dt * 6));
    const b = this.walkBlend;
    // Foot excursion per stance (m): longer when fast, short shuffling steps when spent.
    const reach = THREE.MathUtils.clamp(0.3 + 0.17 * speed, 0.32, 0.8) * (1 - 0.4 * effort);
    // Fraction of the cycle each foot is on the ground; more double support when tired.
    const duty = 0.6 + 0.12 * effort;
    if (moving) {
      // A planted foot travels `reach` while the body moves at `speed`, so the feet never slide.
      // At altitude, pause briefly just after each foot lands (the rest step).
      const u = ((this.phase % 1) + 1) % 1;
      const near = Math.min(Math.abs(u - 0.04), Math.abs(u - 0.54));
      const rest = 1 - 0.55 * effort * Math.exp(-((near / 0.07) ** 2));
      this.phase += ((duty * speed) / reach) * Math.max(0.35, rest) * dt;
    }
    this.breath += dt * (1.2 + effort * 1.6 + (moving ? 0.8 : 0));
    this.idleT += dt;
    this.flinchT = Math.max(0, this.flinchT - dt * 1.6);
    const t = zeroJoints();
    const breathe = Math.sin(this.breath) * (0.02 + 0.03 * effort);
    this.footTargets = null;

    if (pose === 'sit') {
      Object.assign(t, {
        hipsY: 0.42, spineX: 0.38 + breathe, neckX: 0.25, thighL: -1.45, thighR: -1.35, kneeL: 1.55, kneeR: 1.4,
        ankleL: -0.1, ankleR: -0.05, shoulderL: -0.55, shoulderR: -0.6, elbowL: -0.9, elbowR: -0.8, armOutL: 0.25, armOutR: 0.25,
        heave: breathe * 0.6, neckYaw: 0.3 * Math.sin(this.idleT * 0.21),
      });
    } else if (pose === 'lie') {
      Object.assign(t, { hipsY: 0.14, spineX: 0, neckX: -0.2, thighL: -0.1, thighR: 0.05, kneeL: 0.25, kneeR: 0.1, shoulderL: 0.15, shoulderR: -0.1, elbowL: -0.4, elbowR: -0.2, armOutL: 0.45, armOutR: 0.35, lie: 1 });
    } else {
      const uphill = THREE.MathUtils.clamp(lean, -0.5, 0.7);
      const u = ((this.phase % 1) + 1) % 1;
      // Each foot: planted (moving back under the body) or swinging forward through the air.
      const foot = (uf: number) => {
        const w = ((uf % 1) + 1) % 1;
        let z: number, lift: number, pitch: number;
        if (w < duty) {
          const k = w / duty;
          z = reach * (0.5 - k);
          lift = 0;
          // Heel strike (toes up), flat, then heel rising into push-off.
          pitch = -0.28 * Math.max(0, 1 - k / 0.18) + 0.5 * Math.max(0, (k - 0.72) / 0.28) ** 1.5;
        } else {
          const k = (w - duty) / (1 - duty);
          const e = 0.5 - 0.5 * Math.cos(Math.PI * k);
          z = reach * (-0.5 + e);
          // Lift the boot clear: higher uphill and with crampons, a scuffing shuffle when exhausted.
          lift = Math.sin(Math.PI * Math.min(1, k * 1.1)) * (0.1 + 0.12 * Math.max(0, uphill) - 0.04 * effort);
          pitch = 0.3 * (1 - k) - 0.15 * Math.sin(Math.PI * k);
        }
        return { z: z * b, lift: lift * b, pitch: pitch * b, stance: w < duty };
      };
      const fL = foot(u), fR = foot(u + 0.5);
      const swingSide = fL.stance ? 1 : -1; // +1: right leg swinging
      const bob = (0.02 + 0.015 * effort) * b * (0.5 - 0.5 * Math.cos(4 * Math.PI * u));
      const armA = (0.3 - 0.1 * effort) * b;
      // Arms follow the opposite foot; the pole hand reaches to plant as that foot lands.
      const nL = fR.z / Math.max(0.01, reach / 2), nR = fL.z / Math.max(0.01, reach / 2);
      Object.assign(t, {
        hipsY: 0.97 - 0.035 * effort - 0.05 * Math.abs(uphill) * b - bob,
        // Pelvis turns with the swinging leg, drops a touch on its side, and weight shifts over the planted foot.
        hipsYaw: 0.1 * b * (fR.z - fL.z) / Math.max(0.01, reach), hipsRoll: 0.04 * swingSide * b, hipsX: -0.025 * swingSide * b,
        spineX: 0.06 + b * (0.06 + 0.25 * effort) + uphill * 0.45 + breathe, spineYaw: -0.12 * b * (fR.z - fL.z) / Math.max(0.01, reach),
        neckX: 0.25 * effort - uphill * 0.25 + bob * 1.5,
        neckYaw: (1 - b) * 0.45 * Math.sin(this.idleT * 0.27) * Math.sin(this.idleT * 0.11 + 1),
        shoulderL: -armA * nL - 0.15 * b, shoulderR: -armA * nR - 0.1 * b,
        elbowL: -0.35 - 0.3 * Math.max(0, nL) * b, elbowR: -0.4 - 0.25 * Math.max(0, nR) * b,
        armOutL: 0.14 + 0.02 * effort, armOutR: 0.14,
        heave: breathe * (0.4 + (1 - b)),
      });
      this.footTargets = [fL, fR];
      this.footSlope = uphill;
      if (pose === 'jumar') {
        // Left hand up on the jumar, right hand low on the rope.
        Object.assign(t, { shoulderL: -2.3 + 0.15 * nL * b, elbowL: -0.35, shoulderR: -0.7, elbowR: -0.9, armOutL: 0.05, spineX: t.spineX + 0.12 });
      }
      if (!moving) {
        // Hands on knees or poles, catching breath.
        t.shoulderL = damp(t.shoulderL, -0.25, 1 - b);
        t.shoulderR = damp(t.shoulderR, -0.2, 1 - b);
        t.spineX += effort * 0.25 * (1 - b);
      }
    }
    if (this.flinchT > 0) {
      const f = Math.sin(Math.PI * this.flinchT) * this.flinchT;
      t.spineX += 0.35 * f;
      t.hipsY -= 0.09 * f;
      t.armOutL += 0.7 * f;
      t.armOutR += 0.7 * f;
      t.shoulderL -= 0.6 * f;
      t.shoulderR -= 0.4 * f;
    }

    // Blend toward the target pose.
    const k = 1 - Math.exp(-dt * 14);
    const j = this.j;
    for (const key of Object.keys(t) as (keyof Joints)[]) j[key] = damp(j[key], t[key], k);

    this.hips.position.set(j.hipsX, j.hipsY, 0);
    this.hips.rotation.set(0, j.hipsYaw, j.hipsRoll);
    this.spine.rotation.set(j.spineX, j.spineYaw, -j.hipsRoll * 0.7);
    this.neck.rotation.set(j.neckX - j.spineX * 0.35, j.neckYaw, 0);
    for (const [i, a] of this.arms.entries()) a.shoulder.position.y = SHOULDER_UP + j.heave * 0.25 * (i ? 1 : 1);
    const [lL, lR] = this.legs;
    if (this.footTargets) {
      // Solve each leg so its boot lands where the gait puts it, on the ground beneath.
      const flinch = this.flinchT > 0 ? Math.sin(Math.PI * this.flinchT) * this.flinchT : 0;
      this.solveLeg(lL, this.footTargets[0], -0.1, j.hipsY, flinch);
      this.solveLeg(lR, this.footTargets[1], 0.1, j.hipsY, flinch);
    } else {
      lL.thigh.rotation.set(j.thighL, 0, 0.03);
      lR.thigh.rotation.set(j.thighR, 0, -0.03);
      lL.knee.rotation.x = j.kneeL;
      lR.knee.rotation.x = j.kneeR;
      lL.ankle.rotation.x = j.ankleL;
      lR.ankle.rotation.x = j.ankleR;
    }
    const [aL, aR] = this.arms;
    aL.shoulder.rotation.set(j.shoulderL, 0, -j.armOutL);
    aR.shoulder.rotation.set(j.shoulderR, 0, j.armOutR);
    aL.elbow.rotation.x = j.elbowL;
    aR.elbow.rotation.x = j.elbowR;
    this.body.rotation.x = -Math.PI / 2 * j.lie;
    // Lying on the back: lift by the depth of the pack.
    this.body.position.set(0, 0.3 * j.lie, 0.1 * j.lie);
  }

  private footTargets: { z: number; lift: number; pitch: number; stance: boolean }[] | null = null;
  private footSlope = 0;

  /**
   * Two-bone IK in the leg's fore-aft plane: from where the boot should be (forward
   * offset, lift, the ground height under it) find thigh, knee and ankle angles.
   */
  private solveLeg(leg: { thigh: THREE.Group; knee: THREE.Group; ankle: THREE.Group }, f: { z: number; lift: number; pitch: number }, side: number, hipsY: number, flinch: number) {
    const L1 = 0.44, L2 = 0.44, ANKLE = 0.09;
    // Ground height under the foot, relative to the climber's origin.
    let groundY: number;
    if (this.ground && this.groundEnabled && this.detailOn) {
      const r = this.root;
      const yaw = r.rotation.y;
      const p = this.tmp.set(side * Math.cos(yaw) + f.z * Math.sin(yaw), 0, -side * Math.sin(yaw) + f.z * Math.cos(yaw)).add(r.position);
      groundY = THREE.MathUtils.clamp(this.ground(p.x, p.z) - r.position.y, -0.35, 0.35);
    } else {
      groundY = f.z * this.footSlope;
    }
    const hipH = hipsY - 0.02;
    const fz = f.z;
    const fy = groundY + ANKLE + f.lift - hipH; // ankle target below the hip (negative)
    let d = Math.hypot(fz, fy);
    d = THREE.MathUtils.clamp(d, 0.3, L1 + L2 - 0.002);
    const interior = Math.acos(THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const knee = Math.PI - interior + flinch * 0.4;
    const toTarget = Math.atan2(fz, -fy);
    const alpha = Math.acos(THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const thigh = -(toTarget + alpha) - flinch * 0.2;
    leg.thigh.rotation.set(thigh, 0, side < 0 ? 0.03 : -0.03);
    leg.knee.rotation.x = knee;
    // Keep the sole along the ground, plus heel strike / push-off.
    const groundPitch = -Math.atan(this.footSlope);
    leg.ankle.rotation.x = groundPitch + f.pitch - thigh - knee;
  }
}
