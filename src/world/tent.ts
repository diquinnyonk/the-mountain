import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Parts of a high-altitude geodesic dome tent, in metres with the door facing +z:
 * the fly (fabric panels sagging between crossed poles, with a vestibule over the door),
 * the poles, the dark door, and the snow banked around the base.
 */
export function tentParts() {
  const RX = 1.05, RZ = 1.2, H = 1.12;
  // Dome: panels sag inward between the four pole lines on the diagonals.
  const dome = new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = dome.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const th = Math.atan2(z, x);
    const sag = 1 - 0.075 * (0.5 - 0.5 * Math.cos(4 * (th - Math.PI / 4))) * Math.sin(Math.acos(Math.min(1, y)) * 1.0);
    p.setXYZ(i, x * RX * sag, y * H * (0.97 + 0.03 * sag), z * RZ * sag);
  }
  // Vestibule: a smaller half-dome sloping down over the door.
  const vest = new THREE.SphereGeometry(1, 20, 8, -Math.PI / 2, Math.PI, 0, Math.PI / 2);
  vest.rotateY(Math.PI);
  vest.scale(0.75, 0.82, 0.85);
  vest.translate(0, 0, RZ * 0.62);
  const fly = mergeGeometries([dome.toNonIndexed(), vest.toNonIndexed()])!;
  fly.computeVertexNormals();

  // Two poles crossing over the top, a little proud of the fabric.
  const arcs: THREE.BufferGeometry[] = [];
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 24; k++) {
      const u = (k / 24) * Math.PI;
      const c = Math.cos(u), s = Math.sin(u);
      pts.push(new THREE.Vector3(c * Math.cos(a) * RX * 1.01, s * H * 1.01 + 0.01, c * Math.sin(a) * RZ * 1.01));
    }
    arcs.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.012, 4));
  }
  // A third pole over the vestibule.
  const vp: THREE.Vector3[] = [];
  for (let k = 0; k <= 16; k++) {
    const u = (k / 16) * Math.PI;
    vp.push(new THREE.Vector3(Math.cos(u) * 0.76, Math.sin(u) * 0.83 + 0.01, RZ * 0.62));
  }
  arcs.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(vp), 16, 0.011, 4));
  const poles = mergeGeometries(arcs)!;

  // Door: a dark zipped panel on the vestibule front.
  const door = new THREE.CircleGeometry(0.5, 16, 0, Math.PI);
  door.scale(0.9, 1.25, 1);
  door.rotateX(-0.42);
  door.translate(0, 0.02, RZ * 0.62 + 0.62);

  // Snow banked against the walls.
  const drift = new THREE.TorusGeometry(1, 0.22, 6, 28);
  drift.rotateX(Math.PI / 2);
  drift.scale(RX * 1.08, 0.7, RZ * 1.18);
  drift.translate(0, 0.02, 0.12);

  // Guy-line anchor points (local), for lines run out to the snow.
  const guys: [THREE.Vector3, THREE.Vector3][] = [];
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
    const top = new THREE.Vector3(Math.cos(a) * RX * 0.62, H * 0.75, Math.sin(a) * RZ * 0.62);
    const peg = new THREE.Vector3(Math.cos(a) * RX * 2.1, 0, Math.sin(a) * RZ * 2.1);
    guys.push([top, peg]);
  }
  return { fly, poles, door, drift, guys };
}
