import { bt, BehaviourTree, RUNNING, SUCCESS } from '../bt';
import type { Npc } from '../npc';
import type { World } from '../world';
import { BB, collapsed, isDead, campAt, walkTo } from './common';
import { inSpan } from '../../world/sections';

const MIN = 60_000;

/**
 * The player's climbing Sherpa. Leads the way a little ahead, waits, rescues
 * (oxygen, dexamethasone, short-roping down), escorts you down when you call it
 * off, and won't let you wander onto hidden crevasses without a shout.
 */
export function sherpaTree(npc: Npc, world: World): BehaviourTree<BB> {
  const p = () => world.player;
  const playerInTrouble = () => {
    const pl = p();
    const ph = pl.physiology;
    const noGas = pl.altitude > 8000 && pl.gear.litres <= 0 && pl.gear.bottles === 0;
    return !pl.dead && (pl.collapsed || ph.hace > 0.25 || ph.hape > 0.3 || ph.hypothermia > 0.4 || ph.energy < 5 || noGas);
  };
  const gap = (bb: BB) => Math.abs(p().s - bb.npc.s);

  const root = bt.sel<BB>('Sherpa',
    isDead(),
    collapsed(),
    bt.seq('Stay with the player (fast travel)',
      bt.cond('Very far away', (bb) => gap(bb) > 1500 || (p().inTent && gap(bb) > 300)),
      bt.act('Catch up', (bb) => {
        bb.npc.s = Math.max(0, p().s - 6);
        bb.npc.lateral = 4;
        return SUCCESS;
      }),
    ),
    bt.seq('Rescue',
      bt.cond('Player in trouble', () => playerInTrouble()),
      walkTo('Rush to the player', () => p().s, 1.4),
      bt.sel('Help',
        bt.seq('Give oxygen',
          bt.cond('Player has no oxygen', () => p().altitude > 7000 && p().gear.litres <= 50 && p().gear.bottles === 0),
          bt.cond('Spare bottle', (bb) => bb.npc.o2Bottles > 0),
          bt.act('Hand over a bottle', (bb) => {
            bb.npc.o2Bottles--;
            bb.world.givePlayer('o2', bb.npc);
            return SUCCESS;
          }),
        ),
        bt.seq('Give dexamethasone',
          bt.cond('Oedema signs', () => (p().physiology.hace > 0.2 || p().physiology.hape > 0.25) && p().meds.dexUntil < world.now),
          bt.cond('Has dex', (bb) => bb.npc.dex > 0),
          bt.act('Inject dex', (bb) => {
            bb.npc.dex--;
            bb.world.givePlayer('dex', bb.npc);
            return SUCCESS;
          }),
        ),
        bt.act('Short-rope the player down', (bb, ctx) => {
          const { npc, world } = bb;
          if (!world.flags.sherpaAssisting) {
            world.flags.sherpaAssisting = true;
            world.flags.descentOrdered = true;
            world.radio(npc.name, 'I have you on a short rope. We go down now, slowly. Stay with me.', 'warn');
          }
          npc.activity = 'short-roping you down';
          npc.moveToward(world, Math.max(0, p().s - 2.5), ctx.dt, 1.5);
          return playerInTrouble() ? RUNNING : SUCCESS;
        }, (bb) => {
          bb.world.flags.sherpaAssisting = false;
        }),
      ),
    ),
    bt.seq('Escort down',
      bt.cond('Expedition over', (bb) => (p().calledOff || bb.world.flags.descentOrdered) && !p().inTent),
      bt.act('Lead down', (bb, ctx) => {
        const { npc, world } = bb;
        npc.activity = 'leading you down';
        const target = Math.max(0, p().s - 12);
        if (npc.s < p().s - 30) {
          npc.speed = 0;
          npc.pose = 'sit';
          return RUNNING;
        }
        npc.moveToward(world, target, ctx.dt, 1.2);
        return RUNNING;
      }),
    ),
    bt.seq('Camp',
      bt.cond('Player in tent', () => p().inTent),
      walkTo('Go to the tents', () => p().s),
      bt.act('Brew tea and rest', (bb) => {
        bb.npc.inTent = true;
        bb.npc.speed = 0;
        bb.npc.activity = 'resting in camp';
        bb.npc.manageOxygen(bb.world, true);
        return RUNNING;
      }),
    ),
    bt.cooldown(bt.seq('Warn off the trail',
      bt.cond('Player off-route in crevasse country', (bb) => {
        const pl = p();
        const d = bb.world.route.closest(pl.pos.x, pl.pos.z).distance;
        return d > 15 && inSpan(bb.world.layout.hiddenCrevasseZone, pl.s) && gap(bb) < 400;
      }),
      bt.act('Shout', (bb) => {
        bb.world.radio(bb.npc.name, 'Stay on the track! Hidden crevasses everywhere here. Follow my footsteps!', 'warn');
        return SUCCESS;
      }),
    ), 20 * MIN),
    bt.seq('Fall back to the player',
      bt.cond('Too far ahead or behind', (bb) => gap(bb) > 120),
      walkTo('Return to the player', () => p().s + 8, 1.3),
    ),
    bt.act('Lead the way', (bb, ctx) => {
      const { npc, world } = bb;
      const pl = p();
      npc.manageOxygen(world, false);
      const up = pl.velocityS >= -0.02;
      const target = Math.min(world.route.length, Math.max(0, pl.s + (up ? 14 : -14)));
      if (up && npc.s > pl.s + 30) {
        npc.speed = 0;
        npc.pose = 'walk';
        npc.activity = 'waiting for you';
        return RUNNING;
      }
      if (Math.abs(target - npc.s) < 3) {
        npc.speed = 0;
        const camp = campAt(world, npc.s);
        npc.activity = camp ? `at ${camp.name}` : 'waiting for you';
        return RUNNING;
      }
      npc.activity = 'leading the way';
      npc.moveToward(world, target, ctx.dt, up ? 1 : 1.1);
      return RUNNING;
    }),
  );
  return new BehaviourTree(root, { npc, world, memory: {} });
}
