import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terrain } from '../src/world/heightmap';
import { Route } from '../src/world/route';
import { buildLayout } from '../src/world/sections';

const dir = new URL('../public/terrain/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('everest.json', dir), 'utf8'));
const bin = readFileSync(new URL('everest.bin', dir));
const routeData = JSON.parse(readFileSync(new URL('route.json', dir), 'utf8'));
const terrain = new Terrain(meta, new Uint16Array(bin.buffer, bin.byteOffset, bin.length / 2), routeData);
const route = new Route(terrain);
const layout = buildLayout(route);

describe('terrain and route', () => {
  it('decoded heights cover Base Camp to the summit', () => {
    expect(meta.maxHeight).toBe(8849);
    expect(meta.minHeight).toBeGreaterThan(4500);
  });

  it('route starts at Base Camp and ends on the summit', () => {
    expect(route.altitudeAt(0)).toBeCloseTo(5364, -1);
    expect(route.altitudeAt(route.length)).toBeGreaterThan(8820);
    expect(route.length).toBeGreaterThan(10000);
    expect(route.length).toBeLessThan(20000);
  });

  it('camps sit at their surveyed altitudes, in order', () => {
    const L = layout.landmarks;
    const order = ['bc', 'c1', 'c2', 'c3', 'c4', 'balcony', 'southSummit', 'summit'] as const;
    for (let i = 1; i < order.length; i++) expect(L[order[i]].s).toBeGreaterThan(L[order[i - 1]].s);
    expect(Math.abs(route.altitudeAt(L.c1.s) - 6065)).toBeLessThan(40);
    expect(Math.abs(route.altitudeAt(L.c2.s) - 6400)).toBeLessThan(40);
    expect(Math.abs(route.altitudeAt(L.c3.s) - 7160)).toBeLessThan(60);
    // South Col is a saddle around 7,900 m.
    expect(route.altitudeAt(L.c4.s)).toBeGreaterThan(7800);
    expect(route.altitudeAt(L.c4.s)).toBeLessThan(8000);
  });

  it('the upper route has no kinks or switchbacks', () => {
    for (let s = layout.landmarks.c4.s; s < route.length - 15; s += 5) {
      const a = route.tangentAt(s - 10), b = route.tangentAt(s + 10);
      const turn = Math.acos(Math.min(1, a.x * b.x + a.z * b.z));
      expect(20 / Math.max(1e-3, turn)).toBeGreaterThan(30);
    }
  });

  it('the summit ridge has the real profile: South Summit, notch, Hillary Step, knife edge', () => {
    const L = layout.landmarks;
    const ss = route.altitudeAt(L.southSummit.s);
    expect(ss).toBeGreaterThan(8740);
    expect(ss).toBeLessThan(8760);
    // The route dips after the South Summit before the traverse.
    let dip = Infinity;
    for (let s = L.southSummit.s; s < L.hillaryStep.s; s += 2) dip = Math.min(dip, route.altitudeAt(s));
    expect(dip).toBeLessThan(ss - 5);
    // The Hillary Step: much steeper than walking ground, so it needs the fixed rope.
    let steepest = 0;
    for (let s = L.hillaryStep.s - 15; s < L.hillaryStep.s + 15; s += 1) steepest = Math.max(steepest, route.gradeAt(s));
    expect(Math.atan(steepest) * 57.3).toBeGreaterThan(45);
    // A knife edge: the ground falls away on both sides of the crest.
    const p = route.pointAt(L.hillaryStep.s + 60), t = route.tangentAt(L.hillaryStep.s + 60);
    for (const side of [-1, 1]) {
      const x = p.x - t.z * 15 * side, z = p.z + t.x * 15 * side;
      expect(terrain.baseAt(x, z)).toBeLessThan(p.y - 10);
    }
    expect(route.altitudeAt(route.length)).toBeCloseTo(8849, -1);
  });

  it('the trail itself is free of procedural bumps', () => {
    const p = route.pointAt(3000);
    expect(Math.abs(terrain.detailAt(p.x, p.z))).toBeLessThan(0.05);
    expect(route.closest(p.x + 1, p.z).distance).toBeLessThan(2);
  });
});

describe('summit ridge mesh', () => {
  it('every index points at a real vertex (Safari refuses to draw the mesh otherwise)', async () => {
    const THREE = await import('three');
    const { buildRidgeMesh } = await import('../src/world/ridgeMesh');
    const mesh = buildRidgeMesh(terrain, route, layout, new THREE.MeshBasicMaterial());
    const count = mesh.geometry.getAttribute('position').count;
    const idx = mesh.geometry.getIndex()!.array;
    let max = 0;
    for (let i = 0; i < idx.length; i++) max = Math.max(max, idx[i]);
    expect(max).toBeLessThan(count);
    const pos = mesh.geometry.getAttribute('position').array as Float32Array;
    expect(pos.every((v) => Number.isFinite(v))).toBe(true);
  });
});
