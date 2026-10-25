import * as THREE from 'three';
import type { Terrain } from './heightmap';
import { Noise2 } from './noise';
import { smoothstep, clamp } from '../core/mathx';

const CHUNK_PX = 64;
/** LOD sample spacing in DEM pixels and the camera distance (m) below which it is used. */
const LODS: { step: number; maxDist: number }[] = [
  { step: 0.5, maxDist: 650 },
  { step: 1, maxDist: 1600 },
  { step: 2, maxDist: 3800 },
  { step: 4, maxDist: 8000 },
  { step: 8, maxDist: Infinity },
];

interface Chunk {
  ci: number;
  cj: number;
  centre: THREE.Vector3;
  lod: number;
  mesh?: THREE.Mesh;
  pending?: number;
}

const colorNoise = new Noise2(77);

/** Surface colour from altitude, slope and a little noise: moraine, rock, the Yellow Band, ice and snow. */
export function terrainColor(x: number, z: number, y: number, ny: number, routeDist: number, out: THREE.Color) {
  const slope = (Math.acos(clamp(ny, -1, 1)) * 180) / Math.PI;
  const n = colorNoise.fbm(x / 120, z / 120, 3);
  const n2 = colorNoise.noise(x / 17, z / 17);
  // Rock
  let r = 0.3 + n2 * 0.03, g = 0.28 + n2 * 0.03, b = 0.27 + n2 * 0.03;
  const yellow = smoothstep(7380, 7450, y) * (1 - smoothstep(7650, 7720, y));
  r += yellow * 0.22; g += yellow * 0.15; b += yellow * 0.02;
  const moraine = 1 - smoothstep(5330, 5480, y);
  r += moraine * 0.1; g += moraine * 0.09; b += moraine * 0.08;
  // Snow holds on gentler slopes; the snow line is ragged.
  const snowLine = smoothstep(5250, 5550, y + n * 160);
  const hold = smoothstep(52 + n * 8, 36 + n * 8, slope);
  const snow = clamp(snowLine * hold + (y > 7000 ? 0.15 * hold : 0), 0, 1);
  // Glacier ice in the Icefall and on the Lhotse Face shows blue through thin snow.
  const iceBand = smoothstep(5400, 5480, y) * (1 - smoothstep(5980, 6080, y)) * (1 - smoothstep(150, 450, routeDist));
  const lhotse = smoothstep(6550, 6650, y) * (1 - smoothstep(7300, 7400, y)) * smoothstep(25, 35, slope) * (1 - smoothstep(300, 700, routeDist));
  const ice = clamp(Math.max(iceBand * (0.55 + 0.45 * n2), lhotse * 0.7), 0, 1);
  const sr = 0.92 - ice * 0.2 + n * 0.02, sg = 0.94 - ice * 0.08 + n * 0.02, sb = 0.97 + n * 0.01;
  out.setRGB(r + (sr - r) * snow, g + (sg - g) * snow, b + (sb - b) * snow);
  return out;
}

/**
 * Renders the baked heightmap as a grid of chunks whose resolution follows the
 * camera, so the whole of the Everest massif is always drawn while the slope under
 * the climber gets full detail. A low-resolution backdrop covers the wider range.
 */
export class TerrainMesh {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private chunks: Chunk[] = [];
  private queue: Chunk[] = [];

