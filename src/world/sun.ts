/** Solar elevation/azimuth (degrees) for a UTC time at lat/lon (NOAA approximation). */
export function sunPosition(utcMs: number, lat: number, lon: number): { elevation: number; azimuth: number } {
  const rad = Math.PI / 180;
  const d = new Date(utcMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((utcMs - start) / 86_400_000) + 1;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hour - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hour * 60 + eqTime + 4 * lon;
  const ha = (tst / 4 - 180) * rad;
  const phi = lat * rad;
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  let az = Math.acos(Math.max(-1, Math.min(1, (Math.sin(phi) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(phi) * Math.sin(zen)))));
  az = ha > 0 ? (az / rad + 180) % 360 : (540 - az / rad) % 360;
  return { elevation: 90 - zen / rad, azimuth: az };
}

export const EVEREST = { lat: 27.9881, lon: 86.925 };
