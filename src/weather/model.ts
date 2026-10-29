import { LEVELS_HPA, STANDARD_LEVEL_HEIGHT } from './climatology';
import { clamp, lerp, smoothstep } from '../core/mathx';
import { HOUR } from '../core/clock';

export type WeatherSource = 'forecast' | 'historical-forecast' | 'reanalysis' | 'synthetic';

export interface WeatherEvent {
  kind: 'squall' | 'whiteout' | 'cyclone';
  start: number;
  end: number;
  windAdd: number;
  precipAdd: number;
  visibilityCap: number;
}

export interface WeatherSample {
  time: number;
  altitude: number;
  tempC: number;
  windKmh: number;
  gustKmh: number;
  windDirDeg: number;
  humidity: number;
  cloudAtAltitude: number;
  /** Top of a cloud deck below the climber (m), if there is one. */
  cloudBaseBelow: number | null;
  cloudBelowCover: number;
  precipMmH: number;
  snowfallCmH: number;
  visibilityM: number;
  windChillC: number;
  /** 0..1, how dangerous conditions are right here. */
  stormLevel: number;
  event: WeatherEvent | null;
  source: WeatherSource;
}

export interface DaySummary {
  dayStart: number;
  summitWindMax: number;
  summitWindMean: number;
  summitTempMin: number;
  bcTempMin: number;
  bcTempMax: number;
  precipTotal: number;
  stormHours: number;
  source: WeatherSource;
  good: boolean;
}

/** Hourly multi-level weather for the whole expedition window. */
export class WeatherTimeline {
  readonly hours: number;
  /** [level][hour] */
  readonly z: Float32Array[];
  readonly t: Float32Array[];
  readonly rh: Float32Array[];
  readonly cloud: Float32Array[];
  readonly ws: Float32Array[];
  readonly wd: Float32Array[];
  readonly precip: Float32Array;
  readonly snowfall: Float32Array;
  readonly source: WeatherSource[];
  events: WeatherEvent[] = [];
  notes: string[] = [];

  constructor(readonly start: number, hours: number) {
    this.hours = hours;
    const mk = () => LEVELS_HPA.map(() => new Float32Array(hours));
    this.z = mk(); this.t = mk(); this.rh = mk(); this.cloud = mk(); this.ws = mk(); this.wd = mk();
    for (let l = 0; l < LEVELS_HPA.length; l++) this.z[l].fill(STANDARD_LEVEL_HEIGHT[l]);
    this.precip = new Float32Array(hours);
    this.snowfall = new Float32Array(hours);
    this.source = new Array(hours).fill('synthetic');
  }

  get end() {
    return this.start + this.hours * HOUR;
  }

  hourIndex(time: number): number {
    return clamp(Math.floor((time - this.start) / HOUR), 0, this.hours - 1);
  }

