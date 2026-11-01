// Records a gameplay trailer for social media at 30 fps.
// VIDEO_FORMAT=portrait (1080x1920, default) | square (1080x1080) | landscape (1920x1080).
// VIDEO_CUT=short makes a 15 second cut instead of the full trailer.
// The game is stepped frame by frame with a fixed timestep, so it works even
// under slow software rendering. Needs a production build served by `vite preview`.
// Usage: npm run build && npx vite preview --port 4173 & node tools/record-video.mjs out.mp4 [baseUrl]
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? 'the-mountain-trailer.mp4';
const BASE = process.argv[3] ?? 'http://localhost:4173/';
const FPS = 30;
const SCALE = Number(process.env.VIDEO_SCALE ?? 1);
const FORMAT = process.env.VIDEO_FORMAT ?? 'portrait';
const SHORT = process.env.VIDEO_CUT === 'short';
const SIZES = {
  portrait: { view: [540, 960], dsf: 2, out: [1080, 1920] },
  square: { view: [720, 720], dsf: 1.5, out: [1080, 1080] },
  landscape: { view: [960, 540], dsf: 2, out: [1920, 1080] },
};
const SIZE = SIZES[FORMAT];
if (!SIZE) throw new Error(`Unknown VIDEO_FORMAT ${FORMAT}`);
// Seconds per shot: [full trailer, short cut]. A zero skips the shot.
const SECS = {
  title: [3, 1], icefall: [5, 2.5], ladder: [4, 2], cwm: [4, 0], lhotse: [4, 2], sunrise: [6, 3], summit: [5, 2], end: [3.5, 2.5],
};
const sec = (k) => SECS[k][SHORT ? 1 : 0] * FPS;
const FRAMES = join(dirname(OUT), 'frames');
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: SIZE.view[0], height: SIZE.view[1] }, deviceScaleFactor: SIZE.dsf, hasTouch: FORMAT !== 'landscape', isMobile: FORMAT !== 'landscape' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.route(/open-meteo\.com/, (r) => r.abort());
await page.goto(BASE);
await page.waitForSelector('#screen-title:not([hidden])', { timeout: 180000 });

// Take over the frame loop: from here on, frames advance only when we say so.
await page.evaluate(() => {
  window.requestAnimationFrame = () => 0;
  window.__t = performance.now();
  window.__step = (hook) => {
    if (hook) hook();
    window.__t += 1000 / 30;
    window.game.loop(window.__t);
  };
  window.game.renderer.setPixelRatio(1.5);
});

