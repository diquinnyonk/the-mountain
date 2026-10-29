import type * as THREE from 'three';

/**
 * Adds close-range surface detail to the terrain material in the shader, so it
 * costs no geometry: wind-carved sastrugi ridges and glints in the snow, and
 * strata and fractures in the rock (the Yellow Band and Lhotse's limestone read
 * as layered). The detail fades out with distance, and is lighter on mobile.
 */
export function addTerrainDetail(material: THREE.MeshStandardMaterial, low: boolean) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetailPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vDetailPos;
${low ? '#define DETAIL_LOW' : ''}
// Value noise whose lattice repeats every 256 m, so large world coordinates stay precise.
highp float dHash(highp vec3 i) {
  i = mod(i, 256.0);
  highp vec3 p = fract(i * 0.3183099 + 0.1) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
highp float dNoise(highp vec3 x) {
  highp vec3 i = floor(x);
  highp vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dHash(i), dHash(i + vec3(1, 0, 0)), f.x), mix(dHash(i + vec3(0, 1, 0)), dHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(dHash(i + vec3(0, 0, 1)), dHash(i + vec3(1, 0, 1)), f.x), mix(dHash(i + vec3(0, 1, 1)), dHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float detailH;
float detailFade;
float detailSnow;
float detailRock;
float detailGrain;
float detailFoot;
#define BAND(wavelength) (1.0 - smoothstep(0.18 * (wavelength), 0.45 * (wavelength), detailFoot))`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  highp vec3 p = vDetailPos;
  detailFade = 1.0 - smoothstep(40.0, 220.0, length(vViewPosition));
  // Metres covered by one pixel here: any layer finer than ~2 pixels fades out instead of aliasing.
  detailFoot = max(length(dFdx(p)), length(dFdy(p)));
  detailH = 0.0;
  detailSnow = 0.0;
  // Beyond the fade distance there's nothing to add: skip the noise entirely.
  if (detailFade > 0.001) {
  // Snow shows as bright vertex colour, rock as dark.
  detailSnow = smoothstep(0.45, 0.75, dot(vColor, vec3(0.3333)));
  // Snow: sastrugi ridges stretched along the prevailing westerly wind.
  float ridge = mix(0.5, 1.0 - abs(dNoise(vec3(p.x * 0.25, p.y * 0.4, p.z * 0.95)) * 2.0 - 1.0), BAND(1.05));
  detailGrain = mix(0.5, dNoise(p * 2.3), BAND(0.45));
  float hs = ridge * ridge * 0.07 + detailGrain * 0.02;
  // Rock: warped horizontal strata plus fractures.
  float warp = dNoise(p * 0.12) * 6.0;
  float strata = mix(0.5, sin(p.y * 2.4 + warp) * 0.5 + 0.5, BAND(2.6));
  float frac = mix(0.3, dNoise(p * 1.1), BAND(0.9)) * 0.6;
#ifndef DETAIL_LOW
  frac += mix(0.5, dNoise(p * 3.7), BAND(0.27)) * 0.25;
#endif
  float hr = strata * 0.2 + frac * 0.3;
  detailRock = mix(0.72, 1.18, clamp(strata * 0.55 + frac * 0.7, 0.0, 1.0));
  detailH = mix(hr, hs, detailSnow) * detailFade;
  // Albedo: rock bands light and dark; snow faintly blue in the hollows between ridges.
  vec3 snowTint = mix(vec3(0.9, 0.94, 1.02), vec3(1.0), ridge);
  vec3 tint = mix(vec3(detailRock), snowTint * (0.97 + 0.06 * detailGrain), detailSnow);
  diffuseColor.rgb *= mix(vec3(1.0), tint, detailFade);
  }
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // Bump from the detail height using screen-space derivatives (Mikkelsen's surface gradient).
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal);
  vec3 r2 = cross(normal, sx);
  float det = dot(sx, r1);
  float hx = dFdx(detailH);
  float hy = dFdy(detailH);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  normal = normalize(abs(det) * normal - grad);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifndef DETAIL_LOW
{
  // Ice crystals glinting as you move.
  highp vec3 cell = floor(vDetailPos * 12.0);
  float glint = step(0.993, dHash(cell + floor(cameraPosition * 1.5))) * BAND(0.1);
  totalEmissiveRadiance += vec3(glint * detailSnow * detailFade * 0.9);
}
#endif`);
  };
  material.customProgramCacheKey = () => (low ? 'terrain-detail-low' : 'terrain-detail');
}
