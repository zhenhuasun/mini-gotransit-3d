# Step D — GPS re-anchoring: design (approved 2026-11-07)

Context: steps A, C (incl. 2-tick VP grace) and E1 (trains 95, GO buses 60 km/h) committed. E1 replay: trains label 92.9 %, behind/ahead >1 km 28 %/36 %, p95 ~10 km; buses excl. loops p50 1.94 km, behind 51 %. Data from the 11:22–11:37 capture: **62 % of VP observations repeat the previous fix** (same `vehicle.timestamp`); fix age trains p50 3 s, buses p50 26 s / p90 16 min.

## 1. Representation
**Explicit `bus.startDistance` / `bus.endDistance`** (km on shape). Fractional offsets would need conversion to km anyway, since type 2 already treats section values as distances (`compute-fragment.glsl:102-105`, `compute-renderer.js:201-202`) — shader unchanged.
- `helpers-bus-motion.js`: `getMoveDistances(bus)` → `[startDistance ?? offsets[si], endDistance ?? offsets[si+len]]` (timetable buses never set them → unchanged). `getBusMotion` (`:210-211`) uses it.
- `traffic-layer.js` `addObject` type-2 (`:255-261`), `updateObject` (`:284-289`): use `getMoveDistances(object)`.
- `getObjectPosition` (`:296-298`): if `startDistance` set and `sectionLength > 0`, remap `_t = (d - offsets[si]) / (offsets[si+1] - offsets[si])` with `d = start + (end-start)·t`, using the bus's doubles (not the Float32 texture) so endpoints stay exactly 0/1. `standing` (`map.js:4377`), popup next stop (`map.js:2336`), at-stop row (`:2358`) and panel dot (`bus-panel.js:57-60`) then stay correct; a mid-section hold gives 0<_t<1 → not standing.
- Bearing (`compute-renderer.js:258`): skip +180 for type 2 (buses always move forward), otherwise every hold (start==end) flips the tracking camera. JS only.

## 2. VP tick → active vehicle
- `refreshRealtimeBusData`: after `applyVehiclePosition` (`map.js:3412`) add an `isActive` branch → `me.busRepeat(bus, undefined, true)` (tick flag).
- `busRepeat` always ends in `activeBusLookup.schedule(...)` (`map.js:1997/2003`) → generation bump drops the stale callback (`active-object-lookup.js:105-109, 124`). Also fixes a race: a pending `final → stopBus` (`map.js:1980, 2004`) from a one-tick gap is superseded.
- New pure `planRealtimeMove(bus, renderedDistance, onTick)` replaces the realtime branch of `updateBusSection` (`helpers:137-175`), returning `{startDistance, endDistance, sectionIndex, sectionLength, action}`. `sectionFresh` (`helpers:150-154`) goes away: a new vehicle spawns at its snapped GPS (teleport with no rendered position), so busStart/first busRepeat no longer depend on each other.
- Non-tick callbacks (`onTick=false`) never compare with GPS: continue from `endDistance` to the next stop (bounded by GPS next stop) or stand.
- Realtime removal is only via `getVanishedBuses`, not busRepeat `final`.

## 3. Rendered distance without GPU readback
Store `bus.motion = {startDistance, endDistance, startTime, duration, accT, accN, decT, decN}`; pure `getMotionDistance(motion, now)` replicates `glsl:107-112`. Exact (no Float32/Uint32 rounding, no stale uniform), shared with the replay. Debug cross-check: `getInstancePosition` already computes `distance` on CPU (`compute-renderer.js:215`) — return it too and log `|helper − texture| > 1 m` in dev.

