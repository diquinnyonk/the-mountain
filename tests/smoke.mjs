// End-to-end smoke test: plan an expedition (Open-Meteo mocked), walk out of
// Base Camp, check altitude and time move, then visit each section via the
// debug panel and screenshot it. Requires the dev server: npm run dev.
// Usage: node tests/smoke.mjs [baseUrl]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] ?? 'http://localhost:5173/';
const OUT = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** A plausible Open-Meteo pressure-level response for any requested range. */
function fakeOpenMeteo(url) {
  const u = new URL(url);
  const from = Date.parse(u.searchParams.get('start_date') + 'T00:00:00Z');
  const to = Date.parse(u.searchParams.get('end_date') + 'T23:00:00Z');
  const vars = u.searchParams.get('hourly').split(',');
  const time = [];
  for (let t = from; t <= to; t += 3600_000) time.push(t / 1000);
  const hourly = { time };
  const levelZ = { 600: 4420, 500: 5860, 400: 7550, 300: 9650, 250: 10950 };
  const levelT = { 600: 2, 500: -6, 400: -17, 300: -32, 250: -40 };
  for (const v of vars) {
    const m = v.match(/^(.*)_(\d+)hPa$/);
    hourly[v] = time.map((t, i) => {
      const day = Math.floor(i / 24);
      const stormy = day % 9 === 4;
      if (!m) return v === 'precipitation' || v === 'snowfall' ? (stormy ? 1.5 : 0) : 0;
      const L = Number(m[2]);
      switch (m[1]) {
        case 'temperature': return levelT[L] + Math.sin(i / 24 * Math.PI * 2) * 2;
        case 'wind_speed': return (L <= 300 ? 45 : 20) + (stormy ? 50 : 0) + Math.sin(day) * 10;
        case 'wind_direction': return 270;
        case 'relative_humidity': return stormy ? 95 : 40;
        case 'cloud_cover': return stormy ? 100 : L >= 500 ? 60 : 10;
        case 'geopotential_height': return levelZ[L];
        default: return 0;
      }
    });
  }
  return { latitude: 27.98, longitude: 86.92, elevation: 5200, hourly };
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route(/open-meteo\.com/, (route) => route.fulfill({ json: fakeOpenMeteo(route.request().url()) }));

const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  await fn();
  console.log('ok');
};
const shot = (name) => page.screenshot({ path: OUT + name + '.png' });
const state = () => page.evaluate(() => {
  const g = window.game;
  const e = g.exp;
  return e ? { s: e.player.s, alt: e.player.altitude, time: e.clock.time, mode: e.player.mode, npcs: e.world.npcs.length, dead: e.player.dead } : null;
});

await step('title screen', async () => {
  await page.goto(BASE);
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 120000 });
  await shot('01-title');
});
await step('plan with weather', async () => {
  await page.click('#btn-new');
  await page.fill('#plan-date', '2024-05-12');
  await page.dispatchEvent('#plan-date', 'change');
  await page.waitForSelector('#btn-start:not([disabled])', { timeout: 30000 });
  await page.waitForTimeout(300);
  await shot('02-plan');
});
let before;
await step('start at Base Camp', async () => {
  await page.click('#btn-start');
  await page.waitForTimeout(2500);
  before = await state();
  if (!before || before.npcs < 3) throw new Error('expedition did not start: ' + JSON.stringify(before));
  await shot('03-basecamp');
});
await step('walk up the route', async () => {
  // Face up the route and walk.
  await page.evaluate(() => { const e = window.game.exp; e.follow.yaw = e.player.heading; });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(8000);
  await page.keyboard.up('KeyW');
  const after = await state();
  if (!(after.time > before.time)) throw new Error('time did not advance');
  if (Math.abs(after.s - before.s) < 1) throw new Error(`player did not move: ${before.s} -> ${after.s}`);
  console.log(`\n  moved ${(after.s - before.s).toFixed(1)} m along the route, altitude ${before.alt.toFixed(0)} -> ${after.alt.toFixed(0)} m`);
  await shot('04-walking');
});
for (const id of ['c1', 'c2', 'c3', 'c4', 'balcony', 'hillaryStep']) {
  await step(`visit ${id}`, async () => {
    await page.evaluate((id) => {
      const g = window.game;
      g.exp.god = true;
      g.debugActions().teleport(id);
      g.exp.follow.yaw = g.exp.player.heading + Math.PI * 0.85;
    }, id);
    await page.waitForTimeout(2500);
    await shot('05-' + id);
  });
}
await step('camp menu', async () => {
  await page.evaluate(() => window.game.debugActions().teleport('c2'));
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyC');
  await page.waitForSelector('#screen-camp:not([hidden])', { timeout: 5000 });
  await shot('06-camp');
  await page.click('#btn-camp-close');
});
await browser.close();
if (errors.length) {
  console.error('Console errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`Screenshots in ${OUT}`);
