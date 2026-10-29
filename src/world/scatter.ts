import * as THREE from 'three';
import type { Terrain } from './heightmap';
import { Rng } from '../core/rng';

const CELL = 64;
const RADIUS = 330;
const MAX = 5000;

interface Rock {
  m: THREE.Matrix4;
  c: THREE.Color;
}

/**
 * Boulders and rock outcrops near the climber: thick on the Khumbu moraine,
 * jutting from steep rock bands, the odd one poking through snow. Placed per
 * 64 m cell from a seeded random stream, so they're always in the same spots,
 * and kept off the trail.
 */
export class RockScatter {
  readonly mesh: THREE.InstancedMesh;
  private cells = new Map<string, Rock[]>();
  private visible = new Set<string>();
  private pending: [number, number][] = [];
  private dirty = false;

  constructor(private terrain: Terrain) {
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const p = geo.getAttribute('position');
    // Flatten and skew the base shape so instances read as broken rock, not dice.
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * 1.15, p.getY(i) * 0.7, p.getZ(i) * 0.9 + p.getY(i) * 0.2);
    geo.computeVertexNormals();
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), MAX);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  update(focus: THREE.Vector3) {
    const ci = Math.floor(focus.x / CELL), cj = Math.floor(focus.z / CELL);
    const r = Math.ceil(RADIUS / CELL);
    const want = new Set<string>();
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (Math.hypot((i + 0.5) * CELL - focus.x, (j + 0.5) * CELL - focus.z) > RADIUS) continue;
        const key = `${i},${j}`;
        want.add(key);
        if (!this.cells.has(key) && !this.pending.some(([a, b]) => a === i && b === j)) this.pending.push([i, j]);
      }
    }
    // Nearest cells first, a few milliseconds per frame.
    this.pending.sort((a, b) => Math.hypot(a[0] - ci, a[1] - cj) - Math.hypot(b[0] - ci, b[1] - cj));
    const t0 = performance.now();
    while (this.pending.length && performance.now() - t0 < 3) {
      const [i, j] = this.pending.shift()!;
      this.cells.set(`${i},${j}`, this.buildCell(i, j));
      this.dirty = true;
    }
    if (want.size !== this.visible.size || [...want].some((k) => !this.visible.has(k))) {
      this.visible = want;
      this.dirty = true;
    }
    if (this.dirty) this.rebuild();
  }

  private rebuild() {
    this.dirty = false;
    let k = 0;
    for (const key of this.visible) {
      for (const r of this.cells.get(key) ?? []) {
        if (k >= MAX) break;
        this.mesh.setMatrixAt(k, r.m);
        this.mesh.setColorAt(k, r.c);
        k++;
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // Drop cells far behind to bound memory.
    if (this.cells.size > 600) for (const key of this.cells.keys()) if (!this.visible.has(key)) this.cells.delete(key);
  }

  private buildCell(ci: number, cj: number): Rock[] {
    const t = this.terrain;
    const rng = new Rng(`rocks:${ci}:${cj}`);
    const out: Rock[] = [];
    const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), pos = new THREE.Vector3();
    for (let n = 0; n < 45; n++) {
      const x = (ci + rng.next()) * CELL, z = (cj + rng.next()) * CELL;
      if (!t.inBounds(x, z, 20)) continue;
      if (t.routeDistance(x, z) < 4) continue;
      const y = t.heightAt(x, z);
      const slope = t.slopeAt(x, z);
      let size: number;
      if (y < 5460 && slope < 35) {
        // Moraine: rubble and boulders.
        if (!rng.chance(0.75)) continue;
        size = rng.range(0.25, 1.3) * (rng.chance(0.08) ? 2.2 : 1);
      } else if (slope > 38) {
        // Rock bands and buttresses; the summit pyramid is mostly wind-packed snow.
        if (!rng.chance(y > 8450 ? 0.1 : 0.55)) continue;
        size = rng.range(0.6, y > 8450 ? 1.4 : 2.8);
      } else {
        // Snowfields: only the occasional rock breaks through.
        if (!rng.chance(y > 8450 ? 0.015 : 0.05)) continue;
        size = rng.range(0.3, 1.1);
      }
      e.set(rng.range(-0.4, 0.4), rng.range(0, Math.PI * 2), rng.range(-0.4, 0.4));
      q.setFromEuler(e);
      s.set(size * rng.range(0.8, 1.4), size * rng.range(0.6, 1.1), size * rng.range(0.8, 1.3));
      pos.set(x, y - size * 0.25, z);
      const c = new THREE.Color().setHSL(rng.range(0.06, 0.1), rng.range(0.05, 0.18), rng.range(0.2, 0.34));
      // The Yellow Band's limestone.
      if (y > 7400 && y < 7700) c.offsetHSL(0.02, 0.15, 0.1);
      out.push({ m: new THREE.Matrix4().compose(pos, q, s), c });
    }
    return out;
  }
}
