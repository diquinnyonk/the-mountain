import { clamp, smoothstep } from '../core/mathx';
import type { Rng } from '../core/rng';

/** Barometric pressure (Torr) at altitude, West's model fitted to Himalayan measurements. */
export function barometricPressure(altitudeM: number): number {
  const h = altitudeM / 1000;
  return Math.exp(6.63268 - 0.1112 * h - 0.00149 * h * h);
}

/** Inverse of barometricPressure. */
export function altitudeForPressure(pb: number): number {
  // 0.00149 h^2 + 0.1112 h + (ln pb - 6.63268) = 0
  const a = 0.00149, b = 0.1112, c = Math.log(pb) - 6.63268;
  return ((-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)) * 1000;
}

/** Inspired O2 partial pressure (Torr), including supplemental oxygen through a mask. */
export function inspiredO2(altitudeM: number, flowLpm: number, exertion: number): number {
  const pio2 = 0.2095 * (barometricPressure(altitudeM) - 47);
  // At rest, minute ventilation is lower so each litre of O2 enriches the gas more.
  const perLitre = 5 * (1.35 - 0.35 * clamp(exertion, 0, 1.5));
  return pio2 + flowLpm * perLitre;
}

/** The altitude that would give the same inspired O2 without supplemental oxygen. */
export function effectiveAltitude(altitudeM: number, flowLpm: number, exertion: number): number {
  if (flowLpm <= 0) return altitudeM;
  const pio2 = inspiredO2(altitudeM, flowLpm, exertion);
  return Math.max(0, altitudeForPressure(pio2 / 0.2095 + 47));
}

/** Ventilatory acclimatisation, 0..1, from the altitude the body is adapted to. */
export const acclimLevel = (acclimAlt: number) => clamp((acclimAlt - 3000) / 4500, 0, 1);

/**
 * Arterial O2 saturation (%): alveolar gas equation with acclimatisation-driven
 * hyperventilation, the Severinghaus dissociation curve, and a left shift from
 * respiratory alkalosis. Tuned to field data (e.g. ~56% at the summit without O2).
 */
export function spo2(altitudeM: number, acclimAlt: number, flowLpm: number, exertion: number, hape = 0): number {
  const pio2 = inspiredO2(altitudeM, flowLpm, exertion);
  const A = acclimLevel(acclimAlt);
  const paco2 = Math.max(12, 40 - (150 - pio2) * 0.2 - 10 * A);
  const pao2 = pio2 - paco2 / 0.85;
  const pa = Math.max(8, pao2 - 4 - hape * 18);
  const shift = 1 + 0.25 * (1 - paco2 / 40);
  const p = pa * shift;
  const sat = 100 / (1 + 23400 / (p * p * p + 150 * p));
  // Exercise desaturation is worse the higher you are.
  const exDrop = clamp(exertion, 0, 1.5) * smoothstep(3000, 8000, altitudeM) * 4;
  return clamp(sat - exDrop, 20, 98.5);
}

export interface Environment {
  altitude: number;
  tempC: number;
  windChillC: number;
  windKmh: number;
  /** Inside a tent (out of the wind, sleeping bag available). */
  sheltered: boolean;
  sleeping: boolean;
  daylight: number;
  /** 0..1 how much bright snow surrounds you (for UV). */
  snowGlare: number;
}

export interface Loadout {
  o2FlowLpm: number;
  downSuit: boolean;
  goggles: boolean;
  packKg: number;
}

export interface Meds {
  dexUntil: number;
  nifedipineUntil: number;
}

export type ConditionId =
  | 'ams' | 'hape' | 'hace' | 'hypothermia' | 'frostbiteHands' | 'frostbiteFeet' | 'snowBlindness' | 'exhaustion'
  | 'dehydration' | 'cough' | 'hypoxia';

export type DeathCause =
  | 'hape' | 'hace' | 'hypothermia' | 'exhaustion' | 'hypoxia' | 'fall' | 'serac' | 'avalanche' | 'crevasse';

