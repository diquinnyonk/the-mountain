export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const invLerp = (a: number, b: number, v: number) => clamp((v - a) / (b - a), 0, 1);
export const deg = (rad: number) => (rad * 180) / Math.PI;
export const rad = (deg: number) => (deg * Math.PI) / 180;
/** Exponential approach of `cur` toward `target` with time constant `tau` (same units as dt). */
export const approach = (cur: number, target: number, dt: number, tau: number) =>
  target + (cur - target) * Math.exp(-dt / Math.max(1e-6, tau));
