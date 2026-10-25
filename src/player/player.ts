import * as THREE from 'three';
import { Physiology, type Meds } from '../sim/physiology';
import { computeEffects, realisticSpeed, visualSpeed, type Effects } from '../sim/effects';
import { Gear } from './gear';
import type { Input } from './input';
import type { Route, RouteHit } from '../world/route';
import type { RouteLayout, Ladder } from '../world/sections';
import { inSpan } from '../world/sections';
import type { WeatherSample } from '../weather/model';
import type { Rng } from '../core/rng';
import { clamp, smoothstep } from '../core/mathx';

export type PlayerMode = 'walk' | 'ladder' | 'slip' | 'rest' | 'tent' | 'down' | 'dead';

export interface FrameContext {
  input: Input;
  cameraYaw: number;
  weather: WeatherSample;
  now: number;
  daylight: number;
  ropeFixedTo: number;
  speedSetting: number;
  /** A Sherpa is short-roping you: safer and a little faster. */
  assisted: boolean;
}

export interface FrameResult {
  /** Game seconds to advance this frame. */
  gameSeconds: number;
  exertion: number;
  moving: boolean;
  realSpeed: number;
  visualSpeed: number;
}

const IDLE_TIME_RATE = 4;
const REST_TIME_RATE = 60;
const ANCHOR_SPACING = 40;
const ROPE_OFFSET = 0.7;

/** The player climber: movement over the real terrain, fixed ropes, ladders, slips and falls. */
export class Player {
  readonly pos = new THREE.Vector3();
  heading = 0;
  mode: PlayerMode = 'walk';
  clipped = false;
  ladderClipped = false;
  readonly physiology: Physiology;
  readonly gear = new Gear();
  meds: Meds = { dexUntil: 0, nifedipineUntil: 0 };
  effects: Effects;
  hit: RouteHit = { s: 0, index: 0, lateral: 0, distance: 0 };
  prompt = '';
  alert = '';
  alertUntil = 0;
  deathDetail = '';
  /** Highest point reached along the route. */
  maxS = 0;
  summited = false;
  speedReal = 0;
  speedVisual = 0;
  /** The ladder currently being crossed. */
  ladder: Ladder | null = null;
  balance = 0;
  private balanceVel = 0;
  private slipVel = new THREE.Vector3();
  private slipDistance = 0;
  private slipWindow = 0;
  private stopTimer = 0;
  private stopReason = '';
  private reclipTimer = 0;
  private lastAnchor = -1;
  private inputHistory: { t: number; f: number; r: number }[] = [];
  private realTime = 0;
  private invertTimer = 0;
  private gaspTimer = 0;
  /** Events for the game to log/sound: 'stumble', 'cough', 'slip', 'arrest', 'ladderFall', ... */
  events: string[] = [];

  constructor(private route: Route, private layout: RouteLayout, private rng: Rng) {
    this.physiology = new Physiology(rng);
    this.effects = computeEffects(this.physiology);
  }

  get altitude() {
    return this.pos.y;
  }
  get s() {
    return this.hit.s;
  }
  get dead() {
    return this.mode === 'dead';
  }

  placeAt(s: number, lateral = 0) {
    this.route.offsetPoint(s, lateral, this.pos);
    this.heading = Math.atan2(this.route.tangentAt(s).x, this.route.tangentAt(s).z);
    this.hit = this.route.closest(this.pos.x, this.pos.z);
    this.mode = 'walk';
    this.clipped = false;
    this.ladder = null;
    this.slipVel.set(0, 0, 0);
  }

  kill(cause: Parameters<Physiology['die']>[0], detail: string) {
    if (this.dead) return;
    this.physiology.die(cause);
    this.mode = 'dead';
    this.deathDetail = detail;
  }

  showAlert(text: string, seconds = 3) {
    this.alert = text;
    this.alertUntil = this.realTime + seconds;
  }

  /** Halt for a few real seconds (coughing fit, catching breath, stumble). */
  forceStop(seconds: number, reason: string) {
    this.stopTimer = Math.max(this.stopTimer, seconds);
    this.stopReason = reason;
  }

  canClip(ropeFixedTo: number): boolean {
    const s = this.hit.s;
    return s <= ropeFixedTo && this.layout.ropes.some((r) => inSpan(r, s)) && Math.abs(this.hit.lateral - ROPE_OFFSET) < 2.5;
  }

