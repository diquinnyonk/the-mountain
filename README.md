# The Mountain

Climb Mount Everest by the South Col route, from Base Camp (5,364 m) to the summit (8,849 m), in three.js. The terrain is real elevation data and the weather is the real weather of the day you choose.

- **Real terrain.** Elevation tiles of the Khumbu, Western Cwm, Lhotse Face and summit ridge at about 8 m resolution, plus a 70 km wide backdrop of the Himalaya. The route (Icefall → Camp 1 → Western Cwm → Camp 2 → Lhotse Face → Camp 3 → Yellow Band & Geneva Spur → South Col → Balcony → South Summit → Hillary Step → summit) is a least-effort path computed over the DEM, with camps placed at their surveyed altitudes.
- **Real weather.** Pick any date. Past dates replay what the weather did (Open-Meteo archived forecasts with pressure-level data from 2022 on, ERA5 reanalysis before that, back to 1940); dates in the next two weeks use the live forecast. Temperature, wind, cloud and snowfall are interpolated to your altitude from the 600 to 250 hPa levels. Beyond the data, seeded seasonal climatology fills in. Seeded "bad luck" squalls and whiteouts come on top.
- **Your body.** Barometric pressure → inspired O₂ → SpO₂ (alveolar gas equation, Severinghaus curve, acclimatisation-driven hyperventilation). Acclimatisation follows the altitudes you spend time at. AMS, HAPE, HACE, hypothermia, frostbite, snow blindness, dehydration, exhaustion, Khumbu cough and hypoxia each develop, show symptoms, and change how you move: you slow down, stumble, your controls lag or swap, your vision blurs and greys, you hallucinate. Bottled oxygen, dexamethasone and nifedipine help. Descent is the cure.
- **Ways to die.** Oedema, hypothermia, exhaustion in the death zone, slips you fail to self-arrest, falling off ladders unclipped, hidden crevasses off the trail, serac collapses in the Icefall (worse in the afternoon), and avalanches on slopes loaded by real snowfall. Restart with the same date (same luck) or a new one.
- **Calling it off.** From the menu, at any time. Your Sherpa leads you down.
- **NPCs with behaviour trees.** Your Sherpa (leads, waits, rescues you with oxygen and dex, short-ropes you down), climbers from other teams (follow plans timed to the forecast window, queue at the Lhotse Face and Hillary Step, turn back when sick, shelter from storms, call for help), the expedition leader on the radio (forecasts, turnaround time, closing the mountain in high winds, ordering descents), the Base Camp doctor (consultations, clearance to climb), and the rope-fixing team pushing the fixed lines higher as the season goes on. Press **B** in game to see each NPC's active behaviour-tree branch.

## Playing

```bash
npm install
npm run dev        # http://localhost:5173
```

WASD to walk, drag the mouse to look, scroll to zoom. **Shift** pushes harder. **E** clips into fixed ropes and ladder handlines, talks to the doctor, helps collapsed climbers. **Space** self-arrests when you slip. **R** rests. **C** opens the camp menu at a camp (sleep, melt snow, eat, oxygen stash, down suit, wait out weather, fast travel, acclimatisation rotation). **[ ]** set oxygen flow. **1** drink, **2** eat, **3** dexamethasone, **4** nifedipine. **G** goggles, **L** headlamp. **Esc** menu (call off the expedition). **`** debug panel.

In `npm run dev` and `npm run build:dev` builds a **Dev speed** control (1× / 2× / 5×, or press **V**) speeds up the whole simulation; production builds and the artifact leave it out entirely.

Time is compressed while you walk (game time follows how long the real climb would take), so a full expedition is an hour or three of play.

## Development

```bash
npm test           # unit tests: behaviour trees, physiology, weather, terrain/route
npm run build      # production build to dist/ (no dev tools)
npm run build:dev  # local build with dev tools (game speed 1x / 2x / 5x)
npm run smoke      # browser smoke test (needs `npm run dev` running; mocks Open-Meteo)
npm run bake       # re-download elevation tiles and rebuild public/terrain/
```

Layout:

| Path | What |
| --- | --- |
| `tools/bake-terrain.ts` | Downloads Terrarium elevation tiles, fills voids, calibrates to surveyed heights, computes the route, writes `public/terrain/` |
| `src/world/` | Heightmap sampling, chunked LOD terrain, route and sections, camps/ropes/ladders/seracs, sky and sun, snow, hazards, climber model |
| `src/weather/` | Open-Meteo client with fallbacks, multi-level timeline, climatology, storms and bad luck |
| `src/sim/` | Physiology and its effects on movement and vision |
| `src/player/` | Controller (walking, ropes, ladders, slips), camera, gear, input |
| `src/ai/` | Behaviour tree library, NPCs and their trees, the director that runs them |
| `src/expedition.ts` | One attempt: simulation loop, camps, time skips, fast travel, endings, save/load |
| `src/game.ts` | Renderer, frame loop, menus |

Credits: elevation from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM and other public DEMs, via Mapzen); weather from [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).
