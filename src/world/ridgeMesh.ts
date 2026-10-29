import * as THREE from 'three';
import type { Route } from './route';
import type { RouteLayout } from './sections';
import { RIDGE_STRIP_HALF, RIDGE_STRIP_PAST, Terrain } from './heightmap';
import { terrainColor } from './terrainMesh';

/** Across-ridge sample offsets (m): fine at the crest, coarser down the faces. */
const LATS = [0, 0.45, 0.9, 1.4, 2, 2.8, 3.8, 5, 6.5, 8.5, 11, 14, 18, 23, 29, RIDGE_STRIP_HALF];

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
  const pos = new Float32Array(n * 3 + cols * 2 * 3);
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
    for (const lat of lats) {
      const x = p.x - t.z * lat, z = p.z + t.x * lat;
      put(x, z, terrain.heightAt(x, z));
    }
  }
  // Skirts down both long edges so no gap shows against the terrain beside it.
  const skirt0 = k;
  for (const side of [0, cols - 1]) {
    for (let r = 0; r < rows.length; r++) {
      const i = (r * cols + side) * 3;
      if (k * 3 >= pos.length) break;
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
