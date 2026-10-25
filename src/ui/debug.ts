import { $ } from './screens';

export interface DebugActions {
  teleport(id: string): void;
  landmarks(): [string, string][];
  set(key: 'acclim' | 'hape' | 'hace' | 'ams' | 'energy' | 'o2' | 'storm' | 'serac' | 'avalanche' | 'time' | 'god' | 'ropes', v?: number): void;
  status(): string;
}

/** Developer panel (backtick): teleport between camps, force conditions and weather. */
export class DebugPanel {
  open = false;
  constructor(private actions: DebugActions) {}

  toggle() {
    this.open = !this.open;
    const el = $('debug');
    el.hidden = !this.open;
    if (!this.open) return;
    el.className = 'panel';
    el.innerHTML = `
      <b>Debug</b>
      <div class="row">Teleport:<br>${this.actions.landmarks().map(([id, n]) => `<button data-tp="${id}">${n}</button>`).join('')}</div>
      <div class="row">Body:<br>
        <button data-set="acclim" data-v="7200">Acclimatise 7,200 m</button>
        <button data-set="ams" data-v="0.6">AMS</button>
        <button data-set="hape" data-v="0.3">HAPE</button>
        <button data-set="hace" data-v="0.3">HACE</button>
        <button data-set="energy" data-v="100">Full energy</button>
        <button data-set="o2">+2 O₂ bottles</button>
        <button data-set="god">Toggle invulnerable</button></div>
      <div class="row">World:<br>
        <button data-set="storm">Squall now</button>
        <button data-set="serac">Serac fall</button>
        <button data-set="avalanche">Avalanche</button>
        <button data-set="ropes">Fix all ropes</button>
        <button data-set="time" data-v="6">+6 h</button></div>
      <div class="row" id="debug-status"></div>`;
    el.onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.tp) this.actions.teleport(b.dataset.tp);
      if (b.dataset.set) this.actions.set(b.dataset.set as never, b.dataset.v ? Number(b.dataset.v) : undefined);
    };
  }

  update() {
    if (!this.open) return;
    const el = document.getElementById('debug-status');
    if (el) el.textContent = this.actions.status();
  }
}
