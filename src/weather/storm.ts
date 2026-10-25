import { WeatherTimeline, type WeatherEvent } from './model';
import { CLIMATE, LEVELS_HPA, climateTemp, climateWind, monthly } from './climatology';
import { Rng } from '../core/rng';
import { HOUR, DAY, NPT_OFFSET_MS } from '../core/clock';
import { clamp } from '../core/mathx';

/**
 * Fill hours of the timeline that have no real data with plausible weather drawn
 * from climatology (seeded, so the same date always gives the same weather), and
 * blend across the join with real data.
 */
export function fillSynthetic(tl: WeatherTimeline, seed: string) {
  const rng = new Rng('synth:' + seed);
  let windAnom = 0, tempAnom = 0, wetAnom = 0;
  let cycloneLeft = 0;
  for (let h = 0; h < tl.hours; h++) {
    const time = tl.start + h * HOUR;
    // Slowly varying anomalies: a few days' memory.
    if (h % 6 === 0) {
      windAnom = windAnom * 0.88 + rng.gaussian() * 0.08;
      tempAnom = tempAnom * 0.9 + rng.gaussian() * 0.7;
      wetAnom = wetAnom * 0.85 + rng.gaussian() * 0.3;
      if (cycloneLeft <= 0 && h % 24 === 0 && rng.chance(monthly(CLIMATE.cyclone, time) / 7)) cycloneLeft = rng.int(30, 60);
    }
    if (cycloneLeft > 0) cycloneLeft--;
    if (tl.source[h] !== 'synthetic') continue;
    const localHour = ((time + NPT_OFFSET_MS) / HOUR) % 24;
    const afternoon = Math.max(0, Math.sin(((localHour - 9) / 12) * Math.PI));
    const cyclone = cycloneLeft > 0 ? 1 : 0;
    const baseCloud = monthly(CLIMATE.cloud, time);
    for (let l = 0; l < LEVELS_HPA.length; l++) {
      tl.t[l][h] = climateTemp(l, time) + tempAnom - (l <= 1 ? 0 : 0) + (l <= 1 ? afternoon * 3 : 0);
      tl.ws[l][h] = Math.max(2, climateWind(l, time) * Math.exp(windAnom) * (1 + cyclone * 0.6));
      tl.wd[l][h] = 270 + rng.gaussian() * 15;
      const lowBoost = l <= 1 ? afternoon * 0.35 : 0;
      tl.cloud[l][h] = clamp((baseCloud + wetAnom * 0.3 + lowBoost + cyclone * 0.5 - l * 0.08) * 100, 0, 100);
      tl.rh[l][h] = clamp(40 + tl.cloud[l][h] * 0.55, 5, 100);
    }
    const daily = monthly(CLIMATE.precip, time) * Math.exp(wetAnom);
    tl.precip[h] = Math.max(0, (daily / 24) * (0.3 + afternoon * 2.2) + cyclone * 2.5);
    tl.snowfall[h] = tl.precip[h] * 0.9;
  }
  blendJoins(tl);
}

/** Smooth any step between real and synthetic data over 12 hours. */
function blendJoins(tl: WeatherTimeline) {
  for (let h = 1; h < tl.hours; h++) {
    const a = tl.source[h - 1], b = tl.source[h];
    if ((a === 'synthetic') === (b === 'synthetic')) continue;
    const realSide = a === 'synthetic' ? h : h - 1;
    const dir = a === 'synthetic' ? -1 : 1;
    for (let k = 1; k <= 12; k++) {
      const i = realSide + dir * k;
      if (i < 0 || i >= tl.hours || tl.source[i] !== 'synthetic') break;
      const w = 1 - k / 13;
      for (let l = 0; l < LEVELS_HPA.length; l++) {
        for (const arr of [tl.t, tl.ws, tl.cloud, tl.rh]) arr[l][i] = arr[l][i] * (1 - w) + arr[l][realSide] * w;
      }
    }
  }
}

/**
 * "Bad luck": short-lived local events the global models can't resolve. Their
 * likelihood follows the season and the real conditions (humid, unsettled days
 * breed squalls), and they are seeded from the chosen date.
 */
export function generateBadLuck(tl: WeatherTimeline, seed: string): WeatherEvent[] {
  const rng = new Rng('luck:' + seed);
  const events: WeatherEvent[] = [];
  for (let day = 0; day * DAY < tl.hours * HOUR; day++) {
    const noon = tl.start + day * DAY + 12 * HOUR;
    if (noon >= tl.end) break;
    const h = tl.hourIndex(noon);
    const instability = clamp(tl.cloud[1][h] / 100 + tl.precip[h] * 0.3, 0, 1.5);
    const p = monthly(CLIMATE.squall, noon) * (0.5 + instability);
    if (rng.chance(p)) {
      const kind = rng.chance(0.65) ? 'squall' : 'whiteout';
      const start = noon + rng.range(-3, 6) * HOUR;
      const dur = (kind === 'squall' ? rng.range(1.5, 5) : rng.range(3, 10)) * HOUR;
      events.push({
        kind, start, end: start + dur,
        windAdd: kind === 'squall' ? rng.range(35, 70) : rng.range(5, 20),
        precipAdd: kind === 'squall' ? rng.range(0.8, 2.5) : rng.range(0.2, 0.8),
        visibilityCap: kind === 'squall' ? rng.range(60, 200) : rng.range(25, 80),
      });
    }
  }
  return events;
}
