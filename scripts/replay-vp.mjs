// Capture and replay GTFS-RT VehiclePositions/TripUpdates through the GTFS
// vehicle motion engine, and compare the section the engine renders with the
// section the GPS says the vehicle is in (docs/issues/vehicle-motion-plan.md).
//
//   npm run replay-vp -- capture [--out dir] [--minutes 15]
//   npm run replay-vp -- replay --dir dir [--legacy | --compare] [--trip id] [--route id]
//       [--skip n] [--top n] [--report file.md] [--min-label-match pct] [--max-p95 km]
//
// (npm run replay-vp runs Node with --use-system-ca, needed behind the
// corporate TLS proxy, and --no-warnings.)
//
// The simulator drives the real motion helpers (src/helpers/helpers-bus-motion.js)
// and the real ActiveObjectLookup scheduler. The glue around them (the VP
// handler, busStart, busRepeat and the GPU texture interpolation) mirrors
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

function formatOffset(offset) {
    const seconds = Math.round(offset / 1000) + 3 * 3600;

    return [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
        .map(v => String(v).padStart(2, '0')).join(':');
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

// Distance along the shape drawn by the GPU for a vehicle, mirroring
// compute-fragment.glsl / ComputeRenderer#getInstancePosition.
function getRenderedPosition(texture, now) {
    const {from, to, startTime, duration, accelerationTime, normalizedAcceleration} = texture,
        elapsed = Math.min(Math.max(now - startTime, 0), duration),
        left = Math.min(Math.max(startTime + duration - now, 0), duration);
    let t;

    if (elapsed < accelerationTime) {
        t = normalizedAcceleration / 2 * elapsed * elapsed;
    } else if (left < accelerationTime) {
        t = 1 - normalizedAcceleration / 2 * left * left;
    } else {
        t = normalizedAcceleration * accelerationTime * (elapsed - accelerationTime / 2);
    }
    return {distance: from + (to - from) * t, t};
}

class Simulator {

    constructor(engine, gtfs) {
        this.engine = engine;
        this.gtfs = gtfs;
        this.activeBusLookup = new ActiveObjectLookup();
        this.realtimeBuses = new Set();
        this.now = 0;
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

            realtimeBuses.add(tripId);

            const trip = gtfs.trips.get(tripId),
                feature = trip && gtfs.features.get(trip.shape),
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
            engine.applyVehiclePosition(bus, vp, trip, feature);
            if (!isActive) {
                this.busStart(bus);
            }
        }
    }

    // Mirrors busStart + TrafficLayer#addObject
    busStart(bus) {
        if (!this.engine.updateBusSection(bus, this.now)) {
            return;
        }
        this.activeBusLookup.set(bus.trip.id, bus);
        bus.texture = {
            from: bus.offsets[bus.sectionIndex],
            to: bus.offsets[bus.sectionIndex + bus.sectionLength],
            startTime: 86400000,
            duration: 0,
            accelerationTime: 0,
            normalizedAcceleration: 0
        };
        this.busRepeat(bus);
    }

    // Mirrors busRepeat (src/map.js) in realtime mode (clock speed 1)
    busRepeat(bus, index) {
        const {engine, activeBusLookup, now} = this;
        let final;

        if (bus.stop === undefined) {
            final = !engine.updateBusSection(bus, now, index);
        } else {
            final = !engine.updateBusSection(bus, now, undefined, !this.realtimeBuses.has(bus.trip.id));
        }

        const motion = !final && engine.getBusMotion(bus, now, index, 1);

        if (motion) {
            bus.texture = Object.assign({
                from: bus.offsets[bus.sectionIndex],
                to: bus.offsets[bus.sectionIndex + bus.sectionLength]
            }, motion);
            activeBusLookup.schedule(bus.trip.id, motion.startTime + motion.duration, () => {
                this.busRepeat(bus, bus.stop === undefined ? bus.sectionIndex + 1 : undefined);
            });
        } else {
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
    EARLY_GRACE = 2 * 60000,
    LATE_GRACE = 60 * 60000,
    BACKWARD_KM = 0.05,
    TELEPORT_KM = 2;

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
        truthOffsets = new Map(),
        stopOffsetCache = new Map(),
        previous = new Map(),
        observations = [],
        events = {backward: 0, teleport: 0, disappear: 0, ghosts: 0};
    let tuIndex = -1;

    vpSnapshots.forEach(({timestamp, feed}, tick) => {
        const now = toOffset(timestamp);

        simulator.advanceTo(now);
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
                {departureTimes} = trip,
                preDeparture = now < departureTimes[0] - EARLY_GRACE,
                postArrival = now > departureTimes[departureTimes.length - 1] + LATE_GRACE,
                expectedNext = currentEngine.getNextStopIndex(offsets, truth),
                accepted = new Set([expectedNext]),
                status = vp.currentStatus,
                bus = simulator.activeBusLookup.get(tripId);

            truthOffsets.set(tripId, truth);

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
                tuDelay: getDelayAtStop(tuFeed, tripId, trip.stops[expectedNext])
            };

            if (bus) {
                const {distance, t} = getRenderedPosition(bus.texture, now),
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

    return {observations, events};
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
        behindOver1km: pct(rendered.filter(o => o.error < -1).length, rendered.length)
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
        ['behindOver1km', 'behind > 1 km %', 1]
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
        buses = summarize(observations.filter(o => !o.isTrain));

    lines.push(`# VP replay: ${name} engine`, '');
    lines.push(`- Snapshots: ${vpSnapshots.length} VP, ${tuSnapshots.length} TU, ${formatOffset(toOffset(vpSnapshots[0].timestamp))} - ${formatOffset(toOffset(vpSnapshots[vpSnapshots.length - 1].timestamp))} (${gtfs.timezone})`);
    lines.push(`- Simulates a page loaded at the first snapshot; first ${options.skip} tick(s) excluded from stats.`);
    lines.push(`- Truth: GPS snapped to the trip shape. Service window: first departure - 2 min to last stop + 60 min. Stop tolerance ${STOP_TOLERANCE_KM} km.`);
    lines.push('');
    lines.push('## Summary', '');
    lines.push(summaryTable([['all', all], ['trains', trains], ['buses', buses]]));
    lines.push('');
    lines.push(`Events: backward moves > ${BACKWARD_KM * 1000} m: ${events.backward}, jumps > ${TELEPORT_KM} km: ${events.teleport}, disappearances while still in VP: ${events.disappear}, rendered vehicles not in VP (vehicle x tick): ${events.ghosts}`);
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
        if (mismatches) {
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
            '       replay-vp.mjs replay --dir dir [--legacy | --compare] [--trip id] [--route id] [--skip n] [--top n] [--report file.md] [--min-label-match pct] [--max-p95 km]');
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
