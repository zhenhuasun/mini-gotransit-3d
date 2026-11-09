// Capture and replay GTFS-RT VehiclePositions/TripUpdates through the GTFS
// vehicle motion engine, and compare the section the engine renders with the
// section the GPS says the vehicle is in (docs/issues/vehicle-motion-plan.md).
//
//   npm run replay-vp -- capture [--out dir] [--minutes 15]
//   npm run replay-vp -- replay --dir dir [--legacy | --compare [--fail-on-mismatch]] [--trip id] [--route id]
//       [--skip n] [--top n] [--report file.md] [--min-label-match pct] [--max-p95 km]
//       [--train-speed kmph] [--bus-speed kmph]   (override maxTrainSpeedKMPH / maxGoBusSpeedKMPH)
//       [--no-speed-match] [--behind-fixes n]     (override configs.speedMatching / behindTeleportFixes; D4 = --no-speed-match --behind-fixes 2)
//
// (npm run replay-vp runs Node with --use-system-ca, needed behind the
// corporate TLS proxy, and --no-warnings.)
//
// The simulator drives the real motion helpers (src/helpers/helpers-bus-motion.js)
// and the real ActiveObjectLookup scheduler. The glue around them (the VP
// handler, busStart, busRepeat and the GPU interpolation) mirrors
// src/map.js and src/gpgpu/compute-renderer.js; keep it in sync when those
// change. --legacy runs a frozen copy of the pre-refactor logic instead.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {strFromU8, unzipSync} from 'fflate';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import ActiveObjectLookup from '../src/active-object-lookup.js';
import configs from '../src/configs.js';
import * as currentEngine from '../src/helpers/helpers-bus-motion.js';
import nearestCloserPointOnLine from '../src/turf/nearest-closer-point-on-line.js';

const DEFAULT_GTFS_URL = 'https://raw.githubusercontent.com/zhenhuasun/mini-gotransit-3d/master/gtfs/GO-GTFS-slim.zip';
const DEFAULT_VP_URL = 'https://go-3d-tracker-proxy.zhenhuasun.workers.dev/api/gtfs-rt/vp';
const DEFAULT_TU_URL = 'https://go-3d-tracker-proxy.zhenhuasun.workers.dev/api/gtfs-rt/tu';

const {FeedMessage} = GtfsRealtimeBindings.transit_realtime;

function parseArgs(argv) {
    const args = {_: []};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg.startsWith('--')) {
            const key = arg.slice(2),
                next = argv[i + 1];

            if (next === undefined || next.startsWith('--')) {
                args[key] = true;
            } else {
                args[key] = next;
                i++;
            }
        } else {
            args._.push(arg);
        }
    }
    return args;
}

async function fetchBytes(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function capture(args) {
    const minutes = +(args.minutes || 15),
        stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
        dir = path.resolve(args.out || path.join('replay-data', stamp)),
        gtfsUrl = args.gtfs || DEFAULT_GTFS_URL,
        vpUrl = args.vp || DEFAULT_VP_URL,
        tuUrl = args.tu || DEFAULT_TU_URL,
        end = Date.now() + minutes * 60000,
        seen = {vp: new Set(), tu: new Set()};
    let tick = 0;

    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'gtfs.zip'), await fetchBytes(gtfsUrl));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({gtfsUrl, vpUrl, tuUrl, started: new Date().toISOString(), minutes}, null, 2));
    console.log(`capturing ${minutes} min into ${dir}`);

    const save = async (kind, url) => {
        try {
            const bytes = await fetchBytes(url),
                timestamp = Number(FeedMessage.decode(bytes).header.timestamp);

            if (!seen[kind].has(timestamp)) {
                seen[kind].add(timestamp);
                fs.writeFileSync(path.join(dir, `${kind}-${timestamp}.pb`), bytes);
            }
            return timestamp;
        } catch (error) {
            console.log(`${kind} fetch failed: ${error.message}`);
        }
    };

    // Polling is intentionally sequential
    /* eslint-disable no-await-in-loop */
    while (Date.now() < end) {
        const started = Date.now(),
            [vpTimestamp, tuTimestamp] = await Promise.all([
                save('vp', vpUrl),
                tick % 2 === 0 ? save('tu', tuUrl) : undefined
            ]);

        console.log(`${new Date().toTimeString().slice(0, 8)} vp=${vpTimestamp || '-'} tu=${tuTimestamp || '-'} (vp ${seen.vp.size}, tu ${seen.tu.size})`);
        tick++;
        await sleep(Math.max(0, 15000 - (Date.now() - started)));
    }
    /* eslint-enable no-await-in-loop */
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({gtfsUrl, vpUrl, tuUrl, started: new Date(end - minutes * 60000).toISOString(), ended: new Date().toISOString(), minutes, vp: seen.vp.size, tu: seen.tu.size}, null, 2));
    console.log(`done: ${seen.vp.size} VP, ${seen.tu.size} TU snapshots in ${dir}`);
}

// ---------------------------------------------------------------------------
// Legacy engine: frozen copy of the motion logic as it was in src/map.js
// before the helper extraction (commit fafac53). Do not modify.
// ---------------------------------------------------------------------------

