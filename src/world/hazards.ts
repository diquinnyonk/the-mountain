import * as THREE from 'three';
import type { Route } from './route';
import type { RouteLayout } from './sections';
import { inSpan } from './sections';
import { Rng } from '../core/rng';
import { smoothstep } from '../core/mathx';
import type { WeatherSample } from '../weather/model';

export interface HazardEvent {
  kind: 'serac' | 'avalanche';
  /** Route position of the impact. */
  s: number;
  lateral: number;
  radius: number;
  /** Real seconds until impact. */
  warning: number;
  resolved: boolean;
  /** Real seconds since the event started. */
  age: number;
}

export interface HazardTarget {
  s: number;
  lateral: number;
  kill(cause: 'serac' | 'avalanche' | 'crevasse', detail: string): void;
}

/**
 * Objective dangers: serac fall in the Icefall (worse in the afternoon warmth),
 * avalanches on loaded slopes after snowfall, and hidden crevasses off the trail
 * in the Western Cwm. Seeded per expedition date.
 */
export class Hazards {
  readonly group = new THREE.Group();
  active: HazardEvent[] = [];
  /** Fresh snow load on avalanche slopes (cm). */
  snowLoad = 0;
  private rng: Rng;
  private debris: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  private clouds: { pts: THREE.Points; life: number; vel: THREE.Vector3 }[] = [];
  private iceGeo = new THREE.IcosahedronGeometry(1, 0);
  private iceMat = new THREE.MeshStandardMaterial({ color: 0xe3f2fd, flatShading: true, roughness: 0.4 });
  private crevasseDistance = 0;
  onEvent?: (e: HazardEvent, phase: 'warn' | 'impact') => void;

  constructor(private route: Route, private layout: RouteLayout, seed: string) {
    this.rng = new Rng('hazards:' + seed);
  }

  /** Weather loading of avalanche slopes; call with game dt. */
  updateSnow(dtGame: number, w: WeatherSample) {
    const h = dtGame / 3600;
    this.snowLoad = Math.max(0, this.snowLoad + w.snowfallCmH * h - this.snowLoad * 0.015 * h);
  }

  /**
   * Roll for new events near the player. dtGame in game seconds; localHour for
   * diurnal warming of the Icefall.
   */
  roll(dtGame: number, s: number, localHour: number, tempC: number) {
    const h = dtGame / 3600;
    if (this.active.some((e) => !e.resolved)) return;
    if (inSpan(this.layout.seracZone, s)) {
      const warmth = smoothstep(8, 14, localHour) * (1 - smoothstep(17, 21, localHour));
      const rate = 0.05 + 0.35 * warmth + Math.max(0, tempC + 5) * 0.02;
      if (this.rng.next() < rate * h) this.spawn('serac', s + this.rng.range(-10, 35), this.rng.range(-12, 12), 16, 4.5);
    }
    for (const z of this.layout.avalancheZones) {
      if (!inSpan(z, s)) continue;
      const rate = 0.004 + 0.06 * smoothstep(8, 50, this.snowLoad);
      if (this.rng.next() < rate * h) this.spawn('avalanche', s + this.rng.range(-20, 60), this.rng.range(-30, 30), 45, 7);
    }
  }

  /**
   * Hidden crevasses: chance per metre walked off the trail in the Western Cwm.
   * Returns true if the target fell in.
   */
  checkCrevasse(target: HazardTarget, metresMoved: number, routeDistance: number): boolean {
    if (!inSpan(this.layout.hiddenCrevasseZone, target.s) || routeDistance < 18) {
      this.crevasseDistance = 0;
      return false;
    }
    this.crevasseDistance += metresMoved;
    while (this.crevasseDistance > 10) {
      this.crevasseDistance -= 10;
      const p = 0.012 * (routeDistance > 60 ? 2 : 1) * (1 + this.snowLoad / 30);
      if (this.rng.next() < p) {
        target.kill('crevasse', 'Off the trail in the Western Cwm, a snow bridge gave way under you. The crevasse beneath was 40 metres deep.');
        return true;
      }
    }
    return false;
  }

  spawn(kind: HazardEvent['kind'], s: number, lateral: number, radius: number, warning: number) {
    const e: HazardEvent = { kind, s: Math.max(0, Math.min(this.route.length, s)), lateral, radius, warning, resolved: false, age: 0 };
    this.active.push(e);
    this.onEvent?.(e, 'warn');
    if (kind === 'serac') this.launchIce(e);
    else this.launchSlide(e);
  }

