import type * as THREE from 'three';
import type { Route } from '../world/route';
import type { RouteLayout, LandmarkId } from '../world/sections';
import type { WeatherTimeline } from '../weather/model';
import type { Physiology, Meds } from '../sim/physiology';
import type { Gear } from '../player/gear';
import type { Rng } from '../core/rng';
import type { Npc } from './npc';

export type RadioKind = 'info' | 'warn' | 'alert' | 'good';

/** What NPC behaviour trees can see of the player. */
export interface PlayerView {
  s: number;
  pos: THREE.Vector3;
  altitude: number;
  physiology: Physiology;
  gear: Gear;
  meds: Meds;
  dead: boolean;
  collapsed: boolean;
  calledOff: boolean;
  summited: boolean;
  inTent: boolean;
  atCamp: LandmarkId | null;
  /** Route distance per game second (signed), smoothed. */
  velocityS: number;
}

export interface WorldFlags {
  mountainClosed: boolean;
  doctorClearance: boolean;
  sherpaAssisting: boolean;
  descentOrdered: boolean;
  summitPushActive: boolean;
}

/** The world as seen by NPCs (the "perception" layer). */
export interface World {
  now: number;
  localHour: number;
  route: Route;
  layout: RouteLayout;
  weather: WeatherTimeline;
  player: PlayerView;
  npcs: Npc[];
  ropeFixedTo: number;
  turnaroundHour: number;
  flags: WorldFlags;
  rng: Rng;
  radio(from: string, text: string, kind?: RadioKind): void;
  log(text: string): void;
  /** Give the player something (oxygen, medicine, help). */
  givePlayer(kind: 'o2' | 'dex' | 'nifedipine' | 'tea', from: Npc): void;
}