const legacyEngine = {
    getStopOffsets(feature, stopCoords) {
        let offset = 0;

        return stopCoords.map(coord =>
            (offset = nearestCloserPointOnLine(feature, coord, offset).properties.totalDistance)
        );
    },

    applyVehiclePosition(bus, vp, trip, feature) {
        const stop = vp.currentStopSequence,
            position = vp.position;

        bus.status = vp.currentStatus;
        if (stop) {
            bus.stop = stop;
        } else {
            const offsets = bus.offsets,
                offset = bus.offset = nearestCloserPointOnLine(feature, [position.longitude, position.latitude], bus.offset).properties.totalDistance;

            bus.stop = trip.stopSequences[offsets.reduce(
                (acc, cur, i) => cur < offset ? Math.min(i + 1, offsets.length - 1) : acc, 0
            )];
        }
    },

    updateBusSection(bus, now, index, final) {
        const stopSequences = bus.trip.stopSequences;
        let departureTimes, currentSection;

        if (bus.stop === undefined) {
            departureTimes = bus.trip.departureTimes;
            currentSection = index !== undefined ? index : departureTimes.reduce(
                (acc, cur, i) => cur <= now ? i : acc, 0
            );
        } else {
            currentSection = stopSequences.indexOf(bus.stop);
        }

        const finalSection = stopSequences.length - 1;

        if (bus.stop === undefined) {
            if (currentSection !== finalSection) {
                bus.sectionIndex = currentSection;
                bus.sectionLength = 1;
                bus.departureTime = departureTimes[currentSection];
                bus.nextDepartureTime = departureTimes[currentSection + 1];

                return true;
            }
        } else {
            let actualSection, nextSection;

            if (bus.sectionIndex === undefined) {
                actualSection = nextSection = currentSection;
            } else {
                actualSection = bus.sectionIndex + bus.sectionLength;
                nextSection = Math.min(currentSection + 1, finalSection);
            }

            if (!final && actualSection !== finalSection) {
                bus.sectionIndex = actualSection;
                bus.sectionLength = nextSection - actualSection;

                return true;
            }
        }
    },

    getBusMotion(bus, now, index, clockSpeed) {
        const minBusStandingDuration = configs.minBusStandingDuration,
            {offsets, sectionIndex, sectionLength} = bus,
            distance = Math.abs(offsets[sectionIndex + sectionLength] - offsets[sectionIndex]);

        if (!(sectionLength > 0 && distance > 0)) {
            return;
        }

        const minDelay = configs.minDelay,
            {departureTime, nextDepartureTime} = bus,
            actualDepartureTime = index !== undefined ?
                Math.max(departureTime, now + (clockSpeed === 1 ? minBusStandingDuration : 0)) :
                departureTime === undefined ? now : departureTime;
        let {maxBusSpeed, busAcceleration, maxBusAccelerationTime, maxBusAccDistance} = configs,
            duration, maxDuration, accelerationTime;

        if (nextDepartureTime !== undefined) {
            maxDuration = nextDepartureTime - minBusStandingDuration + 60000 - minDelay - actualDepartureTime;
        }

        if (distance <= maxBusAccDistance * 2) {
            duration = Math.sqrt(distance / busAcceleration) * 2;
            if (maxDuration > 0) {
                duration = Math.min(Math.max(duration, 0), maxDuration);
                busAcceleration = distance * 4 / duration / duration;
            }
            accelerationTime = duration / 2;
        } else {
            duration = maxBusAccelerationTime * 2 + (distance - maxBusAccDistance * 2) / maxBusSpeed;
            if (maxDuration > 0) {
                duration = Math.min(Math.max(duration, 0), maxDuration);
                maxBusAccDistance = busAcceleration * duration * duration / 8;
                if (distance >= maxBusAccDistance * 2) {
                    maxBusSpeed = distance * 2 / duration;
                    busAcceleration = maxBusSpeed * 2 / duration;
                } else {
                    maxBusSpeed = busAcceleration * duration / 2 - Math.sqrt(busAcceleration * (maxBusAccDistance * 2 - distance));
                }
            }
            accelerationTime = maxBusSpeed / busAcceleration;
        }

        return {
            startTime: actualDepartureTime,
            duration,
            accelerationTime,
            normalizedAcceleration: busAcceleration / distance
        };
    },

    getBusWaitDuration(bus, now, final) {
        const minBusStandingDuration = configs.minBusStandingDuration;

        return bus.stop === undefined ?
            Math.max(bus.nextDepartureTime - now, minBusStandingDuration) :
            final ? minBusStandingDuration : configs.realtimeCheckInterval;
    }
};

// ---------------------------------------------------------------------------
// GTFS loading (mirrors src/worker.js for the fields the engine uses)
// ---------------------------------------------------------------------------

function csvToArray(text) {
    const result = [''];
    let i = 0, previous = '', state = true;

    for (const letter of text) {
        if (letter === '"') {
            if (state && letter === previous) {
                result[i] += letter;
            }
            state = !state;
        } else if (letter === ',' && state) {
            result[++i] = '';
        } else {
            result[i] += letter;
        }
        previous = letter;
    }
    return result;
}

function readCsv(bytes, onRow) {
    const lines = strFromU8(bytes).replace(/^\uFEFF/, '').split(/\r?\n/),
        header = csvToArray(lines[0]),
        index = name => header.indexOf(name);

    for (let i = 1; i < lines.length; i++) {
        if (lines[i].length > 1) {
            onRow(csvToArray(lines[i]), index);
        }
    }
}

function parseGtfsTime(string) {
    const [hours, minutes, seconds] = string.split(':').map(Number);

    return (((hours - 3) * 60 + minutes) * 60 + seconds) * 1000;
}

