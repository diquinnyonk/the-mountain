import { bt, BehaviourTree, RUNNING, SUCCESS } from '../bt';
import type { Npc } from '../npc';
import type { World } from '../world';
import type { BB } from './common';
import { HOUR } from '../../core/clock';

/** The Base Camp doctor: tends the medical tent, calls you in, and decides whether you're fit to climb. */
export function doctorTree(npc: Npc, world: World): BehaviourTree<BB> {
  const p = () => world.player;
  const atBC = () => p().s < 120;
  const root = bt.sel<BB>('Doctor',
    bt.seq('Call the patient in',
      bt.cond('Unwell climber in Base Camp', (bb) => atBC() && !bb.memory.called &&
        (p().physiology.hape > 0 || p().physiology.hace > 0 || p().physiology.frostbiteFeet > 0.2 || p().physiology.frostbiteHands > 0.2)),
      bt.act('Radio', (bb) => {
        bb.memory.called = true;
        world.radio(npc.name, 'Come to the medical tent as soon as you\'re back. I want to listen to your chest.', 'info');
        return SUCCESS;
      }),
    ),
    bt.seq('Clear for climbing',
      bt.cond('Recovered', (bb) => !world.flags.doctorClearance && atBC() && p().physiology.hape <= 0 && p().physiology.hace <= 0 &&
        world.now - ((bb.memory.bannedAt as number) ?? 0) > 36 * HOUR),
      bt.act('Clear', (bb) => {
        world.flags.doctorClearance = true;
        bb.memory.called = false;
        world.radio(npc.name, 'Your chest is clear and your head is fine. You are cleared to go back up. Slowly.', 'good');
        return SUCCESS;
      }),
    ),
    bt.act('Tend the medical tent', (bb, ctx) => {
      const { npc, world } = bb;
      const t = (bb.memory.wanderTo as number) ?? 30;
      if (npc.moveToward(world, t, ctx.dt, 0.5)) {
        bb.memory.wanderTo = 10 + world.rng.next() * 60;
        npc.targetLateral = 10 + world.rng.next() * 20;
      }
      npc.activity = 'tending the medical tent';
      return RUNNING;
    }),
  );
  return new BehaviourTree(root, { npc, world, memory: {} });
}

/** A consultation when the player talks to the doctor. Returns what the doctor says. */
export function consult(world: World, doctor: Npc): string {
  const ph = world.player.physiology;
  const lines: string[] = [];
  const spo2 = Math.round(ph.spo2 + (world.rng.next() - 0.5) * 3);
  lines.push(`Pulse oximeter: ${spo2}%. Heart rate ${Math.round(70 + (98 - ph.spo2) * 1.4)}.`);
  if (ph.hape > 0) lines.push(`Crackles in both lungs. That's HAPE. Nifedipine, oxygen, and no climbing for at least two days.`);
  if (ph.hace > 0) lines.push(`Your heel-to-toe walk is off. Early HACE. Dexamethasone now, and you rest.`);
  if (ph.ams > 0.3) lines.push(`Moderate AMS. Paracetamol, fluids, and sleep before going higher.`);
  if (ph.frostbiteFeet > 0.2 || ph.frostbiteHands > 0.2) lines.push(`Frostbite. Rewarm slowly in warm water. Some tissue may not survive.`);
  if (ph.cough > 0.5) lines.push(`Classic Khumbu cough. Steam, lozenges, a buff over your mouth.`);
  if (ph.hydration < 50) lines.push(`You're dehydrated. Four litres a day up here, minimum.`);
  const acclim = Math.round(ph.acclimAlt);
  lines.push(`You're acclimatised to about ${acclim.toLocaleString()} m. ${acclim < 6800 ? 'Not ready for a summit push. Do a rotation to Camp 3 first.' : 'You are acclimatised enough for a summit push.'}`);
  if (ph.hape > 0 || ph.hace > 0) {
    world.flags.doctorClearance = false;
    doctor.bt.blackboard.memory.bannedAt = world.now;
    world.player.meds.dexUntil = Math.max(world.player.meds.dexUntil, world.now + 12 * HOUR);
    world.player.meds.nifedipineUntil = Math.max(world.player.meds.nifedipineUntil, world.now + 12 * HOUR);
  } else if (lines.length <= 2) {
    lines.splice(1, 0, 'You look strong.');
  }
  // Restock the medical kit.
  world.player.gear.dex = Math.max(world.player.gear.dex, 2);
  world.player.gear.nifedipine = Math.max(world.player.gear.nifedipine, 2);
  return lines.join(' ');
}
