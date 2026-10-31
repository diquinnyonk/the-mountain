import * as THREE from 'three';
import type { Terrain } from './world/heightmap';
import type { Route } from './world/route';
import { campNear, inSpan, sectionAt, type LandmarkId, type RouteLayout } from './world/sections';
import type { Features } from './world/features';
import { Hazards, type HazardTarget } from './world/hazards';
import { ClimberModel } from './world/climberModel';
import { Player } from './player/player';
import { FollowCamera } from './player/camera';
import type { Input } from './player/input';
import { BOTTLE_LITRES } from './player/gear';
import { Director, seasonFor, type Season } from './ai/director';
import type { World, WorldFlags, RadioKind, PlayerView } from './ai/world';
import { consult } from './ai/npcs/doctor';
import { forecastText } from './ai/npcs/leader';
import type { Npc } from './ai/npc';
import type { WeatherTimeline, WeatherSample } from './weather/model';
import { computeEffects, realisticSpeed } from './sim/effects';
import type { DeathCause } from './sim/physiology';
import type { AudioEngine } from './audio/audio';
import type { RadioMessage } from './ui/hud';
import type { ExpeditionSettings } from './ui/planning';
import type { ActionKind } from './ui/touch';
import { GameClock, HOUR, formatLocalDate, formatLocalTime, localMidnightUtc } from './core/clock';
import { Rng } from './core/rng';
import { clamp, lerp } from './core/mathx';

export interface JournalEntry {
  time: number;
  text: string;
}

export interface Ending {
  kind: 'death' | 'summit' | 'retreat';
  title: string;
  text: string;
}

export interface CampAction {
  label: string;
  disabled?: string;
  run(): string;
  closes?: boolean;
}

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  terrain: Terrain;
  route: Route;
  layout: RouteLayout;
  features: Features;
  audio: AudioEngine;
}

const CAMP_ORDER: LandmarkId[] = ['bc', 'c1', 'c2', 'c3', 'c4'];
const SAVE_KEY = 'the-mountain:save';

/** One attempt on the mountain: the player, the clock, the weather, everyone else, and what happens. */
export class Expedition {
  readonly clock: GameClock;
  readonly player: Player;
  readonly model: ClimberModel;
  readonly follow: FollowCamera;
  readonly director: Director;
  readonly hazards: Hazards;
  readonly world: World;
  readonly season: Season;
  readonly flags: WorldFlags = {
    mountainClosed: false, doctorClearance: true, sherpaAssisting: false, descentOrdered: false, summitPushActive: false,
  };
  journal: JournalEntry[] = [];
  radioLog: RadioMessage[] = [];
  calledOff = false;
  stash: Record<string, number> = { bc: 0, c1: 0, c2: 0, c3: 0, c4: 0 };
  walked = new Set<number>();
  lastCampId: LandmarkId | null = 'bc';
  weatherHere!: WeatherSample;
  ending: Ending | null = null;
  god = false;
  summitTime = 0;
  distanceWalked = 0;
  o2Used = 0;
  private deathTimer = -1;
  private prevS = 0;
  private velocityS = 0;
  private lastRopeDraw = -1;
  private ghost: ClimberModel;
  private ghostLife = 0;
  private hallucinationLogged = false;
  private rng: Rng;
  private ladderLogged = false;
  private lastSave = 0;
  private reopenTimer = 0;

