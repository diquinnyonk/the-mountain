/**
 * A small behaviour tree library.
 *
 * Nodes return SUCCESS, FAILURE or RUNNING each tick. Composites:
 *  - Sequence: runs children in order; resumes a RUNNING child next tick.
 *  - Selector: priority fallback, re-evaluated from the top every tick so
 *    urgent branches (danger, storms) pre-empt lower ones; a pre-empted
 *    RUNNING child is halted.
 *  - Parallel: ticks all children; succeeds/fails by policy.
 * Decorators: Inverter, Succeeder, Repeat, Cooldown, Timeout, Guard.
 * Leaves: Condition (boolean) and Action (returns a Status).
 */
export type Status = 'success' | 'failure' | 'running';
export const SUCCESS: Status = 'success';
export const FAILURE: Status = 'failure';
export const RUNNING: Status = 'running';

export interface TickContext {
  /** Game time (ms). */
  now: number;
  /** Game seconds since the last tick. */
  dt: number;
}

export abstract class BTNode<B> {
  status: Status | null = null;
  constructor(readonly name: string) {}
  tick(bb: B, ctx: TickContext): Status {
    this.status = this.run(bb, ctx);
    return this.status;
  }
  protected abstract run(bb: B, ctx: TickContext): Status;
  /** Called when a RUNNING node is interrupted by a higher-priority branch. */
  halt(bb: B): void {
    this.status = null;
    void bb;
  }
  children(): BTNode<B>[] {
    return [];
  }
}

export class Sequence<B> extends BTNode<B> {
  private current = 0;
  constructor(name: string, private kids: BTNode<B>[]) {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    while (this.current < this.kids.length) {
      const s = this.kids[this.current].tick(bb, ctx);
      if (s === RUNNING) return RUNNING;
      if (s === FAILURE) {
        this.current = 0;
        return FAILURE;
      }
      this.current++;
    }
    this.current = 0;
    return SUCCESS;
  }
  halt(bb: B) {
    for (const k of this.kids) if (k.status === RUNNING) k.halt(bb);
    this.current = 0;
    super.halt(bb);
  }
  children() {
    return this.kids;
  }
}

/** Reactive sequence: re-checks every child from the start each tick (conditions guard the running action). */
export class ReactiveSequence<B> extends BTNode<B> {
  constructor(name: string, private kids: BTNode<B>[]) {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    for (let i = 0; i < this.kids.length; i++) {
      const s = this.kids[i].tick(bb, ctx);
      if (s !== SUCCESS) {
        for (let j = i + 1; j < this.kids.length; j++) if (this.kids[j].status === RUNNING) this.kids[j].halt(bb);
        return s;
      }
    }
    return SUCCESS;
  }
  halt(bb: B) {
    for (const k of this.kids) if (k.status === RUNNING) k.halt(bb);
    super.halt(bb);
  }
  children() {
    return this.kids;
  }
}

export class Selector<B> extends BTNode<B> {
  private running: BTNode<B> | null = null;
  constructor(name: string, private kids: BTNode<B>[]) {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    for (const k of this.kids) {
      const s = k.tick(bb, ctx);
      if (s === FAILURE) continue;
      if (this.running && this.running !== k) this.running.halt(bb);
      this.running = s === RUNNING ? k : null;
      return s;
    }
    if (this.running) this.running.halt(bb);
    this.running = null;
    return FAILURE;
  }
  halt(bb: B) {
    this.running?.halt(bb);
    this.running = null;
    super.halt(bb);
  }
  children() {
    return this.kids;
  }
}

export class Parallel<B> extends BTNode<B> {
  constructor(name: string, private kids: BTNode<B>[], private policy: 'all' | 'one' = 'all') {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    let ok = 0, fail = 0;
    for (const k of this.kids) {
      const s = k.tick(bb, ctx);
      if (s === SUCCESS) ok++;
      else if (s === FAILURE) fail++;
    }
    if (this.policy === 'one') {
      if (ok > 0) return this.finish(bb, SUCCESS);
      if (fail === this.kids.length) return FAILURE;
    } else {
      if (fail > 0) return this.finish(bb, FAILURE);
      if (ok === this.kids.length) return SUCCESS;
    }
    return RUNNING;
  }
  private finish(bb: B, s: Status) {
    for (const k of this.kids) if (k.status === RUNNING) k.halt(bb);
    return s;
  }
  children() {
    return this.kids;
  }
}

export class Inverter<B> extends BTNode<B> {
  constructor(private child: BTNode<B>, name = 'Not') {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    const s = this.child.tick(bb, ctx);
    return s === RUNNING ? RUNNING : s === SUCCESS ? FAILURE : SUCCESS;
  }
  children() {
    return [this.child];
  }
}

