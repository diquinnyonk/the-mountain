import type { NpcBlackboard } from '../npc';
import type { World } from '../world';
import type { Landmark, LandmarkId } from '../../world/sections';
import { bt, RUNNING, SUCCESS, type BTNode } from '../bt';
import { formatLocalTime } from '../../core/clock';

export type BB = NpcBlackboard;
export type Node = BTNode<BB>;

export const CAMP_ORDER: LandmarkId[] = ['bc', 'c1', 'c2', 'c3', 'c4', 'summit'];

export function campAt(world: World, s: number, radius = 60): Landmark | undefined {
  return world.layout.camps.find((c) => Math.abs(c.s - s) < radius);
}

/** Nearest camp at or below s (the safe direction in a storm), unless one is just above. */
export function shelterCamp(world: World, s: number): Landmark {
  const camps = world.layout.camps;
  const above = camps.find((c) => c.s >= s && c.s - s < 120);
  if (above) return above;
  let best = camps[0];
  for (const c of camps) if (c.s <= s) best = c;
  return best;
}

export const isDead = () => bt.seq<BB>('Dead',
  bt.cond('Is dead', (bb) => bb.npc.dead),
  bt.act('Lie still', (bb) => {
    bb.npc.pose = 'lie';
    bb.npc.speed = 0;
    bb.npc.activity = 'dead';
    bb.npc.needsHelp = false;
    return RUNNING;
  }),
);

export function collapsed(): Node {
  return bt.seq<BB>('Collapsed',
    bt.cond('Incapacitated', (bb) => bb.npc.incapacitated),
    bt.act('Call for help', (bb, ctx) => {
      const { npc, world, memory } = bb;
      npc.pose = 'lie';
      npc.speed = 0;
      npc.needsHelp = true;
      npc.activity = 'collapsed, calling for help';
      const last = (memory.lastHelpCall as number) ?? -Infinity;
      if (ctx.now - last > 2 * 3600_000) {
        memory.lastHelpCall = ctx.now;
        world.radio(npc.name, `Mayday… I can't go on. I'm at ${Math.round(npc.altitude)} metres. Anyone near me?`, 'alert');
      }
      return RUNNING;
    }, (bb) => {
      bb.npc.needsHelp = false;
    }),
  );
}

/** Walk to a route distance and succeed on arrival. */
export function walkTo(name: string, target: (bb: BB) => number, speedMul = 1): Node {
  return bt.act<BB>(name, (bb, ctx) => {
    const t = target(bb);
    bb.npc.goalS = t;
    bb.npc.inTent = false;
    bb.npc.activity = name.toLowerCase();
    return bb.npc.moveToward(bb.world, t, ctx.dt, speedMul) ? SUCCESS : RUNNING;
  });
}

export const stormHere = (bb: BB) => bb.world.weather.sample(bb.world.now, bb.npc.altitude).stormLevel > 0.6;

export const timeStr = (world: World) => formatLocalTime(world.now);
