import * as THREE from 'three';

export interface ClimberLook {
  suit: number;
  pack: number;
  helmet: number;
}

const geo = {
  torso: new THREE.CapsuleGeometry(0.24, 0.42, 4, 10),
  head: new THREE.SphereGeometry(0.15, 12, 10),
  goggles: new THREE.BoxGeometry(0.22, 0.07, 0.08),
  mask: new THREE.SphereGeometry(0.07, 8, 6),
  limb: new THREE.CapsuleGeometry(0.085, 0.38, 3, 8),
  arm: new THREE.CapsuleGeometry(0.07, 0.36, 3, 8),
  boot: new THREE.BoxGeometry(0.14, 0.12, 0.3),
  pack: new THREE.BoxGeometry(0.42, 0.55, 0.24),
  bottle: new THREE.CylinderGeometry(0.06, 0.06, 0.5, 10),
  axe: new THREE.BoxGeometry(0.03, 0.6, 0.03),
  lamp: new THREE.SphereGeometry(0.035, 6, 4),
};

/**
 * A stylised high-altitude climber built from primitives: down suit, pack,
 * oxygen cylinder and mask, goggles, headlamp. Animated with a simple walk cycle.
 */
export class ClimberModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legL: THREE.Group;
  private legR: THREE.Group;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private bottle: THREE.Mesh;
  private mask: THREE.Mesh;
  private lampBulb: THREE.Mesh;
  readonly headlamp: THREE.SpotLight | null;
  private phase = 0;
  private materials: THREE.MeshStandardMaterial[] = [];

  constructor(look: ClimberLook, withLight = false) {
    const m = (c: number, r = 0.75) => {
      const mat = new THREE.MeshStandardMaterial({ color: c, roughness: r });
      this.materials.push(mat);
      return mat;
    };
    const suit = m(look.suit, 0.8), dark = m(0x222326), packM = m(look.pack), helmet = m(look.helmet, 0.5);
    const orange = m(0xe8771e, 0.4), skin = m(0xb98e6d), lens = m(0x1d2a3a, 0.15);
    this.root.add(this.body);
    const torso = new THREE.Mesh(geo.torso, suit);
    torso.position.y = 1.12;
    torso.scale.set(1.15, 1, 0.95);
    this.body.add(torso);
    const head = new THREE.Mesh(geo.head, helmet);
    head.position.y = 1.62;
    this.body.add(head);
    const face = new THREE.Mesh(geo.head, skin);
    face.scale.setScalar(0.82);
    face.position.set(0, 1.58, 0.05);
    this.body.add(face);
    const gog = new THREE.Mesh(geo.goggles, lens);
    gog.position.set(0, 1.63, 0.13);
    this.body.add(gog);
    this.mask = new THREE.Mesh(geo.mask, dark);
    this.mask.position.set(0, 1.53, 0.14);
    this.body.add(this.mask);
    this.lampBulb = new THREE.Mesh(geo.lamp, new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
    this.lampBulb.position.set(0, 1.71, 0.13);
    this.body.add(this.lampBulb);
    const pack = new THREE.Mesh(geo.pack, packM);
    pack.position.set(0, 1.18, -0.3);
    this.body.add(pack);
    this.bottle = new THREE.Mesh(geo.bottle, orange);
    this.bottle.position.set(0.12, 1.3, -0.45);
    this.body.add(this.bottle);
    const mkLimb = (g: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, len: number, boot: boolean) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const limb = new THREE.Mesh(g, mat);
      limb.position.y = -len / 2;
      pivot.add(limb);
      if (boot) {
        const b = new THREE.Mesh(geo.boot, dark);
        b.position.set(0, -len - 0.02, 0.05);
        pivot.add(b);
      }
      this.body.add(pivot);
      return pivot;
    };
    this.legL = mkLimb(geo.limb, suit, -0.12, 0.8, 0.62, true);
    this.legR = mkLimb(geo.limb, suit, 0.12, 0.8, 0.62, true);
    this.armL = mkLimb(geo.arm, suit, -0.33, 1.38, 0.55, false);
    this.armR = mkLimb(geo.arm, suit, 0.33, 1.38, 0.55, false);
    const axe = new THREE.Mesh(geo.axe, m(0x777c84, 0.3));
    axe.position.set(0, -0.6, 0.08);
    this.armR.add(axe);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    if (withLight) {
      const spot = new THREE.SpotLight(0xfff3dc, 0, 70, 0.45, 0.5, 1.2);
      spot.position.set(0, 1.71, 0.15);
      spot.target.position.set(0, 0.8, 8);
      this.body.add(spot, spot.target);
      this.headlamp = spot;
    } else {
      this.headlamp = null;
    }
  }

  setOxygen(on: boolean) {
    this.mask.visible = on;
    this.bottle.visible = on;
  }

  setLamp(on: boolean, power = 1) {
    (this.lampBulb.material as THREE.MeshBasicMaterial).color.setHex(on ? 0xfff6d8 : 0x333333);
    if (this.headlamp) this.headlamp.intensity = on ? 40 * power : 0;
  }

  /** Ghostly look for hallucinations. */
  setGhost(opacity: number) {
    for (const mat of this.materials) {
      mat.transparent = true;
      mat.opacity = opacity;
      mat.depthWrite = opacity > 0.9;
    }
  }

  /**
   * speed: m/s on screen. lean: forward lean (rad) on steep ground. pose:
   * 'walk' | 'sit' | 'lie' | 'jumar'.
   */
  animate(dt: number, speed: number, lean: number, pose: 'walk' | 'sit' | 'lie' | 'jumar' = 'walk') {
    this.phase += dt * (1.5 + speed * 2.8);
    const swing = Math.min(0.75, speed * 0.4);
    const s = Math.sin(this.phase);
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    if (pose === 'sit') {
      this.legL.rotation.x = this.legR.rotation.x = -1.4;
      this.armL.rotation.x = this.armR.rotation.x = -0.5;
      this.body.position.y = -0.55;
      this.body.rotation.x = 0.15;
      return;
    }
    if (pose === 'lie') {
      this.legL.rotation.x = this.legR.rotation.x = 0;
      this.armL.rotation.x = this.armR.rotation.x = 0.2;
      this.body.rotation.x = -Math.PI / 2;
      this.body.position.y = 0.25;
      return;
    }
    this.legL.rotation.x = s * swing;
    this.legR.rotation.x = -s * swing;
    this.armL.rotation.x = -s * swing * 0.7 - (pose === 'jumar' ? 1.6 : 0);
    this.armR.rotation.x = s * swing * 0.7 - (pose === 'jumar' ? 0.4 : 0);
    this.body.rotation.x = lean;
    this.body.position.y = Math.abs(Math.cos(this.phase)) * swing * 0.06;
  }
}