## 4. Planner rules and edge cases
`d_g` = snapped GPS, `d_r` = rendered, `err = d_g − d_r`. On tick:
- `|err| > TELEPORT_KM` (2 km): teleport, `d_a = d_g`.
- `−HOLD_KM` (0.3 km) ≤ err < 0: hold (freeze at `d_r`).
- −2 km ≤ err < −0.3 km: see Decision 1.
- 0 ≤ err ≤ 2 km: move from `d_r`.
- Clamp `d_a` to `[offsets[0], offsets[last]]`. Target = first stop with `offset > d_a + ε`, capped at GPS next stop → one stop per move (no multi-stop glide, issue #3).
- **Skip repeated fixes:** unchanged `vp.timestamp` → no re-anchor (otherwise a moving vehicle gets held/pulled back to a stale point).
- **Start at speed:** re-anchor while moving starts at cruise speed (`accT=0`, decel only; asymmetric acc/dec already supported, `glsl:109-111`). Restarting from rest every 15 s at 3 km/h/s would leave trains ~300 m behind per tick. Moves from rest still accelerate.

Edge cases:
- **Stop crossed between ticks:** catch up to own next stop, callback continues to the next; >2 km → teleport.
- **Final leg:** stand at last stop (`sectionIndex = last`, len 0) until grace removal.
- **Origin:** `d_g ≤ offsets[0]` → `(0,0)` standing at stop 0.
- **Loop shapes (C2):** if offsets are not non-decreasing, skip anchoring and keep step C behaviour until C2.
- **Trip switch:** new trip spawns at GPS; old trip gets no ticks → never re-anchored → removed by grace (immediate stop is step F).

## 5. Replay
- Simulator VP handler (`replay-vp.mjs:490-507`) calls `busRepeat(bus, undefined, true)` for active vehicles; `bus.texture` → `bus.motion`; `getRenderedPosition` (`:422-436`, assumes symmetric acc) → `getMotionDistance`; label check (`:680-683`) uses the remapped `_t`.
- **Primary error = pre-tick:** sample `d_r` at `now` before `applyVehiclePositions` (what the viewer saw when the fix arrived); post-tick hides teleports.
- New counters per mode: teleports (fwd/back), holds, catch-ups, repeated fixes skipped, restart-from-rest while moving, pre-tick error by fix-age bucket. Existing backward/jump events become cross-checks.
- `--compare` currently fails on any mismatch (`:932-938`) — gate behind a flag, since divergence is now intended.

## 6. Expected impact (estimates) and risks
| | now (E1) | after D |
|---|---|---|
| trains p95 | ~10 km | < 1 km (fix age 3 s → ≤ ~0.4 km inter-tick at 95 km/h) |
| trains behind/ahead >1 km | 28/36 % | < 5 % each |
| trains label | 92.9 % | ≥ 95 % |
| buses excl. loops p50 | 1.94 km | 0.3–0.6 km (floor = fix age + 60 km/h run-ahead) |
| buses behind | 51 % | < 15 % |

Risks: stop-and-go holds (buses at 60 km/h vs slow traffic) — mitigation: hold tolerance + speed × fix age, capped 2 km; visible back-teleports; loop routes oscillating; STOPPED_AT GPS just past a station starts the train early (F); replay glue drift vs map.js.

## Commits
1. **D1 plumbing (no behaviour change):** `getMoveDistances`, `getMotionDistance`, `_t` remap helper; traffic-layer `addObject`/`updateObject`/`getObjectPosition`; bearing fix; replay uses `getMotionDistance`; `--compare` mismatch gated. Verify: replay identical to E1.
2. **D2 replay metrics:** pre-tick error, action counters, error **and counts** by fix-age bucket (zero actions until D4).
3. **D3 planner:** `planRealtimeMove` replaces the realtime branch of `updateBusSection`; spawn at GPS; stop-by-stop continuation; remove `sectionFresh`; loop guard.
4. **D4 tick re-anchor:** `isActive` call in `refreshRealtimeBusData`; hold/catch-up/teleport incl. Decisions 1–2; skip repeated fixes; start-at-speed; mirrored in replay.
5. **D5 (optional):** hold tolerance by speed × fix age — only if D4 hold/teleport counts show churn.
6. **D6:** before/after numbers in `vehicle-motion-baseline.md` + manual `npm run dev` check.

## Decisions (approved 2026-11-07)
1. **GPS behind by 300 m – 2 km:** hold; if the next 2 fresh fixes are still > 300 m behind, teleport. All thresholds are named constants (e.g. `HOLD_KM = 0.3`, `TELEPORT_KM = 2`, `BEHIND_TELEPORT_FIXES = 2`, `STALE_FIX_S = 90`).
2. **Stale fixes:** if fix age > 90 s, never move the vehicle backward (no hold, no back-teleport); forward catch-up/teleport still allowed. Implemented in D4 (not D5). D2 metrics report counts by fix-age bucket.
3. Everything else as designed: skip repeated fixes, start-at-speed, loop guard, grace-only removal, bearing fix. Commit order D1–D6 as above.

## Precedence and clarifications
- Order of evaluation on each tick:
  1. Repeated fix (same `vp.timestamp`): ignore.
  2. Stale fix (age > `STALE_FIX_S`) AND err < 0: ignore (keep current motion; no hold, no back-teleport).
  3. err > `TELEPORT_KM`: forward teleport.
  4. err < −`TELEPORT_KM`: back-teleport.
  5. −`TELEPORT_KM` ≤ err < −`HOLD_KM`: hold; increment behind counter; teleport when counter ≥ `BEHIND_TELEPORT_FIXES`.
  6. −`HOLD_KM` ≤ err < 0: hold.
  7. 0 ≤ err ≤ `TELEPORT_KM`: move/catch up from `d_r`.
- The behind counter resets to 0 on any fresh fix that is not > `HOLD_KM` behind, and on any teleport.
- "Type 2" in this document means the traffic-layer object type (all GTFS bus objects, including GO trains), NOT GTFS `routeType === 2`. The bearing fix applies to all type-2 objects.