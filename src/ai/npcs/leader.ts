import { bt, BehaviourTree, SUCCESS } from '../bt';
import type { Npc } from '../npc';
import type { World } from '../world';
import type { BB } from './common';
import { HOUR, DAY, NPT_OFFSET_MS, formatLocalTime } from '../../core/clock';

const MIN = 60_000;

/**
 * The expedition leader, on the radio from Base Camp: reads the forecast, sets
 * the turnaround time, closes the mountain in high winds, and reacts to your vitals.
 */
export function leaderTree(npc: Npc, world: World): BehaviourTree<BB> {
  const p = () => world.player;
  const L = world.layout.landmarks;
  const say = (text: string, kind: 'info' | 'warn' | 'alert' | 'good' = 'info') =>
    bt.act<BB>('Radio', () => {
      world.radio(npc.name, text, kind);
      return SUCCESS;
    });
  const sayFn = (fn: () => string, kind: 'info' | 'warn' | 'alert' | 'good' = 'info') =>
    bt.act<BB>('Radio', () => {
      world.radio(npc.name, fn(), kind);
      return SUCCESS;
    });
  const summitWind = (t = world.now) => world.weather.sample(t, 8849).windKmh;

  const root = bt.sel<BB>('Leader',
    bt.cond('Player dead or home', () => p().dead),
    bt.cooldown(bt.seq('Order descent',
      bt.cond('Vitals critical', () => {
        const ph = p().physiology;
        return ph.hape > 0.25 || ph.hace > 0.2 || (ph.spo2 < 55 && p().gear.o2Flowing === 0 && p().altitude > 7900) || ph.hypothermia > 0.35;
      }),
      bt.act('Order descent', () => {
        world.flags.descentOrdered = true;
        const ph = p().physiology;
        const why = ph.hace > 0.2 ? 'You are slurring on the radio. That is HACE until proven otherwise.' :
          ph.hape > 0.25 ? 'That cough and breathing sound like HAPE.' :
          ph.hypothermia > 0.35 ? 'You are hypothermic.' : 'Your saturation is dangerously low.';
        world.radio(npc.name, `${why} Descend NOW. Take dex if you have it. Descent is the cure.`, 'alert');
        return SUCCESS;
      }),
    ), 25 * MIN),
    bt.cooldown(bt.seq('Oxygen check',
      bt.cond('O2 running low up high', () => {
        const g = p().gear;
        return p().altitude > 7800 && g.flowLpm > 0 && g.bottles === 0 && g.litres > 0 && g.litres / g.flowLpm < 90;
      }),
      sayFn(() => `Your last bottle is under ${Math.round(p().gear.litres / Math.max(0.5, p().gear.flowLpm))} minutes at this flow. Turn the flow down or turn around.`, 'warn'),
    ), 40 * MIN),
    bt.cooldown(bt.seq('Turnaround',
      bt.cond('Past turnaround, not summited', () => !p().summited && !p().calledOff && p().s > L.c4.s + 80 &&
        world.localHour >= world.turnaroundHour && world.localHour < 20),
      sayFn(() => `It's ${formatLocalTime(world.now)}. Turnaround was ${world.turnaroundHour}:00. Turn around. The summit will still be there next year.`, 'alert'),
    ), 30 * MIN),
    bt.cooldown(bt.seq('Mountain closed',
      bt.cond('Jet stream on the summit', () => summitWind() > 75 && p().s > L.c3.s - 200 && !p().calledOff),
      bt.act('Close the upper mountain', () => {
        world.flags.mountainClosed = true;
        world.radio(npc.name, `Summit winds are ${Math.round(summitWind())} km/h. The upper mountain is closed. Hold at camp or descend.`, 'warn');
        return SUCCESS;
      }),
    ), 4 * HOUR),
    bt.cooldown(bt.seq('Storm warning',
      bt.cond('Storm coming in the next 6 h', () => {
        if (p().s < L.c1.s - 300) return false;
        for (let h = 1; h <= 6; h++) if (world.weather.sample(world.now + h * HOUR, p().altitude).stormLevel > 0.6) return true;
        return false;
      }),
      sayFn(() => {
        let h = 1;
        while (h < 6 && world.weather.sample(world.now + h * HOUR, p().altitude).stormLevel <= 0.6) h++;
        return `Weather update: a storm reaches your altitude in about ${h} hour${h > 1 ? 's' : ''}. Get to a camp.`;
      }, 'warn'),
    ), 3 * HOUR),
    bt.cooldown(bt.seq('Rope status',
      bt.cond('Beyond the fixed lines', () => world.ropeFixedTo < world.route.length && p().s > world.ropeFixedTo - 80 &&
        p().s < world.ropeFixedTo + 500),
      sayFn(() => `The rope fixers have only reached ${Math.round(world.route.altitudeAt(world.ropeFixedTo))} m. Above that there are no fixed lines.`, 'warn'),
    ), 2 * HOUR),
    bt.cooldown(bt.seq('Doctor clearance',
      bt.cond('Not cleared', () => !world.flags.doctorClearance && p().s > 150 && p().s < 900),
      say('The doctor has not cleared you to climb. Come back to Base Camp.', 'warn'),
    ), HOUR),
    bt.seq('Morning forecast',
      bt.cond('Briefing time', (bb) => {
        const day = Math.floor((world.now + NPT_OFFSET_MS) / DAY);
        return world.localHour >= 6 && world.localHour < 7 && bb.memory.briefDay !== day && !p().dead;
      }),
      bt.act('Read the forecast', (bb) => {
        bb.memory.briefDay = Math.floor((world.now + NPT_OFFSET_MS) / DAY);
        world.radio(npc.name, forecastText(world), 'info');
        return SUCCESS;
      }),
    ),
    bt.seq('Camp arrival',
      bt.cond('Arrived at a new camp', (bb) => !!p().atCamp && bb.memory.lastCamp !== p().atCamp),
      bt.act('Welcome', (bb) => {
        const id = p().atCamp!;
        const first = bb.memory[`visited:${id}`] !== true;
        bb.memory.lastCamp = id;
        bb.memory[`visited:${id}`] = true;
        if (first && id !== 'bc') world.radio(npc.name, CAMP_ADVICE[id] ?? `Good work reaching ${L[id].name}.`, 'good');
        return SUCCESS;
      }),
    ),
  );
  return new BehaviourTree(root, { npc, world, memory: {} });
}

