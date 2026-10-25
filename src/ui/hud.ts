import { $, esc } from './screens';
import { formatLocalDate, formatLocalTime } from '../core/clock';
import type { Physiology } from '../sim/physiology';
import type { Effects } from '../sim/effects';
import type { Gear } from '../player/gear';
import type { WeatherSample } from '../weather/model';
import { clamp } from '../core/mathx';
import type { RadioKind } from '../ai/world';

export interface RadioMessage {
  time: number;
  from: string;
  text: string;
  kind: RadioKind;
}

export interface HudState {
  now: number;
  altitude: number;
  place: string;
  section: string;
  timeRate: number;
  weather: WeatherSample;
  physiology: Physiology;
  effects: Effects;
  gear: Gear;
  prompt: string;
  alert: string;
  clipped: boolean;
  cameraYaw: number;
  routeBearing: number;
  daylight: number;
  dexActive: boolean;
  nifActive: boolean;
  radio: RadioMessage[];
}

/** The heads-up display and the screen-space effects of the climber's condition. */
export class Hud {
  private accum = 1;
  private lastRadio = -1;
  private canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.getElementById('scene') as HTMLCanvasElement;
  }

  show(on: boolean) {
    $('hud').hidden = !on;
    if (!on) this.clearFx();
  }

  clearFx() {
    this.canvas.style.filter = '';
    for (const id of ['fx-vignette', 'fx-headache', 'fx-glare']) $(id).style.opacity = '0';
  }

  update(dt: number, s: HudState, realTime: number) {
    this.fx(s, realTime);
    $('hud-prompt').textContent = s.prompt;
    $('hud-alert').textContent = s.alert;
    if (s.radio.length !== this.lastRadio) {
      this.lastRadio = s.radio.length;
      $('hud-radio').innerHTML = s.radio.slice(-6).map((m) =>
        `<div class="msg ${m.kind}"><time>${formatLocalTime(m.time)}</time><b>${esc(m.from)}:</b> ${esc(m.text)}</div>`).join('');
    }
    this.accum += dt;
    if (this.accum < 0.15) return;
    this.accum = 0;
    const w = s.weather, p = s.physiology, g = s.gear;
    $('hud-location').innerHTML = `
      <div class="alt">${Math.round(s.altitude).toLocaleString()} m</div>
      <div class="place">${esc(s.place)}</div>
      <div class="sub">${esc(s.section)}</div>
      <div class="sub">${formatLocalDate(s.now)} · ${formatLocalTime(s.now)} · ×${Math.round(s.timeRate)}</div>`;
    const storm = w.stormLevel > 0.6 ? '<div class="storm">STORM</div>' : w.event ? `<div class="storm">${w.event.kind.toUpperCase()}</div>` : '';
    $('hud-weather').innerHTML = `
      <div class="big">${Math.round(w.tempC)}°C <span class="hint">feels ${Math.round(w.windChillC)}°C</span></div>
      <div>Wind ${Math.round(w.windKmh)} km/h · gusts ${Math.round(w.gustKmh)}</div>
      <div>Visibility ${w.visibilityM > 9999 ? Math.round(w.visibilityM / 1000) + ' km' : Math.round(w.visibilityM) + ' m'}${w.snowfallCmH > 0.05 ? ` · snow ${w.snowfallCmH.toFixed(1)} cm/h` : ''}</div>
      ${storm}<div class="hint">${w.source === 'synthetic' ? 'climatology' : w.source}</div>`;
    $('hud-conditions').innerHTML = conditionChips(s).join('');
    const bar = (label: string, v: number, text: string, color?: string) => `
      <div class="bar"><span>${label}</span><div class="track"><div class="fill" style="width:${clamp(v, 0, 1) * 100}%;background:${color ?? barColor(v)}"></div></div><span class="val">${text}</span></div>`;
    const o2 = g.litres > 0 || g.bottles > 0
      ? `<div class="vit-o2"><span>O₂ ${g.flowLpm.toFixed(1)} L/min${g.litres <= 0 && g.flowLpm > 0 ? ' (no cylinder!)' : ''}</span><span>${Math.round(g.litres)} L + ${g.bottles} spare${g.flowLpm > 0 && isFinite(g.o2HoursLeft) ? ` · ${g.o2HoursLeft.toFixed(1)} h` : ''}</span></div>`
      : `<div class="vit-o2"><span>No oxygen carried</span><span>${s.clipped ? '🔗 clipped' : ''}</span></div>`;
    $('hud-vitals').innerHTML =
      bar('SpO₂', (p.spo2 - 40) / 58, `${Math.round(p.spo2)}%`) +
      bar('Energy', p.energy / 100, `${Math.round(p.energy)}`) +
      bar('Hydration', p.hydration / 100, `${Math.round(p.hydration)}`) +
      bar('Core temp', (p.coreTemp - 30) / 7.2, `${p.coreTemp.toFixed(1)}°`) +
      bar('Hands / feet', (Math.min(p.handTemp, p.footTemp) + 10) / 40, `${Math.round(p.handTemp)}° / ${Math.round(p.footTemp)}°`) +
      `<div class="bar"><span>Water · food</span><span>${g.water.toFixed(1)} L · ${g.rations} rations</span><span class="val">${s.clipped ? '🔗' : ''}</span></div>` +
      o2;
    this.compass(s);
  }

  private compass(s: HudState) {
    // Heading the camera faces, degrees from north clockwise. Forward = (sin yaw, cos yaw) in x-east/z-south.
    const heading = (deg(Math.atan2(Math.sin(s.cameraYaw), -Math.cos(s.cameraYaw))) + 360) % 360;
    const marks: [number, string, string][] = [[0, 'N', 'n'], [45, 'NE', ''], [90, 'E', ''], [135, 'SE', ''], [180, 'S', ''], [225, 'SW', ''], [270, 'W', ''], [315, 'NW', ''], [s.routeBearing, '▲ route', 'tgt']];
    $('hud-compass').innerHTML = marks.map(([b, l, c]) => {
      let d = b - heading;
      d = ((d + 540) % 360) - 180;
      if (Math.abs(d) > 70) return '';
      return `<span class="${c}" style="left:${50 + (d / 70) * 50}%">${l}</span>`;
    }).join('');
  }

  private fx(s: HudState, t: number) {
    const e = s.effects;
    const blur = e.blurPx + (e.glare > 0.2 ? e.glare * 2 : 0);
    const bright = 1 + e.glare * 0.35;
    this.canvas.style.filter = `blur(${blur.toFixed(2)}px) saturate(${(1 - e.desaturate).toFixed(2)}) brightness(${bright.toFixed(2)})`;
    const pulse = 0.5 + 0.5 * Math.sin(t * (e.heartRate / 60) * Math.PI * 2);
    $('fx-vignette').style.opacity = String(clamp(e.vignette * (0.85 + 0.15 * pulse), 0, 0.95));
    $('fx-headache').style.opacity = String(e.headache > 0.3 ? (e.headache - 0.3) * 0.6 * pulse : 0);
    $('fx-glare').style.opacity = String(e.glare * 0.7 * s.daylight);
  }
}

