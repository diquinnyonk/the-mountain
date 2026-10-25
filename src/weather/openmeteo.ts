import { WeatherTimeline, type WeatherSource } from './model';
import { LEVELS_HPA, STANDARD_LEVEL_HEIGHT, climateWind } from './climatology';
import { fillSynthetic, generateBadLuck } from './storm';
import { DAY, HOUR, localMidnightUtc } from '../core/clock';
import { EVEREST } from '../world/sun';
import { clamp } from '../core/mathx';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const HISTORICAL_FORECAST = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
/** The historical forecast archive (with pressure levels) starts in 2022. */
const HISTORICAL_FORECAST_FROM = Date.UTC(2022, 0, 1);

const LEVEL_VARS = ['temperature', 'relative_humidity', 'cloud_cover', 'wind_speed', 'wind_direction', 'geopotential_height'];
const SURFACE_VARS = ['precipitation', 'snowfall'];
const ARCHIVE_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'snowfall', 'cloud_cover_low', 'cloud_cover_mid',
  'cloud_cover_high', 'wind_speed_10m', 'wind_direction_10m',
];

export interface FetchPlan {
  provider: WeatherSource;
  url: string;
  from: string;
  to: string;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Work out which Open-Meteo endpoints cover which part of the window. */
export function planRequests(startIso: string, days: number, now = Date.now()): FetchPlan[] {
  const start = localMidnightUtc(startIso) - DAY; // GMT dates covering local midnight
  const end = start + (days + 1) * DAY;
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const plans: FetchPlan[] = [];
  const add = (provider: WeatherSource, a: number, b: number) => {
    if (b < a) return;
    plans.push({ provider, url: buildUrl(provider, iso(a), iso(b)), from: iso(a), to: iso(b) });
  };
  const forecastFrom = today - 90 * DAY, forecastTo = today + 15 * DAY;
  if (start >= forecastFrom) {
    add('forecast', start, Math.min(end, forecastTo));
  } else if (start >= HISTORICAL_FORECAST_FROM) {
    const histTo = Math.min(end, today - 2 * DAY);
    add('historical-forecast', start, histTo);
    if (end > histTo) add('forecast', Math.max(histTo + DAY, forecastFrom), Math.min(end, forecastTo));
  } else {
    add('reanalysis', start, Math.min(end, today - 6 * DAY));
  }
  return plans;
}

export function buildUrl(provider: WeatherSource, from: string, to: string): string {
  const p = new URLSearchParams({
    latitude: String(EVEREST.lat),
    longitude: String(EVEREST.lon),
    start_date: from,
    end_date: to,
    timeformat: 'unixtime',
    timezone: 'GMT',
    wind_speed_unit: 'kmh',
  });
  if (provider === 'reanalysis') {
    p.set('hourly', ARCHIVE_VARS.join(','));
    return `${ARCHIVE}?${p}`;
  }
  const vars = [...SURFACE_VARS];
  for (const L of LEVELS_HPA) for (const v of LEVEL_VARS) vars.push(`${v}_${L}hPa`);
  p.set('hourly', vars.join(','));
  return `${provider === 'forecast' ? FORECAST : HISTORICAL_FORECAST}?${p}`;
}

interface OpenMeteoResponse {
  elevation?: number;
  hourly?: Record<string, (number | null)[]> & { time: number[] };
  error?: boolean;
  reason?: string;
}

async function getJson(url: string, fetcher: typeof fetch): Promise<OpenMeteoResponse> {
  const key = 'om:' + url;
  try {
    const cached = localStorage.getItem(key);
    if (cached) {
      const { at, body, permanent } = JSON.parse(cached);
      if (permanent || Date.now() - at < 3 * HOUR) return body;
    }
  } catch { /* storage unavailable */ }
  const res = await fetcher(url);
  const body = (await res.json()) as OpenMeteoResponse;
  if (!res.ok || body.error) throw new Error(body.reason ?? `HTTP ${res.status}`);
  try {
    const permanent = !url.startsWith(FORECAST);
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), body, permanent }));
  } catch { /* quota */ }
  return body;
}

/** Copy pressure-level data into the timeline. */
function applyLevels(tl: WeatherTimeline, body: OpenMeteoResponse, provider: WeatherSource): number {
  const hr = body.hourly!;
  let filled = 0;
  hr.time.forEach((t, k) => {
    const h = Math.round((t * 1000 - tl.start) / HOUR);
    if (h < 0 || h >= tl.hours) return;
    const t500 = hr['temperature_500hPa']?.[k];
    if (t500 == null) return;
    LEVELS_HPA.forEach((L, l) => {
      const g = (v: string) => hr[`${v}_${L}hPa`]?.[k];
      tl.t[l][h] = g('temperature') ?? tl.t[l][h];
      tl.rh[l][h] = g('relative_humidity') ?? tl.rh[l][h];
      tl.cloud[l][h] = g('cloud_cover') ?? tl.cloud[l][h];
      tl.ws[l][h] = g('wind_speed') ?? tl.ws[l][h];
      tl.wd[l][h] = g('wind_direction') ?? tl.wd[l][h];
      tl.z[l][h] = g('geopotential_height') ?? STANDARD_LEVEL_HEIGHT[l];
    });
    tl.precip[h] = hr.precipitation?.[k] ?? 0;
    tl.snowfall[h] = hr.snowfall?.[k] ?? 0;
    tl.source[h] = provider;
    filled++;
  });
  return filled;
}