/** Tunables in one place. Rates are per hour of game time. */
export const PHYS = {
  acclimRateFraction: 0.32 / 24,
  acclimMaxPerHour: 380 / 24,
  acclimCeiling: 7400,
  deacclimPerHour: 25 / 24,
  amsThreshold: 350,
  hapeThreshold: 500,
  haceThreshold: 600,
  hapeOnsetRate: 0.0025,
  haceOnsetRate: 0.002,
  hypoxicDeathDebt: 6,
};

/** The body of a climber. Shared by the player and NPC climbers. */
export class Physiology {
  acclimAlt = 5100;
  energy = 90;
  hydration = 85;
  coreTemp = 37;
  handTemp = 30;
  footTemp = 28;
  frostbiteHands = 0;
  frostbiteFeet = 0;
  ams = 0;
  hape = 0;
  hace = 0;
  uvDose = 0;
  cough = 0.05;
  hypoxicDebt = 0;
  crackedRib = false;
  spo2 = 90;
  effAltitude = 5364;
  dead: DeathCause | null = null;
  /** Hours spent motionless with no energy left (for exhaustion deaths). */
  collapsedHours = 0;
  /** Seconds of rest needed before moving again after a forced stop. */
  forcedStop = 0;

  constructor(private rng: Rng, init?: Partial<Physiology>) {
    if (init) Object.assign(this, init);
  }

  get snowBlindness() {
    return clamp((this.uvDose - 0.8) / 1.2, 0, 1);
  }
  get hypothermia() {
    return clamp((36 - this.coreTemp) / 8, 0, 1);
  }
  get exhaustion() {
    return clamp(1 - this.energy / 30, 0, 1);
  }
  get dehydration() {
    return clamp(1 - this.hydration / 50, 0, 1);
  }
  get hypoxia() {
    return clamp((65 - this.spo2) / 25, 0, 1);
  }

  severity(c: ConditionId): number {
    switch (c) {
      case 'ams': return this.ams;
      case 'hape': return this.hape;
      case 'hace': return this.hace;
      case 'hypothermia': return this.hypothermia;
      case 'frostbiteHands': return this.frostbiteHands;
      case 'frostbiteFeet': return this.frostbiteFeet;
      case 'snowBlindness': return this.snowBlindness;
      case 'exhaustion': return this.exhaustion;
      case 'dehydration': return this.dehydration;
      case 'cough': return this.cough;
      case 'hypoxia': return this.hypoxia;
    }
  }

  /**
   * Advance by `dtSec` game seconds. `exertion` is roughly 0 (asleep) .. 1 (hard
   * climbing) .. 1.5 (all-out).
   */
  step(dtSec: number, env: Environment, gear: Loadout, exertion: number, meds: Meds, now: number) {
    if (this.dead) return;
    // Sub-step long skips so rates stay stable.
    let remaining = dtSec;
    while (remaining > 0) {
      const d = Math.min(remaining, 120);
      this.stepInner(d / 3600, env, gear, exertion, meds, now);
      remaining -= d;
      if (this.dead) return;
    }
  }

