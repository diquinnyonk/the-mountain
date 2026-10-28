import * as THREE from 'three';
import type { WeatherSample } from '../weather/model';
import { clamp } from '../core/mathx';

const PUFFS = 36;
const LENGTH = 2600;

/**
 * The summit plume: spindrift torn off the top of Everest by the jet stream,
 * streaming downwind for kilometres. Strength follows the real summit wind.
 */
export class SummitPlume {
  readonly group = new THREE.Group();
  private sprites: THREE.Sprite[] = [];
  private seeds: number[] = [];
  private t = 0;

  constructor(private summit: THREE.Vector3) {
    const tex = puffTexture();
    for (let i = 0; i < PUFFS; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0xffffff });
      const s = new THREE.Sprite(m);
      this.group.add(s);
      this.sprites.push(s);
      this.seeds.push(Math.random());
    }
  }

  update(summitWeather: WeatherSample, daylight: number, gameSeconds: number) {
    const wind = summitWeather.windKmh;
    // A plume needs wind and clear air at the summit; it's invisible in the dark.
    const strength = clamp((wind - 30) / 60, 0, 1) * (1 - summitWeather.cloudAtAltitude) * (0.25 + 0.75 * daylight);
    this.group.visible = strength > 0.02;
    if (!this.group.visible) return;
    // Drift at a fraction of the wind, in game time so it speeds up with the clock.
    this.t += (gameSeconds * (wind / 3.6) * 0.25) / LENGTH;
    const to = THREE.MathUtils.degToRad(summitWeather.windDirDeg + 180);
    const dx = Math.sin(to), dz = -Math.cos(to);
    const sx = -dz, sz = dx;
    for (let i = 0; i < PUFFS; i++) {
      const u = (this.t + i / PUFFS + this.seeds[i] * 0.02) % 1;
      const d = u * LENGTH;
      const wobble = Math.sin(this.seeds[i] * 40 + u * 6) * u * 160;
      const s = this.sprites[i];
      // Torn off the summit, sinking a little in the lee and spreading as it goes.
      s.position.set(this.summit.x + dx * d + sx * wobble, this.summit.y + 20 - u * 350 + Math.sin(u * 9 + i) * 30, this.summit.z + dz * d + sz * wobble);
      const size = 60 + u * 650;
      s.scale.set(size * 1.6, size, 1);
      (s.material as THREE.SpriteMaterial).opacity = strength * 0.55 * Math.sin(Math.PI * Math.min(1, u * 1.2)) * (1 - u * 0.5);
    }
  }
}

function puffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  for (let k = 0; k < 14; k++) {
    const x = 32 + Math.random() * 64, y = 40 + Math.random() * 48, r = 18 + Math.random() * 30;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}
