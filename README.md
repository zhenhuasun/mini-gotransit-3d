# Mini-GO Transit 3D

Watch GO live, in 3D.

A real-time 3D map of GO Transit trains and buses across the Greater Toronto Area, forked from [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d).

![Mini-GO Transit 3D](https://zhenhuasun.github.io/mini-gotransit-3d/og-thumbnail.jpg)

See the [live demo](https://zhenhuasun.github.io/mini-gotransit-3d/).

## What it shows

- **Live vehicles** — every GO train and bus on the map, updated from GTFS-RT VehiclePositions every 15 seconds.
- **Live delays** — TripUpdates every 30 seconds. Vehicles running 3–14 minutes late get a yellow marker, 15 minutes or more a red one.
- **Departure board** — click or tap any station (or search for one) to see upcoming departures with scheduled and expected times. Platform info is shown for Union Station.
- **Delay dashboard** — a per-minute delay distribution across all live vehicles, with corridor filters (BR, KI, LE, LW, MI, RH, ST, plus Bus). Click a bar to highlight every vehicle in that minute.
- **Station cards** — hover or tap a station to see every route that serves it.
- **3D station markers** — rail stations and bus stops rendered as discs, sized and colored by type.
- **Random vehicle** — the shuffle button jumps to a random live train or bus and follows it.
- **Playback mode** — replay the timetable and watch a day of GO service unfold.
- **Tracking modes** — follow a vehicle from behind, above, in front, by helicopter, drone, or bird's-eye view.

## Data

- **Static schedule**: GO Transit GTFS, slimmed to a 3-day window with full-fidelity shapes (no simplification) by `tools/slim_gtfs.py`, refreshed daily by a GitHub Action and served from this repo at `gtfs/GO-GTFS-slim.zip`.
- **Realtime**: GO Open Data API (VehiclePositions, TripUpdates, NextService, Service at a Glance, UnionDepartures) through a Cloudflare Worker proxy, so the API key stays server-side and never reaches the browser.
- **Basemap**: Mapbox.

## How to run locally

A Mapbox access token is required. Put it in `.env` (`MAPBOX_ACCESS_TOKEN=...`).

```bash
npm install
npm run dev
```

Then open http://localhost:9966. The dev build is unminified and keeps `console.*` calls, so console debugging works locally. (The production bundle strips all `console.*` calls.)

To build for production:

```bash
npm run build
```

## Cheat sheet

Operation | Description
--- | ---
Mouse or finger drag | Pan
Mouse wheel rotation | Zoom in/out
Right click or Ctrl key + mouse drag | Tilt up/down and rotate
Shift key + mouse drag | Box zoom
Pinch in/out | Zoom in/out
Two-finger drag | Tilt up/down and rotate
Double-click or triple-tap | Zoom in
Shift key + Double-click or two-finger tap | Zoom out
Click or tap the search button | Show the station search panel
Click or tap +/- buttons | Zoom in/out
Click or tap the compass button | Reset bearing to north
Click or tap the compass button + mouse or finger drag | Rotate
Click or tap the fullscreen button | Toggle the fullscreen mode
Click or tap the eye button | Toggle the underground mode
Click or tap the playback button | Toggle the playback mode
Click or tap the battery button | Toggle the eco mode
Click or tap the chart button | Show/hide the delay dashboard
Click or tap the layer button | Show/hide the layer display settings panel
Click or tap the camera button | Show/hide the tracking mode settings panel
Click or tap the shuffle button | Jump to a random live vehicle and follow it
Click or tap the info button | Show/hide the app info panel
Click or tap a vehicle or station | Track the vehicle or open the station board
Click or tap the map | Stop tracking or close the board
Hover a vehicle or station | Show the vehicle or station information

## About data

Schedule and realtime data come from GO Transit via the Metrolinx Open Data API. The slimmed GTFS feed in this repo is regenerated daily; its validity window is three days from the build date.

## Acknowledgements

This project is a fork of [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d) by [Akihiko Kusanagi (nagix)](https://github.com/nagix), a real-time 3D digital map of Tokyo's public transport system. The engine, the GPGPU vehicle renderer, and the map controls are his work; this fork adapts them to GO Transit in Toronto.

## License

Mini-GO Transit 3D is available under the [MIT license](https://opensource.org/licenses/MIT).