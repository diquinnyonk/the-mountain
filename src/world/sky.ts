import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { sunPosition, EVEREST } from './sun';
import { clamp, lerp, smoothstep } from '../core/mathx';
import type { WeatherSample } from '../weather/model';

/** Sky dome, sun/moon lighting, stars, cloud cover and fog, all driven by time and weather. */
export class SkySystem {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x9a948c, 0.6);
  readonly fog = new THREE.FogExp2(0xc8d4e2, 0.00005);
  private sky = new Sky();
  private stars: THREE.Points;
  private overcast: THREE.Mesh;
  private cloudSea: THREE.Mesh;
  private sunDir = new THREE.Vector3();
  sunElevation = 0;
  /** 0 = night, 1 = full day. */
  daylight = 1;

  constructor() {
    this.sky.scale.setScalar(80000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 1.2;
    u.rayleigh.value = 0.5;
    u.mieCoefficient.value = 0.003;
    u.mieDirectionalG.value = 0.85;
    this.group.add(this.sky);

    const starGeo = new THREE.BufferGeometry();
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection();
      v.y = Math.abs(v.y);
      v.multiplyScalar(60000);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }));
    this.group.add(this.stars);

    this.overcast = new THREE.Mesh(
      new THREE.SphereGeometry(70000, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0xa8adb5, side: THREE.BackSide, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    this.group.add(this.overcast);

    this.cloudSea = new THREE.Mesh(
      new THREE.PlaneGeometry(90000, 90000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ map: cloudTexture(), transparent: true, opacity: 0, depthWrite: false }),
    );
    (this.cloudSea.material as THREE.MeshLambertMaterial).map!.repeat.set(30, 30);
    this.group.add(this.cloudSea);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 1200;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.group.add(this.sun, this.sun.target, this.hemi);
  }

  update(utcMs: number, focus: THREE.Vector3, camera: THREE.Camera, w: WeatherSample, dt: number) {
    const { elevation, azimuth } = sunPosition(utcMs, EVEREST.lat, EVEREST.lon);
    this.sunElevation = elevation;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    // Azimuth from north, clockwise: north is -z, east is +x.
    this.sunDir.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.overcast.position.copy(camera.position);

    const day = smoothstep(-6, 8, elevation);
    this.daylight = day;
    const cloud = clamp(w.cloudAtAltitude, 0, 1);
    const storm = clamp(w.stormLevel, 0, 1);
    const dim = 1 - 0.75 * Math.max(smoothstep(0.3, 1, cloud) * 0.8, storm);

    // Moonlight keeps nights navigable but dark; a headlamp does the rest.
    this.sun.intensity = lerp(0.06, 3.2, day) * dim;
    this.sun.color.setHSL(lerp(0.6, 0.1, day), lerp(0.3, smoothstep(0, 25, elevation) < 1 ? 0.5 : 0.1, day), lerp(0.75, 0.97, day));
    const dir = elevation > -4 ? this.sunDir : moonDir;
    this.sun.position.copy(focus).addScaledVector(dir, 600);
    this.sun.target.position.copy(focus);
    this.hemi.intensity = lerp(0.05, 0.7, day) * (0.6 + 0.4 * dim) + storm * 0.25 * day;
    this.hemi.color.setHSL(0.6, 0.4 * (1 - storm), lerp(0.25, 0.8, day));

    (this.stars.material as THREE.PointsMaterial).opacity = (1 - smoothstep(-12, -2, elevation)) * (1 - cloud);
    const oc = this.overcast.material as THREE.MeshBasicMaterial;
    // Scattered cloud leaves the sky clear between clouds; only a real overcast greys it all.
    oc.opacity = clamp(Math.max(smoothstep(0.4, 1, cloud) * 0.9, storm), 0, 0.97);
    oc.color.setHSL(0.6, 0.05, lerp(0.04, 0.72, day) * (1 - storm * 0.3));

    // A sea of cloud below when the lower levels are overcast and we are above them.
    const cs = this.cloudSea.material as THREE.MeshLambertMaterial;
    const seaTop = w.cloudBaseBelow;
    cs.opacity = seaTop && focus.y > seaTop + 100 ? clamp(w.cloudBelowCover, 0, 0.95) : 0;
    this.cloudSea.position.set(focus.x, seaTop ?? 0, focus.z);
    cs.map!.offset.x += dt * 0.00002 * w.windKmh;

    // Fog density from visibility (Koschmieder: ~3.9 / visibility).
    // Exponential-squared fog reaches 2% contrast at density * distance = sqrt(3.9), so this fades
    // things out at the reported visibility rather than at half of it.
    const vis = Math.max(20, w.visibilityM);
    const target = 1.98 / vis;
    this.fog.density = lerp(this.fog.density, target, clamp(dt * 0.8, 0, 1));
    // Aerial perspective: distant ridges recede into blue-grey, not into the white of the snow.
    // In a storm the air itself is white.
    const fogDay = lerp(0.03, lerp(0.6, 0.8, storm), day);
    this.fog.color.setHSL(0.59, lerp(0.34, 0.06, storm), fogDay);
    // Thin air high on the mountain: a darker, deeper blue sky with less haze.
    const high = smoothstep(5000, 8800, focus.y);
    const u = this.sky.material.uniforms;
    u.turbidity.value = lerp(1.6, 0.45, high);
    u.rayleigh.value = lerp(0.65, 0.28, high);
    u.mieCoefficient.value = lerp(0.004, 0.0012, high);
  }

  get sunDirection() {
    return this.sunDir;
  }
}

const moonDir = new THREE.Vector3(0.3, 0.8, 0.4).normalize();

function cloudTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  // Tileable value noise with a few octaves.
  const grid = (n: number) => Array.from({ length: n * n }, () => Math.random());
  const octs = [4, 8, 16, 32].map((n) => ({ n, v: grid(n) }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5;
      for (const o of octs) {
        const fx = (x / size) * o.n, fy = (y / size) * o.n;
        const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
        const at = (a: number, b: number) => o.v[((b % o.n) * o.n) + (a % o.n)];
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const top = at(i, j) * (1 - sx) + at(i + 1, j) * sx;
        const bot = at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx;
        v += (top * (1 - sy) + bot * sy) * amp;
        amp *= 0.5;
      }
      const a = clamp((v - 0.35) * 2.4, 0, 1);
      const k = (y * size + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
