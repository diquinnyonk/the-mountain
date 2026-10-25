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
    this.buildRouteMask(40);
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
    return this.demAt(x, z) + this.detailAt(x, z);
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