  update(dtReal: number, ctx: FrameContext): FrameResult {
    this.realTime += dtReal;
    this.events = [];
    this.prompt = '';
    if (this.alert && this.realTime > this.alertUntil) this.alert = '';
    this.effects = computeEffects(this.physiology);
    if (this.physiology.dead && this.mode !== 'dead') {
      this.mode = 'dead';
      this.deathDetail ||= deathText(this.physiology.dead);
    }
    if (this.mode === 'dead') return this.result(dtReal * IDLE_TIME_RATE, 0, false);
    if (this.mode === 'tent') return this.result(dtReal * IDLE_TIME_RATE, 0.1, false);

    const input = ctx.input;
    let f = (input.isDown('KeyW') || input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('KeyS') || input.isDown('ArrowDown') ? 1 : 0);
    let r = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    // Confusion: delayed and occasionally swapped controls.
    this.inputHistory.push({ t: this.realTime, f, r });
    while (this.inputHistory.length > 2 && this.inputHistory[1].t < this.realTime - this.effects.inputLag) this.inputHistory.shift();
    if (this.effects.inputLag > 0.05) ({ f, r } = this.inputHistory[0]);
    if (this.invertTimer > 0) {
      this.invertTimer -= dtReal;
      r = -r;
    } else if (this.rng.next() < this.effects.invertPerSec * dtReal) {
      this.invertTimer = 2 + this.rng.next() * 3;
      this.showAlert('Your thoughts are slipping…', 2);
    }
    const wantsMove = f !== 0 || r !== 0;
    const push = input.isDown('ShiftLeft') || input.isDown('ShiftRight');

    // Resting where you stand.
    if (input.wasPressed('KeyR') && this.mode !== 'slip' && this.mode !== 'ladder') {
      this.mode = this.mode === 'rest' ? 'walk' : 'rest';
    }
    if (this.mode === 'rest') {
      if (wantsMove) this.mode = 'walk';
      else {
        this.prompt = 'Resting… (R or move to continue)';
        return this.result(dtReal * REST_TIME_RATE, 0.12, false);
      }
    }
    if (this.mode === 'down') {
      this.prompt = 'You have collapsed. You need help, or oxygen.';
      if (this.physiology.energy > 8 || this.gear.o2Flowing > 0) this.mode = 'walk';
      return this.result(dtReal * REST_TIME_RATE * 0.5, 0.1, false);
    }

    if (this.mode === 'slip') return this.updateSlip(dtReal, ctx);

    // Random afflictions that stop you in your tracks.
    if (this.rng.next() < this.effects.coughPerSec * dtReal) {
      this.forceStop(1.5 + this.physiology.cough * 2, 'Coughing fit');
      this.events.push('cough');
    }
    if (wantsMove && this.rng.next() < this.effects.stumblePerSec * dtReal * (ctx.daylight < 0.3 && !this.gear.headlamp ? 3 : 1)) {
      this.events.push('stumble');
      this.forceStop(1.2, 'You stumble');
      if (!this.clipped && !ctx.assisted && this.route.terrain.slopeAt(this.pos.x, this.pos.z) > 30 && this.rng.chance(0.4)) {
        return this.startSlip();
      }
    }
    if (this.physiology.energy < 1 && this.physiology.effAltitude > 7000) {
      this.mode = 'down';
      this.events.push('collapse');
      return this.result(0, 0.1, false);
    }
    if (wantsMove && this.physiology.energy < 10) {
      this.gaspTimer += dtReal;
      if (this.gaspTimer > 6 + this.physiology.energy) {
        this.gaspTimer = 0;
        this.forceStop(2.5, 'Gasping for breath');
      }
    }
    // Wind: a gust can knock you off balance.
    const w = ctx.weather;
    if (w.gustKmh > 85 && wantsMove && this.rng.next() < ((w.gustKmh - 85) / 400) * dtReal) {
      this.forceStop(1.5, 'A gust knocks you sideways');
      this.events.push('gust');
      if (!this.clipped && this.route.terrain.slopeAt(this.pos.x, this.pos.z) > 28 && this.rng.chance(0.3)) return this.startSlip();
    }

    if (this.stopTimer > 0) {
      this.stopTimer -= dtReal;
      this.prompt = this.stopReason;
      return this.result(dtReal * IDLE_TIME_RATE, 0.4, false);
    }
    if (this.reclipTimer > 0) {
      this.reclipTimer -= dtReal;
      this.prompt = 'Switching carabiners past an anchor…';
      return this.result(dtReal * IDLE_TIME_RATE, 0.4, false);
    }

    // Rope clipping.
    if (input.wasPressed('KeyE') && this.mode === 'walk') {
      if (this.clipped) {
        this.clipped = false;
        this.events.push('unclip');
      } else if (this.canClip(ctx.ropeFixedTo)) {
        this.clipped = true;
        this.lastAnchor = Math.floor(this.hit.s / ANCHOR_SPACING);
        this.reclipTimer = 0.8 * this.effects.handling;
        this.events.push('clip');
      }
    }
    if (this.clipped && (!this.canClip(ctx.ropeFixedTo))) {
      this.clipped = false;
      this.showAlert('End of the fixed line.');
    }

    if (this.mode === 'ladder') return this.updateLadder(dtReal, ctx, f, r);

    const yaw = ctx.cameraYaw;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const dir = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, r);
    let moving = false, exertion = 0.25, vReal = 0, vVis = 0;
    if (dir.lengthSq() > 0) {
      dir.normalize();
      const jitter = this.effects.steerJitter * Math.sin(this.realTime * 1.7) * Math.sin(this.realTime * 0.6);
      dir.applyAxisAngle(UP, jitter);
      const t = this.route.terrain;
      const look = 1.5;
      const grade = (t.heightAt(this.pos.x + dir.x * look, this.pos.z + dir.z * look) - this.pos.y) / look;
      const climbAngle = Math.atan(grade) * 57.3;
      if (climbAngle > 42 && !this.clipped) {
        this.prompt = this.canClip(ctx.ropeFixedTo) ? 'Too steep. Clip into the fixed line [E]' : 'Too steep to climb here';
        return this.result(dtReal * IDLE_TIME_RATE, 0.35, false);
      }
      if (climbAngle > 62) {
        this.prompt = 'Sheer ice. No way up here.';
        return this.result(dtReal * IDLE_TIME_RATE, 0.35, false);
      }
      let tf = 1;
      const d = this.hit.distance;
      if (d > 3) tf *= d > 40 ? 0.6 : 0.75;
      if (inSpan(this.layout.seracZone, this.hit.s) || (this.hit.s < this.layout.landmarks.c1.s && this.hit.s > 200)) tf *= 0.62;
      if (ctx.daylight < 0.25 && !this.gear.headlamp) tf *= 0.5;
      if (this.clipped && climbAngle > 25) tf *= 0.85;
      const windF = 1 - clamp((w.windKmh - 50) / 120, 0, 0.6);
      vReal = realisticSpeed(grade, tf, this.physiology.spo2, this.pos.y, this.effects, this.gear.packKg) * windF;
      if (push) vReal *= 1.25;
      if (ctx.assisted) vReal *= 1.25;
      vVis = visualSpeed(vReal, ctx.speedSetting);
      exertion = clamp((grade > 0 ? 0.5 + grade * 0.9 : 0.42) + (push ? 0.35 : 0) + (w.windKmh > 60 ? 0.1 : 0), 0.3, 1.5);
      const step = vVis * dtReal;
      const nx = this.pos.x + dir.x * step, nz = this.pos.z + dir.z * step;
      if (t.inBounds(nx, nz, 30)) {
        this.pos.x = nx;
        this.pos.z = nz;
      }
      this.heading = Math.atan2(dir.x, dir.z);
      moving = true;
    }
    this.pos.y = this.route.terrain.heightAt(this.pos.x, this.pos.z);
    this.hit = this.route.closest(this.pos.x, this.pos.z, this.hit.index);

