// Captures clean marketing stills (no HUD) from a production preview build.
// Usage: node tools/capture-stills.mjs <outDir> [baseUrl]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? 'site/media';
const BASE = process.argv[3] ?? 'http://localhost:4173/';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.route(/open-meteo\.com/, (r) => r.abort());
await page.goto(BASE);
await page.waitForSelector('#screen-title:not([hidden])', { timeout: 180000 });
await page.click('#btn-new');
await page.fill('#plan-date', '2019-05-18');
await page.dispatchEvent('#plan-date', 'change');
await page.waitForSelector('#btn-start:not([disabled])', { timeout: 60000 });
await page.click('#plan-start button[data-v="c2"]');
await page.click('#btn-start');
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const g = window.game, e = g.exp;
  e.god = true;
  // Stills jump around the mountain: never end the expedition.
  e.checkEnd = () => {};
  e.director.ropeFront.s = g.route.length;
  const orig = e.weather.sample.bind(e.weather);
  e.weather.sample = (t, a) => Object.assign(orig(t, a), { windKmh: 22, gustKmh: 30, cloudAtAltitude: 0.05, snowfallCmH: 0, stormLevel: 0, event: null, visibilityM: 80000 });
  const st = document.createElement('style');
  st.textContent = '#hud, #touch, #bt-labels, .fx { display: none !important; }';
  document.head.appendChild(st);
  g.hud.update = () => {};
  window.__place = (s, lat, hour, cam) => {
    const p = e.player;
    p.placeAt(s, lat);
    Object.assign(p.physiology, { acclimAlt: 7400, energy: 90, hydration: 90, hypoxicDebt: 0, ams: 0, hape: 0, hace: 0, uvDose: 0 });
    p.gear.litres = 1080; p.gear.flowLpm = p.pos.y > 7000 ? 3 : 0;
    p.clipped = !!cam.clipped;
    e.clock.time = e.clock.nextLocalHour(hour);
    if (cam.sunrise) {
      let t = e.clock.time;
      g.sky.update(t, p.pos, g.camera, e.weatherHere, 0.016);
      while (g.sky.sunElevation < cam.sunrise) { t += 60000; g.sky.update(t, p.pos, g.camera, e.weatherHere, 0.016); }
      e.clock.time = t;
    }
    const sh = e.director.sherpa;
    if (sh) { sh.s = Math.min(g.route.length, s + (cam.sherpa ?? 10)); sh.lateral = 0.4; }
    p.heading = g.route.tangentAt(s).x !== undefined ? Math.atan2(g.route.tangentAt(s).x, g.route.tangentAt(s).z) + (cam.turn ?? 0) : 0;
    e.follow.yaw = p.heading + (cam.yaw ?? 0);
    e.follow.pitch = cam.pitch ?? 0.25;
    e.follow.distance = cam.dist ?? 6;
    e.follow.snap();
    e.player.speedVisual = 1.4;
  };
});
const L = await page.evaluate(() => {
  const l = window.game.layout.landmarks;
  return Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v.s]).concat([['len', window.game.route.length], ['ladder', window.game.layout.ladders[3].s]]));
});
const shots = [
  // name, width, height, s, lateral, hour, camera
  ['summit-flags', 1200, 1200, L.len - 3, 0, 8.3, { yaw: 2.6, pitch: 0.42, dist: 7, sherpa: -4 }],
  ['ridge-sunrise', 900, 1600, L.southSummit + 30, 0.7, 4.5, { sunrise: 2.5, yaw: 0.85, pitch: 0.35, dist: 8, clipped: true }],
  ['icefall', 1200, 1500, L.c1 - 900, 0, 8.5, { pitch: 0.2, dist: 6.5 }],
  ['lhotse-face', 1200, 1500, L.c2 + 900, 0.7, 10.5, { yaw: 0.6, pitch: 0.32, dist: 6, clipped: true }],
  ['ladder', 1600, 900, L.ladder - 5, 0, 9, { yaw: 0.9, pitch: 0.42, dist: 5.5 }],
  ['south-col', 1600, 900, L.c4 + 15, 4, 15, { yaw: 2.2, pitch: 0.22, dist: 9 }],
  ['western-cwm', 1600, 900, L.c1 + 1200, 0, 10, { pitch: 0.1, dist: 9 }],
  ['summit-ridge', 1200, 1500, L.len - 60, 0, 9, { pitch: 0.28, dist: 7, sherpa: 14 }],
];
for (const [name, w, h, s, lat, hour, cam] of shots) {
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(([s, lat, hour, cam]) => { window.__place(s, lat, hour, cam); window.game.terrainMesh.buildAll(window.game.camera.position); }, [s, lat, hour, cam]);
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 86, timeout: 180000 });
  console.log('shot', name);
}
await browser.close();
