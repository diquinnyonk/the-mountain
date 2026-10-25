import { bt, BehaviourTree, RUNNING, SUCCESS } from '../bt';
import type { Npc } from '../npc';
import type { World } from '../world';
import { BB, campAt, collapsed, isDead, shelterCamp, stormHere, walkTo } from './common';
import { HOUR } from '../../core/clock';

/**
 * Another expedition's climber. Follows a plan of legs between camps; turns back
 * when sick, sits out storms, queues at bottlenecks, and (unless stubborn) obeys
 * the turnaround time on summit day.
 */
export function climberTree(npc: Npc, world: World): BehaviourTree<BB> {
  const L = world.layout.landmarks;
  const currentLeg = (bb: BB) => bb.npc.plan[bb.npc.legIndex];
  const onSummitPush = (bb: BB) => currentLeg(bb)?.to === 'summit' && bb.npc.s > L.c4.s + 60;

  const root = bt.sel<BB>('Climber',
    isDead(),
    collapsed(),
    bt.seq('Turn back: too sick',
      bt.cond('Severely ill', (bb) => bb.npc.severelyIll && bb.npc.s > 30),
      bt.act('Abandon the climb', (bb) => {
        const { npc, world } = bb;
        if (!bb.memory.turnedBack) {
          bb.memory.turnedBack = true;
          world.log(`${npc.name} (${npc.team}) turned back at ${Math.round(npc.altitude)} m, unwell.`);
          npc.plan = [{ to: 'bc', departAt: world.now }];
          npc.legIndex = 0;
        }
        return SUCCESS;
      }),
      walkTo('Descend to Base Camp', () => 0, 0.9),
    ),
    bt.seq('Storm: take shelter',
      bt.cond('Storm here', (bb) => !bb.npc.inTent && stormHere(bb)),
      walkTo('Head for shelter', (bb) => shelterCamp(bb.world, bb.npc.s).s),
      bt.act('Pitch in', (bb) => {
        bb.npc.inTent = true;
        return SUCCESS;
      }),
    ),
    bt.seq('Turnaround time',
      bt.cond('Past turnaround', (bb) => onSummitPush(bb) && !bb.npc.summited && !bb.npc.stubborn &&
        bb.world.localHour >= bb.world.turnaroundHour && bb.world.localHour < 20),
      bt.act('Turn around', (bb) => {
        const { npc, world } = bb;
        world.log(`${npc.name} turned around at ${Math.round(npc.altitude)} m: turnaround time.`);
        npc.plan = descentPlan(world.now);
        npc.legIndex = 0;
        return SUCCESS;
      }),
    ),
    bt.seq('Summit',
      bt.cond('On top', (bb) => !bb.npc.summited && bb.npc.s >= world.route.length - 8),
      bt.act('Celebrate', (bb) => {
        const { npc, world } = bb;
        npc.summited = true;
        world.log(`${npc.name} (${npc.team}) reached the summit.`);
        npc.plan = descentPlan(world.now + 0.3 * HOUR);
        npc.legIndex = 0;
        return SUCCESS;
      }),
    ),
    bt.seq('Follow the plan',
      bt.cond('Time to leave', (bb) => {
        const leg = currentLeg(bb);
        if (!leg || bb.world.now < leg.departAt) return false;
        // Nobody sets off into a storm from camp.
        return !(bb.npc.inTent && bb.world.weather.sample(bb.world.now, bb.npc.altitude).stormLevel > 0.4);
      }),
      bt.act('Climb to next camp', (bb, ctx) => {
        const { npc, world } = bb;
        const leg = currentLeg(bb)!;
        const target = world.layout.landmarks[leg.to].s;
        npc.inTent = false;
        npc.goalS = target;
        npc.manageOxygen(world, false);
        if (!npc.activity.startsWith('queueing')) npc.activity = `${target > npc.s ? 'climbing' : 'descending'} to ${world.layout.landmarks[leg.to].name}`;
        if (!npc.moveToward(world, target, ctx.dt)) return RUNNING;
        npc.legIndex++;
        npc.inTent = leg.to !== 'summit';
        npc.targetLateral = (world.rng.next() - 0.5) * 30;
        return SUCCESS;
      }),
    ),
    bt.act('Rest at camp', (bb, ctx) => {
      const { npc, world } = bb;
      const camp = campAt(world, npc.s);
      if (!camp) {
        npc.activity = 'heading for camp';
        npc.moveToward(world, shelterCamp(world, npc.s).s, ctx.dt);
        return RUNNING;
      }
      npc.inTent = true;
      npc.speed = 0;
      npc.pose = 'sit';
      npc.manageOxygen(world, true);
      npc.activity = `resting at ${camp.name}`;
      return RUNNING;
    }),
  );
  return new BehaviourTree(root, { npc, world, memory: {} });
}

/** Down to the South Col, then Camp 2 the next morning, then Base Camp. */
export function descentPlan(now: number) {
  return [
    { to: 'c4' as const, departAt: now },
    { to: 'c2' as const, departAt: now + 8 * HOUR },
    { to: 'bc' as const, departAt: now + 30 * HOUR },
  ];
}
