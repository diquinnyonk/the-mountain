/** Nepal Standard Time is UTC+5:45. */
export const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

/**
 * Game clock. Time is held as UTC epoch milliseconds; the rate at which game time
 * passes per real second is set every frame by the game (walking, resting, sleeping).
 */
export class GameClock {
  time: number;
  /** Game seconds per real second, for the HUD. */
  rate = 1;
  constructor(startUtcMs: number) {
    this.time = startUtcMs;
  }
  advance(gameSeconds: number) {
    this.time += gameSeconds * 1000;
  }
  get localDate(): Date {
    return new Date(this.time + NPT_OFFSET_MS);
  }
  /** Local (Nepal) fractional hour of day, 0..24. */
  get localHour(): number {
    const d = this.localDate;
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  }
  /** UTC ms of the next local occurrence of `hour` (0..24). */
  nextLocalHour(hour: number): number {
    const d = this.localDate;
    const midnightLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - NPT_OFFSET_MS;
    let t = midnightLocal + hour * HOUR;
    if (t <= this.time + 60_000) t += DAY;
    return t;
  }
}

export function formatLocalTime(utcMs: number): string {
  const d = new Date(utcMs + NPT_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function formatLocalDate(utcMs: number): string {
  const d = new Date(utcMs + NPT_OFFSET_MS);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Local midnight (NPT) of a YYYY-MM-DD date string, as UTC ms. */
export function localMidnightUtc(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - NPT_OFFSET_MS;
}