    if (this.clipped) this.constrainToRope();
    this.checkLadders();
    if ((this.mode as PlayerMode) === 'dead') return this.result(0, 0, false);
    if (this.clipped) {
      const anchor = Math.floor(this.hit.s / ANCHOR_SPACING);
      if (anchor !== this.lastAnchor) {
        this.lastAnchor = anchor;
        this.reclipTimer = 0.6 * this.effects.handling;
      }
    }

    // Unroped on steep ground: you can lose your footing.
    if (moving && !this.clipped && !ctx.assisted) {
      const slope = this.route.terrain.slopeAt(this.pos.x, this.pos.z);
      if (slope > 32) {
        const onTrail = this.hit.distance < 2.5 ? 0.25 : 1;
        const risk = 0.006 * (slope - 32) * onTrail * (1 + this.effects.stumblePerSec * 30) * (push ? 1.5 : 1) *
          (ctx.daylight < 0.25 && !this.gear.headlamp ? 2 : 1);
        if (this.rng.next() < risk * dtReal) return this.startSlip();
      }
    }

    if (this.hit.s > this.maxS) this.maxS = this.hit.s;
    if (!this.summited && this.hit.s > this.route.length - 12 && this.hit.distance < 15) {
      this.summited = true;
      this.events.push('summit');
    }