  private stepInner(dt: number, env: Environment, gear: Loadout, exertion: number, meds: Meds, now: number) {
    const alt = env.altitude;
    const dex = now < meds.dexUntil;
    const nif = now < meds.nifedipineUntil;
    const flow = gear.o2FlowLpm;
    this.effAltitude = effectiveAltitude(alt, flow, exertion);
    this.spo2 = spo2(alt, this.acclimAlt, flow, exertion, this.hape);
    const eff = this.effAltitude;
    // Sleeping high is worse than passing through.
    const excess = eff - this.acclimAlt + (env.sleeping ? 150 : 0);

    // Acclimatisation: chase the altitude you spend time at, up to a ceiling; slowly lose it when low.
    if (eff > this.acclimAlt && this.acclimAlt < PHYS.acclimCeiling) {
      const gain = Math.min(PHYS.acclimMaxPerHour, (eff - this.acclimAlt) * PHYS.acclimRateFraction);
      // Too far above your adaptation and the body can't keep up.
      const tooHigh = smoothstep(1800, 3000, eff - this.acclimAlt);
      this.acclimAlt = Math.min(PHYS.acclimCeiling, this.acclimAlt + gain * (1 - 0.7 * tooHigh) * dt);
    } else if (eff < this.acclimAlt - 600) {
      this.acclimAlt -= PHYS.deacclimPerHour * dt;
    }
    // Above 8,000 m the body deteriorates rather than adapts.
    if (alt > 8000 && flow <= 0) this.acclimAlt -= 8 * dt;

    const dry = 1 + this.dehydration;
    const work = 0.5 + clamp(exertion, 0, 1.5) * 0.5;

    // AMS: severity drifts toward a level set by how far above your acclimatisation you are,
    // made worse by dehydration and hard work, and eased by dexamethasone.
    const amsTarget = clamp(((excess - PHYS.amsThreshold) / 1300) * dry * work * (dex ? 0.4 : 1), 0, 1);
    const amsTau = amsTarget > this.ams ? 7 : 10;
    this.ams += (amsTarget - this.ams) * Math.min(1, dt / amsTau);
    this.ams = clamp(this.ams, 0, 1);

    // How far you are above (positive) or below (negative) where your body copes.
    const pressure = clamp((eff - (this.acclimAlt - 600)) / 600, -2, 1.5);
    const cold = 1 + Math.max(0, -env.windChillC - 20) / 30;

    // HAPE
    if (this.hape <= 0) {
      if (excess > PHYS.hapeThreshold && alt > 3500) {
        const hz = PHYS.hapeOnsetRate * Math.pow((excess - PHYS.hapeThreshold) / 500, 1.5) * (1 + 2 * this.ams) * cold *
          (exertion > 0.9 ? 1.5 : 1) * (nif ? 0.3 : 1);
        if (this.rng.next() < hz * dt) this.hape = 0.05;
      }
    } else {
      let rate = 0.02 * (0.5 + exertion) * pressure;
      if (flow >= 2) rate -= 0.05;
      else if (flow > 0) rate -= 0.02;
      if (nif) rate -= 0.025;
      if (alt < 5400 && pressure < 0) rate -= 0.04;
      this.hape = clamp(this.hape + rate * dt, 0, 1);
      if (this.hape >= 1) return this.die('hape');
    }

    // HACE
    if (this.hace <= 0) {
      if (excess > PHYS.haceThreshold) {
        const hz = PHYS.haceOnsetRate * Math.pow((excess - PHYS.haceThreshold) / 500, 1.5) * (1 + 4 * this.ams) * (dex ? 0.2 : 1);
        if (this.rng.next() < hz * dt) this.hace = 0.05;
      }
    } else {
      let rate = 0.025 * (0.6 + 0.4 * exertion) * pressure + this.hypoxia * 0.02;
      if (dex) rate -= 0.06;
      if (flow >= 2) rate -= 0.025;
      if (alt < 5400 && pressure < 0) rate -= 0.04;
      this.hace = clamp(this.hace + rate * dt, 0, 1);
      if (this.hace >= 1) return this.die('hace');
    }

    // Hypoxic debt: prolonged severe desaturation leads to collapse.
    if (this.spo2 < 52) this.hypoxicDebt += ((52 - this.spo2) / 8) * dt;
    else this.hypoxicDebt = Math.max(0, this.hypoxicDebt - 0.5 * dt);
    if (this.hypoxicDebt >= PHYS.hypoxicDeathDebt) return this.die('hypoxia');

    // Energy
    const altLoad = 1 + Math.max(0, eff - 5000) / 4000;
    let dE = -(1.2 + 5 * Math.pow(clamp(exertion, 0, 1.5), 1.5) * altLoad);
    if (exertion < 0.25) {
      const recovery = (env.sleeping ? 6 : 2.5) * (eff < 6500 ? 1 : eff < 7600 ? 0.6 : 0.25) * (1 - this.dehydration * 0.6) * (1 - this.ams * 0.5);
      dE += recovery;
    }
    this.energy = clamp(this.energy + dE * dt, 0, 100);
    if (this.energy <= 0 && exertion < 0.3 && alt > 7800 && flow <= 0) {
      this.collapsedHours += dt;
      if (this.collapsedHours > 3) return this.die('exhaustion');
    } else {
      this.collapsedHours = Math.max(0, this.collapsedHours - dt);
    }

    // Hydration: dry air and heavy breathing.
    const hLoss = 0.9 + 3.2 * clamp(exertion, 0, 1.5) * (1 + Math.max(0, alt - 5000) / 4000);
    this.hydration = clamp(this.hydration - hLoss * dt, 0, 100);

    // Core temperature: heat production vs loss through insulation.
    const insulation = env.sheltered ? (env.sleeping ? 7 : 4) : gear.downSuit ? 3.0 : 1.8;
    const ambient = env.sheltered ? env.tempC + 12 : env.windChillC;
    const shiver = this.coreTemp < 36 && this.energy > 5 ? 0.8 : 0;
    const prod = (0.5 + 2.0 * clamp(exertion, 0, 1.5)) * (this.energy > 3 ? 1 : 0.35) + shiver;
    const loss = (37 - ambient) / insulation / 25;
    this.coreTemp += (prod - loss) * 0.8 * dt;
    if (this.coreTemp > 37.2) this.coreTemp -= (this.coreTemp - 37) * 2 * dt;
    if (this.coreTemp <= 27) return this.die('hypothermia');

    // Hands and feet: perfusion drops with hypoxia, dehydration and a cold core.
    const perf = clamp((this.spo2 - 50) / 40, 0.2, 1) * (1 - this.dehydration * 0.3) * (this.coreTemp > 35 ? 1 : 0.5);
    const ext = env.sheltered ? env.tempC + 15 : env.windChillC;
    // In a tent you are in a sleeping bag; outside it's mitts and 8,000 m boots.
    const handTarget = 33 - (33 - ext) * (env.sheltered ? 0.12 : 0.55 / 2.0) / Math.max(0.45, perf);
    const footTarget = 33 - (33 - ext) * (env.sheltered ? 0.12 : 0.55 / 2.2) / Math.max(0.45, perf);
    this.handTemp += (handTarget - this.handTemp) * Math.min(1, 3 * dt);
    this.footTemp += (footTarget - this.footTemp) * Math.min(1, 2.5 * dt);
    if (this.handTemp < 0) this.frostbiteHands = clamp(this.frostbiteHands + (-this.handTemp / 60) * dt, 0, 1);
    if (this.footTemp < 0) this.frostbiteFeet = clamp(this.frostbiteFeet + (-this.footTemp / 60) * dt, 0, 1);

    // UV: high altitude, snow glare, no goggles.
    if (!gear.goggles && env.daylight > 0.3 && !env.sheltered) {
      this.uvDose += 0.6 * env.daylight * env.snowGlare * (1 + (alt - 5000) / 4000) * dt;
    } else {
      this.uvDose = Math.max(0, this.uvDose - 0.06 * dt);
    }

    // Khumbu cough: cold, dry air and heavy breathing; it rarely gets better on the mountain.
    if (alt > 5000) this.cough = clamp(this.cough + 0.0035 * (0.4 + exertion) * cold * dt, 0, 1);
    if (this.cough > 0.85 && !this.crackedRib && this.rng.next() < 0.02 * dt) this.crackedRib = true;
  }

  /** External harm: falls, avalanches, etc. */
  die(cause: DeathCause) {
    this.dead = cause;
  }

  drink(litres: number) {
    this.hydration = clamp(this.hydration + litres * 30, 0, 100);
  }

  eat() {
    // Appetite vanishes with altitude and AMS.
    const appetite = clamp(1 - this.ams * 0.6 - Math.max(0, this.effAltitude - 7000) / 3000, 0.25, 1);
    this.energy = clamp(this.energy + 22 * appetite, 0, 100);
  }

  serialize() {
    const { rng: _rng, ...rest } = this as unknown as Record<string, unknown>;
    return rest;
  }
}
