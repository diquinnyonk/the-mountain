import * as THREE from 'three';
import type { Terrain } from '../world/heightmap';
import type { Route } from '../world/route';
import type { RouteLayout } from '../world/sections';
import { terrainColor } from '../world/terrainMesh';
import { clamp } from '../core/mathx';

const STEP = 2; // DEM pixels per map pixel

export interface MapMarker {
  x: number;
  z: number;
  kind: 'player' | 'sherpa' | 'climber' | 'dead';
  heading?: number;
  label?: string;
}

export interface MapState {
  player: { x: number; z: number; heading: number; s: number; altitude: number };
  markers: MapMarker[];
  ropeFixedTo: number;
  place: string;
}

/** Peaks and features labelled on the map (lat, lon, name, find the local high point). */
const FEATURES: [number, number, string, boolean][] = [
  [27.9617, 86.9333, 'Lhotse 8,516 m', true],
  [27.9672, 86.8866, 'Nuptse 7,861 m', true],
  [27.9960, 86.8700, 'Khumbu Glacier', false],
  [27.9790, 86.9020, 'Western Cwm', false],
];

/**
 * Shaded-relief map of the Everest massif from the same elevation data the
 * terrain uses: a minimap that follows you, and a full map with the route,
 * camps, fixed ropes, climbers and an altitude profile.
 */
export class EverestMap {
  readonly base: HTMLCanvasElement;
  private w: number;
  private h: number;
  private labels: { x: number; z: number; text: string; peak: boolean }[] = [];

  constructor(private terrain: Terrain, private route: Route, private layout: RouteLayout) {
    this.w = Math.floor(terrain.width / STEP);
    this.h = Math.floor(terrain.height / STEP);
    this.base = document.createElement('canvas');
    this.base.width = this.w;
    this.base.height = this.h;
    this.paintRelief();
    this.placeLabels();
  }

  /** Map pixel for world x/z. */
  toMap(x: number, z: number): [number, number] {
    const t = this.terrain;
    return [(x + t.halfW) / t.mpp / STEP, (z + t.halfH) / t.mpp / STEP];
  }

  private paintRelief() {
    const t = this.terrain;
    const g = this.base.getContext('2d')!;
    const img = g.createImageData(this.w, this.h);
    const col = new THREE.Color();
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const pi = i * STEP, pj = j * STEP;
        // Average a little to suppress DEM speckle.
        const H = (a: number, b: number) => (t.px(a, b) * 2 + t.px(a + 1, b) + t.px(a - 1, b) + t.px(a, b + 1) + t.px(a, b - 1)) / 6;
        const y = H(pi, pj);
        const e = STEP * 2;
        const dx = (H(pi + e, pj) - H(pi - e, pj)) / (2 * e * t.mpp);
        const dz = (H(pi, pj + e) - H(pi, pj - e)) / (2 * e * t.mpp);
        const nl = Math.hypot(dx, 1, dz);
        const ny = 1 / nl;
        // Hillshade lit from the north-west, the cartographic convention.
        const shade = clamp((-dx * -0.6 + -dz * -0.6 + 1 * 0.7) / nl / 1.05, 0, 1);
        const x = pi * t.mpp - t.halfW, z = pj * t.mpp - t.halfH;
        terrainColor(x, z, y, ny, 1e6, col);
        const k = (j * this.w + i) * 4;
        const s = 0.55 + 0.5 * shade;
        img.data[k] = clamp(col.r * s * 255, 0, 255);
        img.data[k + 1] = clamp(col.g * s * 255, 0, 255);
        img.data[k + 2] = clamp(col.b * s * 255 + 6, 0, 255);
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  private placeLabels() {
    const m = this.terrain.meta;
    const ly = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    for (const [lat, lon, text, peak] of FEATURES) {
      let i = ((lon - m.west) / (m.east - m.west)) * m.width;
      let j = ((ly(m.north) - ly(lat)) / (ly(m.north) - ly(m.south))) * m.height;
      if (peak) {
        // Snap to the highest DEM pixel nearby.
        let best = -1, bi = i, bj = j;
        for (let dj = -20; dj <= 20; dj++) for (let di = -20; di <= 20; di++) {
          const v = this.terrain.px(Math.round(i + di), Math.round(j + dj));
          if (v > best) { best = v; bi = i + di; bj = j + dj; }
        }
        i = bi; j = bj;
      }
      this.labels.push({ x: i * m.metresPerPixel - this.terrain.halfW, z: j * m.metresPerPixel - this.terrain.halfH, text, peak });
    }
    const top = this.route.pointAt(this.route.length);
    this.labels.push({ x: top.x, z: top.z, text: 'Everest 8,849 m', peak: true });
  }

  /**
   * Draw the map into ctx. `view`: centre (world x/z) and metres per canvas pixel;
   * null fits the whole massif.
   */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, s: MapState, view: { x: number; z: number; mpp: number } | null, compact: boolean) {
    const t = this.terrain;
    let scale: number, cx: number, cz: number;
    if (view) {
      scale = (t.mpp * STEP) / view.mpp;
      cx = view.x; cz = view.z;
    } else {
      scale = Math.min(w / this.w, h / this.h);
      cx = 0; cz = 0;
    }
    const [mx, mz] = this.toMap(cx, cz);
    const ox = w / 2 - mx * scale, oz = h / 2 - mz * scale;
    const P = (x: number, z: number): [number, number] => {
      const [a, b] = this.toMap(x, z);
      return [ox + a * scale, oz + b * scale];
    };
    ctx.fillStyle = '#0c111a';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, ox, oz, this.w * scale, this.h * scale);