  constructor(private ctx: SceneContext, readonly settings: ExpeditionSettings, readonly weather: WeatherTimeline, save?: SaveData) {
    const { route, layout, scene } = ctx;
    this.rng = new Rng('player:' + settings.date);
    const startId = this.startCamp;
    const startCamp = layout.landmarks[startId];
    // At the South Col you arrive in the afternoon, ready to rest before a night summit push.
    // The South Col in the afternoon, ready to rest before a night push; the summit at 08:00 after the night's climb.
    const start = localMidnightUtc(settings.date) + (startId === 'c4' ? 14 : startId === 'summit' ? 8 : 7) * HOUR;
    this.startTime = start;
    this.clock = new GameClock(start);
    this.player = new Player(route, layout, this.rng);
    this.player.placeAt(startId === 'summit' ? route.length - 3 : startCamp.s + (startId === 'bc' ? 14 : 6), startId === 'summit' ? 0 : 4);
    this.prevS = this.player.s;
    const g = this.player.gear;
    const ph = this.player.physiology;
    if (settings.style === 'push') {
      Object.assign(ph, { acclimAlt: 7000, cough: 0.35, energy: 85, hydration: 75 });
    }
    this.stash.c3 = settings.o2Stash > 0 ? 1 : 0;
    this.stash.c4 = settings.o2Stash;
    g.water = 1.5;
    if (startId !== 'bc') {
      // Starting higher means you climbed here over the previous weeks: acclimatised for this camp,
      // the sections below already walked, and dressed for the altitude.
      const campAlt = route.altitudeAt(startCamp.s);
      ph.acclimAlt = Math.max(ph.acclimAlt, Math.min(7400, campAlt - 400));
      ph.cough = Math.max(ph.cough, 0.2);
      const idx = layout.sections.findIndex((sec) => sec.to === startId);
      for (let i = 0; i <= idx; i++) this.walked.add(i);
      this.player.maxS = startCamp.s;
      this.lastCampId = startCamp.camp ? startId : null;
      if (startId === 'c3' || startId === 'c4' || startId === 'summit') g.downSuit = true;
      if (startId === 'c4') {
        // Resting on low-flow oxygen at the South Col.
        g.litres = 1080;
        g.flowLpm = 1;
      }
      if (startId === 'summit') {
        // On top after climbing through the night: tired, dry, part-way through your oxygen, one spare.
        this.player.summited = true;
        this.summitTime = start;
        this.player.maxS = route.length;
        Object.assign(ph, { energy: 55, hydration: 55, coreTemp: 36.8, handTemp: 12, footTemp: 10 });
        g.litres = 520;
        g.bottles = 1;
        g.flowLpm = 2;
        g.water = 0.5;
        g.rations = 3;
      }
    }

    const season = seasonFor(start, route.length, layout.landmarks.c1.s);
    // Starting high means the ropes got you there: fixed at least to your camp, and to the
    // summit if you start at Camp 3 or above (a summit push only goes on fixed lines).
    const ropesTo = startId === 'bc' ? 0 : ['c3', 'c4', 'summit'].includes(startId) ? route.length : startCamp.s + 50;
    this.season = { ...season, ropeFront: Math.max(season.ropeFront, ropesTo) };
    const self = this;
    const playerView: PlayerView = {
      get s() { return self.player.s; },
      get pos() { return self.player.pos; },
      get altitude() { return self.player.altitude; },
      get physiology() { return self.player.physiology; },
      get gear() { return self.player.gear; },
      get meds() { return self.player.meds; },
      get dead() { return self.player.dead; },
      get collapsed() { return self.player.mode === 'down'; },
      get calledOff() { return self.calledOff; },
      get summited() { return self.player.summited; },
      get inTent() { return self.player.mode === 'tent'; },
      get atCamp() { return self.campHere()?.id ?? null; },
      get velocityS() { return self.velocityS; },
    };
    this.world = {
      get now() { return self.clock.time; },
      get localHour() { return self.clock.localHour; },
      route, layout, weather,
      player: playerView,
      npcs: [],
      ropeFixedTo: this.season.ropeFront,
      turnaroundHour: 13,
      flags: this.flags,
      rng: new Rng('world:' + settings.date),
      radio: (from, text, kind = 'info') => this.radio(from, text, kind),
      log: (text) => this.log(text),
      givePlayer: (kind, from) => this.receive(kind, from),
    };
    this.director = new Director(this.world, settings.date, this.season, settings.sherpa, this.player.s);
    scene.add(this.director.group);
    this.hazards = new Hazards(route, layout, settings.date);
    scene.add(this.hazards.group);
    this.hazards.onEvent = (e, phase) => {
      if (phase === 'warn') {
        ctx.audio.rumble(e.warning);
        const near = Math.abs(e.s - this.player.s) < 120;
        if (near) this.player.showAlert(e.kind === 'serac' ? 'A crack like a gunshot above you. SERAC! RUN!' : 'A deep WHUMPF. AVALANCHE! Get off the slope!', e.warning);
      } else {
        this.follow.addShake(Math.abs(e.s - this.player.s) < 200 ? 1 : 0.3);
        this.log(e.kind === 'serac' ? `A serac collapsed onto the route at ${Math.round(this.ctx.route.altitudeAt(e.s))} m.` : `An avalanche ran across the route at ${Math.round(this.ctx.route.altitudeAt(e.s))} m.`);
      }
    };

    this.model = new ClimberModel({ suit: 0xe53935, pack: 0x1e3a5f, helmet: 0xffffff }, true);
    this.model.setGround((x, z) => ctx.terrain.heightAt(x, z));
    scene.add(this.model.root);
    this.ghost = new ClimberModel({ suit: 0x2e7d32, pack: 0x555555, helmet: 0x888888 });
    this.ghost.setGhost(0);
    this.ghost.root.visible = false;
    scene.add(this.ghost.root);
    this.follow = new FollowCamera(ctx.camera, ctx.terrain);
    this.follow.yaw = this.player.heading;

    if (save) {
      this.restore(save);
    } else {
      if (startId === 'bc') this.log(`Arrived at Everest Base Camp, 5,364 m, on ${formatLocalDate(start)}.`);
      else if (startId === 'summit') this.log(`On the summit of Everest, 8,849 m, at 08:00 on ${formatLocalDate(start)}, after climbing through the night from the South Col. Now the descent.`);
      else this.log(`Starting at ${startCamp.name}, ${Math.round(route.altitudeAt(startCamp.s)).toLocaleString()} m, on ${formatLocalDate(start)}, after climbing up over the previous weeks.`);
      if (settings.style === 'push') this.log('Five weeks of acclimatisation rotations are behind you. This is the summit push.');
      this.radio('Ruth (expedition leader)', this.welcomeText(), 'info');
      this.radio('Ruth (expedition leader)', forecastText(this.world), 'info');
    }
    this.weatherHere = weather.sample(this.clock.time, this.player.altitude);
    this.ctx.features.setRopesFixedTo(this.world.ropeFixedTo);
  }

  /** The camp this expedition started from (older saves have none: Base Camp). */
  get startCamp(): LandmarkId {
    return this.settings.startCamp ?? 'bc';
  }

  private startTime = 0;

  private welcomeText() {
    const L0 = this.ctx.layout.landmarks;
    if (this.startCamp !== 'bc') {
      const here = L0[this.startCamp].name;
      const advice: Record<string, string> = {
        c1: 'Rest, drink, and push on to Camp 2 tomorrow.',
        c2: 'Camp 3 next, up the Lhotse Face. Stay clipped in.',
        c3: 'Next, the Yellow Band and the Geneva Spur to the South Col. Go on oxygen for it.',
        c4: 'Eat, drink, sleep on low flow. Summit push leaves at 21:00. Turnaround is 13:00.',
        summit: 'Take your photos, then start down. Most accidents happen on the descent. Watch your oxygen, and don\'t sit down until you\'re at the South Col.',
      };
      if (this.startCamp === 'summit') return `You're on top of the world! ${advice.summit}`;
      return `You're at ${here}. ${advice[this.startCamp] ?? ''}`;
    }
    if (!this.season.inSeason) {
      return `Welcome to Base Camp. It's ${this.season.name}: no other teams, no Icefall Doctors, no fixed ropes. You are on your own up there.`;
    }
    const front = this.world.ropeFixedTo;
    const L = this.ctx.layout.landmarks;
    const reached = (['summit', 'balcony', 'c4', 'c3', 'c2', 'c1'] as LandmarkId[]).find((id) => front >= L[id].s);
    return `Welcome to Base Camp. Ropes are fixed to ${reached ? L[reached].name : 'the top of the Icefall'}. Start through the Icefall early, before the sun warms it. Turnaround on summit day is 13:00.`;
  }

  radio(from: string, text: string, kind: RadioKind = 'info') {
    this.radioLog.push({ time: this.clock.time, from, text, kind });
    if (this.radioLog.length > 60) this.radioLog.splice(0, this.radioLog.length - 60);
    this.ctx.audio.radio();
  }

  log(text: string) {
    this.journal.push({ time: this.clock.time, text });
  }

  campHere() {
    const c = campNear(this.ctx.layout, this.player.s, 60);
    return c && this.player.hit.distance < 90 ? c : undefined;
  }