const CAMP_ADVICE: Record<string, string> = {
  c1: 'Camp 1, well done. Through the Icefall. Drink, rest, and don\'t rush to Camp 2 if your head hurts.',
  c2: 'Camp 2. This is your home for the next part. Climb high, sleep low: tag Camp 3 and come back down to acclimatise.',
  c3: 'Camp 3 on the Lhotse Face. Stay clipped in even in camp. People have stepped out of their tents and fallen.',
  c4: 'South Col. You are in the death zone now. Rest on low-flow oxygen. Summit push leaves around 21:00 if the weather holds.',
};

export function forecastText(world: World): string {
  const now = world.now;
  let maxWind = 0, minTemp = 99, storms = 0;
  for (let h = 0; h < 24; h++) {
    const s = world.weather.sample(now + h * HOUR, 8849);
    maxWind = Math.max(maxWind, s.windKmh);
    minTemp = Math.min(minTemp, s.tempC);
    if (s.stormLevel > 0.6) storms++;
  }
  const verdict = maxWind < 40 && storms === 0 ? 'That\'s a summit window.' :
    maxWind < 60 ? 'Marginal up high.' : 'No summit attempts today.';
  return `Morning. Next 24 h on the summit: winds to ${Math.round(maxWind)} km/h, ${Math.round(minTemp)}°C${storms ? `, ${storms} h of storm` : ''}. ${verdict}`;
}