    if (!moving) return this.result(dtReal * IDLE_TIME_RATE, exertion, false);
    this.speedReal = vReal;
    this.speedVisual = vVis;
    const rate = clamp(vVis / Math.max(0.02, vReal), 2, 40);
    return this.result(dtReal * rate, exertion, true, vReal, vVis);
  }

  private constrainToRope() {
    const lat = this.hit.lateral;
    const lo = ROPE_OFFSET - 1.6, hi = ROPE_OFFSET + 1.6;
    if (lat < lo || lat > hi) {
      this.route.offsetPoint(this.hit.s, clamp(lat, lo, hi), this.pos);
      this.hit = this.route.closest(this.pos.x, this.pos.z, this.hit.index);
    }
  }

  private checkLadders() {
    const s = this.hit.s, lat = this.hit.lateral;
    for (const lad of this.layout.ladders) {
      const ds = s - lad.s;
      if (Math.abs(ds) > lad.span / 2 + 1.2) continue;
      if (Math.abs(lat) < 1.2) {
        this.mode = 'ladder';
        this.ladder = lad;
        this.balance = 0;
        this.balanceVel = 0;
        this.ladderClipped = false;
        this.events.push('ladder');
        return;
      }
      const halfLen = (34 + lad.span * 4) / 2;
      if (Math.abs(ds) < lad.span / 2 && Math.abs(lat) < halfLen) {
        this.kill('crevasse', 'You stepped off the trail beside the ladder and fell into the crevasse.');
        return;
      }
    }
  }

  private updateLadder(dtReal: number, ctx: FrameContext, f: number, r: number): FrameResult {
    const lad = this.ladder!;
    const input = ctx.input;
    if (input.wasPressed('KeyE')) {
      this.ladderClipped = !this.ladderClipped;
      this.events.push(this.ladderClipped ? 'clip' : 'unclip');
    }
    // Direction along the route: whichever way the camera faces.
    const t = this.route.tangentAt(lad.s);
    const facing = Math.sign(Math.sin(ctx.cameraYaw) * t.x + Math.cos(ctx.cameraYaw) * t.z) || 1;
    const along = f * facing;
    // Balance: wind, crampon points on rungs, and the state of your body.
    const wobble = 0.6 + ctx.weather.gustKmh / 50 + this.effects.stumblePerSec * 60 + (this.physiology.hace * 3);
    this.balanceVel += (this.rng.gaussian() * wobble * 2.2 + this.balance * 1.6) * dtReal;
    this.balanceVel -= r * 4.5 * dtReal;
    this.balanceVel *= 1 - Math.min(1, 2.5 * dtReal);
    this.balance += this.balanceVel * dtReal;
    this.prompt = `Ladder: W/S to cross, A/D to keep balance${this.ladderClipped ? '' : ', [E] clip into the handlines'}`;
    if (Math.abs(this.balance) > 1) {
      if (this.ladderClipped) {
        this.events.push('ladderFall');
        this.showAlert('You slip off the rungs. The handline holds.', 3);
        this.physiology.energy = Math.max(0, this.physiology.energy - 8);
        this.balance = 0;
        this.balanceVel = 0;
        this.forceStop(4, 'Hauling yourself back onto the ladder');
      } else {
        this.kill('crevasse', 'You lost your balance on a ladder and fell into the crevasse. You were not clipped in.');
        return this.result(0, 0, false);
      }
    }
    let vReal = 0, vVis = 0;
    if (along !== 0 && this.stopTimer <= 0) {
      vReal = 0.25 * this.effects.speed;
      vVis = 0.7 * ctx.speedSetting * (0.5 + this.effects.speed * 0.5);
      const s = clamp(this.hit.s + along * vVis * dtReal, 0, this.route.length);
      this.route.pointAt(s, this.pos);
      this.hit = this.route.closest(this.pos.x, this.pos.z, this.hit.index);
      this.heading = Math.atan2(t.x * along, t.z * along);
    } else if (this.stopTimer > 0) {
      this.stopTimer -= dtReal;
    }
    const deck = Math.max(this.route.altitudeAt(lad.s - lad.span / 2 - 0.8), this.route.altitudeAt(lad.s + lad.span / 2 + 0.8)) + 0.15;
    this.pos.y = Math.max(this.route.terrain.heightAt(this.pos.x, this.pos.z), deck);
    if (Math.abs(this.hit.s - lad.s) > lad.span / 2 + 1.25) {
      this.mode = 'walk';
      this.ladder = null;
      this.events.push('ladderDone');
    }
    const moving = vVis > 0;
    return this.result(moving ? dtReal * clamp(vVis / Math.max(0.02, vReal), 2, 30) : dtReal * IDLE_TIME_RATE, 0.5, moving, vReal, vVis);
  }

  private startSlip(): FrameResult {
    this.mode = 'slip';
    this.clipped = false;
    this.slipDistance = 0;
    this.slipWindow = 1.3 * (1 - 0.5 * this.effects.inputLag / 0.6);
    this.slipVel.set(0, 0, 0);
    this.events.push('slip');
    return this.result(0, 1.2, false);
  }

  private updateSlip(dtReal: number, ctx: FrameContext): FrameResult {
    const t = this.route.terrain;
    const n = t.normalAt(this.pos.x, this.pos.z, { x: 0, y: 1, z: 0 });
    const slope = Math.acos(n.y) * 57.3;
    // Accelerate down the fall line.
    const g = 9.81 * Math.sin(Math.acos(n.y)) * 0.75;
    const downhill = new THREE.Vector3(n.x, 0, n.z);
    if (downhill.lengthSq() > 1e-6) downhill.normalize();
    this.slipVel.addScaledVector(downhill, g * dtReal);
    this.slipVel.multiplyScalar(1 - Math.min(1, 0.4 * dtReal));
    const speed = this.slipVel.length();
    this.pos.addScaledVector(this.slipVel, dtReal);
    this.pos.y = t.heightAt(this.pos.x, this.pos.z);
    this.slipDistance += speed * dtReal;
    this.slipWindow -= dtReal;
    this.prompt = this.slipWindow > 0 ? 'SELF-ARREST! Press SPACE!' : 'Falling…';
    if (this.slipWindow > 0 && ctx.input.wasPressed('Space')) {
      this.mode = 'walk';
      this.events.push('arrest');
      this.showAlert('Ice axe in. You stop.', 2.5);
      this.physiology.energy = Math.max(0, this.physiology.energy - 6);
      this.forceStop(2.5, 'Catching your breath');
    } else if (slope < 18 && speed < 3) {
      this.mode = 'walk';
      this.showAlert('You come to a stop on easier ground, battered.', 3);
      this.physiology.energy = Math.max(0, this.physiology.energy - 20);
      this.forceStop(4, 'Winded');
    } else if (this.slipDistance > 45 && speed > 7) {
      this.kill('fall', `You slipped on ${Math.round(slope)}° ice and fell ${Math.round(this.slipDistance)} m. You could not self-arrest.`);
    }
    this.hit = this.route.closest(this.pos.x, this.pos.z, this.hit.index);
    return this.result(dtReal * IDLE_TIME_RATE, 1.2, false);
  }

  private result(gameSeconds: number, exertion: number, moving: boolean, realSpeed = 0, visual = 0): FrameResult {
    if (!moving) {
      this.speedReal = 0;
      this.speedVisual = 0;
    }
    return { gameSeconds, exertion, moving, realSpeed, visualSpeed: visual };
  }

  /** Glare factor of the surroundings for UV (snow fields reflect most of it). */
  snowGlare(): number {
    return smoothstep(5300, 5700, this.pos.y) * 0.8 + 0.2;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

export function deathText(cause: string): string {
  return {
    hape: 'High-altitude pulmonary oedema. Your lungs filled with fluid until you drowned where you lay.',
    hace: 'High-altitude cerebral oedema. Your brain swelled; confusion became coma.',
    hypothermia: 'Hypothermia. The cold reached your core and you stopped shivering.',
    exhaustion: 'Exhaustion. You sat down to rest in the death zone and never got up.',
    hypoxia: 'Hypoxia. Starved of oxygen, your body shut down.',
    fall: 'A fall.',
    serac: 'A serac collapsed in the Icefall. Tonnes of ice came down on the route.',
    avalanche: 'An avalanche swept the slope.',
    crevasse: 'You fell into a crevasse.',
  }[cause] ?? 'You died on the mountain.';
}
