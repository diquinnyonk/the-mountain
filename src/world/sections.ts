import type { Route } from './route';

export type LandmarkId =
  | 'bc' | 'c1' | 'c2' | 'c3' | 'yellowBand' | 'genevaSpur' | 'c4' | 'balcony' | 'southSummit' | 'hillaryStep' | 'summit';

export interface Landmark {
  id: LandmarkId;
  name: string;
  /** Surveyed altitude used to place it on the route. */
  altitude: number;
  s: number;
  camp: boolean;
}

export interface Section {
  index: number;
  name: string;
  from: LandmarkId;
  to: LandmarkId;
  s0: number;
  s1: number;
  blurb: string;
}

export interface ZoneSpan {
  s0: number;
  s1: number;
}

export interface Ladder {
  s: number;
  /** Width of the crevasse the ladder spans (m). */
  span: number;
  /** Rotation of the crevasse relative to the route normal (rad). */
  skew: number;
}

/** Everything placed along the route: camps, ropes, ladders, hazard zones. */
export interface RouteLayout {
  landmarks: Record<LandmarkId, Landmark>;
  camps: Landmark[];
  sections: Section[];
  /** Ranges where fixed ropes are (or will be) installed. */
  ropes: ZoneSpan[];
  ladders: Ladder[];
  seracZone: ZoneSpan;
  avalancheZones: ZoneSpan[];
  hiddenCrevasseZone: ZoneSpan;
  /** Single-file stretches where climbers queue. */
  bottlenecks: (ZoneSpan & { name: string })[];
}

const LANDMARK_DEFS: [LandmarkId, string, number, boolean][] = [
  ['bc', 'Everest Base Camp', 5364, true],
  ['c1', 'Camp 1', 6065, true],
  ['c2', 'Camp 2 (Advanced Base Camp)', 6400, true],
  ['c3', 'Camp 3', 7160, true],
  ['yellowBand', 'The Yellow Band', 7500, false],
  ['genevaSpur', 'The Geneva Spur', 7750, false],
  ['c4', 'Camp 4 (South Col)', 7906, true],
  ['balcony', 'The Balcony', 8400, false],
  ['southSummit', 'South Summit', 8750, false],
  ['hillaryStep', 'Hillary Step', 8790, false],
  ['summit', 'Summit of Everest', 8849, false],
];

export function buildLayout(route: Route): RouteLayout {
  const landmarks = {} as Record<LandmarkId, Landmark>;
  let from = 0;
  for (const [id, name, altitude, camp] of LANDMARK_DEFS) {
    let s: number;
    if (id === 'bc') s = 0;
    else if (id === 'summit') s = route.length;
    else if (id === 'c4') s = route.ss[route.terrain.route.southColIndex];
    else s = route.sAtAltitude(altitude, from);
    landmarks[id] = { id, name, altitude, s, camp };
    from = s;
  }
  const L = landmarks;
  const sections: Section[] = [
    { index: 0, name: 'Khumbu Icefall', from: 'bc', to: 'c1', s0: L.bc.s, s1: L.c1.s,
      blurb: 'A shifting maze of seracs and crevasses. Move fast and early, before the sun loosens the ice.' },
    { index: 1, name: 'Western Cwm', from: 'c1', to: 'c2', s0: L.c1.s, s1: L.c2.s,
      blurb: 'The Valley of Silence. Hidden crevasses, and brutal heat at midday in still air.' },
    { index: 2, name: 'Lhotse Face', from: 'c2', to: 'c3', s0: L.c2.s, s1: L.c3.s,
      blurb: 'A 1,100 m wall of blue ice. Stay clipped to the fixed lines.' },
    { index: 3, name: 'Yellow Band & Geneva Spur', from: 'c3', to: 'c4', s0: L.c3.s, s1: L.c4.s,
      blurb: 'Limestone bands and a rocky buttress lead to the South Col, gateway to the death zone.' },
    { index: 4, name: 'Southeast Ridge', from: 'c4', to: 'summit', s0: L.c4.s, s1: L.summit.s,
      blurb: 'The Balcony, the South Summit, the Hillary Step. Turn around on time.' },
  ];
  const icefallLen = L.c1.s - L.bc.s;
  const ladders: Ladder[] = [0.12, 0.27, 0.4, 0.55, 0.68, 0.83, 0.93].map((f, k) => ({
    s: L.bc.s + 250 + f * (icefallLen - 300),
    span: 2 + (k % 3) * 0.9,
    skew: ((k * 37) % 7 - 3) * 0.08,
  }));
  // One more crossing in the Western Cwm, near Camp 1.
  ladders.push({ s: L.c1.s + 220, span: 3.4, skew: 0.15 });
  return {
    landmarks,
    camps: Object.values(landmarks).filter((l) => l.camp),
    sections,
    ropes: [
      { s0: L.bc.s + 200, s1: L.c1.s - 30 },
      { s0: L.c2.s + 350, s1: L.summit.s - 5 },
    ],
    ladders,
    seracZone: { s0: L.bc.s + 450, s1: L.c1.s - 150 },
    avalancheZones: [
      { s0: L.c1.s + 400, s1: L.c2.s - 300 },
      { s0: L.c2.s + 500, s1: L.c3.s + 400 },
    ],
    hiddenCrevasseZone: { s0: L.c1.s, s1: L.c2.s + 200 },
    bottlenecks: [
      { s0: L.c2.s + 350, s1: L.c2.s + 650, name: 'the foot of the Lhotse Face' },
      { s0: L.southSummit.s, s1: L.summit.s - 30, name: 'the Hillary Step' },
    ],
  };
}

export function sectionAt(layout: RouteLayout, s: number): Section {
  for (const sec of layout.sections) if (s < sec.s1) return sec;
  return layout.sections[layout.sections.length - 1];
}

/** Nearest camp to s within `radius` metres along the route, if any. */
export function campNear(layout: RouteLayout, s: number, radius = 60): Landmark | undefined {
  return layout.camps.find((c) => Math.abs(c.s - s) <= radius);
}

export const inSpan = (span: ZoneSpan, s: number) => s >= span.s0 && s <= span.s1;
