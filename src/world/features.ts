import * as THREE from 'three';
import type { Route } from './route';
import type { RouteLayout } from './sections';
import { Rng } from '../core/rng';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const PRAYER_COLOURS = [0x2a5bd7, 0xf2f2f2, 0xd62828, 0x2a9d47, 0xf4c20d];
const TENT_COLOURS = [0xf4b400, 0xff7a1a, 0xd93025, 0x1a73e8, 0x34a853, 0xffd54f];

/**
 * Hand-placed detail the DEM can't show: the boot track, fixed ropes, ladders
 * over crevasses, Icefall seracs, camps, prayer flags, the Hillary Step.
 */
export class Features {
  readonly group = new THREE.Group();
  private ropeLines: { line: THREE.Line; s0: number; spacing: number; count: number }[] = [];
  private anchors: { mesh: THREE.InstancedMesh; ss: number[] }[] = [];
  readonly ladderMeshes: THREE.Object3D[] = [];
  private rng = new Rng('features');

  constructor(private route: Route, private layout: RouteLayout) {
    this.buildTrail();
    this.buildRopes();
    this.buildCrevassesAndLadders();
    this.buildSeracs();
    this.buildCamps();
    this.buildHillaryStep();
    this.buildSummit();
  }

  /** Fixed ropes are only visible (and clippable) where the rope fixers have reached. */
  setRopesFixedTo(s: number) {
    for (const r of this.ropeLines) {
      const n = Math.max(0, Math.min(r.count, Math.floor((s - r.s0) / r.spacing)));
      r.line.geometry.setDrawRange(0, n);
      r.line.visible = n > 1;
    }
    for (const a of this.anchors) {
      let n = 0;
      while (n < a.ss.length && a.ss[n] <= s) n++;
      a.mesh.count = n;
    }
  }

  private ground(x: number, z: number) {
    return this.route.terrain.heightAt(x, z);
  }

