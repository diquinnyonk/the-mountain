/**
 * Rough monthly climatology for the Everest massif, used to extend real data
 * beyond what the API returns and as an offline fallback.
 * Sources: published reanalysis summaries of 300/500 hPa winds and temperatures
 * over the Khumbu, and Pyramid/South Col station records (values rounded).
 */
export const LEVELS_HPA = [600, 500, 400, 300, 250] as const;
/** Standard-atmosphere geopotential heights (m) for the levels, adjusted for the warm Himalayan column. */
export const STANDARD_LEVEL_HEIGHT = [4420, 5860, 7550, 9650, 10950];

const M = (v: number[]) => v;
// Index 0 = January.
export const CLIMATE = {
  wind300: M([140, 135, 115, 85, 50, 30, 25, 25, 35, 65, 105, 130]),
  temp300: M([-42, -41, -38, -34, -29, -26, -25, -25, -27, -32, -37, -40]),
  temp500: M([-17, -16, -13, -10, -6, -3, -2, -2, -3, -8, -12, -15]),
  /** Precipitation at Base Camp, mm per day. */
  precip: M([0.5, 0.8, 1.0, 1.2, 2.0, 6.0, 9.0, 8.0, 5.0, 1.5, 0.3, 0.3]),
  cloud: M([0.25, 0.3, 0.4, 0.45, 0.5, 0.8, 0.9, 0.9, 0.75, 0.4, 0.2, 0.2]),
  /** Chance per day of a "bad luck" squall/whiteout developing. */
  squall: M([0.06, 0.06, 0.08, 0.1, 0.1, 0.25, 0.3, 0.3, 0.2, 0.08, 0.05, 0.05]),
  /** Chance per week of a tropical cyclone remnant / western disturbance bringing a multi-day storm. */
  cyclone: M([0.05, 0.08, 0.1, 0.08, 0.12, 0.15, 0.05, 0.05, 0.1, 0.15, 0.08, 0.05]),
};

/** Smoothly interpolated monthly value for a UTC time. */
export function monthly(table: number[], utcMs: number): number {
  const d = new Date(utcMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const yearLen = Date.UTC(d.getUTCFullYear() + 1, 0, 1) - start;
  const f = ((utcMs - start) / yearLen) * 12 - 0.5;
  const i = Math.floor(f);
  const t = f - i;
  const a = table[((i % 12) + 12) % 12], b = table[(((i + 1) % 12) + 12) % 12];
  const s = (1 - Math.cos(t * Math.PI)) / 2;
  return a + (b - a) * s;
}

export function climateWind(levelIndex: number, utcMs: number): number {
  const w300 = monthly(CLIMATE.wind300, utcMs);
  const factor = [0.3, 0.42, 0.7, 1, 1.05][levelIndex];
  return w300 * factor + 8;
}

export function climateTemp(levelIndex: number, utcMs: number): number {
  const t300 = monthly(CLIMATE.temp300, utcMs);
  const t500 = monthly(CLIMATE.temp500, utcMs);
  const z = STANDARD_LEVEL_HEIGHT;
  const lapse = (t500 - t300) / (z[3] - z[1]);
  return t500 - lapse * (z[levelIndex] - z[1]);
}
