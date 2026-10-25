import * as THREE from 'three';
import type { Terrain } from '../world/heightmap';
import type { Input } from './input';
import { clamp } from '../core/mathx';

/** Third-person orbit camera that follows the climber and stays above the snow. */
export class FollowCamera {
  yaw = 0;
  pitch = 0.32;
  distance = 7;
  private shake = 0;
  private target = new THREE.Vector3();
  private initialised = false;

  constructor(readonly camera: THREE.PerspectiveCamera, private terrain: Terrain) {}

  addShake(amount: number) {
    this.shake = Math.min(1, this.shake + amount);
  }

  update(dt: number, focus: THREE.Vector3, input: Input, heading: number, moving: boolean) {
    this.yaw -= input.mouseDX * 0.004;
    this.pitch = clamp(this.pitch + input.mouseDY * 0.003, -0.25, 1.35);
    if (input.isDown('ArrowLeft')) this.yaw += dt * 1.8;
    if (input.isDown('ArrowRight')) this.yaw -= dt * 1.8;
    this.distance = clamp(this.distance * (1 + input.wheel * 0.12), 2.5, 60);
    // Drift gently behind the climber when moving and not dragging.
    if (moving && !input.dragging) {
      let d = heading - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 0.8);
    }
    const goal = this.target.set(focus.x, focus.y + 1.5, focus.z);
    const cp = this.camera.position;
    const off = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    ).multiplyScalar(this.distance);
    const want = goal.clone().add(off);
    // Keep the camera out of the ground along the boom.
    for (let k = 1; k <= 4; k++) {
      const p = goal.clone().addScaledVector(off, k / 4);
      const g = this.terrain.heightAt(p.x, p.z) + 0.6;
      if (p.y < g) want.y += g - p.y;
    }
    if (!this.initialised) {
      cp.copy(want);
      this.initialised = true;
    } else {
      cp.lerp(want, Math.min(1, dt * 8));
    }
    const ground = this.terrain.heightAt(cp.x, cp.z) + 0.5;
    if (cp.y < ground) cp.y = ground;
    this.camera.lookAt(goal);
    if (this.shake > 0) {
      this.camera.rotation.z += (Math.random() - 0.5) * this.shake * 0.05;
      this.camera.rotation.x += (Math.random() - 0.5) * this.shake * 0.03;
      this.shake = Math.max(0, this.shake - dt * 1.5);
    }
  }

  snap() {
    this.initialised = false;
  }
}
