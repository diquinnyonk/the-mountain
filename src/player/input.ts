/** Keyboard and mouse state. Movement keys are sampled each frame; actions are edge-triggered. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  dragging = false;
  enabled = true;
  /** Analog movement from the touch joystick, -1..1 (x right, y down). */
  moveX = 0;
  moveY = 0;

  constructor(el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code) && this.enabled) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 2) this.dragging = true;
    });
    addEventListener('mouseup', () => (this.dragging = false));
    addEventListener('mousemove', (e) => {
      if (this.dragging || document.pointerLockElement === el) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    el.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }

  /** True once per key press. */
  wasPressed(code: string): boolean {
    if (!this.enabled) return false;
    return this.pressed.has(code);
  }

  /** Mark a press as handled so nothing else reacts to it this frame. */
  consume(code: string) {
    this.pressed.delete(code);
  }

  /** Forget this frame's key presses but keep held keys (for extra simulation substeps). */
  clearPressed() {
    this.pressed.clear();
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
  }

  /** Simulated key state, for automated tests. */
  press(code: string, held = true) {
    if (held) this.down.add(code);
    else this.down.delete(code);
    this.pressed.add(code);
  }

  /** Let go of a key held by press(). */
  release(code: string) {
    this.down.delete(code);
  }
}
