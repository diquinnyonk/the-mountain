import * as THREE from 'three';
import type { Route } from './route';
import type { RouteLayout } from './sections';
import { RIDGE_STRIP_HALF, RIDGE_STRIP_PAST, Terrain } from './heightmap';
import { terrainColor } from './terrainMesh';
import { Noise2 } from './noise';

const noise = new Noise2(29029);

/** Across-ridge sample offsets (m): fine at the crest, coarser down the faces. */
const LATS = [0, 0.45, 0.9, 1.4, 2, 2.8, 3.6, 4.5, 5.5, 6.7, 8, 9.5, 11, 13, 15, 17.5, 20, 23, 26, 30, 34, 39, 45, 51, 57, RIDGE_STRIP_HALF];

/**
 * The summit ridge from the Balcony up, drawn at about a metre's resolution so the
 * knife edge, the South Summit, the notch and the Hillary Step look exactly as solid
 * as they are to walk on. The regular terrain chunks (4 m and coarser) sink out of
 * sight beneath it.
 */
export function buildRidgeMesh(terrain: Terrain, route: Route, layout: RouteLayout, material: THREE.Material): THREE.Mesh {
  const lats = [...LATS.slice(1).reverse().map((l) => -l), ...LATS];
  const cols = lats.length;
  const s0 = Math.max(layout.landmarks.balcony.s - 80, route.length - Terrain.RIDGE_LENGTH);
  const end = route.length + RIDGE_STRIP_PAST;
  const rows: number[] = [];
  for (let s = s0; s < end; s += 1) rows.push(s);
  rows.push(end);
  const n = rows.length * cols;
  // Grid plus one skirt vertex per row on each long edge.
  const pos = new Float32Array((n + rows.length * 2) * 3);
  const nor = new Float32Array(pos.length);
  const col = new Float32Array(pos.length);
  const p = new THREE.Vector3(), t = new THREE.Vector3(), c = new THREE.Color();
  const lastT = route.tangentAt(route.length - 2).clone();
  const top = route.pointAt(route.length);
  const e = 0.4;
  let k = 0;
  const put = (x: number, z: number, y: number) => {
    const hx = terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z);
    const hz = terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e);
    const l = Math.hypot(hx, 2 * e, hz);
    pos.set([x, y, z], k * 3);
    nor.set([-hx / l, (2 * e) / l, -hz / l], k * 3);
    terrainColor(x, z, y, (2 * e) / l, terrain.routeDistance(x, z), c);
    // The Southwest Face (west) is dark rock with snow caught in patches; the Kangshung Face
    // (east) is bright fluted snow.
    const rc = terrain.ridgeCoords(x, z);
    if (rc && rc.lat < -2.5) {
      // Snow holds on the gentler ribs; the steeper rock between them shows through.
      const slope = Math.acos(Math.min(1, (2 * e) / l)) * 57.3;
      const patch = noise.fbm(x / 30, z / 30, 3) * 16;
      const rock = Math.min(1, Math.max(0, (-rc.lat - 2.5) / 8)) * Math.min(1, Math.max(0, (slope - 34 + patch) / 14));
      const tone = 0.19 + noise.noise(x / 3, z / 3) * 0.03;
      c.setRGB(c.r + (tone - c.r) * rock, c.g + (tone * 0.96 - c.g) * rock, c.b + (tone * 0.95 - c.b) * rock);
    } else if (rc && rc.lat > 2) {
      c.setRGB(Math.min(1, c.r * 1.05 + 0.02), Math.min(1, c.g * 1.05 + 0.02), Math.min(1, c.b * 1.04 + 0.03));
    }
    col.set([c.r, c.g, c.b], k * 3);
    k++;
  };
  for (const s of rows) {
    // Past the summit, carry on in the last direction so the far side falls away.
    if (s <= route.length) {
      route.pointAt(s, p);
      route.tangentAt(Math.min(s, route.length - 2), t);
    } else {
      t.copy(lastT);
      p.copy(top).addScaledVector(lastT, s - route.length);
    }
    // On the inside of a bend, narrow the strip so neighbouring cross-sections can't cross.
    let innerMax = Infinity, innerSign = 0;
    if (s > s0 + 12 && s < route.length - 12) {
      const a = route.tangentAt(s - 10), b2 = route.tangentAt(s + 10);
      const ang = Math.acos(Math.min(1, a.x * b2.x + a.z * b2.z));
      if (ang > 1e-3) {
        innerMax = 0.7 * (20 / ang);
        // Turning toward +lateral (right) puts the inside on the right.
        innerSign = a.x * b2.z - a.z * b2.x > 0 ? 1 : -1;
      }
    }
    for (const lat0 of lats) {
      const lat = Math.sign(lat0) === innerSign && Math.abs(lat0) > innerMax ? innerSign * innerMax : lat0;
      const x = p.x - t.z * lat, z = p.z + t.x * lat;
      put(x, z, terrain.heightAt(x, z));
    }
  }
  // Skirts down both long edges so no gap shows against the terrain beside it.
  const skirt0 = k;
  for (const side of [0, cols - 1]) {
    for (let r = 0; r < rows.length; r++) {
      const i = (r * cols + side) * 3;
      pos.set([pos[i], pos[i + 1] - 3, pos[i + 2]], k * 3);
      nor.set([nor[i], nor[i + 1], nor[i + 2]], k * 3);
      col.set([col[i], col[i + 1], col[i + 2]], k * 3);
      k++;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = r * cols + j, b = a + 1, c2 = a + cols, d = c2 + 1;
      idx.push(a, b, c2, b, d, c2);
    }
  }
  const R = rows.length;
  for (let r = 0; r < R - 1; r++) {
    const l0 = r * cols, l1 = (r + 1) * cols, s0i = skirt0 + r, s1i = skirt0 + r + 1;
    idx.push(l0, s0i, l1, l1, s0i, s1i);
    const g0 = r * cols + cols - 1, g1 = (r + 1) * cols + cols - 1, t0 = skirt0 + R + r, t1 = skirt0 + R + r + 1;
    idx.push(g0, g1, t0, g1, t1, t0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, k * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, k * 3), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/**
 * Wind-built cornices overhanging the Kangshung (east) face, from below the Hillary
 * Step to the summit: a smooth lip of snow that rises a little above the crest and
 * curls out over the drop. A heightfield can't overhang, so it's its own mesh, swept
 * along the route; it sits outside the walkable crest, so it's scenery only.
 */
export function buildCornice(terrain: Terrain, route: Route, layout: RouteLayout): THREE.Mesh {
  // Cross-section (lateral m, height m relative to the crest), from crest edge, up over the lip, curling under.
  const prof: [number, number][] = [[1.4, -0.3], [2.2, 0.55], [3.3, 1.5], [4.7, 2.1], [6.1, 1.9], [7.1, 1.1], [7.5, 0], [7.1, -1.2], [6.0, -2.3], [4.6, -3.1], [3.1, -3.8]];
  const s0 = layout.landmarks.hillaryStep.s - 40, s1 = route.length - 6;
  const rows: number[] = [];
  for (let s = s0; s <= s1; s += 1) rows.push(s);
  const P = prof.length;
  const pos = new Float32Array(rows.length * P * 3);
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  rows.forEach((s, r) => {
    route.pointAt(s, p);
    route.tangentAt(s, t);
    const crestY = p.y;
    // Size varies along the ridge and fades in and out at the ends.
    const u = (s - s0) / (s1 - s0);
    const k = Math.min(1, u * 8, (1 - u) * 6) * (0.75 + 0.45 * noise.fbm(s / 30, 4, 2) + 0.25 * Math.sin(s / 13));
    prof.forEach(([lat, dy], j) => {
      const L = 1.4 + (lat - 1.4) * k;
      const x = p.x - t.z * L, z = p.z + t.x * L;
      pos.set([x, crestY + dy * k - 0.02, z], (r * P + j) * 3);
    });
  });
  const idx: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let j = 0; j < P - 1; j++) {
      const a = r * P + j, b = a + 1, c = a + P, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xeef2f8, roughness: 0.85, side: THREE.DoubleSide }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  void terrain;
  return mesh;
}
