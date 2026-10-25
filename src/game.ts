import * as THREE from 'three';
import { loadTerrain, type Terrain } from './world/heightmap';
import { Route } from './world/route';
import { buildLayout, sectionAt, type RouteLayout } from './world/sections';
import { TerrainMesh } from './world/terrainMesh';
import { Features } from './world/features';
import { SkySystem } from './world/sky';
import { SnowParticles } from './world/particles';
import { Input } from './player/input';
import { AudioEngine } from './audio/audio';
import { Hud } from './ui/hud';
import { PlanningScreen, EXPEDITION_DAYS, type ExpeditionSettings } from './ui/planning';
import { DebugPanel } from './ui/debug';
import { $, showScreen, setLoading, esc } from './ui/screens';
import { Expedition, type SaveData } from './expedition';
import { loadWeather, type WeatherLoad } from './weather/openmeteo';
import { formatLocalTime } from './core/clock';
import { HOUR } from './core/clock';
import type { WeatherSample } from './weather/model';
import { BOTTLE_LITRES } from './player/gear';
import { TouchControls, isTouchDevice, touchPrompt } from './ui/touch';

type Mode = 'menu' | 'play' | 'pause' | 'camp' | 'dialog' | 'end';

const CALM: WeatherSample = {
  time: 0, altitude: 0, tempC: -10, windKmh: 15, gustKmh: 20, windDirDeg: 270, humidity: 40, cloudAtAltitude: 0.1,
  cloudBaseBelow: null, cloudBelowCover: 0, precipMmH: 0, snowfallCmH: 0, visibilityM: 60000, windChillC: -16,
  stormLevel: 0, event: null, source: 'synthetic',
};

