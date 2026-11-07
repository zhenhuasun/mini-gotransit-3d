# Vehicle motion — planning report (read-only analysis)

Live data: VP/TU via Worker at 11:07–11:10 Nov 7 2026 + static slim GTFS (Node needs `--use-system-ca` behind the corporate TLS proxy).

## 1. Call graph (live mode)

```
animation loop                       map.js:1545-1549  (every 15 s, realtime mode)
└─ refreshRealtimeBusData            map.js:3399
   ├─ loadDynamicBusData(vp)         loader.js:247-251  (protobufjs decode)
   ├─ realtimeBuses.clear()/add      map.js:3411, 3428
   ├─ trip match trips.get(tripId)   map.js:3430-3436
   ├─ new Bus: stop offsets (snap)   map.js:3444-3457   (only if not active)
   ├─ GPS snap → bus.offset, bus.stop map.js:3463-3469
   └─ busStart (new only)            map.js:3477 → 1964
      ├─ setBusSectionData           map.js:4822 (VP branch 4853-4868)
      ├─ trafficLayer.addObject      traffic-layer.js:225 (offsets[] → distances, 260-261)
      └─ busRepeat                   map.js:1975
         ├─ setBusSectionData        map.js:1985
         ├─ physics (30 km/h)        map.js:2004-2035
         ├─ updateObject             map.js:2036 → traffic-layer.js:274-291
         │  → computeRenderer.updateInstance  compute-renderer.js:146 → object-data.js:51
         │  → shader: dist = mix(start,end,a) compute-fragment.glsl:102-112
         └─ schedule next busRepeat  map.js:2038 / 2046 (fired by processDue, map.js:1487)
```
The VP tick never calls busRepeat for an already-active vehicle; the new section only takes effect when the current animation ends.

## 2. Root-cause claims

| Claim | Verdict | Evidence |
|---|---|---|
| No `current_stop_sequence`; `if (stop)` dead | **CONFIRMED** | 0/138 entities have it. `stop = vp.currentStopSequence` (3420), `if (stop)` (3460). Note: VP **does** carry `stopId` + `currentStatus` (86 IN_TRANSIT_TO, 48 INCOMING_AT, 4 STOPPED_AT) — ignored. |
| Snap only sets next stop; `bus.offset` unused for rendering | **CONFIRMED** | 3467 `bus.stop = trip.stopSequences[offsets.reduce((acc,cur,i)=> cur < offset ? Math.min(i+1,…) : acc, 0)]` → **NEXT** stop. updateObject uses only `offsets[sectionIndex]`/`[sectionIndex+sectionLength]` (287-288). |
| setBusSectionData uses bus.stop as section **start** | **CONFIRMED (nuance)** | 4833 `currentSection = stopSequences.indexOf(bus.stop)`. New vehicle (4857): `actualSection = nextSection = currentSection`, length 0 → parked **at** next stop. Next repeat (4859-4860): `nextSection = currentSection + 1` → animates next→next+1. Upstream Tokyo semantics was "current/departed stop". |
| Popup/panel/box share sectionIndex | **CONFIRMED** | 2379 `nextStopIndex = bus.sectionIndex + (bus.standing ? 0 : bus.sectionLength)`; bus-panel.js:57. |
| 30 km/h for trains, no timetable clamp on VP | **CONFIRMED** | configs.js:107 `maxBusSpeedKMPH: 30`; busRepeat has no route-type check; departureTime/nextDepartureTime never set for VP buses → `maxDuration` undefined (2011), start = `now` (2007). |
| Snap forward-bias "soft ratchet" | **WRONG** | Penalty `Math.abs(length - location) / 100` (50, 187) is **symmetric** — it pulls toward the last offset either way. Pruning is exact (no bias). 1 km along-track ≈ 10 m lateral, so it only matters on self-overlapping shapes. Live: 0 snaps >300 m off-line. |
| Problem 2: no service-window check | **CONFIRMED** | No time check in 3430-3477 vs 1939. Live 11:10: 41/137 VP trips not yet departed (e.g. LW-1015 STOPPED_AT UN, 7 min early). Worse than stated: staged at origin → snap idx 0 → spawn at stop 0, then 15 s later animates to stop 1 (the "+1"), i.e. drives off pre-departure. |

## 3. Train 604 (live: `20261107-LW-1961`, vehicle 604)

Offsets on shape UNNI: CF idx7 seq45 10:30 **72.10 km**; SCTH idx8 seq53 11:05 **114.44 km**; NI idx9 seq58 11:35 **132.28 km**.
VP 11:08:35: lat/lon **43.15911, -79.33071**, IN_TRANSIT_TO, stopId SCTH; snapped **108.16 km** (7 m off-line) → **6.28 km before SCTH**. TU: +598 s (SCTH pred 11:14:58). At 10:49 it was certainly in CF→SCTH (interp ≈ 90 km, ~24 km before SCTH; estimate, no historical VP).

Engine: snap → next idx 8 → `bus.stop`=53. Fresh spawn → section (8,0) drawn **at SCTH** (114.44); 15 s later (8,1) **SCTH→NI**, 36-min animation at 30 km/h. True section: **(7,1) CF→SCTH**. Matches the screenshot exactly if the page loaded after ~10:31.

Load-time-dependent (simulated 10:49 view): loaded 09:00 → Port Credit→Aldershot at 54 km (36 km **behind**); 09:30 → CF→NI (2-section) 73.5 km; 10:20 → CF→SCTH 86 km (right by luck); ≥10:31 → SCTH→NI 115–123 km (25–33 km **ahead**).

## 4. Other motion issues (by visible impact)

