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

  it('the trail itself is free of procedural bumps', () => {
    const p = route.pointAt(3000);
    expect(Math.abs(terrain.detailAt(p.x, p.z))).toBeLessThan(0.05);
    expect(route.closest(p.x + 1, p.z).distance).toBeLessThan(2);
  });
});