  /** Advance effects in real time; resolve impacts against the targets. */
  update(dtReal: number, targets: HazardTarget[]) {
    for (const e of this.active) {
      e.age += dtReal;
      if (!e.resolved && e.age >= e.warning) {
        e.resolved = true;
        this.onEvent?.(e, 'impact');
        for (const t of targets) {
          const d = Math.hypot(t.s - e.s, (t.lateral - e.lateral) * (e.kind === 'avalanche' ? 0.4 : 1));
          if (d < e.radius) {
            t.kill(e.kind, e.kind === 'serac'
              ? 'A serac the size of a house collapsed onto the route in the Khumbu Icefall.'
              : 'A slab of fresh snow released above you. The avalanche swept you down the slope and buried you.');
          }
        }
      }
    }
    this.active = this.active.filter((e) => e.age < e.warning + 8);
    for (const d of this.debris) {
      d.vel.y -= 9.81 * dtReal;
      d.mesh.position.addScaledVector(d.vel, dtReal);
      d.mesh.rotation.x += dtReal * 2;
      const g = this.route.terrain.heightAt(d.mesh.position.x, d.mesh.position.z);
      if (d.mesh.position.y < g) {
        d.mesh.position.y = g;
        d.vel.multiplyScalar(0.3);
        d.vel.y = Math.abs(d.vel.y) * 0.2;
      }
      d.life -= dtReal;
      if (d.life <= 0) this.group.remove(d.mesh);
    }
    this.debris = this.debris.filter((d) => d.life > 0);
    for (const c of this.clouds) {
      c.pts.position.addScaledVector(c.vel, dtReal);
      c.pts.scale.multiplyScalar(1 + dtReal * 0.25);
      const m = c.pts.material as THREE.PointsMaterial;
      c.life -= dtReal;
      m.opacity = Math.max(0, Math.min(0.85, c.life / 4));
      if (c.life <= 0) {
        this.group.remove(c.pts);
        c.pts.geometry.dispose();
      }
    }
    this.clouds = this.clouds.filter((c) => c.life > 0);
  }

  private impactPoint(e: HazardEvent) {
    return this.route.offsetPoint(e.s, e.lateral);
  }

  private launchIce(e: HazardEvent) {
    const p = this.impactPoint(e);
    for (let k = 0; k < 26; k++) {
      const m = new THREE.Mesh(this.iceGeo, this.iceMat);
      const size = this.rng.range(0.8, 4);
      m.scale.setScalar(size);
      // Start high on the serac wall to one side, timed to land at the warning.
      const side = e.lateral >= 0 ? 1 : -1;
      const t = e.warning;
      const start = p.clone().add(new THREE.Vector3(this.rng.range(-8, 8), 0, this.rng.range(-8, 8)));
      start.x += side * 25;
      start.y += 0.5 * 9.81 * t * t * this.rng.range(0.85, 1);
      m.position.copy(start);
      m.castShadow = true;
      this.group.add(m);
      this.debris.push({ mesh: m, vel: new THREE.Vector3(-side * 25 / t, 0, this.rng.range(-2, 2)), life: t + 6 });
    }
    setTimeout(() => this.puff(p, 0xeef4fa, 35, 600), e.warning * 1000);
  }

  private launchSlide(e: HazardEvent) {
    const p = this.impactPoint(e);
    const uphill = this.route.tangentAt(e.s).multiplyScalar(-1);
    const start = p.clone().addScaledVector(uphill, -120);
    start.y = this.route.terrain.heightAt(start.x, start.z) + 10;
    const cloud = this.puff(start, 0xffffff, 60, 1600, e.warning + 5);
    cloud.vel.copy(p.clone().sub(start).multiplyScalar(1 / e.warning));
  }

  private puff(at: THREE.Vector3, color: number, size: number, n: number, life = 5) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(Math.cbrt(Math.random()) * size);
      v.y = Math.abs(v.y) * 0.6;
      pos.set([v.x, v.y, v.z], i * 3);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 2.5, transparent: true, opacity: 0.85, depthWrite: false }));
    pts.position.copy(at);
    this.group.add(pts);
    const c = { pts, life, vel: new THREE.Vector3() };
    this.clouds.push(c);
    return c;
  }
}
