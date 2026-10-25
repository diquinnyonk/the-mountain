import type { Input } from '../player/input';

export const isTouchDevice = () =>
  matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;

export type ActionKind = 'arrest' | 'clip' | 'unclip' | 'talk' | 'help' | 'camp' | 'ladder' | null;

/**
 * On-screen controls for phones and tablets: a floating joystick on the left
 * half of the screen, drag-to-look and pinch-to-zoom on the right, a context
 * action button, and buttons for everything on the keyboard.
 */
export class TouchControls {
  readonly root = document.createElement('div');
  private stick = document.createElement('div');
  private knob = document.createElement('div');
  private action: HTMLButtonElement;
  private pack: HTMLElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private looks = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private actionCode = '';

  constructor(private input: Input, canvas: HTMLElement) {
    document.body.classList.add('touch');
    this.root.id = 'touch';
    this.root.hidden = true;
    this.stick.className = 'stick';
    this.knob.className = 'knob';
    this.stick.appendChild(this.knob);
    this.root.innerHTML = `
      <button class="tbtn menu" data-tap="Escape" aria-label="Menu">☰</button>
      <div class="cluster">
        <button class="tbtn small" data-toggle-pack>Pack</button>
        <button class="tbtn small" data-tap="KeyR">Rest</button>
        <button class="tbtn small push" data-hold="ShiftLeft">Push</button>
        <button class="tbtn action" data-action>Action</button>
      </div>
      <div class="pack" hidden>
        <button class="tbtn small" data-tap="Digit1">Drink</button>
        <button class="tbtn small" data-tap="Digit2">Eat</button>
        <button class="tbtn small" data-tap="Digit3">Dex</button>
        <button class="tbtn small" data-tap="Digit4">Nifedipine</button>
        <button class="tbtn small" data-tap="BracketLeft">O₂ −</button>
        <button class="tbtn small" data-tap="BracketRight">O₂ +</button>
        <button class="tbtn small" data-tap="KeyG">Goggles</button>
        <button class="tbtn small" data-tap="KeyL">Lamp</button>
        <button class="tbtn small" data-tap="KeyT">Guide</button>
        <button class="tbtn small" data-tap="KeyB">NPC minds</button>
      </div>`;
    this.root.prepend(this.stick);
    document.body.appendChild(this.root);
    this.action = this.root.querySelector('[data-action]')!;
    this.pack = this.root.querySelector('.pack')!;

    // Buttons: tap = one key press, hold = key held while touching.
    this.root.addEventListener('touchstart', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      e.preventDefault();
      b.classList.add('down');
      if (b.dataset.tap) this.tap(b.dataset.tap);
      if (b.dataset.hold) input.press(b.dataset.hold);
      if (b.dataset.action !== undefined && this.actionCode) this.tap(this.actionCode);
      if (b.dataset.togglePack !== undefined) this.pack.hidden = !this.pack.hidden;
    }, { passive: false });
    const up = (e: TouchEvent) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      b.classList.remove('down');
      if (b.dataset.hold) input.release(b.dataset.hold);
    };
    this.root.addEventListener('touchend', up);
    this.root.addEventListener('touchcancel', up);

    // Joystick on the left half, look and pinch on the right.
    canvas.addEventListener('touchstart', (e) => {
      if (this.root.hidden) return;
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < innerWidth * 0.45 && this.stickId === null) {
          this.stickId = t.identifier;
          this.stickOrigin = { x: t.clientX, y: t.clientY };
          this.stick.style.left = `${t.clientX}px`;
          this.stick.style.top = `${t.clientY}px`;
          this.stick.classList.add('active');
        } else {
          this.looks.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
      }
      this.pinchDist = this.lookSpread();
      input.dragging = this.looks.size > 0;
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (this.root.hidden) return;
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          const dx = t.clientX - this.stickOrigin.x, dy = t.clientY - this.stickOrigin.y;
          const max = 55, len = Math.hypot(dx, dy);
          const k = len > max ? max / len : 1;
          this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
          const mag = Math.min(1, len / max);
          const dead = mag < 0.15 ? 0 : 1;
          input.moveX = len ? (dx / len) * mag * dead : 0;
          input.moveY = len ? (dy / len) * mag * dead : 0;
        } else if (this.looks.has(t.identifier)) {
          const p = this.looks.get(t.identifier)!;
          if (this.looks.size === 1) {
            input.mouseDX += (t.clientX - p.x) * 1.4;
            input.mouseDY += (t.clientY - p.y) * 1.4;
          }
          p.x = t.clientX;
          p.y = t.clientY;
        }
      }
      if (this.looks.size === 2) {
        const d = this.lookSpread();
        if (this.pinchDist > 0 && Math.abs(d - this.pinchDist) > 12) {
          input.wheel += d < this.pinchDist ? 1 : -1;
          this.pinchDist = d;
        }
      }
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          this.stickId = null;
          input.moveX = input.moveY = 0;
          this.knob.style.transform = '';
          this.stick.classList.remove('active');
        }
        this.looks.delete(t.identifier);
      }
      this.pinchDist = this.lookSpread();
      input.dragging = this.looks.size > 0;
    };
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('touchcancel', end);
  }

  private tap(code: string) {
    this.input.press(code);
    // Release on the next frame so it acts as a single press.
    requestAnimationFrame(() => requestAnimationFrame(() => this.input.release(code)));
  }

  private lookSpread() {
    const pts = [...this.looks.values()];
    return pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  }

  show(on: boolean) {
    this.root.hidden = !on;
    if (!on) {
      this.input.moveX = this.input.moveY = 0;
      this.stickId = null;
      this.looks.clear();
    }
  }

  /** Update the context button: what tapping it will do right now. */
  setAction(kind: ActionKind, label?: string) {
    const map: Record<string, [string, string]> = {
      arrest: ['Space', 'ARREST!'], clip: ['KeyE', 'Clip in'], unclip: ['KeyE', 'Unclip'], talk: ['KeyE', 'Talk'],
      help: ['KeyE', 'Help'], camp: ['KeyC', 'Tent'], ladder: ['KeyE', 'Clip line'],
    };
    const [code, text] = kind ? map[kind] : ['', 'Action'];
    this.actionCode = code;
    const t = label ?? text;
    if (this.action.textContent !== t) this.action.textContent = t;
    this.action.disabled = !kind;
    this.action.classList.toggle('urgent', kind === 'arrest');
  }
}

/** Rewrite keyboard hints in prompts for touch players. */
export function touchPrompt(text: string): string {
  return text
    .replace(/\[E\] /g, 'Action: ')
    .replace(/\[C\] /g, 'Action: ')
    .replace(/Press SPACE!/i, 'Tap ARREST!')
    .replace(/W\/S to cross, A\/D to keep balance/, 'joystick up/down to cross, left/right to balance')
    .replace(/, \[E\] clip into the handlines/, ', Action to clip the handlines')
    .replace(/\(R or move to continue\)/, '(move to continue)');
}