/**
 * ERA5 reanalysis via the archive API only has near-surface fields for the grid
 * cell (whose terrain is far lower and smoother than Everest), so build the
 * vertical profile from them: lapse-rate temperatures, cloud by layer, and
 * upper winds scaled from climatology by the day's surface wind anomaly.
 */
function applySurface(tl: WeatherTimeline, body: OpenMeteoResponse): number {
  const hr = body.hourly!;
  const elev = body.elevation ?? 5000;
  let filled = 0;
  hr.time.forEach((t, k) => {
    const h = Math.round((t * 1000 - tl.start) / HOUR);
    if (h < 0 || h >= tl.hours) return;
    const t2 = hr.temperature_2m?.[k];
    if (t2 == null) return;
    const rh2 = hr.relative_humidity_2m?.[k] ?? 50;
    const w10 = hr.wind_speed_10m?.[k] ?? 10;
    const wd = hr.wind_direction_10m?.[k] ?? 270;
    const low = hr.cloud_cover_low?.[k] ?? 0, mid = hr.cloud_cover_mid?.[k] ?? 0, high = hr.cloud_cover_high?.[k] ?? 0;
    const time = t * 1000;
    LEVELS_HPA.forEach((_, l) => {
      const z = STANDARD_LEVEL_HEIGHT[l];
      tl.z[l][h] = z;
      tl.t[l][h] = t2 - (6.5 * (z - elev)) / 1000;
      tl.rh[l][h] = clamp(rh2 - l * 8, 5, 100);
      tl.cloud[l][h] = [low, Math.max(low, mid) * 0.8, mid, high, high][l];
      tl.ws[l][h] = climateWind(l, time) * clamp(0.6 + w10 / 25, 0.4, 1.8);
      tl.wd[l][h] = wd;
    });
    tl.precip[h] = hr.precipitation?.[k] ?? 0;
    tl.snowfall[h] = hr.snowfall?.[k] ?? 0;
    tl.source[h] = 'reanalysis';
    filled++;
  });
  return filled;
}

export interface WeatherLoad {
  timeline: WeatherTimeline;
  notes: string[];
}

/**
 * Load real weather at Everest for `days` days starting at local midnight of
 * `startIso`. Whatever the APIs can't cover is filled from climatology.
 */
export async function loadWeather(startIso: string, days: number, fetcher: typeof fetch = fetch.bind(globalThis), now = Date.now()): Promise<WeatherLoad> {
  const start = localMidnightUtc(startIso);
  const tl = new WeatherTimeline(start, days * 24);
  const notes: string[] = [];
  for (const plan of planRequests(startIso, days, now)) {
    // Fall back along forecast > archived forecasts > ERA5 if an endpoint refuses the range.
    const chain: WeatherSource[] = plan.provider === 'forecast'
      ? ['forecast', 'historical-forecast', 'reanalysis']
      : plan.provider === 'historical-forecast' ? ['historical-forecast', 'reanalysis'] : ['reanalysis'];
    let lastError = '';
    for (const provider of chain) {
      try {
        const body = await getJson(buildUrl(provider, plan.from, plan.to), fetcher);
        const n = provider === 'reanalysis' ? applySurface(tl, body) : applyLevels(tl, body, provider);
        if (!n) throw new Error('no data in range');
        notes.push(`${describe(provider)}: ${plan.from} to ${plan.to} (${n} h)`);
        if (provider === 'reanalysis') notes.push('ERA5 has no upper-air data here; summit winds are estimated from climatology scaled by the day\'s winds.');
        lastError = '';
        break;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    if (lastError) notes.push(`Weather service unavailable for ${plan.from} to ${plan.to} (${lastError}).`);
  }
  const synthetic = tl.source.filter((s) => s === 'synthetic').length;
  if (synthetic) notes.push(`${Math.round(synthetic / 24)} day(s) beyond the available data use seasonal climatology.`);
  fillSynthetic(tl, startIso);
  tl.events = generateBadLuck(tl, startIso);
  tl.notes = notes;
  return { timeline: tl, notes };
}

export function describe(s: WeatherSource): string {
  return {
    forecast: 'Live forecast (Open-Meteo)',
    'historical-forecast': 'Archived forecasts (Open-Meteo historical)',
    reanalysis: 'ERA5 reanalysis (Open-Meteo archive)',
    synthetic: 'Seasonal climatology',
  }[s];
}
