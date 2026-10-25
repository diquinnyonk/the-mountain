import * as THREE from 'three';
import type { WeatherSample } from '../weather/model';
import { clamp } from '../core/mathx';

const COUNT = 6000;
const BOX = 50;

/** Falling snow and wind-blown spindrift in a box that travels with the camera. */
export class SnowParticles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private seed: Float32Array;
  private material: THREE.PointsMaterial;

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(COUNT * 3);
    this.seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      this.pos[i * 3] = (Math.random() - 0.5) * BOX;
      this.pos[i * 3 + 1] = (Math.random() - 0.5) * BOX;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * BOX;
      this.seed[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.material = new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.9, depthWrite: false });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  update(dt: number, camera: THREE.Vector3, w: WeatherSample, daylight: number) {
    const fall = clamp(w.snowfallCmH / 1.5, 0, 1);
    const drift = clamp((w.windKmh - 30) / 60, 0, 1);
    const density = Math.max(fall, drift * 0.7);
    const active = Math.floor(COUNT * density);
    this.points.geometry.setDrawRange(0, active);
    this.points.visible = active > 0;
    this.material.opacity = 0.35 + 0.55 * daylight;
    this.material.color.setScalar(0.6 + 0.4 * daylight);
    // Wind blows toward (dir + 180°); x east, z south.
    const to = THREE.MathUtils.degToRad(w.windDirDeg + 180);
    const wind = (w.windKmh / 3.6) * 0.6;
    const vx = Math.sin(to) * wind, vz = -Math.cos(to) * wind;
    const p = this.pos, half = BOX / 2;
    const o = this.points.position;
    for (let i = 0; i < active; i++) {
      const k = i * 3, s = this.seed[i];
      p[k] += (vx * (0.7 + s * 0.6) + Math.sin(s * 40 + p[k + 1]) * 0.5) * dt;
      p[k + 1] -= (0.8 + s * 0.8 - drift * Math.sin(s * 13 + p[k]) * 1.5) * dt;
      p[k + 2] += (vz * (0.7 + s * 0.6)) * dt;
      // Wrap around the camera.
      for (let a = 0; a < 3; a++) {
        const c = a === 0 ? camera.x - o.x : a === 1 ? camera.y - o.y : camera.z - o.z;
        const d = p[k + a] - c;
        if (d > half || d < -half) p[k + a] = c + ((((d + half) % BOX) + BOX) % BOX) - half;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
