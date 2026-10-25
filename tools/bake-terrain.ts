// Downloads AWS Terrarium elevation tiles for the Everest / Khumbu area and
// bakes them into a single 16-bit heightmap (public/terrain/everest.bin) plus
// metadata (public/terrain/everest.json). Run with: npm run bake
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ZOOM = 14;
// Bounds: Gorak Shep / Base Camp in the west to beyond the summit pyramid / Lhotse in the east.
const BOUNDS = { west: 86.835, east: 86.950, south: 27.950, north: 28.012 };
const CACHE = join(process.cwd(), '.tile-cache');
const OUT = join(process.cwd(), 'public', 'terrain');

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

const decoded = new Map<string, PNG>();

async function tile(z: number, x: number, y: number): Promise<PNG> {
  const key = `${z}/${x}/${y}`;
  if (!decoded.has(key)) decoded.set(key, await loadTile(z, x, y));
  return decoded.get(key)!;
}

async function loadTile(z: number, x: number, y: number): Promise<PNG> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${z}_${x}_${y}.png`);
  if (!existsSync(file)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }
  return PNG.sync.read(readFileSync(file));
}

async function main() {
  const px0 = Math.floor(lon2x(BOUNDS.west, ZOOM) * 256);
  const px1 = Math.ceil(lon2x(BOUNDS.east, ZOOM) * 256);
  const py0 = Math.floor(lat2y(BOUNDS.north, ZOOM) * 256);
  const py1 = Math.ceil(lat2y(BOUNDS.south, ZOOM) * 256);
  const width = px1 - px0;
  const height = py1 - py0;
  const heights = new Float32Array(width * height);
  const tiles = new Map<string, PNG>();
  for (let ty = Math.floor(py0 / 256); ty <= Math.floor((py1 - 1) / 256); ty++)
    for (let tx = Math.floor(px0 / 256); tx <= Math.floor((px1 - 1) / 256); tx++)
      tiles.set(`${tx}_${ty}`, await tile(ZOOM, tx, ty));

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const gx = px0 + i, gy = py0 + j;
      const png = tiles.get(`${Math.floor(gx / 256)}_${Math.floor(gy / 256)}`)!;
      const o = ((gy % 256) * 256 + (gx % 256)) * 4;
      heights[j * width + i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
    }
  }
  fillVoids(heights, width, height);

  // Metres per pixel at the centre latitude (Web Mercator is conformal, so x and y match).
  const midLat = (BOUNDS.north + BOUNDS.south) / 2;
  const metresPerPixel = (40075016.686 * Math.cos((midLat * Math.PI) / 180)) / (256 * 2 ** ZOOM);
  const west = x2lon(px0 / 256, ZOOM), east = x2lon(px1 / 256, ZOOM);
  const north = y2lat(py0 / 256, ZOOM), south = y2lat(py1 / 256, ZOOM);
  const toPixel = (lat: number, lon: number): [number, number] => [
    Math.round(lon2x(lon, ZOOM) * 256 - px0),
    Math.round(lat2y(lat, ZOOM) * 256 - py0),
  ];

  // The DEM smooths the summit pyramid and sits a little low at Base Camp, so
  // calibrate linearly against the surveyed heights (Base Camp 5,364 m, summit 8,849 m).
  const bc = toPixel(LANDMARKS.baseCamp[0], LANDMARKS.baseCamp[1]);
  const summit = peakNear(heights, width, toPixel(LANDMARKS.summit[0], LANDMARKS.summit[1]), 20);
  const rawBc = heights[bc[1] * width + bc[0]];
  const rawSummit = heights[summit[1] * width + summit[0]];
  const scale = (8849 - 5364) / (rawSummit - rawBc);
  const offset = 5364 - rawBc * scale;
  const out = new Uint16Array(width * height);
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    const h = Math.max(0, Math.round(heights[k] * scale + offset));
    out[k] = h;
    min = Math.min(min, h); max = Math.max(max, h);
  }

  // Route: least-effort path over the DEM, Base Camp > South Col > summit.
  const col = saddleNear(out, width, toPixel(LANDMARKS.southCol[0], LANDMARKS.southCol[1]), 12);
  const leg1 = leastEffortPath(out, width, height, metresPerPixel, bc, col, 40);
  const leg2 = leastEffortPath(out, width, height, metresPerPixel, col, summit, 5);
  const pixels = [...leg1, ...leg2.slice(1)];
  const route = resample(smooth(pixels.map(([i, j]) => [
    (i - width / 2) * metresPerPixel,
    (j - height / 2) * metresPerPixel,
  ]), 6), 10);

  const meta = {
    zoom: ZOOM, width, height, metresPerPixel, west, east, north, south,
    minHeight: min, maxHeight: max,
    calibration: { scale, offset },
    globalPixelOrigin: [px0, py0],
    source: 'AWS Terrain Tiles (Terrarium): SRTM and other public DEMs',
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'everest.bin'), Buffer.from(out.buffer));
  writeFileSync(join(OUT, 'everest.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(OUT, 'route.json'), JSON.stringify({
    spacing: 10,
    southColIndex: nearestIndex(route, [(col[0] - width / 2) * metresPerPixel, (col[1] - height / 2) * metresPerPixel]),
    points: route.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]),
  }));
  console.log(meta, 'route points', route.length);
  await bakeFar(px0, py0, width, height, metresPerPixel, scale, offset);
}

/**
 * Low-resolution backdrop of the wider Khumbu / Mahalangur Himal (Lhotse, Makalu,
 * Cho Oyu, Pumori, Ama Dablam) so the horizon is not cut off at the play area edge.
 */
async function bakeFar(detailPx0: number, detailPy0: number, detailW: number, detailH: number,
  mpp: number, scale: number, offset: number) {
  const Z = 10, span = 0.36;
  const centre = { lat: 27.98, lon: 86.92 };
  const fx0 = Math.floor(lon2x(centre.lon - span, Z) * 256);
  const fx1 = Math.ceil(lon2x(centre.lon + span, Z) * 256);
  const fy0 = Math.floor(lat2y(centre.lat + span * 0.9, Z) * 256);
  const fy1 = Math.ceil(lat2y(centre.lat - span * 0.9, Z) * 256);
  const w = fx1 - fx0, h = fy1 - fy0;
  const raw = new Float32Array(w * h);
  for (let ty = Math.floor(fy0 / 256); ty <= Math.floor((fy1 - 1) / 256); ty++)
    for (let tx = Math.floor(fx0 / 256); tx <= Math.floor((fx1 - 1) / 256); tx++) await tile(Z, tx, ty);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const gx = fx0 + i, gy = fy0 + j;
    const png = decoded.get(`${Z}/${Math.floor(gx / 256)}/${Math.floor(gy / 256)}`)!;
    const o = ((gy % 256) * 256 + (gx % 256)) * 4;
    raw[j * w + i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
  }
  const out = new Uint16Array(w * h);
  for (let k = 0; k < raw.length; k++) out[k] = Math.max(0, Math.round(raw[k] * scale + offset));
  const ratio = 2 ** (ZOOM - Z);
  // World coordinates of far pixel (0,0), in the same frame as the detail map (origin at its centre).
  const originX = (fx0 * ratio - detailPx0 - detailW / 2) * mpp;
  const originZ = (fy0 * ratio - detailPy0 - detailH / 2) * mpp;
  writeFileSync(join(OUT, 'far.bin'), Buffer.from(out.buffer));
  writeFileSync(join(OUT, 'far.json'), JSON.stringify({
    zoom: Z, width: w, height: h, metresPerPixel: mpp * ratio, originX, originZ,
  }, null, 2));
  console.log('far', w, h, mpp * ratio, fx0, fx1, fy0, fy1);
}

const LANDMARKS = {
  baseCamp: [28.0026, 86.8528],
  southCol: [27.9732, 86.9306],
  summit: [27.9881, 86.9250],
} as const;

/** Some tiles have rows of zeros at the seams; replace anything implausible with neighbour averages. */
function fillVoids(h: Float32Array | Uint16Array | number[] | any, w: number, hgt: number) {
  for (let pass = 0; pass < 4; pass++) {
    for (let j = 0; j < hgt; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (h[k] > 3000) continue;
        let sum = 0, n = 0;
        for (let d = 1; d <= 3 && n === 0; d++) {
          for (const [di, dj] of [[0, -d], [0, d], [-d, 0], [d, 0]]) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= w || jj >= hgt) continue;
            const v = h[jj * w + ii];
            if (v > 3000) { sum += v; n++; }
          }
        }
        if (n) h[k] = sum / n;
      }
    }
  }
}

function peakNear(h: ArrayLike<number>, w: number, [x, y]: [number, number], r: number): [number, number] {
  let best: [number, number] = [x, y], bv = -Infinity;
  for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) {
    if (h[j * w + i] > bv) { bv = h[j * w + i]; best = [i, j]; }
  }
  return best;
}

function saddleNear(h: ArrayLike<number>, w: number, [x, y]: [number, number], r: number): [number, number] {
  let best: [number, number] = [x, y], bv = Infinity;
  for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) {
    if (h[j * w + i] < bv) { bv = h[j * w + i]; best = [i, j]; }
  }
  return best;
}

/** Dijkstra over the 8-connected grid; cost grows with the cube of slope so the path keeps to glacier and ridge lines. */
function leastEffortPath(h: Uint16Array, w: number, hgt: number, mpp: number,
  start: [number, number], end: [number, number], slopeWeight: number): [number, number][] {
  const n = w * hgt;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap: [number, number][] = [];
  const push = (c: number, i: number) => {
    heap.push([c, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]]; k = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const a = 2 * k + 1, b = a + 1;
        let s = k;
        if (a < heap.length && heap[a][0] < heap[s][0]) s = a;
        if (b < heap.length && heap[b][0] < heap[s][0]) s = b;
        if (s === k) break;
        [heap[s], heap[k]] = [heap[k], heap[s]]; k = s;
      }
    }
    return top;
  };
  const si = start[1] * w + start[0], ti = end[1] * w + end[0];
  dist[si] = 0; push(0, si);
  while (heap.length) {
    const [c, i] = pop();
    if (c > dist[i]) continue;
    if (i === ti) break;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= hgt - 1) continue;
      const j = ny * w + nx;
      const run = Math.hypot(dx, dy) * mpp;
      const rise = h[j] - h[i];
      const slope = Math.abs(rise) / run;
      const cost = run * (1 + slopeWeight * slope ** 3) + (rise < 0 ? -rise * 0.5 : 0);
      if (c + cost < dist[j]) { dist[j] = c + cost; prev[j] = i; push(c + cost, j); }
    }
  }
  const path: [number, number][] = [];
  for (let i = ti; i !== -1; i = prev[i]) path.push([i % w, (i / w) | 0]);
  return path.reverse();
}

function smooth(pts: number[][], radius: number): number[][] {
  return pts.map((_, k) => {
    let sx = 0, sz = 0, n = 0;
    for (let d = -radius; d <= radius; d++) {
      const p = pts[Math.min(pts.length - 1, Math.max(0, k + d))];
      sx += p[0]; sz += p[1]; n++;
    }
    return k === 0 || k === pts.length - 1 ? pts[k] : [sx / n, sz / n];
  });
}

function resample(pts: number[][], step: number): number[][] {
  const out = [pts[0]];
  let carry = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k];
    const len = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= len) {
      out.push([ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len]);
      t += step;
    }
    carry = len - (t - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function nearestIndex(pts: number[][], [x, z]: number[]): number {
  let best = 0, bd = Infinity;
  pts.forEach(([px, pz], k) => {
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < bd) { bd = d; best = k; }
  });
  return best;
}

main().catch((e) => { console.error(e); process.exit(1); });
