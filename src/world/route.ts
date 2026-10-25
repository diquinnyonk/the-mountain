import * as THREE from 'three';
import type { Terrain } from './heightmap';

export interface RouteHit {
  s: number;
  index: number;
  /** Signed lateral offset from the centreline (m), positive to the right going up. */
  lateral: number;
  distance: number;
}

/** The South Col route as a polyline over the terrain, parameterised by distance `s` from Base Camp. */
export class Route {
  readonly xs: Float32Array;
  readonly zs: Float32Array;
  readonly ys: Float32Array;
  readonly ss: Float32Array;
  readonly length: number;

  constructor(readonly terrain: Terrain) {
    const pts = terrain.route.points;
    const n = pts.length;
    this.xs = new Float32Array(n);
    this.zs = new Float32Array(n);
    this.ys = new Float32Array(n);
    this.ss = new Float32Array(n);
    let s = 0;
    for (let k = 0; k < n; k++) {
      const [x, z] = pts[k];
      this.xs[k] = x;
      this.zs[k] = z;
      this.ys[k] = terrain.heightAt(x, z);
      if (k > 0) s += Math.hypot(x - this.xs[k - 1], z - this.zs[k - 1], this.ys[k] - this.ys[k - 1]);
      this.ss[k] = s;
    }
    this.length = s;
  }

  get count() {
    return this.xs.length;
  }

  indexAt(s: number): number {
    const ss = this.ss;
    if (s <= 0) return 0;
    if (s >= this.length) return ss.length - 2;
    let lo = 0, hi = ss.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  pointAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const k = this.indexAt(s);
    const t = Math.min(1, Math.max(0, (s - this.ss[k]) / Math.max(1e-6, this.ss[k + 1] - this.ss[k])));
    out.set(
      this.xs[k] + (this.xs[k + 1] - this.xs[k]) * t,
      0,
      this.zs[k] + (this.zs[k + 1] - this.zs[k]) * t,
    );
    out.y = this.terrain.heightAt(out.x, out.z);
    return out;
  }

  /** Unit horizontal tangent (pointing uphill along the route) at s. */
  tangentAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const k = this.indexAt(s);
    const k0 = Math.max(0, k - 1), k1 = Math.min(this.count - 1, k + 2);
    out.set(this.xs[k1] - this.xs[k0], 0, this.zs[k1] - this.zs[k0]).normalize();
    return out;
  }

  /** World position at route distance s, offset sideways by `lateral` metres. */
  offsetPoint(s: number, lateral: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.pointAt(s, out);
    if (lateral !== 0) {
      const t = this.tangentAt(s, tmp);
      out.x += -t.z * lateral;
      out.z += t.x * lateral;
      out.y = this.terrain.heightAt(out.x, out.z);
    }
    return out;
  }

  altitudeAt(s: number): number {
    const k = this.indexAt(s);
    const t = Math.min(1, Math.max(0, (s - this.ss[k]) / Math.max(1e-6, this.ss[k + 1] - this.ss[k])));
    return this.ys[k] + (this.ys[k + 1] - this.ys[k]) * t;
  }

  /** Slope of the route (rise over run) at s; positive uphill. */
  gradeAt(s: number): number {
    const k = this.indexAt(s);
    const run = Math.hypot(this.xs[k + 1] - this.xs[k], this.zs[k + 1] - this.zs[k]);
    return (this.ys[k + 1] - this.ys[k]) / Math.max(0.1, run);
  }

  /** First s at which the route reaches `alt`, searching from `fromS`. */
  sAtAltitude(alt: number, fromS = 0): number {
    for (let k = this.indexAt(fromS); k < this.count; k++) if (this.ys[k] >= alt) return this.ss[k];
    return this.length;
  }

  /** Closest point on the route to (x, z). Uses the terrain's route mask to seed the search. */
  closest(x: number, z: number, hintIndex = -1): RouteHit {
    let seed = this.terrain.nearestRouteIndex(x, z);
    if (seed < 0) seed = hintIndex;
    let k0 = 0, k1 = this.count - 2;
    if (seed >= 0) {
      k0 = Math.max(0, seed - 8);
      k1 = Math.min(this.count - 2, seed + 8);
    }
    let best: RouteHit = { s: 0, index: 0, lateral: 0, distance: Infinity };
    for (let k = k0; k <= k1; k++) {
      const ax = this.xs[k], az = this.zs[k];
      const dx = this.xs[k + 1] - ax, dz = this.zs[k + 1] - az;
      const len2 = dx * dx + dz * dz;
      const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / Math.max(1e-6, len2)));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.distance) {
        const len = Math.sqrt(len2);
        const cross = (dx * (z - az) - dz * (x - ax)) / Math.max(1e-6, len);
        best = { s: this.ss[k] + (this.ss[k + 1] - this.ss[k]) * t, index: k, lateral: cross, distance: d };
      }
    }
    return best;
  }
}

const tmp = new THREE.Vector3();