  private receive(kind: 'o2' | 'dex' | 'nifedipine' | 'tea', from: Npc) {
    if (this.player.dead) return;
    const g = this.player.gear;
    if (kind === 'o2') {
      g.bottles++;
      if (g.litres <= 0) g.swapBottle();
      if (g.flowLpm < 2) g.flowLpm = 2;
      this.radio(from.name, 'Here, a full bottle. Two litres. Breathe slowly.', 'good');
      this.log(`${from.name} gave you an oxygen cylinder.`);
    } else if (kind === 'dex') {
      this.player.meds.dexUntil = this.clock.time + 12 * HOUR;
      this.radio(from.name, 'Dexamethasone, 8 mg. Now we go down.', 'warn');
      this.log(`${from.name} injected you with dexamethasone.`);
    } else if (kind === 'nifedipine') {
      this.player.meds.nifedipineUntil = this.clock.time + 12 * HOUR;
    } else {
      this.player.physiology.drink(0.5);
    }
  }

  /** Called every frame while climbing. */
  frame(dt: number, input: Input, daylight: number) {
    if (this.ending) return;
    const p = this.player, g = p.gear, ph = p.physiology;
    const now = this.clock.time;
    const w = (this.weatherHere = this.weather.sample(now, p.altitude));

    this.handleKeys(input);
    if (this.ending) return;
    const before = p.pos.clone();
    const res = p.update(dt, {
      input, cameraYaw: this.follow.yaw, weather: w, now, daylight, ropeFixedTo: this.world.ropeFixedTo,
      speedSetting: this.settings.speed, assisted: this.flags.sherpaAssisting,
    });
    const gs = Math.min(600, res.gameSeconds);
    this.clock.rate = dt > 0 ? gs / dt : 1;
    this.clock.advance(gs);
    const moved = Math.hypot(p.pos.x - before.x, p.pos.z - before.z);
    this.distanceWalked += moved;

    {
      ph.step(gs, {
        altitude: p.altitude, tempC: w.tempC, windChillC: w.windChillC, windKmh: w.windKmh, sheltered: p.mode === 'tent',
        sleeping: false, daylight, snowGlare: p.snowGlare(),
      }, { o2FlowLpm: g.o2Flowing, downSuit: g.downSuit, goggles: g.goggles, packKg: g.packKg }, res.exertion, p.meds, this.clock.time);
    }
    if (this.god && ph.dead) {
      // Debug invulnerability: keep the symptoms, skip the dying.
      ph.dead = null;
      ph.hypoxicDebt = 0;
      ph.hape = Math.min(ph.hape, 0.9);
      ph.hace = Math.min(ph.hace, 0.9);
      ph.coreTemp = Math.max(ph.coreTemp, 30);
    }
    this.useOxygen(gs);
    if (g.headlamp) g.headlampBattery = Math.max(0, g.headlampBattery - gs / (14 * 3600));

    // Objective hazards.
    this.hazards.updateSnow(gs, w);
    if (!this.god) {
      this.hazards.roll(gs, p.s, this.clock.localHour, w.tempC);
      this.hazards.checkCrevasse(this.playerTarget(), moved, p.hit.distance);
    }
    this.hazards.update(dt, [this.playerTarget(), ...this.npcTargets()]);

    this.director.tick(gs);
    if (Math.abs(this.world.ropeFixedTo - this.lastRopeDraw) > 3) {
      this.lastRopeDraw = this.world.ropeFixedTo;
      this.ctx.features.setRopesFixedTo(this.world.ropeFixedTo);
    }
    this.velocityS = lerp(this.velocityS, (p.s - this.prevS) / Math.max(gs, 1e-3), 0.15);
    this.prevS = p.s;

    this.handleEvents();
    this.trackProgress();
    this.updateHallucinations(dt);
    this.checkEnd(dt);
    if (performance.now() - this.lastSave > 60_000) this.save();
  }

  private useOxygen(gs: number) {
    const g = this.player.gear;
    const before = g.litres;
    if (g.consume(gs)) {
      if (g.swapBottle()) {
        this.player.showAlert('Cylinder empty. You fumble a fresh one onto the regulator.', 3);
        this.player.forceStop(3 * this.player.effects.handling, 'Changing oxygen cylinder');
      } else {
        this.player.showAlert('Your oxygen has run out.', 4);
        this.log(`Ran out of oxygen at ${Math.round(this.player.altitude)} m.`);
      }
    }
    this.o2Used += Math.max(0, before - g.litres);
  }

  private handleKeys(input: Input) {
    const p = this.player, g = p.gear;
    if (input.wasPressed('BracketRight') || input.wasPressed('Equal')) {
      if (g.litres <= 0 && !g.swapBottle()) p.showAlert('No oxygen cylinder.', 2);
      else g.stepFlow(1);
    }
    if (input.wasPressed('BracketLeft') || input.wasPressed('Minus')) g.stepFlow(-1);
    if (input.wasPressed('Digit1')) {
      if (g.water >= 0.25) {
        g.water -= 0.25;
        p.physiology.drink(0.25);
        p.showAlert('You drink. The water is half ice.', 1.5);
      } else p.showAlert('Your bottle is empty. Melt snow at a camp.', 2);
    }
    if (input.wasPressed('Digit2')) {
      if (g.rations > 0) {
        g.rations--;
        p.physiology.eat();
        p.forceStop(3, 'Forcing down some food');
      } else p.showAlert('No food left.', 2);
    }
    if (input.wasPressed('Digit3')) {
      if (g.dex > 0) {
        g.dex--;
        p.meds.dexUntil = this.clock.time + 12 * HOUR;
        this.log('Took dexamethasone.');
        p.showAlert('Dexamethasone, 8 mg. It buys you time, not altitude.', 3);
      } else p.showAlert('No dexamethasone left.', 2);
    }
    if (input.wasPressed('Digit4')) {
      if (g.nifedipine > 0) {
        g.nifedipine--;
        p.meds.nifedipineUntil = this.clock.time + 12 * HOUR;
        this.log('Took nifedipine.');
        p.showAlert('Nifedipine, 30 mg.', 2);
      } else p.showAlert('No nifedipine left.', 2);
    }
    if (input.wasPressed('KeyG')) {
      g.goggles = !g.goggles;
      p.showAlert(g.goggles ? 'Goggles on.' : 'Goggles off. Your eyes will burn in this glare.', 2);
    }
    if (input.wasPressed('KeyL')) {
      g.headlamp = !g.headlamp && g.headlampBattery > 0;
    }
    if (input.wasPressed('KeyE')) {
      const doc = this.director.doctor;
      if (doc.pos.distanceTo(p.pos) < 6) {
        input.consume('KeyE');
        this.dialog = { title: doc.name, text: consult(this.world, doc) };
        this.log('Saw the Base Camp doctor.');
        return;
      }
      const casualty = this.world.npcs.find((n) => n.needsHelp && !n.dead && n.pos.distanceTo(p.pos) < 5);
      if (casualty) {
        input.consume('KeyE');
        this.helpNpc(casualty);
      }
    }
  }