1. **Last leg never drawn (high):** `actualSection !== finalSection` (4863) fails when next stop = terminus → busStart refuses; running vehicle removed 15 s after reaching terminus animation (2046-2048). 604 will vanish from a fresh page once past SCTH.
2. **No re-anchoring of active vehicles (high):** runs to section end at 30 km/h (up to 85 min CF→SCTH); long-open pages fall far behind while labels run ahead.
3. **Multi-stop sections (med-high):** `sectionLength > 1` → glides through stops; popup "previous stop" = nextStopIndex-1 is wrong.
4. **STOPPED_AT / backward jitter (med):** LW-1016 STOPPED_AT BU snaps 150 m past station → engine next = AP → drawn at stop after. Next-index decrease → negative sectionLength → backward animation.
5. **VP gap teardown (med):** trip absent one tick while busRepeat fires → `final` → stopBus → respawn next tick (teleport).
6. **Trip switching (low-med):** new trip spawns while old lingers 15–30 s → two boxes for one vehicle id.
7. **`vp.stopId` unreliable for buses (low, design input):** trains 10/12 matched the computed next stop (1 STOPPED_AT-past-station, 1 Union departure); buses 67/125 report one stop **behind** GPS (some by 5–12 km). Use GPS for position; stopId only as STOPPED_AT hint for trains.
8. **Bearing flip (low):** JS bearing +180 when start==end (compute-renderer.js:258); affects tracking camera, not mesh.

## 5. Fix plan (each independently committable)

- **A. Replay harness first** (`scripts/replay-vp.mjs`, §6) + baseline of current behaviour.
- **B. Service-window gate (P2):** in VP handler (map.js ~3438) skip trip if `now < departureTimes[0] - grace` (0–2 min); if active and future → remove (or hold at idx 0 len 0 — your call). Keep late trips past last scheduled time while VP reports them. Edge: early departures (allow slack). Verify: `npm run dev`, console `map.gtfs.get('go').activeBusLookup` has no trip with first departure > now; staged vehicles at Union/terminals absent.
- **C. Interpret `bus.stop` as NEXT stop:** VP branch of setBusSectionData → section `(next-1, 1)`, or `(0,0)` when parked at origin; make the final leg valid (fixes #1); end only when trip leaves VP. Never negative length. Verify: 604-style trains show "Next: St. Catharines"; final legs visible.
- **D. GPS re-anchoring:** add explicit `startDistance/endDistance` for VP buses consumed by traffic-layer `addObject/updateObject` type-2 branch (fallback to `offsets[]`). On **every** VP tick for active vehicles, program from current rendered distance (or snap if jump > ~300 m) to the next stop; `schedule()` supersedes the old callback by generation (no explicit cancel needed). Remap `_t` to the full section in getObjectPosition so `standing`/panel dot/popup stay right. Shader unchanged. Verify: hover a long-section train; box tracks within ~0.5 km of snapped GPS; log `bus.offset` vs rendered distance.
- **E. Timing:** duration from TU-predicted next-stop time (or schedule + delay), clamped to [min,max] speed; add train speed in configs (~100 km/h for routeType 2) as fallback. Playback also benefits via existing `maxDuration` clamp.
- **F. Robustness:** STOPPED_AT (trains, stopId in trip) → hold at that stop; backward snap < ~300 m → hold, larger → re-anchor (teleport); VP gaps → remove only after 2–3 missed ticks; trip switch → same vehicle id under new trip → stop the old one immediately.
- **G. (optional) snap fallback:** call-site only — if `pointDistance` > 200 m, re-snap with weight 0. No change to the function → Nov 2 harness not needed.

Verify each locally with `npm run dev` + the replay script against the same snapshot (before/after diff).

## 6. `scripts/replay-vp.mjs` design

- Prereq: extract pure logic (next-stop index, section choice, anchor) into e.g. `src/helpers/helpers-bus-motion.js` imported by both `map.js` and the script, so the script tests real code; `--legacy` flag selects a frozen copy of today's logic for baseline.
- `--capture <dir> --minutes N`: save `vp-<ts>.pb` / `tu-<ts>.pb` every 15 s / 30 s.
- Replay: load GTFS zip (fflate) + snapshots (gtfs-realtime-bindings) + snap from `src/turf/...`; feed ticks into a simulated engine state machine; at each tick compare expected section (`offsets[k] ≤ snap < offsets[k+1]`, STOPPED_AT tolerance) vs engine section and rendered distance.
- Output markdown: per-trip rows + totals (% exact section match, mean/p95 along-track error km, pre-departure renders, backward moves, disappearances, teleports); exit non-zero on thresholds. Filters `--trip`, `--route`.

## Open questions

1. Future trips: hide entirely, or show parked at origin?
2. Grace window for early departure / late finish?
3. Large GPS jump: smooth or teleport, and threshold?
4. OK to use `vp.stopId` for trains' at-stop state when STOPPED_AT (data supports trains, not buses)?
5. Acceptable to extract a helper module from map.js for the replay script to exercise real code?

## Decisions (approved 2026-11-07)

1. **Future trips:** hide (do not create). Parked-at-origin display is out of scope for now.
2. **Grace:** create when `now >= departureTimes[0] - 2 min`. Keep late trips while VP reports them, up to last scheduled time + 60 min.
3. **GPS jumps:** backward < 300 m → hold; forward < 2 km → catch up within the speed clamp; > 2 km either way → teleport.
4. **STOPPED_AT:** yes — use `vp.stopId` for STOPPED_AT on trains (routeType 2) only.
5. **Helper module:** yes — extract it.

**Order:** A → C → B → E1 (train speed only) → D → E2 (TU timing) → F. G only if replay shows a need.

**Added to E2:** the 604 popup showed "On Time" while TU had +598 s. Find out why.
