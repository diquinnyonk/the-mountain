import * as THREE from 'three';
import type { Route } from './route';

const AHEAD = 70;
const SPACING = 2.4;
const BACK = 40;

/**
 * A light trail to follow: glowing markers along the route ahead of the climber
 * with a pulse running in the direction of travel, plus a line of markers back
 * to the route when you stray off it.
 */
export class RouteGuide {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private phase = 0;
  enabled = true;

  constructor(private route: Route) {
    const n = AHEAD + BACK;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.55, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** dir: +1 to guide up the mountain, -1 to guide down. */
  update(dt: number, player: THREE.Vector3, s: number, offRoute: number, dir: number, daylight: number) {
    this.points.visible = this.enabled;
    if (!this.enabled) return;
    this.phase += dt * 0.9;
    const p = new THREE.Vector3();
    // At night the markers glow; on sunlit snow a glow vanishes, so draw solid, saturated colour instead.
    const day = daylight > 0.35;
    const mat = this.points.material as THREE.PointsMaterial;
    const blending = day ? THREE.NormalBlending : THREE.AdditiveBlending;
    if (mat.blending !== blending) {
      mat.blending = blending;
      mat.needsUpdate = true;
    }
    mat.size = day ? 0.7 : 0.55;
    const base = day ? 1 : 0.95;
    let k = 0;
    const put = (x: number, y: number, z: number, b: number, warm: boolean) => {
      this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
      let r: number, g: number, bl: number;
      if (day) {
        // Deep orange to bright amber on the route; blue for the way back to it.
        const t = Math.min(1, b);
        [r, g, bl] = warm ? [0.85 + 0.15 * t, 0.28 + 0.4 * t, 0.02 + 0.13 * t] : [0.05 + 0.25 * t, 0.3 + 0.4 * t, 0.8 + 0.2 * t];
      } else {
        // Warm amber glow on the route, cool white for the way back to it.
        [r, g, bl] = warm ? [b, b * 0.72, b * 0.3] : [b * 0.75, b * 0.9, b];
      }
      this.col[k * 3] = r; this.col[k * 3 + 1] = g; this.col[k * 3 + 2] = bl;
      k++;
    };
    // Back to the route if you've strayed.
    const start = this.route.pointAt(s);
    if (offRoute > 6) {
      const steps = Math.min(BACK, Math.floor(offRoute / SPACING));
      for (let i = 1; i <= steps; i++) {
        p.lerpVectors(player, start, i / (steps + 1));
        p.y = this.route.terrain.heightAt(p.x, p.z) + 0.25;
        const wave = 0.5 + 0.5 * Math.sin(i * 0.5 - this.phase * 5);
        put(p.x, p.y, p.z, base * (0.25 + 0.5 * wave), false);
      }
    }
    // The route ahead.
    for (let i = 1; i <= AHEAD; i++) {
      const rs = s + dir * i * SPACING;
      if (rs < 0 || rs > this.route.length) break;
      this.route.pointAt(rs, p);
      const fade = 1 - i / AHEAD;
      // A pulse running away from you along the trail.
      const wave = Math.max(0, Math.sin(i * 0.35 - this.phase * 4)) ** 4;
      put(p.x, p.y + 0.25, p.z, base * fade * (0.22 + 0.8 * wave), true);
    }
    this.points.geometry.setDrawRange(0, k);
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