const deg = (r: number) => (r * 180) / Math.PI;
const barColor = (v: number) => (v > 0.55 ? '#4cd18a' : v > 0.3 ? '#ffc94a' : '#ff5a4f');

function conditionChips(s: HudState): string[] {
  const p = s.physiology;
  const out: string[] = [];
  const chip = (sev: number, label: string, threshold = 0.05) => {
    if (sev < threshold) return;
    out.push(`<div class="cond ${sev > 0.5 ? 'severe' : 'mild'}">${label}</div>`);
  };
  chip(p.ams, p.ams > 0.6 ? 'Severe AMS: pounding headache, vomiting' : p.ams > 0.3 ? 'AMS: headache, nausea' : 'Mild headache', 0.1);
  if (p.hape > 0) chip(Math.max(0.3, p.hape), p.hape > 0.5 ? 'Gurgling breath, pink froth (HAPE)' : 'Wet cough, breathless at rest');
  if (p.hace > 0) chip(Math.max(0.3, p.hace), p.hace > 0.5 ? 'Confused, can\'t walk straight (HACE)' : 'Clumsy, drowsy, odd thoughts');
  chip(p.hypothermia, p.hypothermia > 0.5 ? 'Hypothermia: stopped shivering' : 'Shivering hard');
  chip(p.frostbiteHands, p.frostbiteHands > 0.5 ? 'Frostbitten fingers (black)' : 'Numb, white fingers');
  chip(p.frostbiteFeet, p.frostbiteFeet > 0.5 ? 'Frostbitten toes' : 'Can\'t feel your toes');
  chip(p.snowBlindness, 'Snow blind: eyes burning');
  chip(p.exhaustion, p.exhaustion > 0.6 ? 'Exhausted' : 'Tired', 0.2);
  chip(p.dehydration, 'Dehydrated', 0.25);
  chip(p.cough, p.crackedRib ? 'Cracked rib from coughing' : 'Khumbu cough', 0.35);
  chip(p.hypoxia, 'Hypoxic: grey vision', 0.25);
  if (s.dexActive) out.push('<div class="cond">Dexamethasone active</div>');
  if (s.nifActive) out.push('<div class="cond">Nifedipine active</div>');
  if (!s.gear.goggles && s.daylight > 0.3) out.push('<div class="cond mild">Goggles off</div>');
  return out;
}