  /** Set when an NPC conversation should be shown. */
  dialog: { title: string; text: string } | null = null;

  private helpNpc(n: Npc) {
    const g = this.player.gear;
    if (n.altitude > 7000 && n.o2Litres <= 0 && n.o2Bottles === 0 && g.bottles > 0) {
      g.bottles--;
      n.o2Bottles++;
      n.physiology.energy = Math.min(100, n.physiology.energy + 25);
      this.log(`Gave ${n.name} one of your oxygen cylinders.`);
      this.player.showAlert(`You give ${n.name} a cylinder. They get back on their feet.`, 3);
    } else if (g.dex > 0 && (n.physiology.hace > 0 || n.physiology.hape > 0)) {
      g.dex--;
      n.physiology.hace = Math.max(0, n.physiology.hace - 0.35);
      n.physiology.hape = Math.max(0, n.physiology.hape - 0.2);
      this.log(`Gave ${n.name} your dexamethasone.`);
      this.player.showAlert(`You inject ${n.name} with dex. Their eyes focus.`, 3);
    } else {
      n.physiology.energy = Math.min(100, n.physiology.energy + 10);
      n.physiology.coreTemp = Math.min(37, n.physiology.coreTemp + 0.5);
      this.clock.advance(20 * 60);
      this.player.physiology.energy = Math.max(0, this.player.physiology.energy - 5);
      this.log(`Stopped to help ${n.name}.`);
      this.player.showAlert(`You give ${n.name} water and stay with them for a while.`, 3);
    }
    n.needsHelp = false;
    n.physiology.hypoxicDebt = Math.max(0, n.physiology.hypoxicDebt - 2);
  }

  private playerTarget(): HazardTarget {
    const p = this.player;
    return {
      s: p.s,
      lateral: p.hit.lateral,
      kill: (cause, detail) => {
        if (this.god) return;
        p.kill(cause, detail);
      },
    };
  }

  private npcTargets(): HazardTarget[] {
    return this.world.npcs.filter((n) => !n.dead && !n.inTent && n.role !== 'leader').map((n) => ({
      s: n.s,
      lateral: n.lateral,
      kill: (cause) => {
        n.physiology.die(cause as DeathCause);
        this.log(`${n.name} (${n.team}) was killed by ${cause === 'serac' ? 'a serac fall' : 'an avalanche'}.`);
        this.radio('Base Camp', `We've lost ${n.name} from ${n.team}.`, 'alert');
      },
    }));
  }

  private handleEvents() {
    const p = this.player, audio = this.ctx.audio;
    for (const e of p.events) {
      switch (e) {
        case 'cough': audio.cough(); break;
        case 'clip': case 'unclip': audio.clip(); break;
        case 'stumble': this.follow.addShake(0.4); this.model.flinch(); break;
        case 'slip': this.follow.addShake(0.8); this.model.flinch(); this.log(`Slipped at ${Math.round(p.altitude)} m.`); break;
        case 'arrest': this.log('Self-arrested with the ice axe.'); break;
        case 'gust': this.follow.addShake(0.5); this.model.flinch(); break;
        case 'ladderFall': this.log('Fell off a ladder in the Icefall; the handline held.'); break;
        case 'ladder':
          if (!this.ladderLogged) {
            this.ladderLogged = true;
            this.log('First ladder crossing over a crevasse.');
          }
          break;
        case 'collapse':
          this.log(`Collapsed at ${Math.round(p.altitude)} m.`);
          this.radio('You', 'I… I can\'t…', 'alert');
          break;
        case 'summit':
          this.summitTime = this.clock.time;
          this.log('Reached the summit of Mount Everest, 8,849 m.');
          this.radio('Ruth (expedition leader)', 'You are on top of the world! Take your photos. Now listen: most accidents happen on the way down. Turn around in ten minutes.', 'good');
          p.showAlert('SUMMIT OF EVEREST · 8,849 m', 6);
          break;
      }
    }
  }

  private trackProgress() {
    const p = this.player, L = this.ctx.layout;
    const sec = sectionAt(L, p.s);
    for (const s of L.sections) {
      if (p.maxS >= s.s1 - 5 && !this.walked.has(s.index)) {
        this.walked.add(s.index);
        this.log(`Climbed the ${s.name}.`);
      }
    }
    void sec;
    const camp = this.campHere();
    if (camp && camp.id !== this.lastCampId) {
      this.lastCampId = camp.id;
      this.log(`Reached ${camp.name} (${Math.round(p.altitude).toLocaleString()} m).`);
      if (camp.id === 'bc' && this.calledOff) return;
      this.save();
    } else if (!camp && this.lastCampId && Math.abs(L.landmarks[this.lastCampId].s - p.s) > 150) {
      this.lastCampId = null;
    }
    // Reopen the mountain when the jet stream lifts.
    if (this.flags.mountainClosed) {
      const sw = this.weather.sample(this.clock.time, 8849).windKmh;
      this.reopenTimer = sw < 55 ? this.reopenTimer + 1 : 0;
      if (this.reopenTimer > 600) {
        this.flags.mountainClosed = false;
        this.reopenTimer = 0;
        this.radio('Ruth (expedition leader)', 'Summit winds are dropping. The upper mountain is open again.', 'good');
      }
    }
  }

  private updateHallucinations(dt: number) {
    const e = this.player.effects;
    if (this.ghostLife > 0) {
      this.ghostLife -= dt;
      const a = Math.min(1, this.ghostLife / 2, (6 - this.ghostLife) / 1.5) * 0.65;
      this.ghost.setGhost(Math.max(0, a));
      this.ghost.root.visible = this.ghostLife > 0;
      this.ghost.animate(dt, 0, 0, 'sit');
      return;
    }
    if (e.hallucinate && this.rng.next() < 0.04 * dt) {
      const s = this.player.s + this.rng.range(20, 50);
      const pos = this.ctx.route.offsetPoint(s, this.rng.range(8, 20) * (this.rng.chance(0.5) ? 1 : -1));
      this.ghost.root.position.copy(pos);
      this.ghost.root.rotation.y = this.rng.range(0, Math.PI * 2);
      this.ghostLife = 6;
      if (!this.hallucinationLogged) {
        this.hallucinationLogged = true;
        this.log('Saw a climber sitting in the snow who was not there.');
      }
    }
  }