  sample(time: number, altitude: number): WeatherSample {
    const f = clamp((time - this.start) / HOUR, 0, this.hours - 1.0001);
    const h = Math.floor(f), ft = f - h;
    const h1 = Math.min(this.hours - 1, h + 1);
    const at = (arr: Float32Array[], l: number) => lerp(arr[l][h], arr[l][h1], ft);
    // Find the bracketing pressure levels by geopotential height.
    const nL = LEVELS_HPA.length;
    let l0 = 0;
    while (l0 < nL - 2 && at(this.z, l0 + 1) < altitude) l0++;
    const z0 = at(this.z, l0), z1 = at(this.z, l0 + 1);
    const u = clamp((altitude - z0) / Math.max(1, z1 - z0), -0.6, 1.2);
    const v = (arr: Float32Array[]) => lerp(at(arr, l0), at(arr, l0 + 1), u);
    const tempC = v(this.t);
    let windKmh = Math.max(0, v(this.ws));
    const windDirDeg = at(this.wd, u < 0.5 ? l0 : l0 + 1);
    const humidity = clamp(v(this.rh), 0, 100);
    const cloudAtAltitude = clamp(v(this.cloud) / 100, 0, 1);
    const precipBase = lerp(this.precip[h], this.precip[h1], ft);
    const snowBase = lerp(this.snowfall[h], this.snowfall[h1], ft);
    // Precipitation falls off with height above ~6,000 m.
    const precipFactor = altitude > 6000 ? Math.exp(-(altitude - 6000) / 2500) : 1;
    let precipMmH = precipBase * precipFactor;
    let snowfallCmH = Math.max(snowBase, precipBase * 0.9) * precipFactor;

    let cloudBaseBelow: number | null = null, cloudBelowCover = 0;
    for (let l = 0; l < nL; l++) {
      const zl = at(this.z, l);
      if (zl < altitude - 150) {
        const c = at(this.cloud, l) / 100;
        if (c > 0.55 && c > cloudBelowCover) {
          cloudBelowCover = c;
          cloudBaseBelow = zl + 250;
        }
      }
    }
    if (cloudAtAltitude > 0.5) cloudBaseBelow = null;

    const event = this.events.find((e) => time >= e.start && time < e.end) ?? null;
    let visCap = Infinity;
    if (event) {
      const ramp = smoothstep(event.start, event.start + HOUR, time) * (1 - smoothstep(event.end - HOUR, event.end, time));
      windKmh += event.windAdd * ramp;
      precipMmH += event.precipAdd * ramp * precipFactor;
      snowfallCmH += event.precipAdd * ramp * precipFactor;
      visCap = lerp(60000, event.visibilityCap, ramp);
    }
    const gustKmh = windKmh * 1.35;
    const visibilityM = Math.min(visCap, estimateVisibility(cloudAtAltitude, snowfallCmH, windKmh, humidity));
    const windChillC = windChill(tempC, windKmh);
    const stormLevel = stormLevelOf(windKmh, snowfallCmH, visibilityM);
    return {
      time, altitude, tempC, windKmh, gustKmh, windDirDeg, humidity, cloudAtAltitude, cloudBaseBelow, cloudBelowCover,
      precipMmH, snowfallCmH, visibilityM, windChillC, stormLevel, event, source: this.source[h],
    };
  }

  /** Summaries per local day, for the planning chart and the leader's forecasts. */
  daySummaries(firstLocalMidnight: number, days: number): DaySummary[] {
    const out: DaySummary[] = [];
    for (let d = 0; d < days; d++) {
      const dayStart = firstLocalMidnight + d * 24 * HOUR;
      let wMax = 0, wSum = 0, tMin = 99, bcMin = 99, bcMax = -99, pr = 0, storm = 0, n = 0;
      for (let hr = 0; hr < 24; hr++) {
        const time = dayStart + hr * HOUR;
        if (time < this.start || time >= this.end) continue;
        const s = this.sample(time, 8849);
        const b = this.sample(time, 5364);
        wMax = Math.max(wMax, s.windKmh); wSum += s.windKmh; tMin = Math.min(tMin, s.tempC);
        bcMin = Math.min(bcMin, b.tempC); bcMax = Math.max(bcMax, b.tempC);
        pr += b.precipMmH;
        if (s.stormLevel > 0.6 || b.stormLevel > 0.6) storm++;
        n++;
      }
      if (!n) break;
      const mean = wSum / n;
      out.push({
        dayStart, summitWindMax: wMax, summitWindMean: mean, summitTempMin: tMin, bcTempMin: bcMin, bcTempMax: bcMax,
        precipTotal: pr, stormHours: storm, source: this.source[this.hourIndex(dayStart + 12 * HOUR)],
        good: wMax < 45 && pr < 4 && storm === 0,
      });
    }
    return out;
  }
}

export function windChill(tempC: number, windKmh: number): number {
  if (windKmh < 4.8 || tempC > 10) return tempC;
  const v = Math.pow(windKmh, 0.16);
  return 13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v;
}

export function estimateVisibility(cloud: number, snowCmH: number, windKmh: number, humidity: number): number {
  let vis = 60000;
  // Inside cloud.
  if (cloud > 0.4) vis = Math.min(vis, lerp(20000, 120, smoothstep(0.4, 1, cloud) * smoothstep(60, 95, humidity + 20)));
  // Falling snow.
  if (snowCmH > 0.02) vis = Math.min(vis, 1200 / (0.4 + snowCmH * 4));
  // Blowing snow / spindrift: a near-surface layer that only blots out the view in strong winds.
  if (windKmh > 55) vis = Math.min(vis, 20000 * Math.exp(-(windKmh - 55) / 16));
  return Math.max(15, vis);
}

export function stormLevelOf(windKmh: number, snowCmH: number, visibilityM: number): number {
  return clamp(Math.max((windKmh - 45) / 55, snowCmH / 2.0, 1 - visibilityM / 350), 0, 1);
}
