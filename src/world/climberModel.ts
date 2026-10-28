import * as THREE from 'three';

export interface ClimberLook {
  suit: number;
  pack: number;
  helmet: number;
}

export type ClimberPose = 'walk' | 'sit' | 'lie' | 'jumar';

// Shared geometry: every climber reuses these; only materials differ.
const G = (() => {
  const cap = (r: number, len: number, drop: number) => new THREE.CapsuleGeometry(r, len, 4, 12).translate(0, -drop, 0);
  const ring = (r: number, t: number) => new THREE.TorusGeometry(r, t, 6, 24).rotateX(Math.PI / 2);
  return {
    pelvis: new THREE.SphereGeometry(1, 16, 10),
    torso: new THREE.CapsuleGeometry(0.2, 0.3, 6, 16),
    baffle: ring(0.205, 0.016),
    harness: ring(0.17, 0.022),
    legLoop: ring(0.095, 0.016),
    thigh: cap(0.1, 0.25, 0.21),
    shin: cap(0.084, 0.27, 0.22),
    gaiter: new THREE.CylinderGeometry(0.082, 0.088, 0.17, 12).translate(0, -0.06, 0),
    boot: new THREE.BoxGeometry(0.14, 0.12, 0.3, 2, 1, 3).translate(0, -0.02, 0.05),
    toe: new THREE.SphereGeometry(0.075, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1).translate(0, -0.08, 0.18),
    sole: new THREE.BoxGeometry(0.15, 0.03, 0.32).translate(0, -0.085, 0.05),
    crampon: new THREE.BoxGeometry(0.12, 0.02, 0.29).translate(0, -0.11, 0.05),
    upperArm: cap(0.068, 0.17, 0.15),
    forearm: cap(0.058, 0.15, 0.13),
    cuff: new THREE.CylinderGeometry(0.07, 0.066, 0.06, 10).translate(0, -0.25, 0),
    mitten: new THREE.SphereGeometry(0.066, 10, 8).scale(0.95, 1.25, 1.05).translate(0, -0.31, 0.01),
    thumb: new THREE.SphereGeometry(0.026, 6, 4).translate(0, -0.29, 0.06),
    neck: new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10).translate(0, 0.05, 0),
    head: new THREE.SphereGeometry(0.105, 16, 12).translate(0, 0.12, 0.01),
    hood: new THREE.SphereGeometry(0.135, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62).scale(1, 1.05, 1.08).translate(0, 0.11, -0.025),
    ruff: new THREE.TorusGeometry(0.1, 0.035, 6, 18).scale(1, 1.15, 0.7).translate(0, 0.11, 0.075),
    helmet: new THREE.SphereGeometry(0.142, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.45).translate(0, 0.15, -0.01),
    goggles: new THREE.CylinderGeometry(0.118, 0.118, 0.06, 18, 1, true, -1.05, 2.1).translate(0, 0.15, 0.005),
    strap: new THREE.TorusGeometry(0.143, 0.009, 4, 24).rotateX(Math.PI / 2).translate(0, 0.17, -0.01),
    face: new THREE.SphereGeometry(0.088, 12, 8, -1, 2, 0.9, 1.2).translate(0, 0.12, 0.03),
    mask: new THREE.SphereGeometry(0.055, 10, 8).scale(1, 0.95, 0.85).translate(0, 0.075, 0.105),
    lamp: new THREE.BoxGeometry(0.05, 0.035, 0.03).translate(0, 0.205, 0.135),
    pack: new THREE.BoxGeometry(0.34, 0.48, 0.2, 2, 3, 2),
    lid: new THREE.SphereGeometry(0.18, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 0.62),
    shoulderStrap: new THREE.BoxGeometry(0.05, 0.42, 0.025),
    bottle: new THREE.CylinderGeometry(0.058, 0.058, 0.5, 12),
    regulator: new THREE.CylinderGeometry(0.022, 0.022, 0.07, 8),
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
  hipsY: 0.97, hipsYaw: 0, hipsRoll: 0, spineX: 0.05, spineYaw: 0, neckX: 0, neckYaw: 0, hipsX: 0, heave: 0,
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

  constructor(look: ClimberLook, withLight = false) {
    const mat = (color: number, roughness = 0.7, metalness = 0) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      this.materials.push(m);
      return m;
    };
    const suitColor = new THREE.Color(look.suit);
    const suit = mat(look.suit, 0.55);
    const suitDark = mat(suitColor.clone().multiplyScalar(0.62).getHex(), 0.6);
    const black = mat(0x1c1d21, 0.8);
    const bootYellow = mat(0xf2b705, 0.45);
    const metal = mat(0xaab0b8, 0.35, 0.8);
    const fur = mat(0xc9b79c, 1);
    const skin = mat(0xa87a5a, 0.8);
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
    this.hips.position.y = 0.97;
    add(this.hips, G.pelvis, suit, { scale: [0.19, 0.13, 0.15] });
    add(this.hips, G.harness, harness, { pos: [0, 0.02, 0], scale: [1.08, 1, 0.92], detail: true });

    // Legs: hip > knee > ankle.
    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.set(0.1 * side, -0.02, 0);
      this.hips.add(thigh);
      add(thigh, G.thigh, suit);
      add(thigh, G.legLoop, harness, { pos: [0, -0.07, 0], detail: true });
      const knee = new THREE.Group();
      knee.position.y = -0.44;
      thigh.add(knee);
      add(knee, G.shin, suit);
      add(knee, G.gaiter, bootYellow, { pos: [0, -0.33, 0] });
      const ankle = new THREE.Group();
      ankle.position.y = -0.44;
      knee.add(ankle);
      add(ankle, G.boot, black);
      add(ankle, G.toe, black, { detail: true });
      add(ankle, G.sole, black, { detail: true });
      add(ankle, G.crampon, metal, { detail: true });
      this.legs.push({ thigh, knee, ankle });
    }

    // Torso with down baffles, pack, cylinder.
    this.hips.add(this.spine);
    this.spine.position.y = 0.06;
    add(this.spine, G.torso, suit, { pos: [0, 0.3, 0], scale: [1.15, 1, 0.86] });
    for (const y of [0.13, 0.27, 0.41]) add(this.spine, G.baffle, suitDark, { pos: [0, y, 0], scale: [1.15, 1, 0.86], detail: true });
    add(this.spine, G.pack, packM, { pos: [0, 0.33, -0.25] });
    add(this.spine, G.lid, packM, { pos: [0, 0.57, -0.25], detail: true });
    for (const side of [-1, 1]) add(this.spine, G.shoulderStrap, black, { pos: [0.11 * side, 0.36, 0.15], rot: [0.12, 0, 0], detail: true });
    const bottle = add(this.spine, G.bottle, orange, { pos: [0.1, 0.36, -0.38] });
    const reg = add(this.spine, G.regulator, metal, { pos: [0.1, 0.645, -0.38], detail: true });
    const hose = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.1, 0.68, -0.38), new THREE.Vector3(0.2, 0.72, -0.15), new THREE.Vector3(0.16, 0.66, 0.12), new THREE.Vector3(0.03, 0.72, 0.17),
    ]), 12, 0.012, 5), black);
    this.spine.add(hose);
    this.detail.push(hose);
    this.o2Parts.push(bottle, reg, hose);

    // Neck and head: hood, fur ruff, helmet, goggles, mask, headlamp.
    this.neck.position.y = 0.62;
    this.spine.add(this.neck);
    add(this.neck, G.neck, suitDark, { detail: true });
    add(this.neck, G.head, skin, { shadow: true });
    add(this.neck, G.face, skin, { detail: true });
    add(this.neck, G.hood, suit);
    add(this.neck, G.ruff, fur, { detail: true });
    add(this.neck, G.helmet, helmet);
    add(this.neck, G.goggles, lens);
    add(this.neck, G.strap, black, { detail: true });
    const mask = add(this.neck, G.mask, black);
    this.o2Parts.push(mask);
    add(this.neck, G.lamp, this.lampMat, { detail: true });

    // Arms: shoulder > elbow; ice axe in the right hand, trekking pole in the left.
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.27 * side, 0.52, 0);
      this.spine.add(shoulder);
      add(shoulder, G.upperArm, suit);
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      shoulder.add(elbow);
      add(elbow, G.forearm, suit);
      add(elbow, G.cuff, suitDark, { detail: true });
      add(elbow, G.mitten, black);
      add(elbow, G.thumb, black, { detail: true });
      if (side === 1) {
        const axe = new THREE.Group();
        axe.position.set(0, -0.3, 0.02);
        axe.rotation.x = 0.25;
        elbow.add(axe);
        add(axe, G.axeShaft, metal);
        add(axe, G.axeHead, metal, { detail: true });
      } else {
        const pole = new THREE.Group();
        pole.position.set(0, -0.3, 0.02);
        pole.rotation.x = 0.35;
        elbow.add(pole);
        add(pole, G.pole, metal, { shadow: false });
        add(pole, G.basket, black, { detail: true });
      }
      this.arms.push({ shoulder, elbow });
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
    for (const [i, a] of this.arms.entries()) a.shoulder.position.y = 0.52 + j.heave * 0.25 * (i ? 1 : 1);
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
