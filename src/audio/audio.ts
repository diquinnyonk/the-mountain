/** Procedural sound: wind, breathing, heartbeat, coughs, rumbles, radio squelch. No audio files. */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private breathGain!: GainNode;
  private breathFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private breathPhase = 0;
  private heartPhase = 0;
  muted = false;

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);
    // Brown noise buffer, reused by everything.
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const wind = this.loop();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);

    const breath = this.loop();
    this.breathFilter = ctx.createBiquadFilter();
    this.breathFilter.type = 'bandpass';
    this.breathFilter.frequency.value = 900;
    this.breathFilter.Q.value = 1.2;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    breath.connect(this.breathFilter).connect(this.breathGain).connect(this.master);
  }

  private loop() {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.value = m ? 0 : 0.6;
  }

  update(dt: number, p: { windKmh: number; breathRate: number; exertion: number; heartRate: number; spo2: number; sheltered: boolean; mask: boolean }) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') {
      ctx?.resume().catch(() => {});
      return;
    }
    const t = ctx.currentTime;
    const gust = 0.85 + 0.15 * Math.sin(t * 0.7) * Math.sin(t * 0.23);
    const windLevel = Math.min(1, p.windKmh / 120) * gust * (p.sheltered ? 0.35 : 1);
    this.windGain.gain.setTargetAtTime(windLevel * 0.5, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(250 + windLevel * 900, t, 0.3);

    // Breathing: inhale/exhale cycle, faster and louder with exertion and hypoxia.
    const rate = p.breathRate / 60;
    this.breathPhase += dt * rate;
    const cyc = this.breathPhase % 1;
    const env = cyc < 0.4 ? Math.sin((cyc / 0.4) * Math.PI) : 0.7 * Math.sin(((cyc - 0.4) / 0.6) * Math.PI);
    const loud = Math.min(0.35, 0.04 + p.exertion * 0.12 + Math.max(0, 85 - p.spo2) * 0.006);
    this.breathGain.gain.setTargetAtTime(Math.max(0, env) * loud, t, 0.05);
    this.breathFilter.frequency.setTargetAtTime(p.mask ? 500 : cyc < 0.4 ? 1100 : 750, t, 0.1);

    // Heartbeat when it's pounding.
    if (p.heartRate > 115 || p.spo2 < 65) {
      const before = this.heartPhase % 1;
      this.heartPhase += dt * (p.heartRate / 60);
      if (this.heartPhase % 1 < before) this.thump(t);
    }
  }

  private thump(t: number) {
    const ctx = this.ctx!;
    for (const [dt, f] of [[0, 55], [0.16, 48]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.25, t + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.15);
      o.connect(g).connect(this.master);
      o.start(t + dt);
      o.stop(t + dt + 0.2);
    }
  }

  private burst(freq: number, q: number, dur: number, vol: number, delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  cough() {
    for (let k = 0; k < 3; k++) this.burst(600 + Math.random() * 300, 2, 0.25, 0.6, k * 0.35);
  }
  crunch() {
    this.burst(2500, 0.8, 0.08, 0.08);
  }
  clip() {
    this.burst(4500, 8, 0.05, 0.3);
    this.burst(3800, 8, 0.05, 0.25, 0.08);
  }
  rumble(seconds: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 120;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.2, t + seconds * 0.7);
    g.gain.linearRampToValueAtTime(0, t + seconds + 3);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(t + seconds + 3.2);
  }
  radio() {
    this.burst(1800, 1, 0.18, 0.15);
  }
}
