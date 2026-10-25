import { bt, BehaviourTree, SUCCESS } from '../bt';
import type { Npc } from '../npc';
import type { World } from '../world';
import type { BB } from './common';

/**
 * The Icefall Doctors and the summit rope-fixing team, abstracted: they push the
 * fixed lines higher during working hours when the weather allows.
 */
export function ropeTeamTree(npc: Npc, world: World, front: { s: number }): BehaviourTree<BB> {
  const L = world.layout.landmarks;
  const milestones: [number, string][] = [
    [L.c1.s, 'Camp 1'], [L.c2.s, 'Camp 2'], [L.c3.s, 'Camp 3'], [L.c4.s, 'the South Col'],
    [L.balcony.s, 'the Balcony'], [world.route.length, 'the summit'],
  ];
  const root = bt.sel<BB>('Rope fixers',
    bt.cond('Ropes fixed to the summit', () => front.s >= world.route.length),
    bt.seq('Weather hold',
      bt.cond('Too windy up there', () => {
        const w = world.weather.sample(world.now, world.route.altitudeAt(front.s));
        return w.stormLevel > 0.35 || w.windKmh > 55;
      }),
      bt.act('Wait it out', (bb) => {
        bb.npc.activity = 'holding for weather';
        return SUCCESS;
      }),
    ),
    bt.seq('Fix rope',
      bt.cond('Working hours', () => world.localHour >= 6 && world.localHour < 14),
      bt.act('Fix the next section', (bb, ctx) => {
        const alt = world.route.altitudeAt(front.s);
        const rate = alt > 8000 ? 25 : alt > 7000 ? 35 : 60; // route metres per hour
        const before = front.s;
        front.s = Math.min(world.route.length, front.s + (rate * ctx.dt) / 3600);
        for (const [s, name] of milestones) {
          if (before < s && front.s >= s) world.radio('Base Camp', `The rope fixing team has reached ${name}.`, 'info');
        }
        bb.npc.activity = 'fixing ropes';
        return SUCCESS;
      }),
    ),
    bt.act('Rest', (bb) => {
      bb.npc.activity = 'resting';
      return SUCCESS;
    }),
  );
  return new BehaviourTree(root, { npc, world, memory: {} });
}