/** Boots the renderer and world, runs the frame loop, and drives the menus. */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input: Input;
  readonly audio = new AudioEngine();
  readonly hud = new Hud();
  readonly sky = new SkySystem();
  readonly snow = new SnowParticles();
  terrain!: Terrain;
  route!: Route;
  layout!: RouteLayout;
  terrainMesh!: TerrainMesh;
  features!: Features;
  planning!: PlanningScreen;
  debug: DebugPanel;
  exp: Expedition | null = null;
  mode: Mode = 'menu';
  showBT = false;
  private last = performance.now();
  private realTime = 0;
  private titleAngle = 0;
  private lastSettings: { s: ExpeditionSettings; w: WeatherLoad } | null = null;
  ready = false;
  readonly touch: TouchControls | null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    const touch = isTouchDevice();
    // Phones and tablets get a lighter renderer.
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.25 : 1.75));
    if (touch) this.sky.sun.shadow.mapSize.set(1024, 1024);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.4, 120000);
    this.scene.fog = this.sky.fog;
    this.scene.add(this.sky.group, this.snow.points);
    this.input = new Input(canvas);
    this.touch = touch ? new TouchControls(this.input, canvas) : null;
    this.debug = new DebugPanel(this.debugActions());
    addEventListener('resize', () => {
      this.renderer.setSize(innerWidth, innerHeight, false);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
    addEventListener('pointerdown', () => this.audio.init(), { once: true });
    addEventListener('keydown', () => this.audio.init(), { once: true });
    this.wireMenus();
  }

  async boot() {
    setLoading('Loading Everest…', 'Elevation data for the Khumbu, Western Cwm, Lhotse Face and summit ridge.');
    this.terrain = await loadTerrain(import.meta.env.BASE_URL + 'terrain/');
    this.route = new Route(this.terrain);
    this.layout = buildLayout(this.route);
    this.terrainMesh = new TerrainMesh(this.terrain, this.touch ? 0.6 : 1);
    this.scene.add(this.terrainMesh.group);
    this.features = new Features(this.route, this.layout);
    this.scene.add(this.features.group);
    this.planning = new PlanningScreen(() => ({
      length: this.route.length,
      c1: this.layout.landmarks.c1.s,
      landmarks: Object.values(this.layout.landmarks).map((l) => [l.s, l.name] as [number, string]),
    }));
    this.planning.onStart = (s, w) => this.start(s, w);
    this.titleCamera(0);
    this.terrainMesh.buildAll(this.camera.position);
    this.ready = true;
    $('btn-continue').hidden = !Expedition.loadSave();
    showScreen('title');
    requestAnimationFrame(this.loop);
  }

  private wireMenus() {
    $('btn-new').onclick = () => {
      showScreen('plan');
      const input = $<HTMLInputElement>('plan-date');
      if (!input.value) {
        input.value = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
        this.planning.load(input.value);
      }
    };
    $('btn-help').onclick = () => showScreen('help');
    for (const b of document.querySelectorAll<HTMLButtonElement>('.back')) b.onclick = () => showScreen('title');
    $('btn-continue').onclick = () => this.continueSaved();
    $('btn-resume').onclick = () => this.resume();
    $('btn-calloff').onclick = () => {
      this.exp?.callOff();
      this.resume();
    };
    $('btn-toggle-bt').onclick = () => {
      this.showBT = !this.showBT;
      $('btn-toggle-bt').textContent = this.showBT ? 'Hide NPC behaviour trees' : 'Show NPC behaviour trees';
    };
    $('btn-mute').onclick = () => {
      this.audio.setMuted(!this.audio.muted);
      $('btn-mute').textContent = this.audio.muted ? 'Unmute sound' : 'Mute sound';
    };
    $('btn-quit').onclick = () => {
      this.exp?.save();
      this.quitToTitle();
    };
    $('btn-camp-close').onclick = () => this.closeCamp();
    $('btn-dialog-close').onclick = () => this.resume();
    $('btn-retry').onclick = () => {
      if (this.lastSettings) this.start(this.lastSettings.s, this.lastSettings.w);
    };
    $('btn-newdate').onclick = () => {
      this.quitToTitle();
      showScreen('plan');
    };
  }

  private quitToTitle() {
    this.exp?.dispose();
    this.exp = null;
    this.mode = 'menu';
    this.hud.show(false);
    $('bt-labels').innerHTML = '';
    $('btn-continue').hidden = !Expedition.loadSave();
    showScreen('title');
  }

  start(settings: ExpeditionSettings, w: WeatherLoad, save?: SaveData) {
    this.exp?.dispose();
    this.lastSettings = { s: settings, w };
    this.exp = new Expedition({
      scene: this.scene, camera: this.camera, terrain: this.terrain, route: this.route, layout: this.layout,
      features: this.features, audio: this.audio,
    }, settings, w.timeline, save);
    this.camera.position.copy(this.exp.player.pos).add(new THREE.Vector3(0, 4, -8));
    this.terrainMesh.buildAll(this.camera.position);
    this.mode = 'play';
    showScreen(null);
    this.hud.show(true);
    this.fade();
  }

  private async continueSaved() {
    const save = Expedition.loadSave();
    if (!save) return;
    setLoading('Loading your expedition…', 'Reloading the weather for ' + save.settings.date);
    const w = await loadWeather(save.settings.date, EXPEDITION_DAYS);
    this.start(save.settings, w, save);
  }

  private resume() {
    this.mode = 'play';
    if (this.exp?.player.mode === 'tent') this.exp.leaveCamp();
    showScreen(null);
  }

  private fade() {
    const f = $('fx-fade');
    f.style.transition = 'none';
    f.style.opacity = '1';
    requestAnimationFrame(() => {
      f.style.transition = 'opacity 0.8s';
      f.style.opacity = '0';
    });
  }

  private openCamp() {
    const exp = this.exp!;
    if (!exp.enterCamp()) return;
    this.mode = 'camp';
    $('camp-result').textContent = '';
    this.renderCamp();
    showScreen('camp');
  }

  private renderCamp() {
    const exp = this.exp!;
    const camp = exp.campHere();
    const p = exp.player, ph = p.physiology, g = p.gear;
    $('camp-title').textContent = camp ? `${camp.name} · ${Math.round(p.altitude).toLocaleString()} m` : 'Camp';
    const w = exp.weather.sample(exp.clock.time, p.altitude);
    const top = exp.weather.sample(exp.clock.time, 8849);
    $('camp-status').innerHTML = `${formatLocalTime(exp.clock.time)} · outside ${Math.round(w.tempC)}°C, wind ${Math.round(w.windKmh)} km/h · summit wind ${Math.round(top.windKmh)} km/h<br>
      SpO₂ ${Math.round(ph.spo2)}% · energy ${Math.round(ph.energy)} · hydration ${Math.round(ph.hydration)} · acclimatised to ${Math.round(ph.acclimAlt).toLocaleString()} m<br>
      Water ${g.water.toFixed(1)} L · ${g.rations} rations · O₂ ${Math.round(g.litres)} L + ${g.bottles} spare (${(g.bottles * BOTTLE_LITRES + g.litres).toFixed(0)} L) · ${g.downSuit ? 'down suit on' : 'no down suit'}`;
    const acts = exp.campActions();
    const box = $('camp-actions');
    box.innerHTML = '';
    for (const a of acts) {
      const b = document.createElement('button');
      b.textContent = a.label + (a.disabled ? ` (${a.disabled})` : '');
      b.disabled = !!a.disabled;
      b.onclick = () => {
        const text = a.run();
        $('camp-result').textContent = text;
        if (exp.player.dead) {
          showScreen(null);
          this.mode = 'play';
          return;
        }
        if (a.closes || !exp.campHere()) {
          this.mode = 'dialog';
          $('dialog-title').textContent = a.label;
          $('dialog-text').textContent = text;
          showScreen('dialog');
          return;
        }
        exp.player.mode = 'tent';
        this.renderCamp();
      };
      box.appendChild(b);
    }
  }

  private closeCamp() {
    this.exp?.leaveCamp();
    this.mode = 'play';
    showScreen(null);
  }

  private showEnd() {
    const exp = this.exp!;
    const e = exp.ending!;
    this.mode = 'end';
    this.hud.show(false);
    $('end-eyebrow').textContent = e.kind === 'death' ? 'Expedition over' : e.kind === 'summit' ? 'Success' : 'You came home';
    $('end-title').textContent = e.title;
    $('end-text').textContent = e.text;
    $('end-stats').innerHTML = Object.entries(exp.stats()).map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
    $('end-journal').innerHTML = exp.journal.map((j) =>
      `<li><time>${new Date(j.time + 5.75 * HOUR).toISOString().slice(5, 16).replace('T', ' ')}</time>${esc(j.text)}</li>`).join('');
    showScreen('end');
  }

  private titleCamera(dt: number) {
    this.titleAngle += dt * 0.02;
    const summit = this.route.pointAt(this.route.length);
    const r = 9000;
    this.camera.position.set(summit.x + Math.sin(this.titleAngle) * r - 3000, 7300, summit.z + Math.cos(this.titleAngle) * r);
    this.camera.lookAt(summit.x, 7600, summit.z);
  }

  private loop = (t: number) => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.realTime += dt;
    const input = this.input;
    const exp = this.exp;

    if (input.wasPressed('Backquote')) this.debug.toggle();
    if (exp && this.mode === 'play') {
      if (input.wasPressed('Escape')) {
        this.mode = 'pause';
        showScreen('pause');
      } else if (input.wasPressed('KeyB')) {
        this.showBT = !this.showBT;
      } else if (input.wasPressed('KeyC') && exp.campHere()) {
        this.openCamp();
      }
    } else if (exp && (this.mode === 'pause' || this.mode === 'dialog') && input.wasPressed('Escape')) {
      this.resume();
    } else if (exp && this.mode === 'camp' && input.wasPressed('Escape')) {
      this.closeCamp();
    }

    if (this.touch) {
      this.touch.show(!!exp && this.mode === 'play');
      if (exp && this.mode === 'play') {
        const kind = exp.contextAction();
        this.touch.setAction(kind, kind === 'ladder' ? (exp.player.ladderClipped ? 'Unclip line' : 'Clip line') : undefined);
      }
    }
    let weather = CALM;
    let focus = this.camera.position;
    let timeRate = 1;
    if (exp && this.mode === 'play') {
      input.enabled = true;
      exp.frame(dt, input, this.sky.daylight);
      if (exp.dialog) {
        this.mode = 'dialog';
        $('dialog-title').textContent = exp.dialog.title;
        $('dialog-text').textContent = exp.dialog.text;
        exp.dialog = null;
        showScreen('dialog');
      }
      if (exp.ending) this.showEnd();
    }
    if (exp) {
      weather = exp.weatherHere;
      focus = exp.player.pos;
      timeRate = this.mode === 'play' ? exp.clock.rate : 0;
      exp.updateModel(dt);
      exp.follow.update(dt, exp.player.pos, input, exp.player.heading, exp.player.speedVisual > 0);
      exp.director.render(dt, this.camera.position, timeRate, this.showBT && this.mode === 'play', $('bt-labels'), this.camera);
    } else if (this.ready) {
      this.titleCamera(dt);
    }
    if (!this.ready) return;
    const now = exp ? exp.clock.time : Date.now();
    this.sky.update(now, focus, this.camera, weather, dt);
    this.snow.update(dt, this.camera.position, weather, this.sky.daylight);
    this.terrainMesh.update(this.camera.position);
    if (exp && this.mode === 'play') {
      const p = exp.player;
      const ahead = this.route.pointAt(Math.min(this.route.length, p.s + (exp.calledOff ? -80 : 80)));
      const bearing = (Math.atan2(ahead.x - p.pos.x, -(ahead.z - p.pos.z)) * 180) / Math.PI;
      this.hud.update(dt, {
        now: exp.clock.time, altitude: p.altitude, place: exp.placeLabel(), section: sectionAt(this.layout, p.s).name,
        timeRate, weather, physiology: p.physiology, effects: p.effects, gear: p.gear,
        prompt: this.touch ? touchPrompt(exp.contextPrompt()) : exp.contextPrompt(),
        alert: p.alert, clipped: p.clipped, cameraYaw: exp.follow.yaw, routeBearing: (bearing + 360) % 360,
        daylight: this.sky.daylight, dexActive: p.meds.dexUntil > exp.clock.time, nifActive: p.meds.nifedipineUntil > exp.clock.time,
        radio: exp.radioLog,
      }, this.realTime);
      this.audio.update(dt, {
        windKmh: weather.windKmh, breathRate: p.effects.breathRate, exertion: p.speedVisual > 0 ? 0.8 : 0.2,
        heartRate: p.effects.heartRate, spo2: p.physiology.spo2, sheltered: p.mode === 'tent', mask: p.gear.o2Flowing > 0,
      });
    }
    this.debug.update();
    this.renderer.render(this.scene, this.camera);
    input.endFrame();
  };

  private debugActions() {
    return {
      landmarks: () => this.layout ? Object.values(this.layout.landmarks).map((l) => [l.id, l.name] as [string, string]) : [],
      teleport: (id: string) => {
        const exp = this.exp;
        if (!exp) return;
        const l = this.layout.landmarks[id as keyof RouteLayout['landmarks']];
        exp.player.placeAt(Math.max(0, Math.min(this.route.length - 2, l.s - (id === 'summit' ? 30 : 0))), 2);
        if (exp.director.sherpa) exp.director.sherpa.s = Math.max(0, l.s - 6);
        exp.follow.snap();
      },
      set: (key: string, v?: number) => {
        const exp = this.exp;
        if (!exp) return;
        const ph = exp.player.physiology;
        switch (key) {
          case 'acclim': ph.acclimAlt = v!; break;
          case 'ams': ph.ams = v!; break;
          case 'hape': ph.hape = v!; break;
          case 'hace': ph.hace = v!; break;
          case 'energy': ph.energy = v!; ph.hydration = 100; break;
          case 'o2': exp.player.gear.bottles += 2; break;
          case 'god': exp.god = !exp.god; break;
          case 'ropes': exp.director.ropeFront.s = this.route.length; break;
          case 'time': exp.clock.advance(v! * 3600); break;
          case 'storm': exp.weather.events.push({ kind: 'squall', start: exp.clock.time, end: exp.clock.time + 3 * HOUR, windAdd: 60, precipAdd: 2, visibilityCap: 60 }); break;
          case 'serac': exp.hazards.spawn('serac', exp.player.s + 12, 0, 16, 4.5); break;
          case 'avalanche': exp.hazards.spawn('avalanche', exp.player.s + 30, 0, 45, 7); break;
        }
      },
      status: () => {
        const exp = this.exp;
        if (!exp) return '';
        const p = exp.player, ph = p.physiology;
        return `s=${p.s.toFixed(0)} / ${this.route.length.toFixed(0)} lat=${p.hit.lateral.toFixed(1)} mode=${p.mode} ` +
          `acclim=${ph.acclimAlt.toFixed(0)} eff=${ph.effAltitude.toFixed(0)} ams=${ph.ams.toFixed(2)} hape=${ph.hape.toFixed(2)} hace=${ph.hace.toFixed(2)} ` +
          `ropes=${exp.world.ropeFixedTo.toFixed(0)} snow=${exp.hazards.snowLoad.toFixed(1)}cm god=${exp.god}`;
      },
    };
  }
}