function loadGtfs(zipBytes, tripIds) {
    const files = unzipSync(zipBytes, {filter: file => /^(agency|routes|trips|stops|stop_times|shapes)\.txt$/.test(file.name)}),
        routes = new Map(),
        trips = new Map(),
        stops = new Map(),
        features = new Map(),
        stopTimes = new Map(),
        shapeIds = new Set();
    let timezone = 'America/Toronto';

    readCsv(files['agency.txt'], (f, i) => {
        timezone = f[i('agency_timezone')] || timezone;
    });
    readCsv(files['routes.txt'], (f, i) => {
        routes.set(f[i('route_id')], {id: f[i('route_id')], shortName: f[i('route_short_name')], type: +f[i('route_type')]});
    });
    readCsv(files['trips.txt'], (f, i) => {
        const id = f[i('trip_id')];

        if (tripIds.has(id)) {
            trips.set(id, {id, route: f[i('route_id')], shape: f[i('shape_id')]});
            shapeIds.add(f[i('shape_id')]);
        }
    });
    readCsv(files['stops.txt'], (f, i) => {
        stops.set(f[i('stop_id')], {name: f[i('stop_name')], coord: [+f[i('stop_lon')], +f[i('stop_lat')]]});
    });
    readCsv(files['stop_times.txt'], (f, i) => {
        const id = f[i('trip_id')];

        if (trips.has(id)) {
            const departure = parseGtfsTime(f[i('departure_time')]);

            if (Number.isFinite(departure)) {
                if (!stopTimes.has(id)) {
                    stopTimes.set(id, []);
                }
                stopTimes.get(id).push([departure, f[i('stop_id')], +f[i('stop_sequence')]]);
            }
        }
    });
    for (const [id, rows] of stopTimes) {
        rows.sort((a, b) => a[2] - b[2]);
        Object.assign(trips.get(id), {
            departureTimes: rows.map(v => v[0]),
            stops: rows.map(v => v[1]),
            stopSequences: rows.map(v => v[2])
        });
    }
    for (const [id, trip] of trips) {
        if (!trip.stops) {
            trips.delete(id);
        }
    }

    const shapePoints = new Map();

    readCsv(files['shapes.txt'], (f, i) => {
        const id = f[i('shape_id')];

        if (shapeIds.has(id)) {
            if (!shapePoints.has(id)) {
                shapePoints.set(id, []);
            }
            shapePoints.get(id).push([+f[i('shape_pt_lon')], +f[i('shape_pt_lat')], +f[i('shape_pt_sequence')]]);
        }
    });
    for (const [id, points] of shapePoints) {
        points.sort((a, b) => a[2] - b[2]);
        features.set(id, {
            type: 'Feature',
            properties: {id},
            geometry: {type: 'LineString', coordinates: points.map(([lon, lat]) => [lon, lat])}
        });
    }

    return {timezone, routes, trips, stops, features};
}

// ---------------------------------------------------------------------------
// Snapshots and time
// ---------------------------------------------------------------------------

function loadSnapshots(dir, kind) {
    return fs.readdirSync(dir)
        .filter(name => name.startsWith(`${kind}-`) && name.endsWith('.pb'))
        .map(name => {
            const feed = FeedMessage.decode(fs.readFileSync(path.join(dir, name)));

            return {timestamp: Number(feed.header.timestamp) * 1000, feed};
        })
        .sort((a, b) => a.timestamp - b.timestamp);
}

// Milliseconds since 3am of the transit day in the feed time zone, as
// Clock#getTimeOffset() returns them.
function makeTimeOffset(timezone) {
    const format = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'});

    return time => {
        const parts = Object.fromEntries(format.formatToParts(new Date(time)).map(({type, value}) => [type, +value])),
            offset = ((parts.hour - 3) * 3600 + parts.minute * 60 + parts.second) * 1000 + time % 1000;

        return parts.hour < 3 ? offset + 86400000 : offset;
    };
}

// Service date (YYYYMMDD) at a time, through the same helper as the app
function makeServiceDate(timezone) {
    const format = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});

    return time => {
        const p = Object.fromEntries(format.formatToParts(new Date(time)).map(({type, value}) => [type, value]));

        return currentEngine.getServiceDate(`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`);
    };
}

