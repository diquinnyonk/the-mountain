import { describe, it, expect } from 'vitest';
import { WeatherTimeline, windChill, stormLevelOf } from '../src/weather/model';
import { planRequests, loadWeather } from '../src/weather/openmeteo';
import { fillSynthetic } from '../src/weather/storm';
import { localMidnightUtc, HOUR } from '../src/core/clock';

describe('weather', () => {
  it('interpolates between pressure levels by geopotential height', () => {
    const tl = new WeatherTimeline(0, 2);
    // 500 hPa at 5,860 m: -6°C, 20 km/h. 400 hPa at 7,550 m: -18°C, 40 km/h.
    for (const h of [0, 1]) {
      tl.t[1][h] = -6; tl.ws[1][h] = 20; tl.z[1][h] = 5860;
      tl.t[2][h] = -18; tl.ws[2][h] = 40; tl.z[2][h] = 7550;
    }
    const s = tl.sample(0, (5860 + 7550) / 2);
    expect(s.tempC).toBeCloseTo(-12, 1);
    expect(s.windKmh).toBeCloseTo(30, 1);
  });

  it('wind chill and storm level', () => {
    expect(windChill(-30, 60)).toBeLessThan(-45);
    expect(stormLevelOf(20, 0, 50000)).toBe(0);
    expect(stormLevelOf(110, 0, 50000)).toBe(1);
    expect(stormLevelOf(20, 2.5, 50000)).toBe(1);
  });

  it('chooses the right endpoint for past and future dates', () => {
    const now = Date.UTC(2026, 9, 25);
    expect(planRequests('1996-05-06', 30, now)[0].provider).toBe('reanalysis');
    expect(planRequests('2024-05-12', 30, now)[0].provider).toBe('historical-forecast');
    const soon = planRequests('2026-10-30', 30, now);
    expect(soon[0].provider).toBe('forecast');
    expect(soon[0].url).toContain('wind_speed_300hPa');
  });

  it('fills missing data from climatology, deterministically', () => {
    const a = new WeatherTimeline(localMidnightUtc('2024-05-10'), 24 * 5);
    const b = new WeatherTimeline(localMidnightUtc('2024-05-10'), 24 * 5);
    fillSynthetic(a, 'x');
    fillSynthetic(b, 'x');
    expect(a.ws[3][50]).toBe(b.ws[3][50]);
    const summit = a.sample(a.start + 12 * HOUR, 8849);
    expect(summit.tempC).toBeLessThan(-15);
    expect(summit.tempC).toBeGreaterThan(-45);
  });

  it('January summit winds are far stronger than May', () => {
    const jan = new WeatherTimeline(localMidnightUtc('2024-01-10'), 24 * 10);
    const may = new WeatherTimeline(localMidnightUtc('2024-05-20'), 24 * 10);
    fillSynthetic(jan, 'j');
    fillSynthetic(may, 'm');
    const mean = (tl: WeatherTimeline) => {
      let s = 0;
      for (let h = 0; h < tl.hours; h++) s += tl.sample(tl.start + h * HOUR, 8849).windKmh;
      return s / tl.hours;
    };
    expect(mean(jan)).toBeGreaterThan(mean(may) * 1.8);
  });

  it('loads Open-Meteo pressure-level data and falls back when the service fails', async () => {
    const fake = (async (url: string) => {
      const u = new URL(url);
      const from = Date.parse(u.searchParams.get('start_date') + 'T00:00:00Z');
      const to = Date.parse(u.searchParams.get('end_date') + 'T23:00:00Z');
      const time: number[] = [];
      for (let t = from; t <= to; t += HOUR) time.push(t / 1000);
      const hourly: Record<string, number[]> = { time };
      for (const v of u.searchParams.get('hourly')!.split(',')) hourly[v] = time.map(() => (v.startsWith('wind_speed') ? 33 : v.startsWith('geopotential') ? 7000 : 1));
      return new Response(JSON.stringify({ hourly, elevation: 5000 }), { status: 200 });
    }) as typeof fetch;
    const ok = await loadWeather('2024-05-12', 5, fake, Date.UTC(2026, 9, 25));
    expect(ok.timeline.source[30]).toBe('historical-forecast');
    expect(ok.timeline.sample(ok.timeline.start + 30 * HOUR, 8000).windKmh).toBeCloseTo(33, 0);

    const down = (async () => new Response('{"error":true,"reason":"down"}', { status: 400 })) as typeof fetch;
    const fallback = await loadWeather('2024-05-12', 5, down, Date.UTC(2026, 9, 25));
    expect(fallback.timeline.source.every((s) => s === 'synthetic')).toBe(true);
    expect(fallback.notes.join(' ')).toMatch(/unavailable/);
  });
});

describe('sun position', () => {
  it('rises in the east and sets in the west at Everest', async () => {
    const { sunPosition, EVEREST } = await import('../src/world/sun');
    const local = (h: number) => Date.UTC(2019, 4, 18) - 5.75 * 3600e3 + h * 3600e3;
    const dawn = sunPosition(local(5.5), EVEREST.lat, EVEREST.lon);
    const dusk = sunPosition(local(18.5), EVEREST.lat, EVEREST.lon);
    const noon = sunPosition(local(12), EVEREST.lat, EVEREST.lon);
    expect(dawn.azimuth).toBeGreaterThan(45);
    expect(dawn.azimuth).toBeLessThan(110);
    expect(dusk.azimuth).toBeGreaterThan(250);
    expect(dusk.azimuth).toBeLessThan(315);
    expect(noon.elevation).toBeGreaterThan(75);
  });
});
