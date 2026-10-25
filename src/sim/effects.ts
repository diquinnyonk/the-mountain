import { clamp, smoothstep } from '../core/mathx';
import type { Physiology } from './physiology';

/** What the body's state does to the player: movement, controls and vision. */
export interface Effects {
  /** Multiplier on climbing speed (0..1). */
  speed: number;
  /** Chance per second of stumbling (ataxia, exhaustion). */
  stumblePerSec: number;
  /** Seconds of input delay (confusion). */
  inputLag: number;
  /** Random steering wobble (radians). */
  steerJitter: number;
  /** Chance per second that left/right briefly swap (severe HACE). */
  invertPerSec: number;
  blurPx: number;
  vignette: number;
  desaturate: number;
  glare: number;
  hallucinate: boolean;
  headache: number;
  breathRate: number;
  heartRate: number;
  /** Multiplier on how long rope/carabiner handling takes. */
  handling: number;
  coughPerSec: number;
}

export function computeEffects(p: Physiology): Effects {
  const hypoxia = p.hypoxia;
  const confusion = clamp(Math.max(p.hace * 1.2, hypoxia * 0.6, (34.5 - p.coreTemp) / 4), 0, 1);
  const ataxia = clamp(p.hace * 1.5 + p.exhaustion * 0.6 + p.hypothermia * 0.8, 0, 1);
  const hapeBreath = p.hape;
  let speed = 1;
  speed *= 1 - 0.3 * p.ams;
  speed *= 1 - 0.65 * smoothstep(0, 0.8, hapeBreath);
  speed *= 1 - 0.5 * p.hace;
  speed *= 1 - 0.55 * p.exhaustion;
  speed *= 1 - 0.4 * p.hypothermia;
  speed *= 1 - 0.35 * p.frostbiteFeet;
  speed *= 1 - 0.25 * p.dehydration;
  if (p.crackedRib) speed *= 0.85;
  return {
    speed: clamp(speed, 0.05, 1),
    stumblePerSec: 0.015 * ataxia + 0.01 * p.exhaustion,
    inputLag: confusion * 0.6,
    steerJitter: confusion * 0.5,
    invertPerSec: p.hace > 0.5 ? (p.hace - 0.5) * 0.12 : 0,
    blurPx: Math.max(p.snowBlindness * 6, confusion * 2.5, hypoxia * 1.5),
    vignette: clamp(Math.max(hypoxia * 0.8, p.exhaustion * 0.6, p.hace * 0.7, p.hypothermia * 0.6), 0, 0.95),
    desaturate: clamp(hypoxia * 0.7 + p.hypothermia * 0.4, 0, 0.9),
    glare: p.snowBlindness,
    hallucinate: p.hace > 0.45 || p.hypoxia > 0.75,
    headache: p.ams,
    breathRate: 14 + (98 - p.spo2) * 0.9 + p.hape * 20,
    heartRate: 70 + (98 - p.spo2) * 1.6 + p.exhaustion * 20,
    handling: 1 + p.frostbiteHands * 3 + confusion * 1.5 + p.hypothermia * 2,
    coughPerSec: p.cough * 0.012 + p.hape * 0.03,
  };
}

/**
 * Realistic sustained walking speed (m/s along the trail) for the terrain and
 * the body: Tobler's hiking function, a terrain factor, an aerobic-capacity
 * factor from SpO2, and the effects above.
 */
export function realisticSpeed(grade: number, terrainFactor: number, spo2: number, altitude: number, effects: Effects, packKg: number): number {
  const tobler = (6 * Math.exp(-3.5 * Math.abs(grade + 0.05))) / 3.6;
  // Going down needs far less oxygen than going up.
  const aerobic = clamp(Math.pow(clamp((spo2 - 42) / 54, 0, 1), grade < 0 ? 0.55 : 1.1), 0.04, 1);
  const altitudeFactor = 1 - Math.max(0, altitude - 5000) / 14000;
  const pack = clamp(1 - Math.max(0, packKg - 8) * 0.012, 0.6, 1);
  return Math.max(0.02, tobler * terrainFactor * aerobic * altitudeFactor * pack * effects.speed);
}

/** On-screen walking speed for a realistic speed. Game time is scaled so the two agree. */
export function visualSpeed(realistic: number, speedSetting: number): number {
  return (0.8 + 3.4 * Math.pow(realistic / 1.1, 0.65)) * speedSetting;
}
