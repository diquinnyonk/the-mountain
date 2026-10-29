import * as THREE from 'three';
import { Npc, type Leg } from './npc';
import type { World } from './world';
import { climberTree } from './npcs/climber';
import { sherpaTree } from './npcs/sherpa';
import { leaderTree } from './npcs/leader';
import { doctorTree } from './npcs/doctor';
import { ropeTeamTree } from './npcs/ropeTeam';
import { ClimberModel } from '../world/climberModel';
import { Rng } from '../core/rng';
import { DAY, HOUR } from '../core/clock';
import type { LandmarkId } from '../world/sections';
import { clamp } from '../core/mathx';

const TEAMS = ['Kathmandu Peaks', 'Northern Lights Alpine', 'Andes to Himalaya', 'Valley of Silence Expeditions', 'Yeti Ridge Club'];
const CLIENT_NAMES = [
  'Ingrid', 'Tomás', 'Mei', 'Farhan', 'Olu', 'Hannah', 'Rafael', 'Yuki', 'Siddharth', 'Chloé', 'Mateo', 'Anouk', 'Kofi',
  'Leila', 'Bjørn', 'Priya', 'Dmitri', 'Grace', 'Arjun', 'Zofia',
];
const SHERPA_NAMES = ['Lhakpa', 'Mingma', 'Dawa', 'Nima', 'Pasang', 'Phurba', 'Kami', 'Chhiring', 'Ang Dorje', 'Tashi', 'Pemba Nuru', 'Lakpa Rita'];
const SUITS = [0xd93025, 0x1a73e8, 0xf4b400, 0x0f9d58, 0xff6d00, 0x9c27b0, 0x263238, 0x00acc1];

export interface Season {
  inSeason: boolean;
  name: string;
  ropeFront: number;
}

