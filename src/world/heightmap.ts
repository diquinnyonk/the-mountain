import { Noise2 } from './noise';
import { clamp, smoothstep } from '../core/mathx';

export interface TerrainMeta {
  width: number;
  height: number;
  metresPerPixel: number;
  west: number;
  east: number;
  north: number;
  south: number;
  minHeight: number;
  maxHeight: number;
}

export interface FarMeta {
  width: number;
  height: number;
  metresPerPixel: number;
  originX: number;
  originZ: number;
}

export interface RouteData {
  spacing: number;
  southColIndex: number;
  points: [number, number][];
}

/**
 * The playable terrain. World frame: metres, x east, z south, y = altitude above
 * sea level, origin at the centre of the baked map.
 *
 * heightAt() is the single source of truth for both rendering and physics:
 * a bicubic DEM sample plus procedural detail that fades out near the route so
 * the trail stays walkable.
 */
/** Half-width (m) of the detailed summit-ridge mesh, and how far past the summit it runs. */
export const RIDGE_STRIP_HALF = 64;
export const RIDGE_STRIP_PAST = 25;

export class Terrain {
  readonly halfW: number;
  readonly halfH: number;
  private routeDist: Float32Array;
  private routeIdx: Int32Array;
  private noise = new Noise2(8849);

  constructor(
    readonly meta: TerrainMeta,
    readonly data: Uint16Array,
    readonly route: RouteData,
    readonly far?: { meta: FarMeta; data: Uint16Array },
  ) {
    this.halfW = (meta.width * meta.metresPerPixel) / 2;
    this.halfH = (meta.height * meta.metresPerPixel) / 2;
    const n = meta.width * meta.height;
    this.routeDist = new Float32Array(n).fill(1e6);
    this.routeIdx = new Int32Array(n).fill(-1);
    this.snapRouteToCrest();
    this.buildRouteMask(40);
    this.prepareSummitRidge();
  }

  get width() {
    return this.meta.width;
  }
  get height() {
    return this.meta.height;
  }
  get mpp() {
    return this.meta.metresPerPixel;
  }

  /** Raw DEM pixel, clamped to the map. */
  px(i: number, j: number): number {
    const w = this.meta.width, h = this.meta.height;
    i = i < 0 ? 0 : i >= w ? w - 1 : i;
    j = j < 0 ? 0 : j >= h ? h - 1 : j;
    return this.data[j * w + i];
  }

  /** Bicubic (Catmull-Rom) DEM sample at world x/z. */
  demAt(x: number, z: number): number {
    const fx = (x + this.halfW) / this.mpp - 0.5;
    const fz = (z + this.halfH) / this.mpp - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const rows = [0, 0, 0, 0];
    for (let r = -1; r <= 2; r++) {
      rows[r + 1] = cubic(this.px(i - 1, j + r), this.px(i, j + r), this.px(i + 1, j + r), this.px(i + 2, j + r), tx);
    }
    return cubic(rows[0], rows[1], rows[2], rows[3], tz);
  }

  /** Distance (m) from the nearest route centreline point, approximated from the baked mask. */
  routeDistance(x: number, z: number): number {
    const k = this.cell(x, z);
    return k < 0 ? 1e6 : this.routeDist[k];
  }

  /** Index of the nearest route point (or -1 if far from the route). */
  nearestRouteIndex(x: number, z: number): number {
    const k = this.cell(x, z);
    return k < 0 ? -1 : this.routeIdx[k];
  }

  heightAt(x: number, z: number): number {
    return this.baseAt(x, z) + this.detailAt(x, z);
  }

  /** DEM height, with the summit ridge sculpted where the DEM is too coarse to show it. */
  baseAt(x: number, z: number): number {
    const dem = this.demAt(x, z);
    const k = this.nearestRouteIndex(x, z);
    if (k < this.ridgeStart) return dem;
    const sc = this.ridgeSculpt(x, z, k, dem);
    return sc ? dem + (sc.h - dem) * sc.w : dem;
  }