export class Succeeder<B> extends BTNode<B> {
  constructor(private child: BTNode<B>, name = 'AlwaysSucceed') {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    const s = this.child.tick(bb, ctx);
    return s === RUNNING ? RUNNING : SUCCESS;
  }
  children() {
    return [this.child];
  }
}

export class Repeat<B> extends BTNode<B> {
  private count = 0;
  constructor(private child: BTNode<B>, private times: number, name = 'Repeat') {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    const s = this.child.tick(bb, ctx);
    if (s === RUNNING) return RUNNING;
    if (s === FAILURE) {
      this.count = 0;
      return FAILURE;
    }
    if (++this.count >= this.times) {
      this.count = 0;
      return SUCCESS;
    }
    return RUNNING;
  }
  children() {
    return [this.child];
  }
}

/** After the child succeeds, fail for `cooldownMs` of game time. */
export class Cooldown<B> extends BTNode<B> {
  private readyAt = -Infinity;
  constructor(private child: BTNode<B>, private cooldownMs: number, name = 'Cooldown') {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    if (ctx.now < this.readyAt) return FAILURE;
    const s = this.child.tick(bb, ctx);
    if (s === SUCCESS) this.readyAt = ctx.now + this.cooldownMs;
    return s;
  }
  children() {
    return [this.child];
  }
}

/** Fail the child if it keeps RUNNING longer than `limitMs` of game time. */
export class Timeout<B> extends BTNode<B> {
  private startedAt: number | null = null;
  constructor(private child: BTNode<B>, private limitMs: number, name = 'Timeout') {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    this.startedAt ??= ctx.now;
    if (ctx.now - this.startedAt > this.limitMs) {
      this.child.halt(bb);
      this.startedAt = null;
      return FAILURE;
    }
    const s = this.child.tick(bb, ctx);
    if (s !== RUNNING) this.startedAt = null;
    return s;
  }
  halt(bb: B) {
    this.startedAt = null;
    this.child.halt(bb);
    super.halt(bb);
  }
  children() {
    return [this.child];
  }
}

export class Condition<B> extends BTNode<B> {
  constructor(name: string, private fn: (bb: B, ctx: TickContext) => boolean) {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    return this.fn(bb, ctx) ? SUCCESS : FAILURE;
  }
}

export class Action<B> extends BTNode<B> {
  constructor(name: string, private fn: (bb: B, ctx: TickContext) => Status, private onHalt?: (bb: B) => void) {
    super(name);
  }
  protected run(bb: B, ctx: TickContext): Status {
    return this.fn(bb, ctx);
  }
  halt(bb: B) {
    this.onHalt?.(bb);
    super.halt(bb);
  }
}

/** Builder helpers for readable tree definitions. */
export const bt = {
  seq: <B>(name: string, ...kids: BTNode<B>[]) => new Sequence<B>(name, kids),
  rseq: <B>(name: string, ...kids: BTNode<B>[]) => new ReactiveSequence<B>(name, kids),
  sel: <B>(name: string, ...kids: BTNode<B>[]) => new Selector<B>(name, kids),
  par: <B>(name: string, policy: 'all' | 'one', ...kids: BTNode<B>[]) => new Parallel<B>(name, kids, policy),
  not: <B>(child: BTNode<B>) => new Inverter<B>(child, `Not ${child.name}`),
  ok: <B>(child: BTNode<B>) => new Succeeder<B>(child),
  cond: <B>(name: string, fn: (bb: B, ctx: TickContext) => boolean) => new Condition<B>(name, fn),
  act: <B>(name: string, fn: (bb: B, ctx: TickContext) => Status, onHalt?: (bb: B) => void) => new Action<B>(name, fn, onHalt),
  cooldown: <B>(child: BTNode<B>, ms: number) => new Cooldown<B>(child, ms, `Cooldown(${child.name})`),
  timeout: <B>(child: BTNode<B>, ms: number) => new Timeout<B>(child, ms, `Timeout(${child.name})`),
  repeat: <B>(child: BTNode<B>, n: number) => new Repeat<B>(child, n),
};

/** A tree plus its blackboard. */
export class BehaviourTree<B> {
  constructor(readonly root: BTNode<B>, readonly blackboard: B) {}
  tick(ctx: TickContext): Status {
    return this.root.tick(this.blackboard, ctx);
  }
  /** Names of nodes on the currently active path (for the debug overlay). */
  activePath(): string[] {
    const path: string[] = [];
    let node: BTNode<B> | undefined = this.root;
    while (node) {
      path.push(node.name);
      const kids: BTNode<B>[] = node.children();
      node = kids.find((k) => k.status === RUNNING) ??
        [...kids].reverse().find((k) => k.status === SUCCESS && !(k instanceof Condition));
      if (node && node.status !== RUNNING && node.status !== SUCCESS) break;
    }
    return path;
  }
}