  constructor(private terrain: Terrain, private lodScale = 1) {
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, shadowSide: THREE.FrontSide });
    const nx = Math.ceil(terrain.width / CHUNK_PX), nz = Math.ceil(terrain.height / CHUNK_PX);
    for (let cj = 0; cj < nz; cj++) {
      for (let ci = 0; ci < nx; ci++) {
        const cx = ((ci + 0.5) * CHUNK_PX) * terrain.mpp - terrain.halfW;
        const cz = ((cj + 0.5) * CHUNK_PX) * terrain.mpp - terrain.halfH;
        this.chunks.push({ ci, cj, centre: new THREE.Vector3(cx, terrain.demAt(cx, cz), cz), lod: -1 });
      }
    }
    if (terrain.far) this.group.add(this.buildFar());
  }

  /** Synchronously build every chunk at a coarse LOD so something is on screen at once. */
  buildAll(camera: THREE.Vector3) {
    for (const c of this.chunks) this.setLod(c, Math.max(this.desiredLod(c, camera), 2));
    this.update(camera, 1000);
  }

  update(camera: THREE.Vector3, budgetMs = 6) {
    for (const c of this.chunks) {
      const want = this.desiredLod(c, camera);
      if (want !== c.lod && c.pending !== want) {
        c.pending = want;
        if (!this.queue.includes(c)) this.queue.push(c);
      }
    }
    // Nearest first.
    this.queue.sort((a, b) => a.centre.distanceToSquared(camera) - b.centre.distanceToSquared(camera));
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const c = this.queue.shift()!;
      if (c.pending !== undefined) this.setLod(c, c.pending);
      c.pending = undefined;
    }
  }

  private desiredLod(c: Chunk, cam: THREE.Vector3): number {
    const half = (CHUNK_PX * this.terrain.mpp) / 2;
    const dx = Math.max(0, Math.abs(cam.x - c.centre.x) - half);
    const dz = Math.max(0, Math.abs(cam.z - c.centre.z) - half);
    const d = Math.hypot(dx, dz, (cam.y - c.centre.y) * 0.5) / this.lodScale;
    return LODS.findIndex((l) => d < l.maxDist);
  }

  private setLod(c: Chunk, lod: number) {
    const geo = this.buildChunk(c.ci, c.cj, LODS[lod].step);
    if (c.mesh) {
      c.mesh.geometry.dispose();
      c.mesh.geometry = geo;
    } else {
      c.mesh = new THREE.Mesh(geo, this.material);
      c.mesh.receiveShadow = true;
      c.mesh.matrixAutoUpdate = false;
      this.group.add(c.mesh);
    }
    c.mesh.castShadow = lod === 0;
    c.lod = lod;
  }

  private buildChunk(ci: number, cj: number, step: number): THREE.BufferGeometry {
    const t = this.terrain;
    const mpp = t.mpp;
    const n = Math.round(CHUNK_PX / step) + 1;
    const x0 = ci * CHUNK_PX * mpp - t.halfW;
    const z0 = cj * CHUNK_PX * mpp - t.halfH;
    const d = step * mpp;
    const detailed = step <= 1;
    const h = (x: number, z: number) => (detailed ? t.heightAt(x, z) : t.demAt(x, z));
    // Grid plus a one-vertex skirt ring hanging below the edges to hide LOD cracks.
    const total = n * n + 4 * n;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const color = new THREE.Color();
    const e = Math.max(1.5, d * 0.5);
    let k = 0;
    const put = (x: number, z: number, y: number, nx: number, ny: number, nz: number) => {
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
      terrainColor(x, z, y, ny, t.routeDistance(x, z), color);
      col[k * 3] = color.r; col[k * 3 + 1] = color.g; col[k * 3 + 2] = color.b;
      k++;
    };
    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * d, z = z0 + j * d;
        const y = h(x, z);
        heights[j * n + i] = y;
        const hx = h(x + e, z) - h(x - e, z);
        const hz = h(x, z + e) - h(x, z - e);
        const l = Math.hypot(hx, 2 * e, hz);
        put(x, z, y, -hx / l, (2 * e) / l, -hz / l);
      }
    }
    const drop = 6 + d * 2;
    const edge = (i: number, j: number) => {
      const s = (j * n + i) * 3;
      put(pos[s], pos[s + 2], heights[j * n + i] - drop, nor[s], nor[s + 1], nor[s + 2]);
    };
    const sk0 = n * n;
    for (let i = 0; i < n; i++) edge(i, 0);
    for (let i = 0; i < n; i++) edge(i, n - 1);
    for (let j = 0; j < n; j++) edge(0, j);
    for (let j = 0; j < n; j++) edge(n - 1, j);

    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, dd = c + 1;
        idx.push(a, c, b, b, c, dd);
      }
    }
    // Skirts: top edge, bottom edge, left edge, right edge.
    for (let i = 0; i < n - 1; i++) {
      const a = i, b = i + 1, sa = sk0 + i, sb = sk0 + i + 1;
      idx.push(a, b, sa, b, sb, sa);
      const c = (n - 1) * n + i, dd = c + 1, sc = sk0 + n + i, sd = sk0 + n + i + 1;
      idx.push(c, sc, dd, dd, sc, sd);
    }
    for (let j = 0; j < n - 1; j++) {
      const a = j * n, b = (j + 1) * n, sa = sk0 + 2 * n + j, sb = sk0 + 2 * n + j + 1;
      idx.push(a, sa, b, b, sa, sb);
      const c = j * n + n - 1, dd = (j + 1) * n + n - 1, sc = sk0 + 3 * n + j, sd = sk0 + 3 * n + j + 1;
      idx.push(c, dd, sc, dd, sd, sc);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(total > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /** The wider range at ~135 m resolution; dropped well below ground inside the detail map. */
  private buildFar(): THREE.Mesh {
    const t = this.terrain;
    const m = t.far!.meta;
    const step = 2;
    const w = Math.floor((m.width - 1) / step) + 1, hgt = Math.floor((m.height - 1) / step) + 1;
    const pos = new Float32Array(w * hgt * 3);
    const col = new Float32Array(w * hgt * 3);
    const color = new THREE.Color();
    const R = 6_371_000;
    for (let j = 0; j < hgt; j++) {
      for (let i = 0; i < w; i++) {
        const x = m.originX + i * step * m.metresPerPixel;
        const z = m.originZ + j * step * m.metresPerPixel;
        let y = t.far!.data[j * step * m.width + i * step];
        if (t.inBounds(x, z, -m.metresPerPixel)) y -= 120;
        // Earth curvature (with standard refraction) so distant peaks sit realistically low.
        y -= ((x * x + z * z) / (2 * R)) * 0.87;
        const k = (j * w + i) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < hgt - 1; j++) {
      for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let k = 0; k < w * hgt; k++) {
      terrainColor(pos[k * 3], pos[k * 3 + 2], pos[k * 3 + 1], nor.getY(k), 1e6, color);
      col[k * 3] = color.r; col[k * 3 + 1] = color.g; col[k * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = false;
    return mesh;
  }
}
