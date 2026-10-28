import { $, segmented, esc } from './screens';
import { loadWeather, type WeatherLoad } from '../weather/openmeteo';
import type { DaySummary } from '../weather/model';
import { describe } from '../weather/openmeteo';
import { DAY, localMidnightUtc } from '../core/clock';
import { seasonFor } from '../ai/director';

export type StartCamp = 'bc' | 'c1' | 'c2' | 'c3' | 'c4';

export interface ExpeditionSettings {
  date: string;
  /** Where on the mountain to begin (defaults to Base Camp). */
  startCamp?: StartCamp;
  style: 'full' | 'push';
  sherpa: boolean;
  o2Stash: number;
  speed: number;
}

export const EXPEDITION_DAYS = 40;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The planning screen: date, weather briefing, options. */
export class PlanningScreen {
  weather: WeatherLoad | null = null;
  private style = segmented('plan-style', () => this.updateStyleHint());
  private sherpa = segmented('plan-sherpa');
  private o2 = segmented('plan-o2');
  private speed = segmented('plan-speed');
  private start = segmented('plan-start', (v) => this.updateStart(v));
  private token = 0;
  onStart?: (s: ExpeditionSettings, w: WeatherLoad) => void;

  constructor(private routeLength: () => { length: number; c1: number; landmarks: [number, string][] }) {
    const input = $<HTMLInputElement>('plan-date');
    const today = new Date();
    input.min = '1940-01-01';
    input.max = iso(new Date(today.getTime() + 14 * DAY));
    input.addEventListener('change', () => this.load(input.value));
    const quick: [string, string][] = [
      ['Next week', iso(new Date(today.getTime() + 7 * DAY))],
      ['Tomorrow', iso(new Date(today.getTime() + DAY))],
      ['May 2024', '2024-05-12'],
      ['May 2019 (the queue)', '2019-05-18'],
      ['May 1996 (Into Thin Air)', '1996-05-06'],
      ['May 1953 (first ascent)', '1953-05-24'],
      ['April 2023', '2023-04-15'],
    ];
    $('plan-quick').innerHTML = quick.map(([l, d]) => `<button data-d="${d}">${l}</button>`).join('');
    $('plan-quick').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      input.value = b.dataset.d!;
      this.load(b.dataset.d!);
    });
    $('btn-start').addEventListener('click', () => {
      if (this.weather) this.onStart?.(this.settings(), this.weather);
    });
    this.updateStyleHint();
  }

  settings(): ExpeditionSettings {
    return {
      date: $<HTMLInputElement>('plan-date').value,
      style: this.style() as 'full' | 'push',
      sherpa: this.sherpa() === 'yes',
      o2Stash: Number(this.o2()),
      speed: Number(this.speed()),
      startCamp: this.start() as StartCamp,
    };
  }

  private updateStart(v: string) {
    const names: Record<string, string> = { bc: 'Base Camp', c1: 'Camp 1', c2: 'Camp 2', c3: 'Camp 3', c4: 'the South Col' };
    $('btn-start').textContent = `Start at ${names[v]}`;
    $('plan-start-hint').textContent = v === 'bc' ? 'The whole climb, from the foot of the Icefall.'
      : `You climbed here over the previous weeks: acclimatised for this camp, with the sections below already done.${v === 'c4' ? ' You start in the afternoon on low-flow oxygen.' : ''}`;
  }

  private updateStyleHint() {
    $('plan-style-hint').textContent = this.style() === 'full'
      ? 'You arrive at Base Camp acclimatised to about 5,100 m from the trek in. You will need rotations before a summit push.'
      : 'Five weeks of rotations are behind you: acclimatised to about 7,000 m, and a little worn down.';
  }

  async load(date: string) {
    if (!date) return;
    const token = ++this.token;
    $<HTMLButtonElement>('btn-start').disabled = true;
    $('plan-weather').innerHTML = `<p class="hint">Fetching weather for Everest from ${esc(date)}…</p>`;
    try {
      const w = await loadWeather(date, EXPEDITION_DAYS);
      if (token !== this.token) return;
      this.weather = w;
      this.render(date, w);
      $<HTMLButtonElement>('btn-start').disabled = false;
    } catch (e) {
      $('plan-weather').innerHTML = `<p class="hint">Could not load weather: ${esc(String(e))}</p>`;
    }
  }

  private render(date: string, w: WeatherLoad) {
    const start = localMidnightUtc(date);
    const days = w.timeline.daySummaries(start, 21);
    const r = this.routeLength();
    const season = seasonFor(start, r.length, r.c1);
    let ropes = 'No fixed ropes: nobody is climbing in this season.';
    if (season.inSeason) {
      let name = 'Camp 1';
      for (const [s, n] of r.landmarks) if (season.ropeFront >= s) name = n;
      ropes = season.ropeFront >= r.length ? 'Fixed ropes reach the summit.' : `Fixed ropes currently reach ${name}; the rope fixers are still working higher.`;
    }
    const good = days.filter((d) => d.good).length;
    const sources = [...new Set(days.map((d) => d.source))].map(describe).join(', ');
    $('plan-weather').innerHTML = `
      <canvas id="wx-chart" width="620" height="220"></canvas>
      <div class="wx-days">${days.map((d) => dayCell(d)).join('')}</div>
      <div class="season"><b>${season.inSeason ? 'Climbing ' + season.name : 'Off season (' + season.name + ')'}.</b> ${ropes}
        ${good ? `${good} likely summit day${good > 1 ? 's' : ''} in the next three weeks.` : 'No clear summit windows in the next three weeks.'}</div>
      <ul class="wx-notes">${w.notes.map((n) => `<li>${esc(n)}</li>`).join('')}<li>Sources: ${esc(sources)}</li></ul>`;
    drawChart($<HTMLCanvasElement>('wx-chart'), days);
  }
}

