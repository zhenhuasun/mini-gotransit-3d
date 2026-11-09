# VP replay: legacy engine

- Snapshots: 60 VP, 30 TU, 11:22:38 - 11:37:24 (America/Toronto)
- Simulates a page loaded at the first snapshot; first 0 tick(s) excluded from stats.
- Truth: GPS snapped to the trip shape. Service window: first departure - 2 min to last stop + 60 min. Stop tolerance 0.2 km.

## Summary

| metric | all | trains | buses |
|---|---:|---:|---:|
| VP observations (vehicle x tick) | 8407 | 675 | 7732 |
| in service window | 6110 | 564 | 5546 |
| rendered (in window) | 5826 | 470 | 5356 |
| missing (in window, not rendered) | 284 | 94 | 190 |
| pre-departure observations | 2297 | 111 | 2186 |
| pre-departure rendered | 2297 | 111 | 2186 |
| past last stop + 60 min rendered | 0 | 0 | 0 |
| label next-stop match % | 45.6 | 68.1 | 43.6 |
| rendered section match % | 47.6 | 70.9 | 45.6 |
| mean abs along-track error km | 8.23 | 2.76 | 8.71 |
| p50 abs error km | 2.90 | 2.19 | 3.00 |
| p95 abs error km | 45.08 | 7.58 | 46.07 |
| max abs error km | 89.24 | 8.34 | 89.24 |
| mean signed error km (+ = ahead) | 6.94 | 0.69 | 7.49 |
| ahead > 1 km % | 61.3 | 41.9 | 63.0 |
| behind > 1 km % | 12.9 | 33.8 | 11.0 |

Events: backward moves > 50 m: 10, jumps > 2 km: 6, disappearances while still in VP: 6, rendered vehicles not in VP (vehicle x tick): 127

## Worst trips by mean abs error (top 8)

| trip | route | mode | ticks | rendered | missing | pre-dep rendered | label % | mean err km | signed km | max km |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 20261107-25-25313 | 25 | bus | 60 | 60 | 0 | 0 | 2 | 89.20 | 89.20 | 89.24 |
| 20261107-30-30323 | 30 | bus | 60 | 26 | 0 | 34 | 4 | 79.24 | 79.24 | 80.47 |
| 20261107-16-16341 | 16 | bus | 28 | 28 | 0 | 0 | 4 | 66.75 | 66.75 | 66.99 |
| 20261107-90-90310 | 90 | bus | 60 | 60 | 0 | 0 | 2 | 56.50 | 56.50 | 57.47 |
| 20261107-90-90314 | 90 | bus | 60 | 60 | 0 | 0 | 2 | 47.30 | 47.30 | 49.45 |
| 20261107-90-90312 | 90 | bus | 60 | 60 | 0 | 0 | 5 | 46.23 | 46.23 | 49.38 |
| 20261107-90-90332 | 90 | bus | 60 | 38 | 0 | 22 | 5 | 46.21 | 46.21 | 48.72 |
| 20261107-16-16321 | 16 | bus | 60 | 60 | 0 | 0 | 2 | 32.82 | 32.82 | 46.05 |

# VP replay: current engine

- Snapshots: 60 VP, 30 TU, 11:22:38 - 11:37:24 (America/Toronto)
- Simulates a page loaded at the first snapshot; first 0 tick(s) excluded from stats.
- Truth: GPS snapped to the trip shape. Service window: first departure - 2 min to last stop + 60 min. Stop tolerance 0.2 km.

## Summary

| metric | all | trains | buses |
|---|---:|---:|---:|
| VP observations (vehicle x tick) | 8407 | 675 | 7732 |
| in service window | 6110 | 564 | 5546 |
| rendered (in window) | 5826 | 470 | 5356 |
| missing (in window, not rendered) | 284 | 94 | 190 |
| pre-departure observations | 2297 | 111 | 2186 |
| pre-departure rendered | 2297 | 111 | 2186 |
| past last stop + 60 min rendered | 0 | 0 | 0 |
| label next-stop match % | 45.6 | 68.1 | 43.6 |
| rendered section match % | 47.6 | 70.9 | 45.6 |
| mean abs along-track error km | 8.23 | 2.76 | 8.71 |
| p50 abs error km | 2.90 | 2.19 | 3.00 |
| p95 abs error km | 45.08 | 7.58 | 46.07 |
| max abs error km | 89.24 | 8.34 | 89.24 |
| mean signed error km (+ = ahead) | 6.94 | 0.69 | 7.49 |
| ahead > 1 km % | 61.3 | 41.9 | 63.0 |
| behind > 1 km % | 12.9 | 33.8 | 11.0 |

Events: backward moves > 50 m: 10, jumps > 2 km: 6, disappearances while still in VP: 6, rendered vehicles not in VP (vehicle x tick): 127

## Worst trips by mean abs error (top 8)

| trip | route | mode | ticks | rendered | missing | pre-dep rendered | label % | mean err km | signed km | max km |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 20261107-25-25313 | 25 | bus | 60 | 60 | 0 | 0 | 2 | 89.20 | 89.20 | 89.24 |
| 20261107-30-30323 | 30 | bus | 60 | 26 | 0 | 34 | 4 | 79.24 | 79.24 | 80.47 |
| 20261107-16-16341 | 16 | bus | 28 | 28 | 0 | 0 | 4 | 66.75 | 66.75 | 66.99 |
| 20261107-90-90310 | 90 | bus | 60 | 60 | 0 | 0 | 2 | 56.50 | 56.50 | 57.47 |
| 20261107-90-90314 | 90 | bus | 60 | 60 | 0 | 0 | 2 | 47.30 | 47.30 | 49.45 |
| 20261107-90-90312 | 90 | bus | 60 | 60 | 0 | 0 | 5 | 46.23 | 46.23 | 49.38 |
| 20261107-90-90332 | 90 | bus | 60 | 38 | 0 | 22 | 5 | 46.21 | 46.21 | 48.72 |
| 20261107-16-16321 | 16 | bus | 60 | 60 | 0 | 0 | 2 | 32.82 | 32.82 | 46.05 |

## Legacy vs current

8407 observations compared, 0 mismatches.
