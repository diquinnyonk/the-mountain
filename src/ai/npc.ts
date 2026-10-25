import * as THREE from 'three';
import { Physiology } from '../sim/physiology';
import { computeEffects, realisticSpeed } from '../sim/effects';
import type { BehaviourTree } from './bt';
import type { World } from './world';
import type { LandmarkId } from '../world/sections';
import { inSpan } from '../world/sections';
import type { ClimberLook } from '../world/climberModel';
import type { Rng } from '../core/rng';

export type NpcRole = 'sherpa' | 'climber' | 'leader' | 'doctor';

export interface Leg {
  to: LandmarkId;
  /** Earliest departure (game ms). */
  departAt: number;
}

export interface NpcBlackboard {
  npc: Npc;
  world: World;
  memory: Record<string, number | string | boolean | undefined>;
}

/** A person on the mountain. Movement is along the route; decisions come from a behaviour tree. */
export class Npc {
  s = 0;
  lateral = 0;
  targetLateral = 0;
  readonly pos = new THREE.Vector3();
  heading = 0;
  /** Visual speed hint for animation (route m per game s). */
  speed = 0;
  pose: 'walk' | 'sit' | 'lie' | 'jumar' = 'walk';
  physiology: Physiology;
  o2Bottles = 0;
  o2Litres = 0;
  o2Flow = 0;
  dex = 1;
  goalS: number | null = null;
  plan: Leg[] = [];
  legIndex = 0;
  summited = false;
  /** Ignores turnaround times (summit fever). */
  stubborn = false;
  inTent = false;
  activity = 'idle';
  needsHelp = false;
  /** Sherpas are faster and tire less. */
  strength = 1;
  deathReported = false;
  bt!: BehaviourTree<NpcBlackboard>;
  btAccum = 0;
  visible = true;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly role: NpcRole,
    readonly team: string,
    readonly look: ClimberLook,
    rng: Rng,
    acclimAlt: number,
  ) {
    this.physiology = new Physiology(rng, { acclimAlt });
  }

  get dead() {
    return this.physiology.dead !== null;
  }
  get altitude() {
    return this.pos.y;
  }

  /** Lying down and unable to continue without help. */
  get incapacitated() {
    const p = this.physiology;
    return !this.dead && (p.energy < 2 || p.hace > 0.6 || p.hape > 0.75 || p.hypothermia > 0.6);
  }

  get severelyIll() {
    const p = this.physiology;
    return p.ams > 0.7 || p.hape > 0.12 || p.hace > 0.08 || p.frostbiteFeet > 0.5 || p.exhaustion > 0.85;
  }

  updatePosition(world: World) {
    world.route.offsetPoint(this.s, this.lateral, this.pos);
  }

  /**
   * Walk along the route toward targetS for dt game seconds. Returns true on arrival.
   * Waits behind slower climbers on single-file stretches.
   */
  moveToward(world: World, targetS: number, dt: number, speedMul = 1): boolean {
    const ds = targetS - this.s;
    if (Math.abs(ds) < 1) {
      this.speed = 0;
      return true;
    }
    const dir = Math.sign(ds);
    const bottleneck = world.layout.bottlenecks.find((b) => inSpan(b, this.s));
    let passing = 1;
    if (bottleneck) {
      // Single file on the fixed line: queue behind slower climbers going the same way,
      // and squeeze past (slowly, unclipping and reclipping) anyone coming the other way.
      const others = world.npcs.filter((o) => o !== this && !o.dead && !o.inTent && o.role === 'climber' || (o !== this && o.role === 'sherpa' && !o.dead && !o.inTent));
      const ahead = (o: { s: number }) => (o.s - this.s) * dir > 0 && (o.s - this.s) * dir < 2.5;
      const sameWay = (o: Npc) => o.goalS !== null && Math.sign(o.goalS - o.s) === dir && !o.incapacitated;
      const blocker = others.find((o) => ahead(o) && sameWay(o) && o.speed < 0.02);
      const pl = world.player;
      const playerBlocks = !pl.dead && ahead(pl) && Math.sign(pl.velocityS) === dir && Math.abs(pl.velocityS) < 0.02;
      if (blocker || playerBlocks) {
        this.speed = 0;
        this.activity = `queueing at ${bottleneck.name}`;
        return false;
      }
      if (others.some((o) => ahead(o) && (!sameWay(o)))) passing = 0.35;
    }
    const grade = world.route.gradeAt(this.s) * dir;
    const eff = computeEffects(this.physiology);
    const tf = this.s < world.layout.landmarks.c1.s && this.s > 200 ? 0.62 : 1;
    const w = world.weather.sample(world.now, this.altitude);
    const windF = 1 - Math.min(0.6, Math.max(0, (w.windKmh - 50) / 120));
    const v = realisticSpeed(grade, tf, this.physiology.spo2, this.altitude, eff, 14) * windF * speedMul * passing * this.strength;
    const step = Math.min(Math.abs(ds), v * dt);
    this.s += dir * step;
    this.speed = v;
    const t = world.route.tangentAt(this.s);
    this.heading = Math.atan2(t.x * dir, t.z * dir);
    this.pose = grade > 0.5 ? 'jumar' : 'walk';
    this.lateral += (this.targetLateral - this.lateral) * Math.min(1, dt * 0.05);
    return Math.abs(targetS - this.s) < 1;
  }

  /** Oxygen: climbers go on gas above Camp 3 on a summit push, Sherpas higher and lower flow. */
  manageOxygen(world: World, sleeping: boolean) {
    const c3 = world.layout.landmarks.c3.s;
    const c4 = world.layout.landmarks.c4.s;
    const threshold = this.role === 'sherpa' ? c4 + 50 : c3 - 20;
    let want = 0;
    if (this.s > threshold) want = sleeping ? 0.5 : this.role === 'sherpa' ? 1 : 2;
    if (want > 0 && this.o2Litres <= 0 && this.o2Bottles > 0) {
      this.o2Bottles--;
      this.o2Litres = 1080;
    }
    this.o2Flow = this.o2Litres > 0 ? want : 0;
  }
}
