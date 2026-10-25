/** A 4 L carbon cylinder at ~270 bar holds roughly 1,080 L of oxygen. */
export const BOTTLE_LITRES = 1080;
export const FLOW_STEPS = [0, 0.5, 1, 1.5, 2, 3, 4];

export class Gear {
  /** Full spare cylinders carried. */
  bottles = 0;
  /** Litres left in the cylinder on the regulator (0 when none fitted). */
  litres = 0;
  flowLpm = 0;
  water = 1.5;
  waterMax = 2;
  rations = 6;
  dex = 2;
  nifedipine = 2;
  downSuit = false;
  goggles = true;
  headlamp = false;
  headlampBattery = 1;

  get o2Flowing(): number {
    return this.litres > 0 ? this.flowLpm : 0;
  }

  get packKg(): number {
    return 8 + (this.litres > 0 ? 3.5 : 0) + this.bottles * 3.5 + this.water + this.rations * 0.25 + (this.downSuit ? 1.5 : 0);
  }

  /** Hours of oxygen left at the current flow (including spares). */
  get o2HoursLeft(): number {
    if (this.flowLpm <= 0) return Infinity;
    return (this.litres + this.bottles * BOTTLE_LITRES) / this.flowLpm / 60;
  }

  /** Consume oxygen for dt game seconds. Returns true if the cylinder just ran out. */
  consume(dtSec: number): boolean {
    if (this.litres <= 0 || this.flowLpm <= 0) return false;
    this.litres -= (this.flowLpm * dtSec) / 60;
    if (this.litres <= 0) {
      this.litres = 0;
      return true;
    }
    return false;
  }

  /** Fit a fresh cylinder from the spares. */
  swapBottle(): boolean {
    if (this.bottles <= 0) return false;
    this.bottles--;
    this.litres = BOTTLE_LITRES;
    return true;
  }

  stepFlow(dir: number) {
    const i = FLOW_STEPS.indexOf(this.flowLpm);
    this.flowLpm = FLOW_STEPS[Math.max(0, Math.min(FLOW_STEPS.length - 1, (i < 0 ? 0 : i) + dir))];
  }
}