  private buildTrail() {
    const step = 2, half = 0.55;
    const n = Math.floor(this.route.length / step);
    const pos = new Float32Array((n + 1) * 2 * 3);
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    for (let k = 0; k <= n; k++) {
      const s = k * step;
      this.route.pointAt(s, p);
      this.route.tangentAt(s, t);
      const nx = -t.z, nz = t.x;
      for (let side = 0; side < 2; side++) {
        const o = side ? half : -half;
        const x = p.x + nx * o, z = p.z + nz * o;
        const i = (k * 2 + side) * 3;
        pos[i] = x; pos[i + 1] = this.ground(x, z) + 0.05; pos[i + 2] = z;
      }
    }
    const idx: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc9cdd4, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildRopes() {
    const colours = [0xd62828, 0x1a73e8];
    this.layout.ropes.forEach((span, ri) => {
      const spacing = 1.5;
      const count = Math.floor((span.s1 - span.s0) / spacing);
      const pos = new Float32Array(count * 3);
      const p = new THREE.Vector3(), t = new THREE.Vector3();
      const anchorEvery = 40;
      for (let k = 0; k < count; k++) {
        const s = span.s0 + k * spacing;
        this.route.pointAt(s, p);
        this.route.tangentAt(s, t);
        const x = p.x - t.z * 0.7, z = p.z + t.x * 0.7;
        const u = ((s - span.s0) % anchorEvery) / anchorEvery;
        const sag = Math.sin(u * Math.PI) * 0.45;
        pos[k * 3] = x; pos[k * 3 + 1] = this.ground(x, z) + 0.95 - sag; pos[k * 3 + 2] = z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: colours[ri % colours.length] }));
      line.frustumCulled = false;
      this.group.add(line);
      this.ropeLines.push({ line, s0: span.s0, spacing, count });

      const ss: number[] = [];
      for (let s = span.s0; s < span.s1; s += anchorEvery) ss.push(s);
      const stake = new THREE.CylinderGeometry(0.03, 0.03, 1.1, 5);
      stake.translate(0, 0.45, 0);
      const mesh = new THREE.InstancedMesh(stake, new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.6, roughness: 0.4 }), ss.length);
      const m = new THREE.Matrix4();
      ss.forEach((s, k) => {
        this.route.pointAt(s, p);
        this.route.tangentAt(s, t);
        const x = p.x - t.z * 0.7, z = p.z + t.x * 0.7;
        m.makeTranslation(x, this.ground(x, z), z);
        mesh.setMatrixAt(k, m);
      });
      this.group.add(mesh);
      this.anchors.push({ mesh, ss });
    });
  }

  /** A crevasse as a dark slot following the ground with icy lips, across the route at s. */
  private crevasse(cx: number, cz: number, dirX: number, dirZ: number, length: number, width: number) {
    const segs = Math.max(4, Math.round(length / 3));
    const nx = -dirZ, nz = dirX; // across the slot
    const pos: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k <= segs; k++) {
      const u = (k / segs - 0.5) * length;
      const taper = Math.sin((k / segs) * Math.PI) ** 0.5;
      for (const side of [-1, 1]) {
        const w = (width / 2) * taper * side;
        const x = cx + dirX * u + nx * w, z = cz + dirZ * u + nz * w;
        pos.push(x, this.ground(x, z) + 0.1, z);
      }
      if (k < segs) {
        const a = k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x0b1a2e, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    }));
    this.group.add(mesh);
  }

  private buildCrevassesAndLadders() {
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    const rail = new THREE.BoxGeometry(0.05, 0.05, 1);
    const rung = new THREE.CylinderGeometry(0.015, 0.015, 0.45, 5);
    rung.rotateZ(Math.PI / 2);
    const metal = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.8, roughness: 0.35 });
    for (const lad of this.layout.ladders) {
      this.route.pointAt(lad.s, p);
      this.route.tangentAt(lad.s, t);
      // Crevasse runs across the route.
      const cos = Math.cos(lad.skew), sin = Math.sin(lad.skew);
      const ax = -t.z * cos - t.x * sin, az = t.x * cos - t.z * sin;
      this.crevasse(p.x, p.z, ax, az, 34 + lad.span * 4, lad.span);
      const len = lad.span + 1.6;
      const g = new THREE.Group();
      // Rails and rungs merged into one mesh per ladder.
      const parts: THREE.BufferGeometry[] = [];
      for (const side of [-0.22, 0.22]) parts.push(rail.clone().scale(1, 1, len).translate(side, 0, 0));
      for (let k = 0; k <= Math.floor(len / 0.3); k++) parts.push(rung.clone().translate(0, 0, -len / 2 + k * 0.3));
      g.add(new THREE.Mesh(mergeGeometries(parts), metal));
      // Handlines either side, the ones you clip into.
      const lines: THREE.Vector3[] = [];
      for (const side of [-0.6, 0.6]) {
        lines.push(new THREE.Vector3(side, 1.0, -len / 2 - 1), new THREE.Vector3(side, 0.85, 0));
        lines.push(new THREE.Vector3(side, 0.85, 0), new THREE.Vector3(side, 1.0, len / 2 + 1));
      }
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lines), new THREE.LineBasicMaterial({ color: 0xf4c20d })));
      const y0 = this.route.altitudeAt(lad.s - len / 2), y1 = this.route.altitudeAt(lad.s + len / 2);
      g.position.set(p.x, Math.max(y0, y1, p.y) + 0.12, p.z);
      g.rotation.y = Math.atan2(t.x, t.z);
      g.rotateX(-Math.atan2(y1 - y0, len) * 0.5);
      g.traverse((o) => (o.castShadow = true));
      this.group.add(g);
      this.ladderMeshes.push(g);
    }
    // Open crevasses scattered across the Western Cwm, away from the trail.
    const cwm = this.layout.hiddenCrevasseZone;
    for (let s = cwm.s0 + 100; s < cwm.s1; s += 45) {
      this.route.pointAt(s, p);
      this.route.tangentAt(s, t);
      for (let k = 0; k < 2; k++) {
        const lat = (this.rng.chance(0.5) ? 1 : -1) * this.rng.range(35, 260);
        const x = p.x - t.z * lat, z = p.z + t.x * lat;
        const a = this.rng.range(-0.4, 0.4);
        this.crevasse(x, z, -t.z * Math.cos(a) - t.x * Math.sin(a), t.x * Math.cos(a) - t.z * Math.sin(a),
          this.rng.range(25, 80), this.rng.range(1.5, 5));
      }
    }
  }

  private buildSeracs() {
    const L = this.layout.landmarks;
    const geo = new THREE.IcosahedronGeometry(1, 0);
    // Squash and shear the base shape so instances read as broken ice blocks.
    const pa = geo.getAttribute('position');
    for (let i = 0; i < pa.count; i++) {
      pa.setXYZ(i, pa.getX(i) * 1.1, pa.getY(i) * 0.8 + 0.4, pa.getZ(i) * 0.9 + pa.getY(i) * 0.25);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xdceefa, roughness: 0.35, metalness: 0, flatShading: true });
    const placements: THREE.Matrix4[] = [];
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    const q = new THREE.Quaternion(), sc = new THREE.Vector3(), e = new THREE.Euler();
    for (let s = L.bc.s + 220; s < L.c1.s - 20; s += 5) {
      this.route.pointAt(s, p);
      this.route.tangentAt(s, t);
      const n = this.rng.int(1, 4);
      for (let k = 0; k < n; k++) {
        const size = this.rng.range(2, 12);
        const side = this.rng.chance(0.5) ? 1 : -1;
        const lat = side * (3 + size * 0.9 + this.rng.range(0, 90) * this.rng.next());
        const x = p.x - t.z * lat + t.x * this.rng.range(-2, 2);
        const z = p.z + t.x * lat + t.z * this.rng.range(-2, 2);
        e.set(this.rng.range(-0.3, 0.3), this.rng.range(0, Math.PI * 2), this.rng.range(-0.3, 0.3));
        q.setFromEuler(e);
        sc.set(size * this.rng.range(0.6, 1.3), size * this.rng.range(0.6, 1.6), size * this.rng.range(0.6, 1.3));
        placements.push(new THREE.Matrix4().compose(new THREE.Vector3(x, this.ground(x, z) - size * 0.35, z), q, sc));
      }
    }
    const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
    placements.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildCamps() {
    const dome = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    dome.scale(1.3, 1.15, 1.7);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const counts: Record<string, [number, number, number]> = {
      // tents, spread along route (m), spread across (m)
      bc: [70, 260, 140], c1: [16, 70, 45], c2: [34, 140, 70], c3: [10, 50, 10], c4: [26, 90, 80],
    };
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const placements: { m: THREE.Matrix4; c: number }[] = [];
    for (const camp of this.layout.camps) {
      const [n, along, across] = counts[camp.id] ?? [10, 50, 30];
      for (let k = 0; k < n; k++) {
        const s = Math.max(0, camp.s + this.rng.range(-along * 0.3, along * 0.7));
        this.route.pointAt(s, p);
        this.route.tangentAt(s, t);
        const lat = (this.rng.chance(0.5) ? 1 : -1) * this.rng.range(4, across);
        const x = p.x - t.z * lat, z = p.z + t.x * lat;
        q.setFromAxisAngle(up, this.rng.range(0, Math.PI * 2));
        m.compose(new THREE.Vector3(x, this.ground(x, z) - 0.1, z), q, new THREE.Vector3(1, 1, 1));
        placements.push({ m: m.clone(), c: this.rng.pick(TENT_COLOURS) });
      }
    }
    const tents = new THREE.InstancedMesh(dome, mat, placements.length);
    const col = new THREE.Color();
    placements.forEach((pl, i) => {
      tents.setMatrixAt(i, pl.m);
      tents.setColorAt(i, col.setHex(pl.c));
    });
    tents.castShadow = true;
    tents.receiveShadow = true;
    this.group.add(tents);

    // Base Camp puja chorten with prayer flag lines radiating from it.
    const bc = this.layout.landmarks.bc;
    this.route.pointAt(bc.s + 40, p);
    this.route.tangentAt(bc.s + 40, t);
    const cx = p.x - t.z * 18, cz = p.z + t.x * 18, cy = this.ground(cx, cz);
    const chorten = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.6, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x8c8378, roughness: 1 }));
    chorten.position.set(cx, cy + 1.1, cz);
    chorten.castShadow = true;
    this.group.add(chorten);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6), new THREE.MeshStandardMaterial({ color: 0x6b4f2a }));
    pole.position.set(cx, cy + 3, cz);
    this.group.add(pole);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const ex = cx + Math.cos(a) * 28, ez = cz + Math.sin(a) * 28;
      this.prayerFlags(new THREE.Vector3(cx, cy + 5.8, cz), new THREE.Vector3(ex, this.ground(ex, ez) + 0.5, ez));
    }
    // Camp 2 and the South Col get a couple of strings too.
    for (const id of ['c2', 'c4'] as const) {
      this.route.pointAt(this.layout.landmarks[id].s + 10, p);
      const a = new THREE.Vector3(p.x + 6, this.ground(p.x + 6, p.z + 3) + 1.5, p.z + 3);
      const b = new THREE.Vector3(p.x - 14, this.ground(p.x - 14, p.z - 6) + 0.6, p.z - 6);
      this.prayerFlags(a, b);
    }
  }

  private prayerFlags(a: THREE.Vector3, b: THREE.Vector3) {
    const len = a.distanceTo(b);
    const n = Math.floor(len / 0.45);
    const geo = new THREE.PlaneGeometry(0.28, 0.3);
    geo.translate(0, -0.15, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 1 }), n);
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), col = new THREE.Color();
    const yaw = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      p.lerpVectors(a, b, u);
      p.y -= Math.sin(u * Math.PI) * len * 0.06;
      m.compose(p, q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, col.setHex(PRAYER_COLOURS[k % PRAYER_COLOURS.length]));
    }
    this.group.add(mesh);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0x555555 }));
    this.group.add(line);
  }

  private buildHillaryStep() {
    // The step itself is sculpted into the terrain; this is its rock: blocks along the
    // Southwest Face (west) side of the crest, and a few loose ones below.
    const hs = this.layout.landmarks.hillaryStep;
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    const rock = new THREE.MeshStandardMaterial({ color: 0x35322f, roughness: 0.95, flatShading: true });
    const geo = new THREE.DodecahedronGeometry(1, 0);
    for (let k = 0; k < 14; k++) {
      const s = hs.s + this.rng.range(-14, 6);
      this.route.pointAt(s, p);
      this.route.tangentAt(s, t);
      const size = this.rng.range(0.6, 2.2);
      const lat = -(1.6 + size * 0.7 + this.rng.range(0, 3)); // west of the crest
      const x = p.x - t.z * lat, z = p.z + t.x * lat;
      const r = new THREE.Mesh(geo, rock);
      r.scale.set(size, size * this.rng.range(1, 2.2), size);
      r.position.set(x, this.ground(x, z) + size * 0.4, z);
      r.rotation.set(this.rng.next(), this.rng.next() * 6, this.rng.next());
      r.castShadow = true;
      this.group.add(r);
    }
  }

  /**
   * The top: snow cornices overhanging the Kangshung Face along the traverse, years of
   * old fixed ropes on the final ridge, and the summit itself buried in prayer flags.
   */
  private buildSummit() {
    const L = this.layout.landmarks;
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), col = new THREE.Color();

    // Cornices along the Cornice Traverse: wind-built snow lips overhanging the Kangshung Face.
    const blobs: THREE.Matrix4[] = [];
    for (let s = L.southSummit.s + 15; s < L.hillaryStep.s - 12; s += this.rng.range(1.2, 2.4)) {
      this.route.pointAt(s, p);
      this.route.tangentAt(s, t);
      const lat = this.rng.range(1.3, 2.1);
      const x = p.x - t.z * lat, z = p.z + t.x * lat;
      e.set(this.rng.range(-0.15, 0.15), Math.atan2(t.x, t.z) + this.rng.range(-0.3, 0.3), this.rng.range(0.2, 0.45));
      q.setFromEuler(e);
      sc.set(this.rng.range(0.6, 1.2), this.rng.range(0.22, 0.45), this.rng.range(0.9, 1.8));
      blobs.push(new THREE.Matrix4().compose(new THREE.Vector3(x, p.y - this.rng.range(0.35, 0.6), z), q, sc));
    }
    const snow = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshStandardMaterial({ color: 0xe9eef5, roughness: 0.9 }), blobs.length);
    blobs.forEach((b, i) => snow.setMatrixAt(i, b));
    snow.castShadow = true;
    snow.receiveShadow = true;
    this.group.add(snow);

    // Old fixed ropes from previous seasons alongside this year's, up the last stretch.
    const ropeCols = [0xf4c20d, 0xd62828, 0x2a9d47, 0x1a73e8];
    ropeCols.forEach((c, i) => {
      const off = [-0.35, 0.25, -0.6, 0.45][i];
      const pts: THREE.Vector3[] = [];
      for (let s = L.southSummit.s + 10 + i * 15; s <= this.route.length - 1; s += 1.5) {
        this.route.pointAt(s, p);
        this.route.tangentAt(s, t);
        const wob = Math.sin(s * 0.13 + i) * 0.25;
        const x = p.x - t.z * (off + wob), z = p.z + t.x * (off + wob);
        pts.push(new THREE.Vector3(x, this.ground(x, z) + 0.04, z));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: c }));
      this.group.add(line);
    });

    // The summit: a few square metres of snow under heaps of prayer flags, katas and junk.
    const top = this.route.pointAt(this.route.length);
    const flagGeo = new THREE.PlaneGeometry(0.32, 0.26).rotateX(-Math.PI / 2);
    const lying = 420;
    const flags = new THREE.InstancedMesh(flagGeo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 1 }), lying);
    for (let k = 0; k < lying; k++) {
      // Dense on the very top, thinning down the slopes around it.
      const a = this.rng.range(0, Math.PI * 2), r = Math.pow(this.rng.next(), 1.7) * 6.5;
      const x = top.x + Math.cos(a) * r, z = top.z + Math.sin(a) * r;
      e.set(this.rng.range(-0.5, 0.5), this.rng.range(0, Math.PI * 2), this.rng.range(-0.5, 0.5));
      q.setFromEuler(e);
      const heap = r < 1.6 ? this.rng.range(0, 0.45) : this.rng.range(0, 0.08);
      m.compose(new THREE.Vector3(x, this.ground(x, z) + 0.03 + heap, z), q, sc.set(1, 1, 1));
      flags.setMatrixAt(k, m);
      flags.setColorAt(k, col.setHex(this.rng.chance(0.12) ? 0xf5f0e6 : PRAYER_COLOURS[k % PRAYER_COLOURS.length]));
    }
    flags.receiveShadow = true;
    this.group.add(flags);
    // Poles carrying flag strings that drape away down the slopes.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      const x = top.x + Math.cos(a) * 0.9, z = top.z + Math.sin(a) * 0.9;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.4, 5), poleMat);
      pole.position.set(x, this.ground(x, z) + 0.6, z);
      pole.rotation.set(this.rng.range(-0.2, 0.2), 0, this.rng.range(-0.2, 0.2));
      this.group.add(pole);
    }
    for (let k = 0; k < 7; k++) {
      const a = this.rng.range(0, Math.PI * 2), len = this.rng.range(6, 14);
      const ax = top.x + Math.cos(a) * 0.5, az = top.z + Math.sin(a) * 0.5;
      const bx = top.x + Math.cos(a) * len, bz = top.z + Math.sin(a) * len;
      this.prayerFlags(new THREE.Vector3(ax, this.ground(ax, az) + 0.9, az), new THREE.Vector3(bx, this.ground(bx, bz) + 0.1, bz));
    }
  }
}