  /**
   * The least-effort path traverses the east flank of the summit ridge. From the Balcony
   * up, move it sideways onto the ridge's actual crest in the DEM, as the real route runs.
   */
  private snapRouteToCrest() {
    const src = this.route.points;
    const n = src.length;
    const dEnd = new Float32Array(n);
    for (let k = n - 2; k >= 0; k--) dEnd[k] = dEnd[k + 1] + Math.hypot(src[k + 1][0] - src[k][0], src[k + 1][1] - src[k][1]);
    const offs = new Float32Array(n);
    for (let k = 1; k < n - 1; k++) {
      if (dEnd[k] > Terrain.RIDGE_LENGTH + 100 || dEnd[k] < 2) continue;
      const tx = src[k + 1][0] - src[k - 1][0], tz = src[k + 1][1] - src[k - 1][1];
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      let best = 0, bh = -Infinity;
      for (let o = -150; o <= 150; o += 3) {
        let h = 0;
        for (const d of [-6, 0, 6]) h += this.demAt(src[k][0] + nx * (o + d), src[k][1] + nz * (o + d));
        if (h > bh) { bh = h; best = o; }
      }
      offs[k] = best;
    }
    // Rate-limit the offsets (they jump between neighbouring bumps), then smooth them.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 2; k < n - 1; k++) offs[k] = Math.max(offs[k - 1] - 4, Math.min(offs[k - 1] + 4, offs[k]));
      for (let k = n - 3; k >= 1; k--) offs[k] = Math.max(offs[k + 1] - 4, Math.min(offs[k + 1] + 4, offs[k]));
    }
    const sm = new Float32Array(n);
    for (let k = 1; k < n - 1; k++) {
      let sum = 0, c = 0;
      for (let j = Math.max(1, k - 10); j <= Math.min(n - 2, k + 10); j++) { sum += offs[j]; c++; }
      sm[k] = sum / c;
    }
    const out = src.map((p) => [p[0], p[1]] as [number, number]);
    let first = n;
    for (let k = 1; k < n - 1; k++) {
      const fade = (1 - smoothstep(Terrain.RIDGE_LENGTH - 100, Terrain.RIDGE_LENGTH + 80, dEnd[k])) * smoothstep(2, 60, dEnd[k]);
      if (fade > 0 && k < first) first = k;
      const o = sm[k] * fade;
      const tx = src[k + 1][0] - src[k - 1][0], tz = src[k + 1][1] - src[k - 1][1];
      const tl = Math.hypot(tx, tz) || 1;
      out[k] = [src[k][0] - (tz / tl) * o, src[k][1] + (tx / tl) * o];
    }
    // Smooth the shifted tail as a curve (ends fixed), then re-space it evenly so nothing doubles back.
    const t0 = Math.max(1, first - 5);
    for (let pass = 0; pass < 12; pass++) {
      const prev = out.map((p) => [p[0], p[1]]);
      for (let k = t0; k < n - 1; k++) {
        out[k] = [(prev[k - 1][0] + 2 * prev[k][0] + prev[k + 1][0]) / 4, (prev[k - 1][1] + 2 * prev[k][1] + prev[k + 1][1]) / 4];
      }
    }
    const tail = out.slice(t0);
    const spaced: [number, number][] = [tail[0]];
    let carry = 0;
    for (let k = 1; k < tail.length; k++) {
      const [ax, az] = tail[k - 1], [bx, bz] = tail[k];
      const len = Math.hypot(bx - ax, bz - az);
      let d = 10 - carry;
      while (d <= len) {
        spaced.push([ax + ((bx - ax) * d) / len, az + ((bz - az) * d) / len]);
        d += 10;
      }
      carry = len - (d - 10);
    }
    const last = tail[tail.length - 1];
    if (Math.hypot(spaced[spaced.length - 1][0] - last[0], spaced[spaced.length - 1][1] - last[1]) > 2) spaced.push(last);
    else spaced[spaced.length - 1] = last;
    out.length = t0;
    out.push(...spaced);
    this.route.points = out;
  }

  // ----- The summit ridge -----
  // The DEM (~30 m) rounds Everest's summit pyramid into a dome. From the Balcony up we
  // replace it near the route with a knife-edge ridge whose crest follows the trail and
  // whose profile follows the real one: South Summit, the notch, the Cornice Traverse,
  // the Hillary Step, the summit ridge and a small summit top.
  private ridgeStart = Infinity;
  /** Horizontal distance (m) from each route point to the summit. */
  private dEnd = new Float32Array(0);
  /** Crest altitude at each route point in the ridge section. */
  private crest = new Float32Array(0);
  static readonly RIDGE_LENGTH = 1150;

  /** Crest profile for the top 340 m: [distance from summit (m), altitude (m)]. */
  static readonly SUMMIT_PROFILE: [number, number][] = [
    [0, 8849], [4, 8848.7], [40, 8843], [100, 8828], [150, 8812],
    // Hillary Step: about 12 m, near vertical.
    [163, 8806], [168, 8794], [172, 8790],
    // Cornice Traverse, dipping to the notch below the South Summit.
    [215, 8776], [250, 8752], [272, 8740], [288, 8739],
    // South Summit.
    [312, 8751], [322, 8754], [340, 8749],
  ];

  private prepareSummitRidge() {
    const pts = this.route.points;
    const n = pts.length;
    this.dEnd = new Float32Array(n);
    for (let k = n - 2; k >= 0; k--) {
      this.dEnd[k] = this.dEnd[k + 1] + Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    }
    let start = n - 1;
    while (start > 0 && this.dEnd[start - 1] < Terrain.RIDGE_LENGTH) start--;
    this.ridgeStart = start;
    // Crest: the DEM along the route (smoothed) lower down, the real profile near the top.
    const raw = new Float32Array(n);
    for (let k = 0; k < n; k++) raw[k] = this.demAt(pts[k][0], pts[k][1]);
    this.crest = new Float32Array(n);
    for (let k = start; k < n; k++) {
      let sum = 0, c = 0;
      for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, k + 3); j++) { sum += raw[j]; c++; }
      const smooth = sum / c;
      const d = this.dEnd[k];
      const t = smoothstep(340, 430, d);
      this.crest[k] = Terrain.profileAt(Math.min(d, 340)) * (1 - t) + smooth * t;
    }
  }

  static profileAt(d: number): number {
    const P = Terrain.SUMMIT_PROFILE;
    if (d <= 0) return P[0][1];
    for (let i = 1; i < P.length; i++) {
      if (d <= P[i][0]) {
        const [d0, h0] = P[i - 1], [d1, h1] = P[i];
        return h0 + ((h1 - h0) * (d - d0)) / (d1 - d0);
      }
    }
    return P[P.length - 1][1];
  }

  /**
   * Spindrift flutes on the Kangshung (east) face: sharp parallel snow ribs running
   * straight down the fall line, a few metres apart, deepening away from the crest.
   */
  flutes(along: number, lat: number): number {
    if (lat <= 2) return 0;
    const warp = this.noise.noise(along / 18, lat / 30) * 2.4 + lat * 0.025;
    const wl = 5.5 + this.noise.noise(along / 40 + 7, 3) * 1.5;
    const f = 1 - Math.abs(Math.sin((Math.PI * along) / wl + warp));
    // Shallow just below the crest (where you see them from the trail), deeper further down the face.
    const depth = Math.min(1.3, 0.1 + lat * 0.03) * smoothstep(5, 16, lat);
    return (Math.pow(f, 0.6) - 0.5) * depth * 2;
  }

  /**
   * The cornice along the Cornice Traverse and the final ridge, built into the surface so it
   * blends with the snow: a smooth swell rising from the trail on the east side to a rounded
   * lip, then falling away steeply to the Kangshung Face. None beside the Hillary Step or
   * on the summit dome.
   */
  cornice(d: number, lat: number): number {
    if (lat <= 0.8 || d < 40 || d > 350) return 0;
    const along = smoothstep(40, 80, d) * (1 - smoothstep(310, 350, d)) * smoothstep(12, 30, Math.abs(d - 168));
    if (along <= 0) return 0;
    const size = along * (0.8 + 0.3 * this.noise.noise(d / 35, 11));
    const swell = 1.5 * smoothstep(1, 5, lat) * (1 - smoothstep(5, 8.5, lat));
    const fall = Math.max(0, lat - 6.5) * 0.9;
    return size * (swell - fall);
  }

  /** Sculpted height near the ridge, and how strongly it replaces the DEM. */
  /**
   * Position relative to the summit ridge: d = distance from the summit along the route
   * (negative past it), lat = signed distance from the crest (positive east). Null away from it.
   */
  ridgeCoords(x: number, z: number): { d: number; lat: number } | null {
    const k = this.nearestRouteIndex(x, z);
    if (k < this.ridgeStart) return null;
    const p = this.projectRidge(x, z, k);
    return p ? { d: p.d, lat: p.lat } : null;
  }

  /** The detailed ridge strip covers the crest; sink the coarse terrain just out of sight beneath it. */
  renderSink(x: number, z: number): number {
    const r = this.ridgeCoords(x, z);
    if (!r || r.d < -RIDGE_STRIP_PAST || r.d > Terrain.RIDGE_LENGTH) return 0;
    const a = Math.abs(r.lat);
    if (a >= RIDGE_STRIP_HALF) return 0;
    return 2.5 * (1 - smoothstep(RIDGE_STRIP_HALF - 5, RIDGE_STRIP_HALF - 1, a)) *
      (1 - smoothstep(Terrain.RIDGE_LENGTH - 40, Terrain.RIDGE_LENGTH, r.d)) *
      (1 - smoothstep(RIDGE_STRIP_PAST - 5, RIDGE_STRIP_PAST - 1, -r.d));
  }

  private projectRidge(x: number, z: number, k: number) {
    const pts = this.route.points;
    const n = pts.length;
    // Project onto the nearer of the two segments around k.
    let best = { d: 0, lat: 0, dist: Infinity, crest: 0, px: 0, pz: 0 };
    for (const a of [k - 1, k]) {
      if (a < 0 || a >= n - 1) continue;
      const [ax, az] = pts[a], [bx, bz] = pts[a + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      const u = ((x - ax) * dx + (z - az) * dz) / (len * len);
      const tu = Math.min(1, Math.max(0, u));
      const px = ax + dx * tu, pz = az + dz * tu;
      const dist = Math.hypot(x - px, z - pz);
      if (dist < best.dist) {
        // Positive lateral = right of the way up (east on the summit ridge: the Kangshung Face).
        const lat = (dx * (z - az) - dz * (x - ax)) / len;
        // Past the summit, keep measuring "beyond" so the ground falls away on the far side.
        const along = a === n - 2 && u > 1 ? -(u - 1) * len : this.dEnd[a] - tu * len;
        const crest = this.crest[a] + (this.crest[a + 1] - this.crest[a]) * tu;
        best = { d: along, lat, dist, crest, px, pz };
      }
    }
    return best.dist === Infinity ? null : best;
  }

  private ridgeSculpt(x: number, z: number, k: number, dem: number): { h: number; w: number } | null {
    const best = this.projectRidge(x, z, k);
    if (!best) return null;
    const crestLine = best.d < 0 ? Terrain.profileAt(0) - Math.max(0, -best.d - 3) * 1.1 : best.d < 340 ? Terrain.profileAt(best.d) : best.crest;
    // A narrow walkable crest, then steep faces: the Kangshung (east) steeper than the Southwest Face.
    const a = Math.abs(best.lat);
    // The last stretch widens into the small, rounded snow dome of the summit.
    const dome = best.d < 45 ? 3.2 * (1 - smoothstep(0, 45, Math.max(0, best.d))) : 0;
    const off = Math.max(0, a - 0.9 - dome);
    const drop = best.lat > 0 ? off * 1.3 + off * off * 0.004 : off * 0.95 + off * off * 0.003;
    let face = crestLine - drop;
    // Ribs and gullies on the faces, growing away from the crest; flutes on the east face.
    const rib = this.noise.fbm(best.d / 22, best.lat / 9, 3) * 4.5 + Math.abs(this.noise.noise(best.d / 9 + 30, best.lat / 6)) * 1.5;
    face += rib * smoothstep(3, 25, a) * (best.lat > 0 ? 0.35 : 1) + this.flutes(best.d, best.lat);
    face += this.cornice(best.d, best.lat);
    // The Southwest Face breaks into blocky rock steps and snow ledges.
    if (best.lat < -3) {
      const q = face / 6 + this.noise.noise(best.d / 15, 9) * 0.6;
      face += (Math.round(q) - q) * 3.2 * smoothstep(3, 12, a);
    }
    // The faces cut down into the terrain until they meet it, and never rise back above it
    // (which would leave the crest in a trench). The DEM is shifted to agree with the crest
    // along the route, fading out with distance from it.
    const shift = (crestLine - this.demAt(best.px, best.pz)) * (1 - smoothstep(25, 130, a));
    const surface = dem + shift;
    // Carve down to the steep face near the crest, but cap the depth and let it taper so the
    // faces ease back into the terrain while still descending (no cliff where the carve ends).
    const cap = 55 * (1 - smoothstep(45, 260, a));
    const h = surface - Math.min(Math.max(0, surface - face), cap);
    const wAlong = 1 - smoothstep(Terrain.RIDGE_LENGTH - 150, Terrain.RIDGE_LENGTH, best.d);
    return { h, w: wAlong * (1 - smoothstep(260, 300, a)) };
  }

  /** Procedural sub-DEM relief: wind-sculpted snow, rubble, ice hummocks; flattened on the trail. */
  detailAt(x: number, z: number): number {
    const d = this.routeDistance(x, z);
    const trail = smoothstep(3, 25, d);
    if (trail <= 0) return 0;
    const base = this.noise.fbm(x / 38, z / 38, 3) * 2.2;
    const fine = this.noise.noise(x / 9 + 100, z / 9) * 0.35;
    // Icefall / glacier hummocks: stronger relief in the lower glacier band near the route.
    const alt = this.demAt(x, z);
    const icefall = smoothstep(5420, 5500, alt) * (1 - smoothstep(5980, 6080, alt)) * (1 - smoothstep(250, 500, d));
    const hummock = icefall * Math.abs(this.noise.fbm(x / 22 + 40, z / 22 - 40, 3)) * 7;
    return (base + fine + hummock) * trail;
  }

  normalAt(x: number, z: number, out: { x: number; y: number; z: number }, e = 2) {
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  /** Slope angle in degrees at a point. */
  slopeAt(x: number, z: number): number {
    const e = 2;
    const hx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const hz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return (Math.atan(Math.hypot(hx, hz)) * 180) / Math.PI;
  }

  inBounds(x: number, z: number, margin = 0): boolean {
    return x > -this.halfW + margin && x < this.halfW - margin && z > -this.halfH + margin && z < this.halfH - margin;
  }

  /** Far backdrop height (raw, lower resolution), for the wider Himalaya. */
  farHeightAt(x: number, z: number): number {
    if (!this.far) return 0;
    const m = this.far.meta;
    const fx = (x - m.originX) / m.metresPerPixel, fz = (z - m.originZ) / m.metresPerPixel;
    const i = clamp(Math.floor(fx), 0, m.width - 2), j = clamp(Math.floor(fz), 0, m.height - 2);
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const d = this.far.data, w = m.width;
    const a = d[j * w + i], b = d[j * w + i + 1], c = d[(j + 1) * w + i], e = d[(j + 1) * w + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  }

  private cell(x: number, z: number): number {
    const i = Math.floor((x + this.halfW) / this.mpp), j = Math.floor((z + this.halfH) / this.mpp);
    if (i < 0 || j < 0 || i >= this.meta.width || j >= this.meta.height) return -1;
    return j * this.meta.width + i;
  }

  private buildRouteMask(radiusPx: number) {
    const { width: w, height: h } = this.meta;
    const mpp = this.mpp;
    const pts = this.route.points;
    for (let k = 0; k < pts.length; k++) {
      const [x, z] = pts[k];
      const ci = Math.floor((x + this.halfW) / mpp), cj = Math.floor((z + this.halfH) / mpp);
      for (let j = Math.max(0, cj - radiusPx); j <= Math.min(h - 1, cj + radiusPx); j++) {
        for (let i = Math.max(0, ci - radiusPx); i <= Math.min(w - 1, ci + radiusPx); i++) {
          const px = (i + 0.5) * mpp - this.halfW, pz = (j + 0.5) * mpp - this.halfH;
          const d = Math.hypot(px - x, pz - z);
          const c = j * w + i;
          if (d < this.routeDist[c]) {
            this.routeDist[c] = d;
            this.routeIdx[c] = k;
          }
        }
      }
    }
  }
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** Terrain embedded in the page as base64 (single-file builds, e.g. a hosted artifact). */
interface EmbeddedTerrain {
  meta: TerrainMeta;
  bin: string;
  route: RouteData;
  farMeta: FarMeta;
  far: string;
}

function decodeBase64(b64: string): Uint16Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Uint16Array(bytes.buffer);
}

export async function loadTerrain(base = './terrain/'): Promise<Terrain> {
  const embedded = (globalThis as { __TERRAIN__?: EmbeddedTerrain }).__TERRAIN__;
  if (embedded) {
    return new Terrain(embedded.meta, decodeBase64(embedded.bin), embedded.route,
      { meta: embedded.farMeta, data: decodeBase64(embedded.far) });
  }
  const [meta, bin, route, farMeta, farBin] = await Promise.all([
    fetch(base + 'everest.json').then((r) => r.json()),
    fetch(base + 'everest.bin').then((r) => r.arrayBuffer()),
    fetch(base + 'route.json').then((r) => r.json()),
    fetch(base + 'far.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(base + 'far.bin').then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]);
  return new Terrain(meta, new Uint16Array(bin), route,
    farMeta && farBin ? { meta: farMeta, data: new Uint16Array(farBin) } : undefined);
}