    // Route: walked-to-come in white, fixed lines in blue.
    const r = this.route;
    const line = (s0: number, s1: number, color: string, width: number, dash: number[] = []) => {
      ctx.beginPath();
      const k0 = r.indexAt(Math.max(0, s0)), k1 = r.indexAt(Math.min(r.length, s1)) + 1;
      for (let k = k0; k <= k1 && k < r.count; k++) {
        const [px, pz] = P(r.xs[k], r.zs[k]);
        if (k === k0) ctx.moveTo(px, pz);
        else ctx.lineTo(px, pz);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    ctx.lineJoin = 'round';
    line(0, r.length, 'rgba(10,14,22,0.55)', compact ? 4 : 6);
    line(0, r.length, 'rgba(255,255,255,0.85)', compact ? 1.6 : 2.2, [5, 4]);
    for (const rope of this.layout.ropes) line(rope.s0, Math.min(rope.s1, s.ropeFixedTo), '#4aa3ff', compact ? 2 : 3);

    // Camps and landmarks.
    ctx.font = `${compact ? 10 : 12}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const l of Object.values(this.layout.landmarks)) {
      const [px, pz] = P(r.pointAt(l.s).x, r.pointAt(l.s).z);
      if (px < -20 || pz < -20 || px > w + 20 || pz > h + 20) continue;
      if (l.camp) {
        ctx.fillStyle = '#ff8a2a';
        ctx.beginPath();
        ctx.moveTo(px, pz - 6); ctx.lineTo(px + 5, pz + 4); ctx.lineTo(px - 5, pz + 4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#1a0e02';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (!compact && view) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px, pz, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Zoomed out, the summit ridge features would pile on top of each other: camps only.
      if (l.camp || (!compact && view)) this.text(ctx, shortName(l.name, true), px + 8, pz, l.camp ? '#ffd2ad' : '#e6edf5');
    }
    if (!compact) {
      for (const lb of this.labels) {
        const [px, pz] = P(lb.x, lb.z);
        if (lb.peak) {
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.moveTo(px, pz - 5); ctx.lineTo(px + 4, pz + 2); ctx.lineTo(px - 4, pz + 2);
          ctx.closePath();
          ctx.fill();
          this.text(ctx, lb.text, px + 7, pz - 8, '#ffffff', true);
        } else {
          this.text(ctx, lb.text, px, pz, 'rgba(230,237,245,0.85)', false, true);
        }
      }
    }

    // People.
    for (const m of s.markers) {
      const [px, pz] = P(m.x, m.z);
      if (px < -10 || pz < -10 || px > w + 10 || pz > h + 10) continue;
      ctx.beginPath();
      ctx.arc(px, pz, m.kind === 'sherpa' ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === 'sherpa' ? '#ffd23f' : m.kind === 'dead' ? '#ff5a4f' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (m.label && !compact && view) this.text(ctx, m.label, px + 6, pz + 1, '#ffe27a');
    }
    // You: an arrow pointing the way you face.
    const [px, pz] = P(s.player.x, s.player.z);
    ctx.save();
    ctx.translate(px, pz);
    // Heading is radians from +z (south); canvas y points south too.
    ctx.rotate(-s.player.heading + Math.PI);
    const a = compact ? 7 : 9;
    ctx.beginPath();
    ctx.moveTo(0, -a); ctx.lineTo(a * 0.65, a * 0.75); ctx.lineTo(0, a * 0.35); ctx.lineTo(-a * 0.65, a * 0.75);
    ctx.closePath();
    ctx.fillStyle = '#ff3b30';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // North arrow and scale bar.
    ctx.fillStyle = 'rgba(10,14,22,0.7)';
    ctx.fillRect(w - 26, 6, 20, 22);
    this.text(ctx, 'N', w - 20, 17, '#ff8a2a', true);
    if (!compact) {
      const metres = 1000;
      const px1 = (metres / (t.mpp * STEP)) * scale;
      ctx.fillStyle = 'rgba(10,14,22,0.7)';
      ctx.fillRect(10, h - 26, px1 + 44, 18);
      ctx.fillStyle = '#fff';
      ctx.fillRect(16, h - 18, px1, 3);
      this.text(ctx, '1 km', 20 + px1, h - 17, '#fff');
    }
  }

  private text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, bold = false, centre = false) {
    ctx.font = `${bold ? '600 ' : ''}${ctx.font.replace(/^(600 )?/, '')}`;
    ctx.textAlign = centre ? 'center' : 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(8,12,20,0.85)';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.textAlign = 'left';
  }

  /** The route's altitude profile with camps, fixed ropes and you on it. */
  drawProfile(ctx: CanvasRenderingContext2D, w: number, h: number, s: MapState) {
    const r = this.route;
    const pad = { l: 58, r: 12, t: 14, b: 22 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const a0 = 5200, a1 = 8950;
    const X = (sv: number) => pad.l + (sv / r.length) * iw;
    const Y = (alt: number) => pad.t + ih * (1 - (alt - a0) / (a1 - a0));
    ctx.fillStyle = '#0c111a';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // Gridlines every 1,000 m.
    for (let alt = 6000; alt <= 8000; alt += 1000) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(alt));
      ctx.lineTo(w - pad.r, Y(alt));
      ctx.stroke();
      ctx.fillStyle = '#9aa6b6';
      ctx.textAlign = 'right';
      ctx.fillText(`${alt.toLocaleString()} m`, pad.l - 6, Y(alt));
    }
    // Death zone.
    ctx.fillStyle = 'rgba(255,90,79,0.08)';
    ctx.fillRect(pad.l, pad.t, iw, Y(8000) - pad.t);
    ctx.fillStyle = 'rgba(255,90,79,0.7)';
    ctx.textAlign = 'left';
    ctx.fillText('death zone', pad.l + 4, pad.t + 9);
    // Profile fill and line.
    ctx.beginPath();
    ctx.moveTo(X(0), Y(a0));
    for (let k = 0; k < r.count; k += 4) ctx.lineTo(X(r.ss[k]), Y(r.ys[k]));
    ctx.lineTo(X(r.length), Y(r.altitudeAt(r.length)));
    ctx.lineTo(X(r.length), Y(a0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(200,215,235,0.18)';
    ctx.fill();
    ctx.beginPath();
    for (let k = 0; k < r.count; k += 4) (k ? ctx.lineTo : ctx.moveTo).call(ctx, X(r.ss[k]), Y(r.ys[k]));
    ctx.strokeStyle = '#e6edf5';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Fixed ropes along the bottom.
    for (const rope of this.layout.ropes) {
      const e = Math.min(rope.s1, s.ropeFixedTo);
      if (e <= rope.s0) continue;
      ctx.fillStyle = '#4aa3ff';
      ctx.fillRect(X(rope.s0), h - pad.b + 4, X(e) - X(rope.s0), 3);
    }
    ctx.fillStyle = '#4aa3ff';
    ctx.fillText('fixed ropes', pad.l, h - 7);
    // Camps.
    ctx.textAlign = 'center';
    for (const l of this.layout.camps) {
      const x = X(l.s), y = Y(r.altitudeAt(l.s));
      ctx.fillStyle = '#ff8a2a';
      ctx.beginPath();
      ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y + 3); ctx.lineTo(x - 5, y + 3);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffd2ad';
      ctx.fillText(shortName(l.name, true), x, y - 14);
    }
    ctx.fillStyle = '#fff';
    ctx.fillText('Summit', X(r.length) - 14, Y(8849) - 10);
    // You.
    const x = X(s.player.s), y = Y(s.player.altitude);
    ctx.strokeStyle = 'rgba(255,59,48,0.5)';
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3b30';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = 'left';
  }
}

function shortName(name: string, compact: boolean): string {
  if (!compact) return name;
  return name.replace('Everest Base Camp', 'Base Camp').replace(' (Advanced Base Camp)', '').replace('Camp 4 (South Col)', 'South Col').replace('Summit of Everest', 'Summit');
}