function dayCell(d: DaySummary): string {
  const date = new Date(d.dayStart + 6 * 3600_000);
  const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const cls = d.good ? 'good' : d.stormHours > 0 ? 'storm' : '';
  return `<div class="wx-day ${cls}" title="Summit wind max ${Math.round(d.summitWindMax)} km/h, summit min ${Math.round(d.summitTempMin)}°C, ${d.precipTotal.toFixed(1)} mm precipitation">
    <b>${label}</b>${Math.round(d.summitWindMax)} km/h<br>${Math.round(d.summitTempMin)}°C</div>`;
}

/** Summit wind (bars) and temperature (line) for each day. */
function drawChart(c: HTMLCanvasElement, days: DaySummary[]) {
  const g = c.getContext('2d')!;
  const dpr = devicePixelRatio || 1;
  const W = c.clientWidth || 620, H = c.clientHeight || 220;
  c.width = W * dpr;
  c.height = H * dpr;
  g.scale(dpr, dpr);
  const pad = { l: 36, r: 36, t: 18, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const maxW = Math.max(100, ...days.map((d) => d.summitWindMax));
  g.font = '11px system-ui';
  g.fillStyle = '#9aa6b6';
  g.fillText('Summit wind (km/h)', pad.l, 12);
  g.textAlign = 'right';
  g.fillText('Summit temp (°C)', W - pad.r + 30, 12);
  g.textAlign = 'left';
  // Danger line at 60 km/h.
  const y60 = pad.t + ih * (1 - 60 / maxW);
  g.strokeStyle = 'rgba(255,90,79,0.5)';
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(pad.l, y60);
  g.lineTo(pad.l + iw, y60);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,90,79,0.8)';
  g.fillText('60', 8, y60 + 4);
  const bw = iw / days.length;
  days.forEach((d, i) => {
    const h = ih * (d.summitWindMax / maxW);
    g.fillStyle = d.good ? '#4cd18a' : d.summitWindMax > 60 ? '#ff5a4f' : '#ffc94a';
    g.globalAlpha = 0.85;
    g.fillRect(pad.l + i * bw + 2, pad.t + ih - h, bw - 4, h);
    g.globalAlpha = 1;
    if (i % 3 === 0) {
      const date = new Date(d.dayStart + 6 * 3600_000);
      g.fillStyle = '#9aa6b6';
      g.fillText(date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), pad.l + i * bw, H - 6);
    }
  });
  const temps = days.map((d) => d.summitTempMin);
  const tMin = Math.min(...temps) - 3, tMax = Math.max(...temps) + 3;
  g.strokeStyle = '#a9c7ff';
  g.lineWidth = 2;
  g.beginPath();
  temps.forEach((t, i) => {
    const x = pad.l + i * bw + bw / 2, y = pad.t + ih * (1 - (t - tMin) / (tMax - tMin));
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.stroke();
  g.fillStyle = '#a9c7ff';
  g.textAlign = 'right';
  g.fillText(`${Math.round(tMax)}`, W - 4, pad.t + 8);
  g.fillText(`${Math.round(tMin)}`, W - 4, pad.t + ih);
}