let frame = 0;
const shoot = async (n, hook = 'null') => {
  if (n <= 0) return;
  n = Math.max(1, Math.round(n * SCALE));
  for (let i = 0; i < n; i++) {
    await page.evaluate(`window.__step(${hook})`);
    await page.screenshot({ path: join(FRAMES, `${String(frame++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90, timeout: 180000 });
  }
  console.log(`frame ${frame}`);
};
const warm = (n = 8) => page.evaluate((n) => {
  const g = window.game;
  g.terrainMesh.buildAll(g.camera.position);
  for (let i = 0; i < n; i++) window.__step();
}, n);

// 1. Title screen.
await shoot(sec('title'));

// Start an expedition and set the scene: clear skies, invulnerable, Pemba with us.
await page.evaluate(() => document.getElementById('btn-new').click());
await page.fill('#plan-date', '2019-05-18');
await page.dispatchEvent('#plan-date', 'change');
await page.waitForSelector('#btn-start:not([disabled])', { timeout: 60000 });
await page.evaluate(() => {
  document.querySelector('#plan-start button[data-v="c2"]').click();
  document.getElementById('btn-start').click();
  const g = window.game, e = g.exp;
  e.god = true;
  e.director.ropeFront.s = g.route.length;
  const orig = e.weather.sample.bind(e.weather);
  e.weather.sample = (t, a) => {
    const w = orig(t, a);
    Object.assign(w, { windKmh: 22, gustKmh: 30, cloudAtAltitude: 0.05, snowfallCmH: 0, stormLevel: 0, event: null, visibilityM: 80000 });
    return w;
  };
  e.radioLog.length = 0;
  // The fade-in waits on requestAnimationFrame, which we've taken over: clear it now.
  const fade = document.getElementById('fx-fade');
  fade.style.transition = 'none';
  fade.style.opacity = '0';
  window.__walk = () => {
    const p = e.player;
    if (p.mode === 'slip' || p.mode === 'down' || p.mode === 'rest') p.mode = 'walk';
    if (p.mode === 'ladder') { p.ladderClipped = true; p.balance *= 0.3; }
    g.input.moveX = 0;
    g.input.moveY = -1;
    const knob = document.querySelector('#touch .knob');
    if (knob) knob.style.transform = 'translate(0px, -44px)';
    document.querySelector('#touch .stick')?.classList.add('active');
  };
  // A clean frame: no prompts or radio over the action.
  const style = document.createElement('style');
  style.textContent = '#hud-prompt, #hud-radio, #hud-conditions { display: none !important; }';
  document.head.appendChild(style);
  window.__place = (s, lat, hour, opts = {}) => {
    const p = e.player;
    p.placeAt(s, lat);
    // A well-acclimatised climber, on oxygen high up, so no hypoxia effects cloud the shot.
    Object.assign(p.physiology, { acclimAlt: 7400, energy: 90, hydration: 90, ams: 0, hape: 0, hace: 0, hypoxicDebt: 0, coreTemp: 37, uvDose: 0 });
    p.gear.litres = 1080;
    p.gear.flowLpm = p.pos.y > 7000 ? 3 : 0;
    p.clipped = !!opts.clipped;
    e.clock.time = e.clock.nextLocalHour(hour);
    const sh = e.director.sherpa;
    if (sh) { sh.s = Math.min(g.route.length, s + 12); sh.lateral = 0.3; }
    e.follow.yaw = p.heading + (opts.yaw ?? 0);
    e.follow.pitch = opts.pitch ?? 0.28;
    e.follow.distance = opts.dist ?? 6;
    e.follow.snap();
  };
});
const L = await page.evaluate(() => {
  const g = window.game, l = g.layout;
  return { c1: l.landmarks.c1.s, c2: l.landmarks.c2.s, c3: l.landmarks.c3.s, ss: l.landmarks.southSummit.s, len: g.route.length, ladder: l.ladders[3].s };
});

// 2. The Khumbu Icefall, Pemba leading.
await page.evaluate((s) => window.__place(s, 0, 8.5, { pitch: 0.22, dist: 6.5 }), L.c1 - 900);
await warm();
await shoot(sec('icefall'), 'window.__walk');

// 3. A ladder over a crevasse.
await page.evaluate((s) => window.__place(s - 7, 0, 9, { pitch: 0.45, dist: 5, yaw: 0.5 }), L.ladder);
await warm();
await shoot(sec('ladder'), 'window.__walk');

// 4. The Western Cwm with the Lhotse Face ahead.
if (sec('cwm') > 0) {
  await page.evaluate((s) => window.__place(s, 0, 10, { pitch: 0.12, dist: 9 }), L.c1 + 1200);
  await warm();
}
await shoot(sec('cwm'), 'window.__walk');

// 5. Jumaring the Lhotse Face on the fixed line.
await page.evaluate((s) => window.__place(s, 0.7, 10.5, { clipped: true, pitch: 0.35, dist: 6, yaw: 0.6 }), L.c2 + 900);
await warm();
await shoot(sec('lhotse'), 'window.__walk');

// 6. The summit ridge at sunrise (alpenglow).
await page.evaluate((s) => {
  const g = window.game, e = g.exp;
  window.__place(s, 0.7, 4.5, { clipped: true, pitch: 0.38, dist: 8, yaw: 0.85 });
  let t = e.clock.time;
  g.sky.update(t, e.player.pos, g.camera, e.weatherHere, 0.016);
  while (g.sky.sunElevation < 2.5) { t += 60000; g.sky.update(t, e.player.pos, g.camera, e.weatherHere, 0.016); }
  e.clock.time = t;
}, L.ss + 25);
await warm();
await shoot(sec('sunrise'), `() => { window.__walk(); window.game.exp.clock.time -= 1000 * 3; }`);

// 7. On the summit: orbit around the climber.
await page.evaluate((len) => {
  const g = window.game, e = g.exp;
  window.__place(len - 2, 0, 8, {});
  e.player.showAlert('SUMMIT OF EVEREST · 8,849 m', 30);
  const c = e.player.pos.clone();
  let a = e.player.heading + Math.PI;
  e.follow.update = () => {
    a += 0.012;
    g.camera.position.set(c.x + Math.sin(a) * 9, c.y + 3.2, c.z + Math.cos(a) * 9);
    g.camera.lookAt(c.x, c.y + 1.2, c.z);
  };
  window.__still = () => { g.input.moveY = 0; const k = document.querySelector('#touch .knob'); if (k) k.style.transform = ''; };
}, L.len);
await warm();
await shoot(sec('summit'), 'window.__still');

// 8. End card.
await page.evaluate(() => {
  document.getElementById('hud-alert').style.display = 'none';
  const card = document.createElement('div');
  card.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:radial-gradient(ellipse at center, rgba(8,12,20,0.55), rgba(8,12,20,0.92));font-family:system-ui,sans-serif;color:#eef2f7;text-align:center;padding:24px';
  card.innerHTML = `<div><div style="letter-spacing:.16em;color:#ff8a2a;font-weight:600;font-size:13px">EVEREST · SOUTH COL ROUTE</div>
    <div style="font-size:52px;font-weight:750;margin:8px 0 10px">The Mountain</div>
    <div style="font-size:17px;color:#cfd7e2;max-width:400px;margin:0 auto">Real terrain. Real weather. Altitude sickness, storms and the death zone.<br>Can you climb Everest and get back down?</div>
    <div style="margin:28px auto 0;display:inline-block;background:#ff8a2a;color:#14181f;font-weight:700;font-size:19px;padding:12px 20px;border-radius:8px">Play free: climb-the-mountain.netlify.app</div>
    <div style="margin-top:26px;font-size:14px;color:#9aa6b6">Supported by <span style="color:#ff8a2a;font-weight:600">ratemarketing.co.uk</span></div></div>`;
  document.body.appendChild(card);
});
await shoot(sec('end'), 'window.__still');

await browser.close();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, '%05d.jpg'),
  '-vf', `scale=${SIZE.out[0]}:${SIZE.out[1]}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', OUT]);
console.log(`Wrote ${OUT}`);