/** Where the rope fixers will have got to, and whether anyone else is on the mountain, for a date. */
export function seasonFor(startUtc: number, routeLength: number, c1: number): Season {
  const d = new Date(startUtc);
  const doy = Math.floor((startUtc - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
  if (doy >= 95 && doy <= 158) {
    const f = clamp((doy - 104) / (136 - 104), 0, 1);
    return { inSeason: true, name: 'spring season', ropeFront: Math.max(c1, f * routeLength) };
  }
  if (doy >= 250 && doy <= 300) {
    const f = clamp((doy - 258) / (282 - 258), 0, 1);
    return { inSeason: true, name: 'autumn season', ropeFront: Math.max(c1, f * routeLength) };
  }
  return { inSeason: false, name: doy > 300 || doy < 60 ? 'winter' : doy < 95 ? 'late winter' : 'monsoon', ropeFront: 0 };
}

/** Spawns and runs everyone else on the mountain, and draws the ones near the camera. */
export class Director {
  readonly npcs: Npc[] = [];
  readonly group = new THREE.Group();
  sherpa: Npc | null = null;
  leader!: Npc;
  doctor!: Npc;
  private ropeTeam!: Npc;
  readonly ropeFront: { s: number };
  private models = new Map<string, ClimberModel>();
  /** Last rendered position and smoothed on-screen speed, so strides match real movement. */
  private motion = new Map<string, { last: THREE.Vector3; speed: number }>();
  private rng: Rng;
  private aiAccum = 0;

  constructor(private world: World, seed: string, season: Season, withSherpa: boolean, playerS: number) {
    this.rng = new Rng('npcs:' + seed);
    this.ropeFront = { s: season.ropeFront };
    world.npcs = this.npcs;
    const L = world.layout.landmarks;

    this.leader = this.add(new Npc('leader', 'Ruth (expedition leader)', 'leader', 'Your expedition',
      { suit: 0x3949ab, pack: 0x333333, helmet: 0xeeeeee }, this.rng, 5400));
    this.leader.s = 45;
    this.leader.lateral = -22;
    this.leader.bt = leaderTree(this.leader, world);

    this.doctor = this.add(new Npc('doctor', 'Dr. Anjali Rai (Base Camp doctor)', 'doctor', 'Everest ER',
      { suit: 0xeeeeee, pack: 0xc62828, helmet: 0xc62828 }, this.rng, 5400));
    this.doctor.s = 30;
    this.doctor.lateral = 18;
    this.doctor.targetLateral = 18;
    this.doctor.bt = doctorTree(this.doctor, world);

    this.ropeTeam = new Npc('ropes', 'Rope fixing team', 'sherpa', 'SPCC', { suit: 0, pack: 0, helmet: 0 }, this.rng, 7400);
    this.ropeTeam.visible = false;
    this.ropeTeam.bt = ropeTeamTree(this.ropeTeam, world, this.ropeFront);

    if (withSherpa) {
      const s = this.add(new Npc('pemba', 'Pemba Sherpa', 'sherpa', 'Your expedition',
        { suit: 0xffb300, pack: 0x5d4037, helmet: 0xff5722 }, this.rng, 7400));
      // Just ahead of you, or just below you if you start on the summit.
      s.s = playerS > world.route.length - 20 ? playerS - 6 : Math.max(0, playerS + 6);
      s.lateral = 1.5;
      s.o2Bottles = 4;
      s.strength = 1.35;
      s.dex = 2;
      s.bt = sherpaTree(s, world);
      this.sherpa = s;
    }
    if (season.inSeason) this.spawnTeams();
    for (const n of this.npcs) n.updatePosition(world);
    void L;
  }

  private add(n: Npc) {
    this.npcs.push(n);
    return n;
  }

  /** Other expeditions, each timing its summit push to the best forecast window. */
  private spawnTeams() {
    const w = this.world;
    const start = w.weather.start;
    const days = w.weather.daySummaries(start, Math.floor(w.weather.hours / 24));
    const candidates = days.map((d, i) => ({ d, i })).filter(({ i }) => i >= 3);
    const good = candidates.filter(({ d }) => d.good);
    const ranked = (good.length ? good : [...candidates].sort((a, b) => a.d.summitWindMax - b.d.summitWindMax).slice(0, 4));
    const nTeams = this.rng.int(3, 5);
    let clientIdx = this.rng.int(0, CLIENT_NAMES.length - 1), sherpaIdx = this.rng.int(0, SHERPA_NAMES.length - 1);
    for (let t = 0; t < nTeams; t++) {
      // Most teams pile onto the first good window: that is how queues happen.
      const pick = ranked.length ? (this.rng.chance(0.6) ? ranked[0] : this.rng.pick(ranked)) : null;
      const summitDay = pick ? pick.i : this.rng.int(6, 14);
      const team = TEAMS[t % TEAMS.length];
      const plan = this.teamPlan(start, summitDay);
      const size = this.rng.int(2, 4);
      const suit = SUITS[t % SUITS.length];
      for (let k = 0; k < size + 1; k++) {
        const isSherpa = k === size;
        const name = isSherpa ? `${SHERPA_NAMES[sherpaIdx++ % SHERPA_NAMES.length]} Sherpa` : CLIENT_NAMES[clientIdx++ % CLIENT_NAMES.length];
        const n = this.add(new Npc(`t${t}-${k}`, name, 'climber', team,
          { suit: isSherpa ? 0xffb300 : suit, pack: this.rng.pick(SUITS), helmet: this.rng.pick([0xffffff, 0xff5722, 0xffeb3b, 0x2196f3]) },
          this.rng, isSherpa ? 7400 : this.rng.range(6400, 7100)));
        n.plan = plan.map((l) => ({ ...l, departAt: l.departAt + this.rng.range(-0.3, 0.6) * HOUR }));
        n.o2Bottles = isSherpa ? 3 : 5;
        n.strength = isSherpa ? 1.3 : this.rng.range(0.9, 1.1);
        n.stubborn = !isSherpa && this.rng.chance(0.25);
        n.lateral = n.targetLateral = (this.rng.next() - 0.5) * 30;
        // Resume the plan where it would be by now.
        let last = -1;
        n.plan.forEach((leg, i) => {
          if (leg.departAt < w.now) last = i;
        });
        if (last >= 0) {
          n.s = w.layout.landmarks[n.plan[last].to].s;
          n.legIndex = last + 1;
          n.inTent = true;
        } else {
          n.s = this.rng.range(10, 55);
          n.inTent = true;
        }
        n.physiology.energy = this.rng.range(70, 95);
        n.bt = climberTree(n, w);
      }
    }
  }

  private teamPlan(start: number, summitDay: number): Leg[] {
    const day = (d: number, h: number) => start + d * DAY + h * HOUR;
    const D = summitDay;
    const legs: Leg[] = [];
    const leg = (to: LandmarkId, at: number) => legs.push({ to, departAt: at });
    if (D > 10) {
      // An acclimatisation rotation first.
      leg('c1', day(1, 4.5)); leg('c2', day(2, 7)); leg('c3', day(4, 6)); leg('c2', day(4, 12)); leg('bc', day(5, 7));
    }
    leg('c2', day(D - 4, 4)); leg('c3', day(D - 2, 6)); leg('c4', day(D - 1, 7)); leg('summit', day(D - 1, 21));
    return legs;
  }

  /** Advance everyone by dt game seconds. */
  tick(dt: number) {
    const w = this.world;
    for (const n of this.npcs) {
      if (n.role === 'climber' || n.role === 'sherpa') {
        const ws = w.weather.sample(w.now, n.altitude);
        n.physiology.step(dt, {
          altitude: n.altitude, tempC: ws.tempC, windChillC: ws.windChillC, windKmh: ws.windKmh,
          sheltered: n.inTent, sleeping: n.inTent && (w.localHour > 20 || w.localHour < 4), daylight: 1, snowGlare: 0,
        }, { o2FlowLpm: n.o2Flow, downSuit: n.altitude > 6000 || ws.windChillC < -25, goggles: true, packKg: 14 },
        (n.speed > 0 ? (n.goalS !== null && n.goalS < n.s ? 0.45 : 0.7) : 0.15) / n.strength, { dexUntil: 0, nifedipineUntil: 0 }, w.now);
        if (n.o2Flow > 0) n.o2Litres = Math.max(0, n.o2Litres - (n.o2Flow * dt) / 60);
        const ph = n.physiology, h = dt / 3600;
        if (n.inTent) {
          // Brewing up and eating in camp.
          ph.hydration = Math.min(90, ph.hydration + 5 * h);
          ph.energy = Math.min(100, ph.energy + (n.altitude < 7600 ? 2 : 1) * h);
        } else if (n.speed > 0) {
          // Sipping and snacking on the move.
          ph.hydration = Math.min(90, ph.hydration + 1.5 * h);
        }
        if (n.incapacitated && n.role === 'climber') this.maybeRescue(n, h);
      }
      if (n.dead && !n.deathReported) {
        n.deathReported = true;
        w.log(`${n.name} (${n.team}) died at ${Math.round(n.altitude).toLocaleString()} m: ${n.physiology.dead}.`);
        if (n.role !== 'leader' && n.role !== 'doctor') w.radio('Base Camp', `Terrible news. ${n.name} of ${n.team} has died near ${Math.round(n.altitude).toLocaleString()} m.`, 'alert');
      }
      // Anyone near the player thinks every frame so they move smoothly; distant climbers less often.
      const near = Math.abs(n.s - w.player.s) < 250;
      n.btAccum += dt;
      const interval = near ? 0 : 20;
      if (n.btAccum >= interval) {
        n.bt.tick({ now: w.now, dt: n.btAccum });
        n.btAccum = 0;
      }
      n.updatePosition(w);
    }
    this.aiAccum += dt;
    if (this.aiAccum >= 30) {
      this.ropeTeam.bt.tick({ now: w.now, dt: this.aiAccum });
      this.aiAccum = 0;
    }
    w.ropeFixedTo = this.ropeFront.s;
  }

  /** Other teams' Sherpas and climbers may reach and evacuate a collapsed climber; far less likely up high. */
  private maybeRescue(n: Npc, hours: number) {
    const alt = n.altitude;
    const perHour = alt < 6600 ? 0.6 : alt < 7600 ? 0.3 : alt < 8300 ? 0.07 : 0.02;
    if (this.rng.next() >= perHour * hours) return;
    const ph = n.physiology;
    ph.energy = Math.max(ph.energy, 35);
    ph.coreTemp = Math.max(ph.coreTemp, 35.5);
    ph.hape = Math.max(0, ph.hape - 0.3);
    ph.hace = Math.max(0, ph.hace - 0.3);
    ph.hypoxicDebt = 0;
    n.needsHelp = false;
    n.plan = [{ to: 'bc', departAt: this.world.now }];
    n.legIndex = 0;
    n.bt.blackboard.memory.turnedBack = true;
    n.o2Bottles = Math.max(n.o2Bottles, 1);
    this.world.log(`Sherpas reached ${n.name} (${n.team}) at ${Math.round(alt).toLocaleString()} m and are bringing them down.`);
    this.world.radio('Base Camp', `Rescue update: ${n.name} is being brought down from ${Math.round(alt).toLocaleString()} m.`, 'info');
  }

  /** Update visible NPC models near the camera. timeRate: game seconds per real second. */
  render(dtReal: number, camera: THREE.Vector3, timeRate: number, showLabels: boolean, labels: HTMLElement, cam: THREE.Camera) {
    let html = '';
    for (const n of this.npcs) {
      if (!n.visible) continue;
      const show = !n.inTent && n.pos.distanceTo(camera) < 1500;
      let m = this.models.get(n.id);
      if (!show) {
        if (m) m.root.visible = false;
        continue;
      }
      if (!m) {
        m = new ClimberModel(n.look);
        m.setGround((x, z) => this.world.route.terrain.heightAt(x, z));
        this.models.set(n.id, m);
        this.group.add(m.root);
      }
      m.root.visible = true;
      m.root.position.copy(n.pos);
      m.face(n.heading, dtReal);
      const dist = n.pos.distanceTo(camera);
      m.setDetail(dist < 70);
      const pose = n.dead || n.needsHelp ? 'lie' : n.speed === 0 && n.pose === 'sit' ? 'sit' : n.pose;
      let mo = this.motion.get(n.id);
      if (!mo) {
        mo = { last: n.pos.clone(), speed: 0 };
        this.motion.set(n.id, mo);
      }
      const moved = Math.hypot(n.pos.x - mo.last.x, n.pos.z - mo.last.z);
      mo.last.copy(n.pos);
      // Teleports (fast travel, catching up) aren't walking.
      const inst = dtReal > 0 && moved < 20 ? moved / dtReal : 0;
      mo.speed += (inst - mo.speed) * Math.min(1, dtReal * 6);
      const vis = n.speed > 0 || mo.speed > 0.15 ? Math.min(5, mo.speed) : 0;
      void timeRate;
      const grade = n.goalS !== null && n.goalS < n.s ? -this.world.route.gradeAt(n.s) : this.world.route.gradeAt(n.s);
      const ph = n.physiology;
      const effort = Math.min(1, Math.max(0, (ph.effAltitude - 6000) / 2800) * 0.6 + ph.exhaustion * 0.5 + (n.role === 'sherpa' || n.strength > 1.2 ? -0.15 : 0));
      m.animate(dtReal, vis, vis > 0 ? grade : 0, pose, Math.max(0, effort));
      m.setOxygen(n.o2Flow > 0);
      if (showLabels && n.pos.distanceTo(camera) < 250) {
        const p = n.pos.clone().add(new THREE.Vector3(0, 2.3, 0)).project(cam);
        if (p.z < 1) {
          const x = (p.x * 0.5 + 0.5) * innerWidth, y = (-p.y * 0.5 + 0.5) * innerHeight;
          const path = n.bt.activePath().slice(1).join(' › ');
          html += `<div class="bt-label" style="left:${x}px;top:${y}px"><b>${n.name}</b><br>${n.activity}<br><small>${path}</small></div>`;
        }
      }
    }
    labels.innerHTML = html;
  }

  serialize() {
    return {
      ropeFront: this.ropeFront.s,
      npcs: this.npcs.map((n) => ({
        id: n.id, s: n.s, lateral: n.lateral, legIndex: n.legIndex, summited: n.summited, inTent: n.inTent,
        o2Bottles: n.o2Bottles, o2Litres: n.o2Litres, dex: n.dex, plan: n.plan, physiology: n.physiology.serialize(),
      })),
    };
  }

  restore(data: ReturnType<Director['serialize']>) {
    this.ropeFront.s = data.ropeFront;
    for (const d of data.npcs) {
      const n = this.npcs.find((x) => x.id === d.id);
      if (!n) continue;
      Object.assign(n, { s: d.s, lateral: d.lateral, legIndex: d.legIndex, summited: d.summited, inTent: d.inTent,
        o2Bottles: d.o2Bottles, o2Litres: d.o2Litres, dex: d.dex, plan: d.plan });
      Object.assign(n.physiology, d.physiology);
      n.updatePosition(this.world);
    }
  }
}
