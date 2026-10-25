import { describe, it, expect } from 'vitest';
import { bt, BehaviourTree, RUNNING, SUCCESS, FAILURE, type Status } from '../src/ai/bt';

const ctx = (now = 0) => ({ now, dt: 1 });

describe('behaviour trees', () => {
  it('sequence runs children in order and stops at the first failure', () => {
    const log: string[] = [];
    const leaf = (name: string, s: Status) => bt.act<object>(name, () => (log.push(name), s));
    expect(bt.seq('s', leaf('a', SUCCESS), leaf('b', FAILURE), leaf('c', SUCCESS)).tick({}, ctx())).toBe(FAILURE);
    expect(log).toEqual(['a', 'b']);
  });

  it('sequence resumes a RUNNING child without re-running earlier ones', () => {
    let aCount = 0, bCount = 0;
    const s = bt.seq<object>('s',
      bt.act('a', () => (aCount++, SUCCESS)),
      bt.act('b', () => (++bCount < 3 ? RUNNING : SUCCESS)));
    expect(s.tick({}, ctx())).toBe(RUNNING);
    expect(s.tick({}, ctx())).toBe(RUNNING);
    expect(s.tick({}, ctx())).toBe(SUCCESS);
    expect(aCount).toBe(1);
    expect(bCount).toBe(3);
  });

  it('selector pre-empts a running low-priority branch and halts it', () => {
    let danger = false, halted = false;
    const tree = bt.sel<object>('root',
      bt.seq('flee', bt.cond('danger', () => danger), bt.act('run', () => SUCCESS)),
      bt.act('wander', () => RUNNING, () => (halted = true)));
    expect(tree.tick({}, ctx())).toBe(RUNNING);
    danger = true;
    expect(tree.tick({}, ctx())).toBe(SUCCESS);
    expect(halted).toBe(true);
  });

  it('selector fails only when every child fails', () => {
    expect(bt.sel<object>('x', bt.cond('a', () => false), bt.cond('b', () => false)).tick({}, ctx())).toBe(FAILURE);
    expect(bt.sel<object>('x', bt.cond('a', () => false), bt.cond('b', () => true)).tick({}, ctx())).toBe(SUCCESS);
  });

  it('inverter, parallel and repeat behave', () => {
    expect(bt.not<object>(bt.cond('t', () => true)).tick({}, ctx())).toBe(FAILURE);
    let n = 0;
    const r = bt.repeat<object>(bt.act('inc', () => (n++, SUCCESS)), 3);
    expect(r.tick({}, ctx())).toBe(RUNNING);
    expect(r.tick({}, ctx())).toBe(RUNNING);
    expect(r.tick({}, ctx())).toBe(SUCCESS);
    expect(n).toBe(3);
    const p = bt.par<object>('p', 'one', bt.act('r', () => RUNNING), bt.cond('ok', () => true));
    expect(p.tick({}, ctx())).toBe(SUCCESS);
    const all = bt.par<object>('p', 'all', bt.act('r', () => RUNNING), bt.cond('ok', () => true));
    expect(all.tick({}, ctx())).toBe(RUNNING);
  });

  it('cooldown blocks re-entry for the given game time', () => {
    let fired = 0;
    const c = bt.cooldown<object>(bt.act('radio', () => (fired++, SUCCESS)), 1000);
    expect(c.tick({}, ctx(0))).toBe(SUCCESS);
    expect(c.tick({}, ctx(500))).toBe(FAILURE);
    expect(c.tick({}, ctx(1500))).toBe(SUCCESS);
    expect(fired).toBe(2);
  });

  it('timeout fails a child that runs too long', () => {
    const t = bt.timeout<object>(bt.act('forever', () => RUNNING), 1000);
    expect(t.tick({}, ctx(0))).toBe(RUNNING);
    expect(t.tick({}, ctx(1500))).toBe(FAILURE);
  });

  it('reports the active path for the debug overlay', () => {
    const tree = new BehaviourTree(bt.sel<object>('Root',
      bt.seq('Storm', bt.cond('stormy', () => false), bt.act('shelter', () => RUNNING)),
      bt.seq('Climb', bt.cond('daylight', () => true), bt.act('Walk', () => RUNNING))), {});
    tree.tick(ctx());
    expect(tree.activePath()).toEqual(['Root', 'Climb', 'Walk']);
  });
});
