import { describe, it, expect } from 'vitest';
import { Physiology, spo2, barometricPressure, altitudeForPressure, effectiveAltitude } from '../src/sim/physiology';
import { computeEffects, realisticSpeed } from '../src/sim/effects';
import { Rng } from '../src/core/rng';

const env = (altitude: number, extra = {}) => ({
  altitude, tempC: -20, windChillC: -30, windKmh: 20, sheltered: false, sleeping: false, daylight: 1, snowGlare: 1, ...extra,
});
const gear = (o2 = 0) => ({ o2FlowLpm: o2, downSuit: true, goggles: true, packKg: 12 });
const meds = { dexUntil: 0, nifedipineUntil: 0 };

describe('physiology', () => {
  it('barometric pressure matches measurements on Everest', () => {
    expect(barometricPressure(8849)).toBeGreaterThan(245);
    expect(barometricPressure(8849)).toBeLessThan(260);
    expect(altitudeForPressure(barometricPressure(6400))).toBeCloseTo(6400, 0);
  });

  it('SpO2 is close to published field values', () => {
    expect(spo2(0, 0, 0, 0.1)).toBeGreaterThan(96);
    const bc = spo2(5364, 5300, 0, 0.1);
    expect(bc).toBeGreaterThan(80);
    expect(bc).toBeLessThan(92);
    // Acclimatised climber on the summit without oxygen: roughly 50-65%.
    const top = spo2(8849, 7200, 0, 0.1);
    expect(top).toBeGreaterThan(48);
    expect(top).toBeLessThan(66);
    // Supplemental oxygen helps a lot.
    expect(spo2(8849, 7200, 2, 0.7)).toBeGreaterThan(top + 15);
  });

  it('2 L/min of oxygen at the summit is like being around 7,000 to 8,000 m', () => {
    const eff = effectiveAltitude(8849, 2, 0.7);
    expect(eff).toBeGreaterThan(7000);
    expect(eff).toBeLessThan(8000);
  });

  it('acclimatises over days at altitude and is capped', () => {
    const p = new Physiology(new Rng(1), { acclimAlt: 5000 });
    for (let h = 0; h < 72; h++) p.step(3600, env(6400, { sheltered: true }), gear(), 0.1, meds, 0);
    expect(p.acclimAlt).toBeGreaterThan(5600);
    expect(p.acclimAlt).toBeLessThan(6400);
    for (let h = 0; h < 24 * 30; h++) p.step(3600, env(7900, { sheltered: true }), gear(4), 0.1, meds, 0);
    expect(p.acclimAlt).toBeLessThanOrEqual(7400);
  });

  it('rushing high without acclimatisation brings on AMS and risks oedema', () => {
    let sick = 0;
    for (let seed = 0; seed < 40; seed++) {
      const p = new Physiology(new Rng(seed), { acclimAlt: 4900 });
      for (let m = 0; m < 24 * 60; m += 10) {
        p.step(600, env(7200), gear(), 0.8, meds, 0);
        if (p.dead) break;
      }
      expect(p.ams).toBeGreaterThan(0.5);
      if (p.hape > 0 || p.hace > 0 || p.dead) sick++;
    }
    expect(sick).toBeGreaterThan(10);
  });

  it('a well-acclimatised climber at Camp 2 stays healthy', () => {
    const p = new Physiology(new Rng(3), { acclimAlt: 6600 });
    for (let h = 0; h < 48; h++) p.step(3600, env(6400, { sheltered: true }), gear(), 0.1, meds, 0);
    expect(p.dead).toBeNull();
    expect(p.ams).toBeLessThan(0.1);
    expect(p.hape).toBe(0);
  });

  it('a storm without a down suit causes hypothermia and death', () => {
    const p = new Physiology(new Rng(2), { acclimAlt: 7000 });
    const storm = env(8000, { tempC: -35, windChillC: -65, windKmh: 100 });
    for (let h = 0; h < 24 && !p.dead; h++) p.step(3600, storm, { ...gear(), downSuit: false }, 0.1, meds, 0);
    expect(p.dead).toBe('hypothermia');
  });

  it('extreme cold freezes fingers and toes', () => {
    const p = new Physiology(new Rng(4), { acclimAlt: 7200 });
    for (let h = 0; h < 6; h++) p.step(3600, env(8500, { tempC: -35, windChillC: -60, windKmh: 80 }), gear(2), 0.7, meds, 0);
    expect(p.frostbiteHands + p.frostbiteFeet).toBeGreaterThan(0.1);
  });

  it('snow blindness without goggles', () => {
    const p = new Physiology(new Rng(5), { acclimAlt: 6500 });
    for (let h = 0; h < 4; h++) p.step(3600, env(6400), { ...gear(), goggles: false }, 0.5, meds, 0);
    expect(p.snowBlindness).toBeGreaterThan(0.3);
  });

  it('effects slow you down when sick', () => {
    const p = new Physiology(new Rng(6));
    const healthy = computeEffects(p);
    p.hape = 0.6;
    p.hace = 0.4;
    const sick = computeEffects(p);
    expect(sick.speed).toBeLessThan(healthy.speed * 0.5);
    expect(sick.inputLag).toBeGreaterThan(0);
    expect(realisticSpeed(0.3, 1, 55, 8700, sick, 12)).toBeLessThan(realisticSpeed(0.3, 1, 85, 6000, healthy, 12));
  });
});