function formatOffset(offset) {
    const seconds = Math.round(offset / 1000) + 3 * 3600;

    return [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
        .map(v => String(v).padStart(2, '0')).join(':');
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

// Routes whose shapes loop back on themselves, so their stop offsets are unreliable (step C2)
const LOOP_ROUTES = new Set(['25', '30', '16', '90']);

const ACTIONS = [
    ['teleport', 'spawn teleports'],
    ['teleportForward', 'forward teleports'],
    ['teleportBack', 'back teleports'],
    ['hold', 'holds'],
    ['holdMid', 'holds between two stops (mid-section freezes)'],
    ['slowDown', 'slow-downs (ahead of the GPS, kept moving)'],
    ['catchUp', 'catch-ups'],
    ['repeatedSkipped', 'repeated fixes skipped'],
    ['staleIgnored', 'stale fixes ignored'],
    ['restartFromRest', 'restart-from-rest while moving'],
    ['gatedFutureAtOrigin', 'gated: future trip, GPS at origin'],
    ['gatedFutureMoving', 'gated: future trip, GPS > 300 m from origin (early departure)'],
    ['gatedLate', 'gated: past last time + LATE_TRIP_GRACE']
];

// A gated trip whose GPS is farther than this (km) from its origin has departed early
const EARLY_DEPARTURE_KM = 0.3;

function createActionCounters() {
    return Object.fromEntries([...ACTIONS.map(([key]) => key), 'freshTicks', 'speedTicks'].map(key => [key, 0]));
}

// Mode of a vehicle for the per-mode counters: trains, buses excl. loops, loop routes
function getMode(route) {
    return route.type === 2 ? 'trains' : LOOP_ROUTES.has(route.shortName) ? 'loops' : 'buses';
}

class Simulator {

    constructor(engine, gtfs) {
        this.engine = engine;
        this.gtfs = gtfs;
        this.activeBusLookup = new ActiveObjectLookup();
        this.realtimeBuses = new Set();
        this.now = 0;
        this.serviceDate = undefined;
        this.earlyDepartures = new Map();
        this.stopOffsetCache = new Map();
        this.actions = createActionCounters();
        this.actionsByMode = {trains: createActionCounters(), buses: createActionCounters(), loops: createActionCounters()};
    }

    // Counts the ACTIONS key returned by the planner, in total and for the mode of the vehicle
    reportAction(bus, result, onTick) {
        const keys = [];

        if (result.action in this.actions) {
            keys.push(result.action);
        }
        if (result.action === 'hold' && result.sectionLength === 1) {
            keys.push('holdMid');
        }
        // Applied (not ignored) ticks, and those with an observed speed to match
        if (onTick && result.action !== 'teleport') {
            keys.push('freshTicks');
            if (result.speedAvailable) {
                keys.push('speedTicks');
            }
        }

        const byMode = this.actionsByMode[getMode(this.gtfs.routes.get(bus.trip.route))];

        for (const key of keys) {
            this.actions[key]++;
            byMode[key]++;
        }
    }

    // Mirrors setBusSectionData; the current engine's realtime plan carries an action
    updateSection(bus, index, renderedDistance, onTick) {
        const {engine} = this,
            // The frozen legacy engine removes vehicles in busRepeat (4th argument: final)
            result = engine === legacyEngine && bus.stop !== undefined && index === undefined ?
                engine.updateBusSection(bus, this.now, undefined, !this.realtimeBuses.has(bus.trip.id)) :
                engine.updateBusSection(bus, this.now, index, renderedDistance, onTick);

        if (result && result.action) {
            this.reportAction(bus, result, onTick);
        }
        return result;
    }

    // Fires the busRepeat callbacks due up to time, each at its own deadline
    // (the app fires them on the first frame after the deadline).
    advanceTo(time) {
        const lookup = this.activeBusLookup,
            heap = lookup._heap;

        while (heap.length && heap[0].deadline <= time) {
            this.now = Math.max(this.now, heap[0].deadline);
            lookup.processDue(this.now);
        }
        this.now = time;
    }

    // Mirrors refreshRealtimeBusData (src/map.js)
    applyVehiclePositions(feed) {
        const {engine, gtfs, activeBusLookup, realtimeBuses} = this;

        realtimeBuses.clear();
        for (const {id, vehicle: vp} of feed.entity) {
            if (!vp) {
                continue;
            }

            const vehicle = vp.vehicle,
                stop = vp.currentStopSequence,
                position = vp.position,
                tripId = vp.trip && vp.trip.tripId;

            if (!(stop || position) || !tripId) {
                continue;
            }

            const trip = gtfs.trips.get(tripId);

            if (trip && engine !== legacyEngine) {
                const state = engine.getServiceWindowState(trip, this.now, this.serviceDate);

                if (state !== 'ok') {
                    this.reportGated(trip, state, vp, vp.position && gtfs.features.get(trip.shape));
                    activeBusLookup.delete(tripId);
                    continue;
                }
            }
            realtimeBuses.add(tripId);

            const feature = trip && gtfs.features.get(trip.shape),
                route = trip && gtfs.routes.get(trip.route);

            if (!trip || !feature || !route) {
                continue;
            }

            const isActive = activeBusLookup.has(tripId);
            let bus;

            if (isActive) {
                bus = activeBusLookup.get(tripId);
            } else {
                bus = {
                    id: vehicle ? vehicle.licensePlate || vehicle.id : id,
                    trip,
                    feature,
                    offsets: engine.getStopOffsets(feature, trip.stops.map(stopId => gtfs.stops.get(stopId).coord)),
                    offset: 0
                };
            }
            engine.applyVehiclePosition(bus, vp, trip, feature,             Number(feed.header.timestamp), route.type);
            if (!isActive) {
                this.busStart(bus);
            } else if (engine !== legacyEngine) {
                this.busRepeat(bus, undefined, true);
            }
        }

        // The frozen legacy engine has no VP grace period
        if (engine.getVanishedBuses) {
            for (const bus of engine.getVanishedBuses(activeBusLookup.values(), realtimeBuses)) {
                activeBusLookup.delete(bus.trip.id);
            }
        }
    }

    // Counts a gated observation: future at the origin, future already moving, or past the late grace
    reportGated(trip, state, vp, feature) {
        let action = 'gatedLate';

        if (state === 'early') {
            let moved = false;

            if (feature) {
                if (!this.stopOffsetCache.has(trip.id)) {
                    this.stopOffsetCache.set(trip.id, currentEngine.getStopOffsets(feature, trip.stops.map(stopId => this.gtfs.stops.get(stopId).coord)));
                }
                moved = currentEngine.snapToShape(feature, [vp.position.longitude, vp.position.latitude], 0) - this.stopOffsetCache.get(trip.id)[0] > EARLY_DEPARTURE_KM;
            }
            action = moved ? 'gatedFutureMoving' : 'gatedFutureAtOrigin';
            if (moved) {
                this.earlyDepartures.set(trip.id, (this.earlyDepartures.get(trip.id) || 0) + 1);
            }
        }
        this.reportAction({trip}, {action}, false);
    }

    // Mirrors busStart + TrafficLayer#addObject
    busStart(bus) {
        if (!this.updateSection(bus)) {
            return;
        }
        this.activeBusLookup.set(bus.trip.id, bus);
        const [startDistance, endDistance] = currentEngine.getMoveDistances(bus);

        bus.motion = {startDistance, endDistance, startTime: 86400000, duration: 0, accT: 0, accN: 0, decT: 0, decN: 0};
        this.busRepeat(bus);
    }

    // Mirrors busRepeat (src/map.js) in realtime mode (clock speed 1)
    busRepeat(bus, index, onTick) {
        const {engine, activeBusLookup, now} = this,
            rendered = onTick && bus.motion ? currentEngine.getMotionDistance(bus.motion, now) : undefined,
            plan = this.updateSection(bus, index, rendered && rendered.distance, onTick);

        if (plan && plan.ignore) {
            return;
        }

        const final = !plan,
            routeType = this.gtfs.routes.get(bus.trip.route).type,
            motion = !final && engine.getBusMotion(bus, now, index, 1, routeType, !!rendered &&             rendered.t > 0 && rendered.t < 1, plan.speedKMPH);

        if (motion) {
            const [startDistance, endDistance] = currentEngine.getMoveDistances(bus);

            bus.motion = {
                startDistance, endDistance,
                startTime: motion.startTime,
                duration: motion.duration,
                accT: motion.accelerationTime,
                accN: motion.normalizedAcceleration,
                decT: motion.decelerationTime === undefined ? motion.accelerationTime : motion.decelerationTime,
                decN: motion.normalizedDeceleration === undefined ? motion.normalizedAcceleration : motion.normalizedDeceleration
            };
            activeBusLookup.schedule(bus.trip.id, motion.startTime + motion.duration, () => {
                this.busRepeat(bus, bus.stop === undefined ? bus.sectionIndex + 1 : undefined);
            });
        } else {
            if (!final && bus.stop !== undefined && bus.startDistance !== undefined) {
                const [startDistance, endDistance] = currentEngine.getMoveDistances(bus);

                bus.motion = {startDistance, endDistance, startTime: now, duration: 0, accT: 0, accN: 0, decT: 0, decN: 0};
            }
            activeBusLookup.schedule(bus.trip.id, now + engine.getBusWaitDuration(bus, now, final), () => {
                if (final) {
                    activeBusLookup.delete(bus.trip.id);
                } else {
                    this.busRepeat(bus);
                }
            });
        }
    }

}

// ---------------------------------------------------------------------------
// Replay and evaluation
// ---------------------------------------------------------------------------

const STOP_TOLERANCE_KM = 0.2,
    BACKWARD_KM = 0.05,
    TELEPORT_KM = 2,
    // Upper bounds (s) of the fix-age buckets
    FIX_AGE_BUCKETS = [[15, '< 15 s'], [60, '15-60 s'], [90, '60-90 s'], [300, '90 s-5 min'], [Infinity, '> 5 min']];

function getFixAgeBucket(age) {
    return FIX_AGE_BUCKETS.findIndex(([limit]) => age < limit);
}

function getDelayAtStop(tuFeed, tripId, stopId) {
    if (!tuFeed) {
        return;
    }
    for (const {tripUpdate: tu} of tuFeed.entity) {
        if (tu && tu.trip && tu.trip.tripId === tripId) {
            for (const s of tu.stopTimeUpdate || []) {
                if (s.stopId === stopId) {
                    const event = s.arrival && s.arrival.time ? s.arrival : s.departure;

                    return event ? event.delay : undefined;
                }
            }
        }
    }
}

function runReplay(engine, gtfs, vpSnapshots, tuSnapshots, options) {
    const simulator = new Simulator(engine, gtfs),
        toOffset = makeTimeOffset(gtfs.timezone),
        serviceDate = makeServiceDate(gtfs.timezone),
        truthOffsets = new Map(),
        stopOffsetCache = new Map(),
        previous = new Map(),
        lastFix = new Map(),
        observations = [],
        events = {backward: 0, teleport: 0, disappear: 0, ghosts: 0},
        jumps = {trains: 0, buses: 0, loops: 0};
    let tuIndex = -1;

    vpSnapshots.forEach(({timestamp, feed}, tick) => {
        const now = toOffset(timestamp);

        simulator.advanceTo(now);
        simulator.serviceDate = serviceDate(timestamp);

        // What the viewer saw at the moment the fix arrived
        const preTick = new Map();

        for (const bus of simulator.activeBusLookup.values()) {
            preTick.set(bus.trip.id, currentEngine.getMotionDistance(bus.motion, now).distance);
        }
        simulator.applyVehiclePositions(feed);

        while (tuIndex + 1 < tuSnapshots.length && tuSnapshots[tuIndex + 1].timestamp <= timestamp) {
            tuIndex++;
        }

        const tuFeed = tuIndex >= 0 ? tuSnapshots[tuIndex].feed : undefined,
            seen = new Set();

        for (const {vehicle: vp} of feed.entity) {
            const tripId = vp && vp.trip && vp.trip.tripId,
                trip = tripId && gtfs.trips.get(tripId),
                feature = trip && gtfs.features.get(trip.shape);

            if (!feature || !vp.position || seen.has(tripId)) {
                continue;
            }
            seen.add(tripId);

            const route = gtfs.routes.get(trip.route),
                isTrain = route.type === 2;

            if ((options.trip && tripId !== options.trip) || (options.route && trip.route !== options.route && route.shortName !== options.route)) {
                continue;
            }

            if (!stopOffsetCache.has(tripId)) {
                stopOffsetCache.set(tripId, currentEngine.getStopOffsets(feature, trip.stops.map(stopId => gtfs.stops.get(stopId).coord)));
            }

            const offsets = stopOffsetCache.get(tripId),
                truth = currentEngine.snapToShape(feature, [vp.position.longitude, vp.position.latitude], truthOffsets.get(tripId) || 0),
                windowState = currentEngine.getServiceWindowState(trip, now, serviceDate(timestamp)),
                preDeparture = windowState === 'early',
                postArrival = windowState === 'late',
                expectedNext = currentEngine.getNextStopIndex(offsets, truth),
                accepted = new Set([expectedNext]),
                status = vp.currentStatus,
                bus = simulator.activeBusLookup.get(tripId);

            truthOffsets.set(tripId, truth);

            const fixTime = vp.timestamp ? Number(vp.timestamp) : undefined,
                fixAge = fixTime ? Math.max(0, timestamp / 1000 - fixTime) : undefined,
                repeated = fixTime !== undefined && lastFix.get(tripId) === fixTime,
                preDistance = preTick.get(tripId);

            if (fixTime) {
                lastFix.set(tripId, fixTime);
            }

            // Within the stop tolerance either side of a stop, the vehicle is
            // "at" that stop: its next stop may be that stop or the one after.
            if (Math.abs(offsets[expectedNext] - truth) <= STOP_TOLERANCE_KM) {
                accepted.add(Math.min(expectedNext + 1, offsets.length - 1));
            }
            if (expectedNext > 0 && Math.abs(truth - offsets[expectedNext - 1]) <= STOP_TOLERANCE_KM) {
                accepted.add(expectedNext - 1);
            }
            if (isTrain && (status === 1 || status === 'STOPPED_AT')) {
                const index = trip.stops.indexOf(vp.stopId);

                if (index !== -1) {
                    accepted.add(index);
                    accepted.add(Math.min(index + 1, offsets.length - 1));
                }
            }

            const observation = {
                tick, now, tripId, route: route.shortName, isTrain, status, vpStopId: vp.stopId,
                truth, expectedNext, preDeparture, postArrival,
                expected: !preDeparture && !postArrival,
                rendered: !!bus,
                fixAge, repeated,
                preError: preDistance === undefined ? undefined : preDistance - truth,
                tuDelay: getDelayAtStop(tuFeed, tripId, trip.stops[expectedNext])
            };

            if (bus) {
                const {distance, t: moveT} = currentEngine.getMotionDistance(bus.motion, now),
                    t = currentEngine.getSectionT(bus, moveT),
                    standing = t === 0 || t === 1,
                    labelNext = bus.sectionIndex + (standing ? 0 : bus.sectionLength),
                    positionNext = currentEngine.getNextStopIndex(offsets, distance);

                Object.assign(observation, {
                    distance,
                    error: distance - truth,
                    section: [bus.sectionIndex, bus.sectionIndex + bus.sectionLength],
                    labelNext,
                    labelOk: accepted.has(labelNext),
                    positionOk: accepted.has(positionNext) || Math.abs(distance - truth) <= STOP_TOLERANCE_KM
                });

                const last = previous.get(tripId);

                if (last && last.rendered && tick >= options.skip) {
                    const delta = distance - last.distance;

                    if (delta < -BACKWARD_KM) {
                        events.backward++;
                    }
                    if (Math.abs(delta) > TELEPORT_KM) {
                        events.teleport++;
                        jumps[getMode(route)]++;
                    }
                }
            } else {
                const last = previous.get(tripId);

                if (last && last.rendered && tick >= options.skip) {
                    events.disappear++;
                }
            }
            previous.set(tripId, observation);
            if (tick >= options.skip) {
                observations.push(observation);
            }
        }

        if (tick >= options.skip) {
            for (const bus of simulator.activeBusLookup.values()) {
                if (!simulator.realtimeBuses.has(bus.trip.id)) {
                    events.ghosts++;
                }
            }
        }
    });

    return {observations, events, jumps, actions: simulator.actions, actionsByMode: simulator.actionsByMode, earlyDepartures: simulator.earlyDepartures};
}

function percentile(values, p) {
    if (!values.length) {
        return NaN;
    }

    const sorted = values.slice().sort((a, b) => a - b);

    return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
}

function summarize(observations) {
    const inWindow = observations.filter(o => o.expected),
        rendered = inWindow.filter(o => o.rendered),
        errors = rendered.map(o => Math.abs(o.error)),
        preErrors = inWindow.filter(o => o.preError !== undefined).map(o => Math.abs(o.preError)),
        withFix = observations.filter(o => o.fixAge !== undefined),
        pct = (n, d) => d ? n / d * 100 : NaN;

    return {
        observations: observations.length,
        inWindow: inWindow.length,
        preDeparture: observations.filter(o => o.preDeparture).length,
        preDepartureRendered: observations.filter(o => o.preDeparture && o.rendered).length,
        postArrivalRendered: observations.filter(o => o.postArrival && o.rendered).length,
        missing: inWindow.length - rendered.length,
        rendered: rendered.length,
        labelMatch: pct(rendered.filter(o => o.labelOk).length, rendered.length),
        positionMatch: pct(rendered.filter(o => o.positionOk).length, rendered.length),
        meanError: errors.reduce((a, b) => a + b, 0) / errors.length,
        p50Error: percentile(errors, 50),
        p95Error: percentile(errors, 95),
        maxError: errors.length ? Math.max(...errors) : NaN,
        meanSignedError: rendered.reduce((a, o) => a + o.error, 0) / rendered.length,
        aheadOver1km: pct(rendered.filter(o => o.error > 1).length, rendered.length),
        behindOver1km: pct(rendered.filter(o => o.error < -1).length, rendered.length),
        preCount: preErrors.length,
        preMeanError: preErrors.reduce((a, b) => a + b, 0) / preErrors.length,
        preP50Error: percentile(preErrors, 50),
        preP95Error: percentile(preErrors, 95),
        preAheadOver1km: pct(inWindow.filter(o => o.preError > 1).length, preErrors.length),
        preBehindOver1km: pct(inWindow.filter(o => o.preError < -1).length, preErrors.length),
        repeatedShare: pct(withFix.filter(o => o.repeated).length, withFix.length)
    };
}

const fixed = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '-';

function summaryTable(rows) {
    const keys = [
        ['observations', 'VP observations (vehicle x tick)', 0],
        ['inWindow', 'in service window', 0],
        ['rendered', 'rendered (in window)', 0],
        ['missing', 'missing (in window, not rendered)', 0],
        ['preDeparture', 'pre-departure observations', 0],
        ['preDepartureRendered', 'pre-departure rendered', 0],
        ['postArrivalRendered', 'past last stop + 60 min rendered', 0],
        ['labelMatch', 'label next-stop match %', 1],
        ['positionMatch', 'rendered section match %', 1],
        ['meanError', 'mean abs along-track error km', 2],
        ['p50Error', 'p50 abs error km', 2],
        ['p95Error', 'p95 abs error km', 2],
        ['maxError', 'max abs error km', 2],
        ['meanSignedError', 'mean signed error km (+ = ahead)', 2],
        ['aheadOver1km', 'ahead > 1 km %', 1],
        ['behindOver1km', 'behind > 1 km %', 1],
        ['repeatedShare', 'repeated fixes % (same fix timestamp)', 1]
    ];

    return [
        `| metric | ${rows.map(([name]) => name).join(' | ')} |`,
        `|---|${rows.map(() => '---:').join('|')}|`,
        ...keys.map(([key, label, digits]) => `| ${label} | ${rows.map(([, summary]) => fixed(summary[key], digits)).join(' | ')} |`)
    ].join('\n');
}

function buildReport(name, result, gtfs, vpSnapshots, tuSnapshots, options) {
    const {observations, events} = result,
        toOffset = makeTimeOffset(gtfs.timezone),
        lines = [],
        all = summarize(observations),
        trains = summarize(observations.filter(o => o.isTrain)),
        buses = summarize(observations.filter(o => !o.isTrain)),
        regularBuses = summarize(observations.filter(o => !o.isTrain && !LOOP_ROUTES.has(o.route))),
        loopBuses = summarize(observations.filter(o => !o.isTrain && LOOP_ROUTES.has(o.route)));

    lines.push(`# VP replay: ${name} engine`, '');
    lines.push(`- Cruise speeds: trains ${configs.maxTrainSpeedKMPH} km/h, GO buses ${configs.maxGoBusSpeedKMPH} km/h (the legacy engine ignores them)`);
    lines.push(`- Snapshots: ${vpSnapshots.length} VP, ${tuSnapshots.length} TU, ${formatOffset(toOffset(vpSnapshots[0].timestamp))} - ${formatOffset(toOffset(vpSnapshots[vpSnapshots.length - 1].timestamp))} (${gtfs.timezone})`);
    lines.push(`- Simulates a page loaded at the first snapshot; first ${options.skip} tick(s) excluded from stats.`);
    lines.push(`- Truth: GPS snapped to the trip shape. Service window: first departure - 2 min to last stop + 60 min. Stop tolerance ${STOP_TOLERANCE_KM} km.`);
    lines.push('');
    lines.push('## Summary', '');
    lines.push(summaryTable([['all', all], ['trains', trains], ['buses', buses], ['buses excl. loops', regularBuses], ['loop routes', loopBuses]]));
    lines.push('');
    lines.push(`Events: backward moves > ${BACKWARD_KM * 1000} m: ${events.backward}, jumps > ${TELEPORT_KM} km: ${events.teleport}, disappearances while still in VP: ${events.disappear}, rendered vehicles not in VP (vehicle x tick): ${events.ghosts}`);
    lines.push('');

    const groups = [
        ['all', all, observations],
        ['trains', trains, observations.filter(o => o.isTrain)],
        ['buses', buses, observations.filter(o => !o.isTrain)],
        ['buses excl. loops', regularBuses, observations.filter(o => !o.isTrain && !LOOP_ROUTES.has(o.route))],
        ['loop routes', loopBuses, observations.filter(o => !o.isTrain && LOOP_ROUTES.has(o.route))]
    ];

    lines.push('## Pre-tick error (rendered distance when each fix arrives, before it is applied)', '');
    lines.push(`| metric | ${groups.map(([name]) => name).join(' | ')} |`, `|---|${groups.map(() => '---:').join('|')}|`);
    for (const [key, label, digits] of [['preCount', 'vehicles with a rendered position', 0], ['preMeanError', 'mean abs error km', 2], ['preP50Error', 'p50 abs error km', 2], ['preP95Error', 'p95 abs error km', 2], ['preAheadOver1km', 'ahead > 1 km %', 1], ['preBehindOver1km', 'behind > 1 km %', 1]]) {
        lines.push(`| ${label} | ${groups.map(([, summary]) => fixed(summary[key], digits)).join(' | ')} |`);
    }
    lines.push('');

    const modeColumns = [['all', result.actions], ['trains', result.actionsByMode.trains], ['buses excl. loops', result.actionsByMode.buses], ['loop routes', result.actionsByMode.loops]],
        row = (label, values) => `| ${label} | ${values.join(' | ')} |`;

    lines.push('## Actions', '', row('action', modeColumns.map(([name]) => name)), `|---|${modeColumns.map(() => '---:').join('|')}|`);
    for (const [key, label] of ACTIONS) {
        lines.push(row(label, modeColumns.map(([, counters]) => counters[key])));
    }
    lines.push(row('fresh ticks applied', modeColumns.map(([, counters]) => counters.freshTicks)));
    lines.push(row('fresh ticks with an observed speed %', modeColumns.map(([, counters]) => fixed(counters.freshTicks ? counters.speedTicks / counters.freshTicks * 100 : NaN, 1))));
    lines.push(row(`jumps > ${TELEPORT_KM} km between observations`, [result.events.teleport, result.jumps.trains, result.jumps.buses, result.jumps.loops]));
    lines.push('');

    if (result.earlyDepartures && result.earlyDepartures.size) {
        lines.push(`Early departures (gated, GPS > ${EARLY_DEPARTURE_KM * 1000} m from origin): ${result.earlyDepartures.size} trips: ${Array.from(result.earlyDepartures, ([id, n]) => `${id} (${n})`).join(', ')}`, '');
    }

    lines.push('## Fix age (now - vehicle.timestamp), in service window', '');
    lines.push('| mode | bucket | observations | share % | repeated % | pre-tick n | pre-tick p50 km | pre-tick p95 km |', '|---|---|---:|---:|---:|---:|---:|---:|');
    for (const [mode, list] of [['trains', groups[1][2]], ['buses', groups[2][2]]]) {
        const inWindow = list.filter(o => o.expected && o.fixAge !== undefined);

        FIX_AGE_BUCKETS.forEach(([, label], index) => {
            const bucket = inWindow.filter(o => getFixAgeBucket(o.fixAge) === index),
                errors = bucket.filter(o => o.preError !== undefined).map(o => Math.abs(o.preError));

            lines.push(`| ${mode} | ${label} | ${bucket.length} | ${fixed(inWindow.length ? bucket.length / inWindow.length * 100 : NaN, 1)} | ${fixed(bucket.length ? bucket.filter(o => o.repeated).length / bucket.length * 100 : NaN, 1)} | ${errors.length} | ${fixed(percentile(errors, 50))} | ${fixed(percentile(errors, 95))} |`);
        });
    }
    lines.push('');

    const byTrip = new Map();

    for (const o of observations) {
        if (!byTrip.has(o.tripId)) {
            byTrip.set(o.tripId, []);
        }
        byTrip.get(o.tripId).push(o);
    }

    const tripRows = Array.from(byTrip, ([tripId, list]) => {
        const summary = summarize(list);

        return {tripId, list, summary};
    }).sort((a, b) => (b.summary.meanError || 0) - (a.summary.meanError || 0));

    lines.push(`## Worst trips by mean abs error (top ${options.top})`, '');
    lines.push('| trip | route | mode | ticks | rendered | missing | pre-dep rendered | label % | mean err km | signed km | max km |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const {tripId, list, summary} of tripRows.slice(0, options.top)) {
        lines.push(`| ${tripId} | ${list[0].route} | ${list[0].isTrain ? 'train' : 'bus'} | ${list.length} | ${summary.rendered} | ${summary.missing} | ${summary.preDepartureRendered} | ${fixed(summary.labelMatch, 0)} | ${fixed(summary.meanError)} | ${fixed(summary.meanSignedError)} | ${fixed(summary.maxError)} |`);
    }
    lines.push('');

    if (options.trip) {
        const trip = gtfs.trips.get(options.trip),
            stopName = index => (index === undefined ? '-' : gtfs.stops.get(trip.stops[index]).name.replace(/ GO$/, ''));

        lines.push(`## Timeline: ${options.trip}`, '');
        lines.push('| time | status | VP stop | GPS km | expected next | engine section | label next | drawn km | error km | TU delay s |');
        lines.push('|---|---|---|---:|---|---|---|---:|---:|---:|');
        for (const o of byTrip.get(options.trip) || []) {
            lines.push(`| ${formatOffset(o.now)} | ${o.status} | ${o.vpStopId} | ${fixed(o.truth)} | ${stopName(o.expectedNext)} | ${o.section ? `${stopName(o.section[0])} -> ${stopName(o.section[1])}` : (o.preDeparture ? 'hidden (pre-dep)' : 'not rendered')} | ${o.rendered ? stopName(o.labelNext) : '-'} | ${fixed(o.distance)} | ${fixed(o.error)} | ${o.tuDelay === undefined ? '-' : o.tuDelay} |`);
        }
        lines.push('');
    }

    return {markdown: lines.join('\n'), summary: all};
}

function compareResults(a, b) {
    const key = o => `${o.tick}|${o.tripId}`,
        map = new Map(b.observations.map(o => [key(o), o]));
    let mismatches = 0;

    for (const o of a.observations) {
        const other = map.get(key(o));

        if (!other || other.rendered !== o.rendered || other.distance !== o.distance || other.labelNext !== o.labelNext ||
            (o.section && (other.section[0] !== o.section[0] || other.section[1] !== o.section[1]))) {
            mismatches++;
        }
    }
    return {compared: a.observations.length, mismatches: mismatches + Math.abs(a.observations.length - b.observations.length)};
}

async function replay(args) {
    if (!args.dir) {
        throw new Error('replay needs --dir <capture dir>');
    }

    const dir = path.resolve(args.dir),
        vpSnapshots = loadSnapshots(dir, 'vp'),
        tuSnapshots = loadSnapshots(dir, 'tu'),
        options = {
            trip: args.trip,
            route: args.route,
            skip: +(args.skip || 0),
            top: +(args.top || 20)
        };

    if (args['train-speed']) {
        configs.maxTrainSpeedKMPH = +args['train-speed'];
    }
    if (args['bus-speed']) {
        configs.maxGoBusSpeedKMPH = +args['bus-speed'];
    }
    if (args['no-speed-match']) {
        configs.speedMatching = false;
    }
    if (args['behind-fixes']) {
        configs.behindTeleportFixes = +args['behind-fixes'];
    }

    if (!vpSnapshots.length) {
        throw new Error(`no vp-*.pb snapshots in ${dir}`);
    }

    const tripIds = new Set();

    for (const {feed} of vpSnapshots) {
        for (const {vehicle: vp} of feed.entity) {
            if (vp && vp.trip && vp.trip.tripId) {
                tripIds.add(vp.trip.tripId);
            }
        }
    }

    const zipPath = path.join(dir, 'gtfs.zip'),
        gtfs = loadGtfs(fs.existsSync(zipPath) ? new Uint8Array(fs.readFileSync(zipPath)) : await fetchBytes(args.gtfs || DEFAULT_GTFS_URL), tripIds),
        engines = args.compare ?
            [['legacy', legacyEngine], ['current', currentEngine]] :
            [[args.legacy ? 'legacy' : 'current', args.legacy ? legacyEngine : currentEngine]],
        results = engines.map(([name, engine]) => [name, runReplay(engine, gtfs, vpSnapshots, tuSnapshots, options)]),
        output = [];
    let failed = false;

    for (const [name, result] of results) {
        const {markdown, summary} = buildReport(name, result, gtfs, vpSnapshots, tuSnapshots, options);

        output.push(markdown);
        if (args['min-label-match'] !== undefined && !(summary.labelMatch >= +args['min-label-match'])) {
            output.push(`**FAIL** (${name}): label match ${fixed(summary.labelMatch, 1)}% < ${args['min-label-match']}%`, '');
            failed = true;
        }
        if (args['max-p95'] !== undefined && !(summary.p95Error <= +args['max-p95'])) {
            output.push(`**FAIL** (${name}): p95 error ${fixed(summary.p95Error)} km > ${args['max-p95']} km`, '');
            failed = true;
        }
    }

    if (results.length === 2) {
        const {compared, mismatches} = compareResults(results[0][1], results[1][1]);

        output.push('## Legacy vs current', '', `${compared} observations compared, ${mismatches} mismatches.`, '');
        if (mismatches && args['fail-on-mismatch']) {
            failed = true;
        }
    }

    const markdown = output.join('\n');

    console.log(markdown);
    if (args.report) {
        fs.writeFileSync(args.report, markdown);
    }
    if (failed) {
        process.exitCode = 2;
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2)),
        command = args._[0];

    if (command === 'capture') {
        await capture(args);
    } else if (command === 'replay') {
        await replay(args);
    } else {
        console.log('usage: replay-vp.mjs capture [--out dir] [--minutes 15]\n' +
            '       replay-vp.mjs replay --dir dir [--legacy | --compare [--fail-on-mismatch]] [--trip id] [--route id] [--skip n] [--top n] [--report file.md] [--min-label-match pct] [--max-p95 km]');
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