  private checkEnd(dt: number) {
    const p = this.player, L = this.ctx.layout;
    if (p.dead) {
      if (this.deathTimer < 0) {
        this.deathTimer = 3.5;
        this.log(`Died at ${Math.round(p.altitude).toLocaleString()} m. ${p.deathDetail}`);
        this.radio('Base Camp', 'Come in… come in… do you copy?', 'alert');
        this.clearSave();
      }
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) {
        this.ending = {
          kind: 'death',
          title: p.summited ? 'You reached the summit. You did not come home.' : 'You died on Everest',
          text: p.deathDetail,
        };
      }
      return;
    }
    if (p.summited && p.s < L.landmarks.c4.s + 40) {
      this.ending = {
        kind: 'summit',
        title: 'Summit, and back to the South Col alive',
        text: `You stood on top of the world at ${formatLocalTime(this.summitTime)} on ${formatLocalDate(this.summitTime)} and made it back to Camp 4.`,
      };
      this.clearSave();
    } else if (this.calledOff && p.s < 60) {
      this.ending = {
        kind: 'retreat',
        title: 'Expedition called off',
        text: `You turned back and walked into Base Camp alive. Highest point: ${Math.round(this.ctx.route.altitudeAt(p.maxS)).toLocaleString()} m. The mountain will still be there.`,
      };
      this.clearSave();
    }
  }

  callOff() {
    if (this.calledOff) return;
    this.calledOff = true;
    this.flags.descentOrdered = true;
    this.log(`Called off the expedition at ${Math.round(this.player.altitude).toLocaleString()} m.`);
    this.radio('Ruth (expedition leader)', 'Understood. Good call. Get yourself down safely; Base Camp is waiting with hot tea.', 'info');
    if (this.director.sherpa) this.radio(this.director.sherpa.name, 'OK. We go down together. I lead.', 'info');
  }

  // ----- Camps, time skips, fast travel -----

  enterCamp(): boolean {
    if (!this.campHere()) return false;
    this.player.mode = 'tent';
    return true;
  }

  leaveCamp() {
    if (this.player.mode === 'tent') this.player.mode = 'walk';
    this.save();
  }

  /** Pass time in the tent. */
  private skip(hours: number, opts: { sleeping?: boolean; sheltered?: boolean; exertion?: number; until?: () => boolean } = {}) {
    const p = this.player, g = p.gear, ph = p.physiology;
    const steps = Math.ceil(hours * 60);
    let spo2Sum = 0, n = 0;
    const start = { hape: ph.hape, hace: ph.hace, ams: ph.ams, core: ph.coreTemp };
    let woke = '';
    for (let i = 0; i < steps; i++) {
      this.clock.advance(60);
      const w = this.weather.sample(this.clock.time, p.altitude);
      ph.step(60, {
        altitude: p.altitude, tempC: w.tempC, windChillC: w.windChillC, windKmh: w.windKmh,
        sheltered: opts.sheltered ?? true, sleeping: !!opts.sleeping, daylight: 0, snowGlare: 0,
      }, { o2FlowLpm: g.o2Flowing, downSuit: g.downSuit, goggles: true, packKg: g.packKg }, opts.exertion ?? 0.1, p.meds, this.clock.time);
      this.useOxygen(60);
      this.campHydration(60);
      this.hazards.updateSnow(60, w);
      this.director.tick(60);
      spo2Sum += ph.spo2;
      n++;
      if (ph.dead || opts.until?.()) break;
      // New symptoms wake you so you can act on them.
      if (ph.hape > 0 && start.hape === 0) woke = 'You wake gasping, with a wet, rattling cough.';
      else if (ph.hace > 0 && start.hace === 0) woke = 'You wake confused, and can\'t find the tent zip.';
      else if (ph.ams > 0.6 && start.ams <= 0.6) woke = 'You wake with a crushing headache and vomit.';
      else if (ph.hape > start.hape + 0.15 || ph.hace > start.hace + 0.15) woke = 'You are getting worse.';
      else if (ph.coreTemp < 35.5 && start.core >= 35.5) woke = 'You wake shaking uncontrollably with cold.';
      if (woke) break;
    }
    if (woke) this.log(woke);
    this.weatherHere = this.weather.sample(this.clock.time, p.altitude);
    this.ctx.features.setRopesFixedTo(this.world.ropeFixedTo);
    if (ph.dead) this.player.mode = 'dead';
    return { avgSpo2: n ? spo2Sum / n : ph.spo2, hours: n / 60, woke };
  }

  /** In a tent you keep the stove going: tea at the kitchen camps, melted snow higher up. */
  private campHydration(dtSec: number) {
    const ph = this.player.physiology;
    const camp = this.campHere();
    if (!camp || ph.hydration > 90) return;
    const h = dtSec / 3600;
    if (camp.id === 'bc' || camp.id === 'c2') {
      ph.hydration = Math.min(95, ph.hydration + 6 * h);
    } else {
      // The stove is slow and the snow is mostly air, but you keep brewing.
      ph.hydration = Math.min(85, ph.hydration + 3.5 * h);
    }
  }

  private sleepUntil(hour: number): string {
    const p = this.player.physiology;
    const before = { ams: p.ams, energy: p.energy };
    const target = this.clock.nextLocalHour(hour);
    const r = this.skip((target - this.clock.time) / HOUR, { sleeping: true });
    if (p.dead) return this.deathInTent();
    if (r.woke) return `${r.woke} It's ${formatLocalTime(this.clock.time)}. SpO₂ ${Math.round(p.spo2)}%.`;
    const feel = p.ams > before.ams + 0.1 ? 'You wake with a splitting headache.' :
      p.energy > before.energy + 10 ? 'You slept, mostly. You feel stronger.' : 'A long, restless night of Cheyne-Stokes breathing.';
    return `Slept ${r.hours.toFixed(1)} h, until ${formatLocalTime(this.clock.time)}. Average SpO₂ overnight ${Math.round(r.avgSpo2)}%. ${feel}`;
  }

  private deathInTent(): string {
    if (!this.player.deathDetail) this.player.deathDetail = `You died in your tent at ${Math.round(this.player.altitude).toLocaleString()} m.`;
    this.player.mode = 'dead';
    return 'You did not wake up.';
  }

  /** Walk along the route to targetS with the time and the body simulated, stopping if something goes wrong. */
  travel(targetS: number, label: string): { text: string; arrived: boolean } {
    const p = this.player, g = p.gear, ph = p.physiology, route = this.ctx.route, L = this.ctx.layout;
    p.mode = 'walk';
    let s = p.s;
    const dir = Math.sign(targetS - s);
    let minutes = 0;
    let stop = '';
    const hapeBefore = ph.hape, haceBefore = ph.hace;
    const userFlow = g.flowLpm;
    while (Math.abs(targetS - s) > 2 && !stop) {
      const alt = route.altitudeAt(s);
      const grade = route.gradeAt(s) * dir;
      const eff = computeEffects(ph);
      const tf = s < L.landmarks.c1.s && s > 200 ? 0.62 : 1;
      const w = this.weather.sample(this.clock.time, alt);
      const windF = 1 - clamp((w.windKmh - 50) / 120, 0, 0.6);
      // Climbers go on gas from Camp 3 up.
      if (s > L.landmarks.c3.s - 20 && (g.litres > 0 || g.bottles > 0)) {
        if (g.litres <= 0) g.swapBottle();
        g.flowLpm = Math.max(userFlow, dir > 0 ? 2 : 1);
      }
      const v = realisticSpeed(grade, tf, ph.spo2, alt, eff, g.packKg) * windF * (this.flags.sherpaAssisting ? 1.25 : 1);
      s += dir * Math.min(Math.abs(targetS - s), v * 60);
      route.pointAt(s, p.pos);
      p.hit = { s, index: route.indexAt(s), lateral: 0, distance: 0 };
      this.clock.advance(60);
      minutes++;
      ph.step(60, {
        altitude: alt, tempC: w.tempC, windChillC: w.windChillC, windKmh: w.windKmh, sheltered: false, sleeping: false,
        daylight: 1, snowGlare: 0.8,
      }, { o2FlowLpm: g.o2Flowing, downSuit: g.downSuit, goggles: true, packKg: g.packKg }, dir > 0 ? 0.75 : 0.5, p.meds, this.clock.time);
      this.useOxygen(60);
      this.hazards.updateSnow(60, w);
      this.director.tick(60);
      if (s > p.maxS) p.maxS = s;
      // Objective dangers, abstracted.
      if (!this.god && inSpan(L.seracZone, s) && this.rng.next() < (0.05 + 0.35 * clamp((this.clock.localHour - 8) / 6, 0, 1)) / 60) {
        if (this.rng.chance(0.3)) p.kill('serac', 'A serac collapsed in the Khumbu Icefall as you passed beneath it.');
        else this.log('A serac collapsed close to the route. You ran.');
      }
      for (const z of L.avalancheZones) {
        if (!this.god && inSpan(z, s) && this.rng.next() < (0.004 + 0.06 * clamp(this.hazards.snowLoad / 50, 0, 1)) / 60) {
          if (this.rng.chance(0.35)) p.kill('avalanche', 'An avalanche released above the route and buried you.');
          else this.log('An avalanche ran down the slope just ahead of you.');
        }
      }
      if (ph.dead || p.dead) {
        p.mode = 'dead';
        p.deathDetail ||= `You died on the way, at ${Math.round(alt).toLocaleString()} m.`;
        stop = 'dead';
      } else if (w.stormLevel > 0.6) stop = `A storm hits at ${Math.round(alt).toLocaleString()} m. You stop and brace.`;
      else if (ph.hape > 0 && hapeBefore === 0) stop = 'You can\'t stop coughing, and your chest gurgles. Something is wrong.';
      else if (ph.hace > 0 && haceBefore === 0) stop = 'You stumble, again and again. Your head feels wrong.';
      else if (ph.ams > 0.65) stop = 'Your head is pounding and you vomit. You stop.';
      else if (ph.energy < 6) stop = 'You are spent. You have to stop.';
      else if (dir > 0 && (this.clock.localHour >= 19 || this.clock.localHour < 3) && !(s > L.landmarks.c4.s - 5)) stop = 'Night falls. You stop.';
      else if (minutes > 30 * 60) stop = 'You lose track of time.';
    }
    if (!g.o2Flowing) g.flowLpm = userFlow;
    if (!p.dead) {
      p.placeAt(s, 2);
      this.follow.snap();
    }
    this.prevS = p.s;
    const sh = this.director.sherpa;
    if (sh && !sh.dead) sh.s = Math.max(0, s - 5);
    const dur = `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    if (stop === 'dead') return { text: 'You did not make it.', arrived: false };
    if (stop) {
      this.log(`${label}: stopped after ${dur}. ${stop}`);
      return { text: `${stop} (after ${dur})`, arrived: false };
    }
    this.log(`${label} (${dur}).`);
    return { text: `${label}: ${dur}. Arrived at ${formatLocalTime(this.clock.time)}.`, arrived: true };
  }

  campActions(): CampAction[] {
    const camp = this.campHere();
    if (!camp) return [];
    const p = this.player, g = p.gear, ph = p.physiology, L = this.ctx.layout;
    const id = camp.id;
    const idx = CAMP_ORDER.indexOf(id);
    const kitchen = id === 'bc' || id === 'c2';
    const night = this.clock.localHour >= 18 || this.clock.localHour < 4;
    const acts: CampAction[] = [];
    acts.push({ label: 'Rest for an hour', run: () => {
      this.skip(1);
      return `Rested. Energy ${Math.round(ph.energy)}, SpO₂ ${Math.round(ph.spo2)}%.`;
    } });
    acts.push({ label: night ? 'Sleep until 05:00' : 'Sleep until tomorrow, 05:00', run: () => this.sleepUntil(5) });
    if (id === 'c4' || id === 'c3') {
      acts.push({ label: 'Rest until 21:00 (summit push departure)', run: () => this.sleepUntil(21) });
    }
    acts.push({ label: kitchen ? 'Fill bottles from the kitchen tent' : 'Melt snow on the stove (fill bottles)', run: () => {
      const need = g.waterMax - g.water;
      if (need <= 0.01) return 'Your bottles are already full.';
      this.skip(kitchen ? 0.25 : need * 0.9, { exertion: 0.15 });
      g.water = g.waterMax;
      ph.drink(0.5);
      return `Bottles full (${g.waterMax} L). You drank half a litre of tea.`;
    } });
    acts.push({ label: kitchen ? 'Eat in the mess tent (and restock food)' : `Eat a meal (${g.rations} rations left)`, disabled: !kitchen && g.rations <= 0 ? 'No food' : undefined, run: () => {
      this.skip(0.5);
      ph.eat();
      if (kitchen) g.rations = 6;
      else g.rations--;
      return ph.effAltitude > 7000 ? 'You force down a few spoonfuls of noodles. No appetite up here.' : 'A hot meal. You feel human again.';
    } });
    if (this.stash[id] > 0) {
      acts.push({ label: `Take an oxygen cylinder from the stash (${this.stash[id]} here)`, run: () => {
        this.stash[id]--;
        g.bottles++;
        if (g.litres <= 0) g.swapBottle();
        return `You now have ${Math.round(g.litres)} L on the regulator and ${g.bottles} spare.`;
      } });
    }
    if (g.bottles > 0) {
      acts.push({ label: 'Leave a spare cylinder in the stash', run: () => {
        g.bottles--;
        this.stash[id]++;
        return 'Cylinder cached for later.';
      } });
    }
    if (g.litres > 0) {
      acts.push({ label: `Oxygen while resting: ${g.flowLpm > 0 ? g.flowLpm + ' L/min (turn off)' : 'off (turn on at 0.5 L/min)'}`, run: () => {
        g.flowLpm = g.flowLpm > 0 ? 0 : 0.5;
        return g.flowLpm > 0 ? 'Sleeping on half a litre a minute.' : 'Oxygen off.';
      } });
    }
    acts.push({ label: g.downSuit ? 'Take off the down suit' : 'Put on the down suit', run: () => {
      g.downSuit = !g.downSuit;
      return g.downSuit ? 'Zipped into the down suit. Warm, bulky, slower.' : 'Down suit packed away. You will overheat less in the Cwm.';
    } });
    acts.push({ label: 'Wait for better weather (up to 48 h)', run: () => {
      const r = this.skip(48, { until: () => {
        const here = this.weather.sample(this.clock.time, p.altitude);
        const top = this.weather.sample(this.clock.time, 8849);
        return here.stormLevel < 0.3 && top.windKmh < 50 && this.clock.localHour > 3 && this.clock.localHour < 10;
      } });
      if (ph.dead) return this.deathInTent();
      return `Waited ${r.hours.toFixed(0)} h. It's ${formatLocalTime(this.clock.time)}, ${formatLocalDate(this.clock.time)}. ${forecastText(this.world)}`;
    } });
    if (id === 'bc') {
      acts.push({ label: 'Rest day at Base Camp (24 h)', run: () => {
        this.skip(24, { sleeping: true });
        ph.cough = Math.max(0, ph.cough - 0.05);
        return `A day of rest, eating and sleeping. Energy ${Math.round(ph.energy)}. Acclimatised to ${Math.round(ph.acclimAlt).toLocaleString()} m.`;
      } });
      acts.push({ label: 'Acclimatisation rotation: Camp 1, Camp 2, tag Camp 3, back (about 6 days)', disabled: this.calledOff ? 'Expedition called off' : !this.flags.doctorClearance ? 'Not cleared by the doctor' : undefined, run: () => this.rotation(), closes: false });
    }
    // Fast travel down (always) and up (only sections you've climbed before).
    if (idx > 0) {
      const below = CAMP_ORDER[idx - 1];
      acts.push({ label: `Descend to ${L.landmarks[below].name}`, run: () => this.travel(L.landmarks[below].s, `Descended to ${L.landmarks[below].name}`).text, closes: true });
      if (idx > 1) acts.push({ label: 'Descend all the way to Base Camp', run: () => this.travel(0, 'Descended to Base Camp').text, closes: true });
    }
    if (idx >= 0 && idx < CAMP_ORDER.length - 1) {
      const above = CAMP_ORDER[idx + 1];
      const sec = L.sections[idx];
      let disabled: string | undefined;
      if (!this.walked.has(sec.index)) disabled = 'Climb it on foot first';
      else if (this.calledOff) disabled = 'Expedition called off';
      else if (this.clock.localHour < 3 || this.clock.localHour > 11) disabled = 'Leave early in the morning (03:00 to 11:00)';
      acts.push({ label: `Climb to ${L.landmarks[above].name} (fast travel)`, disabled, run: () => this.travel(L.landmarks[above].s, `Climbed to ${L.landmarks[above].name}`).text, closes: true });
    }
    return acts;
  }

  private rotation(): string {
    const L = this.ctx.layout.landmarks;
    const out: string[] = [];
    const leg = (s: number, label: string) => {
      const r = this.travel(s, label);
      out.push(r.text);
      return r.arrived && !this.player.dead;
    };
    const sleep = (h: number) => {
      const ph = this.player.physiology;
      const before = { hape: ph.hape, hace: ph.hace };
      out.push(this.sleepUntil(h));
      // Abandon the rotation if the night went badly.
      return !this.player.dead && ph.hape <= before.hape && ph.hace <= before.hace && ph.ams < 0.6;
    };
    if (this.clock.localHour > 6) sleep(3.5);
    const ok = leg(L.c1.s, 'Rotation: up to Camp 1') && sleep(5) &&
      leg(L.c2.s, 'Rotation: up to Camp 2') && sleep(5) && (this.skip(20), true) && sleep(4) &&
      leg(L.c3.s, 'Rotation: tagged Camp 3') && leg(L.c2.s, 'Rotation: back to Camp 2') && sleep(5) &&
      leg(0, 'Rotation: down to Base Camp');
    if (ok) {
      this.walked.add(0); this.walked.add(1); this.walked.add(2);
      this.log(`Completed an acclimatisation rotation. Acclimatised to about ${Math.round(this.player.physiology.acclimAlt).toLocaleString()} m.`);
      out.push(`Rotation complete. You are acclimatised to about ${Math.round(this.player.physiology.acclimAlt).toLocaleString()} m.`);
    }
    return out.join(' ');
  }

  /** What the touch Action button should do right now. */
  contextAction(): ActionKind {
    const p = this.player;
    if (p.mode === 'slip') return 'arrest';
    if (p.mode === 'ladder') return 'ladder';
    if (p.mode !== 'walk' && p.mode !== 'rest') return null;
    if (this.director.doctor.pos.distanceTo(p.pos) < 6) return 'talk';
    if (this.world.npcs.some((n) => n.needsHelp && !n.dead && n.pos.distanceTo(p.pos) < 5)) return 'help';
    if (p.clipped) return 'unclip';
    if (p.canClip(this.world.ropeFixedTo) && p.hit.distance < 3) return 'clip';
    if (this.campHere()) return 'camp';
    return null;
  }

  /** Context prompt when the player isn't already being told something. */
  contextPrompt(): string {
    const p = this.player;
    if (p.prompt) return p.prompt;
    if (this.director.doctor.pos.distanceTo(p.pos) < 6) return '[E] Talk to the doctor';
    const casualty = this.world.npcs.find((n) => n.needsHelp && !n.dead && n.pos.distanceTo(p.pos) < 5);
    if (casualty) return `[E] Help ${casualty.name}`;
    if (!p.clipped && p.canClip(this.world.ropeFixedTo) && p.hit.distance < 3) return '[E] Clip into the fixed line';
    const camp = this.campHere();
    if (camp) return `[C] Enter your tent at ${camp.name}`;
    return '';
  }

  placeLabel(): string {
    const p = this.player, L = this.ctx.layout;
    const camp = this.campHere();
    if (camp) return camp.name;
    const near = Object.values(L.landmarks).find((l) => !l.camp && Math.abs(l.s - p.s) < 60);
    if (near) return near.name;
    if (p.hit.distance > 40) return 'Off route';
    return sectionAt(L, p.s).name;
  }

  stats() {
    const p = this.player, ph = p.physiology;
    return {
      'Highest point': `${Math.round(this.ctx.route.altitudeAt(p.maxS)).toLocaleString()} m`,
      'Days on the mountain': `${((this.clock.time - this.startTime) / (24 * HOUR)).toFixed(1)}`,
      'Distance walked': `${(this.distanceWalked / 1000).toFixed(1)} km`,
      'Oxygen used': `${Math.round(this.o2Used)} L (${(this.o2Used / BOTTLE_LITRES).toFixed(1)} cylinders)`,
      'Acclimatised to': `${Math.round(ph.acclimAlt).toLocaleString()} m`,
      'Frostbite': ph.frostbiteFeet > 0.6 || ph.frostbiteHands > 0.6 ? 'Severe: amputation likely' : ph.frostbiteFeet > 0.25 || ph.frostbiteHands > 0.25 ? 'Moderate' : ph.frostbiteFeet + ph.frostbiteHands > 0.02 ? 'Frostnip' : 'None',
      'Others who summited': `${this.world.npcs.filter((n) => n.summited).length}`,
      'Others who died': `${this.world.npcs.filter((n) => n.dead).length}`,
    };
  }

  // ----- Save / load -----

  serialize(): SaveData {
    const p = this.player;
    return {
      version: 1,
      settings: this.settings,
      time: this.clock.time,
      player: {
        s: p.s, lateral: p.hit.lateral, maxS: p.maxS, summited: p.summited, meds: p.meds,
        physiology: p.physiology.serialize(), gear: { ...p.gear },
      },
      journal: this.journal, radio: this.radioLog.slice(-20), flags: this.flags, calledOff: this.calledOff,
      stash: this.stash, walked: [...this.walked], summitTime: this.summitTime, distance: this.distanceWalked,
      o2Used: this.o2Used, snowLoad: this.hazards.snowLoad, director: this.director.serialize(),
    };
  }

  private restore(d: SaveData) {
    this.clock.time = d.time;
    const p = this.player;
    p.placeAt(d.player.s, d.player.lateral);
    p.maxS = d.player.maxS;
    p.summited = d.player.summited;
    p.meds = d.player.meds;
    Object.assign(p.physiology, d.player.physiology);
    Object.assign(p.gear, d.player.gear);
    this.journal = d.journal;
    this.radioLog = d.radio;
    Object.assign(this.flags, d.flags);
    this.calledOff = d.calledOff;
    this.stash = d.stash;
    this.walked = new Set(d.walked);
    this.summitTime = d.summitTime;
    this.distanceWalked = d.distance;
    this.o2Used = d.o2Used;
    this.hazards.snowLoad = d.snowLoad;
    this.director.restore(d.director);
    this.world.ropeFixedTo = d.director.ropeFront;
    this.prevS = p.s;
    this.lastCampId = this.campHere()?.id ?? null;
  }

  save() {
    if (this.ending || this.player.dead) return;
    this.lastSave = performance.now();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.serialize()));
    } catch { /* storage unavailable */ }
  }

  clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch { /* ignore */ }
  }

  static loadSave(): SaveData | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? (JSON.parse(raw) as SaveData) : null;
    } catch {
      return null;
    }
  }

  dispose() {
    const { scene } = this.ctx;
    scene.remove(this.director.group, this.hazards.group, this.model.root, this.ghost.root);
  }

  /** Per-frame visuals for the player's climber model. */
  updateModel(dt: number) {
    const p = this.player;
    const m = this.model;
    m.root.position.copy(p.pos);
    m.face(p.heading, dt);
    m.groundEnabled = p.mode !== 'ladder';
    const t = this.ctx.terrain;
    // Slope along the direction the climber faces.
    const ahead = t.heightAt(p.pos.x + Math.sin(p.heading) * 1.5, p.pos.z + Math.cos(p.heading) * 1.5);
    const grade = clamp((ahead - p.pos.y) / 1.5, -0.6, 0.8);
    const pose = p.mode === 'dead' || p.mode === 'down' ? 'lie' : p.mode === 'rest' ? 'sit' : p.clipped && p.speedVisual > 0 && grade > 0.5 ? 'jumar' : 'walk';
    const effort = clamp((1 - p.effects.speed) * 0.8 + clamp((p.physiology.effAltitude - 6000) / 2800, 0, 1) * 0.6 + p.physiology.exhaustion * 0.4, 0, 1);
    m.animate(dt, p.speedVisual, grade, pose, effort);
    m.setOxygen(p.gear.o2Flowing > 0);
    m.setLamp(p.gear.headlamp && p.gear.headlampBattery > 0, p.gear.headlampBattery > 0.1 ? 1 : 0.3);
    m.root.visible = p.mode !== 'tent';
  }
}

export interface SaveData {
  version: 1;
  settings: ExpeditionSettings;
  time: number;
  player: {
    s: number; lateral: number; maxS: number; summited: boolean; meds: { dexUntil: number; nifedipineUntil: number };
    physiology: Record<string, unknown>; gear: Record<string, unknown>;
  };
  journal: JournalEntry[];
  radio: RadioMessage[];
  flags: WorldFlags;
  calledOff: boolean;
  stash: Record<string, number>;
  walked: number[];
  summitTime: number;
  distance: number;
  o2Used: number;
  snowLoad: number;
  director: ReturnType<Director['serialize']>;
}
