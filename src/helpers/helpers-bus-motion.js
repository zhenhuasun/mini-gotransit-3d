// Pure motion logic for GTFS vehicles (buses and GO trains), shared by
// map.js and scripts/replay-vp.mjs. Imports carry explicit .js extensions
// so the module also loads in Node without the bundler.
import configs from '../configs.js';
import nearestCloserPointOnLine from '../turf/nearest-closer-point-on-line.js';

// Consecutive VP ticks (15 s each) a trip may be absent before its vehicle is removed
export const MAX_MISSED_VP_TICKS = 2;

// GPS re-anchoring on each VP tick (docs/issues/vehicle-motion-step-d-design.md)
// Behind the rendered position by less than this (km): hold
export const HOLD_KM = 0.3;
// Farther than this (km) from the rendered position: teleport
export const TELEPORT_KM = 2;
// A fix older than this (s) never moves the vehicle backward and is not extrapolated
export const STALE_FIX_S = 90;
// The speed observed between two fixes is only used if they are this far apart (s)
export const MIN_SPEED_FIX_INTERVAL_S = 5;
export const MAX_SPEED_FIX_INTERVAL_S = 120;
// Weight of the newest sample in the per-vehicle moving average of the observed speed
export const SPEED_EMA_ALPHA = 0.5;
// A speed-matched move ends with a deceleration of this duration (ms), practically a constant speed
const CONSTANT_SPEED_END_MS = 100;
// Observed speed (km/h) below which a vehicle continuing between two ticks stands
const MIN_MOVING_SPEED_KMPH = 1;

// Service-window gate for realtime vehicles (step B)
// A trip is not shown before its first departure minus this (ms)
export const PRE_DEPARTURE_GRACE = 2 * 60000;
// A trip still reported by VP is kept until its last scheduled time plus this (ms)
export const LATE_TRIP_GRACE = 60 * 60000;
const DAY_MS = 86400000;

/**
 * Returns the service date (YYYYMMDD) at a local date and time. Service days
 * start at 3am, so before 3am it is still the previous calendar day.
 * @param {string} dateTime - Local time in "YYYY-MM-DD HH:mm:ss" format (Clock#getString)
 * @returns {string} Service date
 */
export function getServiceDate(dateTime) {
    const [year, month, day] = dateTime.slice(0, 10).split('-').map(Number),
        hours = Number(dateTime.slice(11, 13)),
        date = new Date(Date.UTC(year, month - 1, day - (hours < 3 ? 1 : 0)));

    return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// Days between two YYYYMMDD dates
function getDayDifference(date, baseDate) {
    const toTime = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));

    return Math.round((toTime(date) - toTime(baseDate)) / DAY_MS);
}

/**
 * Classifies a trip against its service window. Trip times are milliseconds
 * since 3am of the trip's own service day, which the tripId prefix
 * (YYYYMMDD-...) names; they are shifted to the 3am of the current service day
 * before being compared with now. Trips without a date prefix are taken to
 * belong to the current service day.
 * @param {Object} trip - GTFS trip (id, departureTimes)
 * @param {number} now - Milliseconds since the last 3am
 * @param {string} serviceDate - Current service date (YYYYMMDD), see getServiceDate
 * @returns {string} 'early' (before first departure - PRE_DEPARTURE_GRACE),
 *     'late' (after last time + LATE_TRIP_GRACE) or 'ok'
 */
export function getServiceWindowState(trip, now, serviceDate) {
    const times = trip.departureTimes,
        prefix = /^(\d{8})-/.exec(trip.id),
        shift = prefix && serviceDate ? getDayDifference(prefix[1], serviceDate) * DAY_MS : 0;

    if (now < times[0] + shift - PRE_DEPARTURE_GRACE) {
        return 'early';
    }
    if (now > times[times.length - 1] + shift + LATE_TRIP_GRACE) {
        return 'late';
    }
    return 'ok';
}

/**
 * Whether a realtime vehicle of the trip may exist now.
 * @param {Object} trip - GTFS trip
 * @param {number} now - Milliseconds since the last 3am
 * @param {string} serviceDate - Current service date (YYYYMMDD)
 * @returns {boolean} True if inside the service window
 */
export function isInServiceWindow(trip, now, serviceDate) {
    return getServiceWindowState(trip, now, serviceDate) === 'ok';
}

/**
 * Snaps a coordinate to a shape, preferring points close to a previous
 * location along the shape.
 * @param {Object} feature - LineString feature of the shape
 * @param {Array<number>} coord - [lon, lat] to snap
 * @param {number} location - Previous distance along the shape in km, used as a weight
 * @returns {number} Distance along the shape in km
 */
export function snapToShape(feature, coord, location) {
    return nearestCloserPointOnLine(feature, coord, location).properties.totalDistance;
}

/**
 * Returns the distance along the shape of each stop of a trip.
 * @param {Object} feature - LineString feature of the shape
 * @param {Array<Array<number>>} stopCoords - [lon, lat] of each stop, in trip order
 * @returns {Array<number>} Distance along the shape of each stop in km
 */
export function getStopOffsets(feature, stopCoords) {
    let offset = 0;

    // Use the previous offset to calulate a weight and pick a closer point
    return stopCoords.map(coord => (offset = snapToShape(feature, coord, offset)));
}

/**
 * Returns the index of the first stop whose offset is not behind the given
 * distance (the NEXT stop), clamped to the last stop.
 * @param {Array<number>} offsets - Distance along the shape of each stop in km
 * @param {number} offset - Distance along the shape in km
 * @returns {number} Stop index
 */
export function getNextStopIndex(offsets, offset) {
    return offsets.reduce(
        (acc, cur, i) => cur < offset ? Math.min(i + 1, offsets.length - 1) : acc, 0
    );
}

/**
 * Applies a GTFS-RT VehiclePosition to a vehicle: sets its status and stop
 * (from current_stop_sequence, or from the snapped GPS position).
 * @param {Object} bus - Vehicle
 * @param {Object} vp - Decoded VehiclePosition
 * @param {Object} trip - GTFS trip of the vehicle
 * @param {Object} feature - LineString feature of the trip shape
 * @param {number} feedTime - Timestamp of the VP feed in seconds (optional), to age the fix
 * @param {number} routeType - GTFS route type of the vehicle (optional), to bound its observed speed
 */
export function applyVehiclePosition(bus, vp, trip, feature, feedTime, routeType) {
    const stop = vp.currentStopSequence,
        position = vp.position,
        fixTime = vp.timestamp ? Number(vp.timestamp) : undefined;

    // A repeated fix carries the timestamp of the previous one
    bus.repeatedFix = fixTime !== undefined && bus.fixTime === fixTime;
    bus.fixTime = fixTime;
    bus.fixAge = fixTime !== undefined && feedTime !== undefined ? Math.max(0, feedTime - fixTime) : undefined;
    bus.routeType = routeType;
    bus.status = vp.currentStatus;
    // Use the current bus.offset to calulate a weight and pick a closer point
    const offset = position ? bus.offset = snapToShape(feature, [position.longitude, position.latitude], bus.offset) : bus.offset;

    if (position && fixTime !== undefined && !bus.repeatedFix) {
        updateObservedSpeed(bus, fixTime, offset);
    }

    bus.stop = stop || trip.stopSequences[getNextStopIndex(bus.offsets, offset)];
}

// Updates bus.observedSpeed (km/h, a moving average) from the last two fresh
// fixes of the vehicle. Samples from fixes too close together, or from a fix
// that moved backward, are ignored; the average is dropped if the previous fix
// is too old.
function updateObservedSpeed(bus, fixTime, distance) {
    const previous = bus.speedFix;

    bus.speedFix = {time: fixTime, distance};
    if (!previous) {
        return;
    }

    const interval = fixTime - previous.time,
        delta = distance - previous.distance;

    if (interval > MAX_SPEED_FIX_INTERVAL_S) {
        bus.observedSpeed = undefined;
    } else if (interval >= MIN_SPEED_FIX_INTERVAL_S && delta >= 0) {
        const sample = Math.min(delta / interval * 3600, getCruiseSpeedKMPH(bus, bus.routeType));

        bus.observedSpeed = bus.observedSpeed === undefined ? sample :
            SPEED_EMA_ALPHA * sample + (1 - SPEED_EMA_ALPHA) * bus.observedSpeed;
    }
}

/**
 * Counts, for each active realtime vehicle, the consecutive VP ticks in which
 * its trip was not reported (bus.missedTicks, reset when it is reported), and
 * returns the vehicles absent for MAX_MISSED_VP_TICKS ticks or more. Call once
 * per VP tick, after the VP entities have been applied.
 * @param {Iterable<Object>} activeBuses - Active vehicles
 * @param {Set<string>} reportedTripIds - Trip ids reported by this VP tick
 * @returns {Array<Object>} Vehicles to remove
 */
export function getVanishedBuses(activeBuses, reportedTripIds) {
    const vanished = [];

    for (const bus of activeBuses) {
        // Timetable vehicles (no bus.stop) are not driven by VP
        if (bus.stop === undefined) {
            continue;
        }
        if (reportedTripIds.has(bus.trip.id)) {
            bus.missedTicks = 0;
        } else if ((bus.missedTicks = (bus.missedTicks || 0) + 1) >= MAX_MISSED_VP_TICKS) {
            vanished.push(bus);
        }
    }
    return vanished;
}

// Distance (km) within which a vehicle counts as being at a stop
const STOP_EPSILON_KM = 0.001;

function isNonDecreasing(offsets) {
    return offsets.every((offset, i) => i === 0 || offset >= offsets[i - 1]);
}

// Index of the first stop beyond the distance, or -1 if there is none
function getStopIndexAfter(offsets, distance) {
    return offsets.findIndex(offset => offset > distance + STOP_EPSILON_KM);
}

function isMidSection(offsets, distance) {
    const index = getStopIndexAfter(offsets, distance);

    return index > 0 && distance > offsets[index - 1] + STOP_EPSILON_KM;
}

// Plan for a vehicle standing at the distance. Between two stops it keeps the
// section it is in (length 1, start = end) so it counts as not standing at a stop.
function planStand(offsets, distance, action) {
    const index = getStopIndexAfter(offsets, distance);

    return {
        startDistance: distance,
        endDistance: distance,
        sectionIndex: index === -1 ? offsets.length - 1 : Math.max(index - 1, 0),
        sectionLength: isMidSection(offsets, distance) ? 1 : 0,
        action
    };
}

// True if the vehicle may not move on from the distance: no stop ahead, or the
// next stop ahead is beyond the GPS next stop
function isBlocked(bus, index) {
    return index === -1 || bus.trip.stopSequences.indexOf(bus.stop) < index;
}

// Plan for a vehicle continuing from the distance to the next stop ahead, not
// beyond the GPS next stop (index); it stands if that stop is not ahead. With a
// speed (km/h) the vehicle moves at that constant speed (it stands if the speed is ~0).
function planFrom(bus, distance, action, speedKMPH) {
    const {offsets} = bus,
        index = getStopIndexAfter(offsets, distance);

    if (isBlocked(bus, index) || speedKMPH < MIN_MOVING_SPEED_KMPH) {
        return planStand(offsets, distance, action);
    }
    return {
        startDistance: distance,
        endDistance: offsets[index],
        sectionIndex: index - 1,
        sectionLength: 1,
        action,
        speedKMPH
    };
}

// Plan for a vehicle moving from the distance to where the GPS fix says the
// vehicle will be at the next VP tick (speed-matched re-anchoring): the fix
// (gpsDistance) plus the observed speed times the age of the fix and the tick
// interval, not beyond the next stop. The move takes one tick interval, at most
// at the cruise speed. A stale fix is not extrapolated. The vehicle stands only
// if that distance is not ahead of it.
function planPredicted(bus, distance, gpsDistance, observedKMPH, ahead, action) {
    const {offsets} = bus,
        index = getStopIndexAfter(offsets, distance),
        standAction = ahead ? 'hold' : action;

    if (isBlocked(bus, index)) {
        return planStand(offsets, distance, standAction);
    }

    const tickS = configs.realtimeCheckInterval / 1000,
        horizonS = Math.min(bus.fixAge || 0, STALE_FIX_S) + tickS,
        predicted = bus.fixAge > STALE_FIX_S ? gpsDistance : gpsDistance + observedKMPH * horizonS / 3600,
        endDistance = Math.min(predicted, offsets[index]);

    if (endDistance <= distance + STOP_EPSILON_KM) {
        return planStand(offsets, distance, standAction);
    }
    return {
        startDistance: distance,
        endDistance,
        sectionIndex: index - 1,
        sectionLength: 1,
        action: ahead ? 'slowDown' : action,
        speedKMPH: Math.min((endDistance - distance) / tickS * 3600, getCruiseSpeedKMPH(bus, bus.routeType))
    };
}

// Observed speed (km/h) to match, or undefined if speed matching is off or not known
function getObservedSpeed(bus) {
    const speed = bus.observedSpeed;

    return configs.speedMatching && speed !== undefined ?
        Math.min(Math.max(speed, 0), getCruiseSpeedKMPH(bus, bus.routeType)) : undefined;
}

// Re-anchors a vehicle to its GPS fix on a VP tick, in the precedence order of
// docs/issues/vehicle-motion-step-d-design.md
function planTick(bus, renderedDistance) {
    const {offsets} = bus,
        last = offsets.length - 1,
        clamp = distance => Math.min(Math.max(distance, offsets[0]), offsets[last]);

    if (bus.repeatedFix) {
        return {ignore: true, action: 'repeatedSkipped'};
    }

    const gpsDistance = clamp(bus.offset),
        distance = clamp(renderedDistance),
        err = gpsDistance - distance,
        speed = getObservedSpeed(bus),
        // Without an observed speed: freeze if ahead of the GPS, else move at cruise speed
        move = (from, action, ahead) => speed === undefined ?
            (ahead ? planStand(offsets, from, action) : planFrom(bus, from, action)) :
            planPredicted(bus, from, gpsDistance, speed, ahead, action),
        // The observed speed is dropped on a teleport
        teleport = action => Object.assign(move(gpsDistance, action, false), {behindFixes: 0, resetSpeed: true});
    let plan;

    if (bus.fixAge > STALE_FIX_S && err < 0) {
        return {ignore: true, action: 'staleIgnored'};
    }
    if (err > TELEPORT_KM) {
        plan = teleport('teleportForward');
    } else if (err < -TELEPORT_KM) {
        plan = teleport('teleportBack');
    } else if (err < -HOLD_KM) {
        const behindFixes = (bus.behindFixes || 0) + 1;

        plan = behindFixes >= configs.behindTeleportFixes ?
            teleport('teleportBack') :
            Object.assign(move(distance, 'hold', true), {behindFixes});
    } else if (err < 0) {
        plan = Object.assign(move(distance, 'hold', true), {behindFixes: 0});
    } else {
        plan = Object.assign(move(distance, 'catchUp', false), {behindFixes: 0});
    }
    plan.speedAvailable = speed !== undefined;
    return plan;
}
/**
 * Plans the next move of a realtime vehicle (bus.stop is the GPS NEXT stop).
 * Pure: it does not modify the vehicle.
 *
 * - A new vehicle (no section yet) spawns standing at its snapped GPS
 *   distance, bus.offset (action 'teleport'); at or before the first stop it
 *   stands at the origin, section (0, 0).
 * - On a VP tick (renderedDistance given) the vehicle is re-anchored to its
 *   GPS fix: repeated and stale fixes are ignored ({ignore: true}), else it
 *   teleports, holds or catches up from renderedDistance (see planTick).
 * - With an observed speed (see applyVehiclePosition) the vehicle is moved to
 *   its predicted position at the next tick at a constant speed (plan.speedKMPH),
 *   and slows down instead of freezing when it is ahead of the GPS (see planPredicted).
 * - Otherwise the vehicle continues stop by stop from its endDistance, one
 *   stop per move, never beyond the GPS next stop; if that stop is not ahead
 *   it stands. After the last stop it stands there until it is removed (see
 *   getVanishedBuses).
 * - If the stop offsets are not non-decreasing (loop shapes) the Step C
 *   section logic is kept, VP ticks are ignored and no start/end distances are set.
 * @param {Object} bus - Realtime vehicle
 * @param {number} renderedDistance - Distance currently rendered in km (undefined if none)
 * @param {boolean} onTick - True if called for a new VP tick
 * @returns {Object} {startDistance, endDistance, sectionIndex, sectionLength, action, behindFixes, speedKMPH}, {ignore: true, action} to leave the vehicle as is, undefined if the vehicle has no section to run
 */
export function planRealtimeMove(bus, renderedDistance, onTick) {
    const {offsets, trip: {stopSequences}} = bus,
        last = offsets.length - 1,
        nextIndex = stopSequences.indexOf(bus.stop),
        hasSection = bus.sectionIndex !== undefined;

    if (!isNonDecreasing(offsets)) {
        if (onTick && hasSection) {
            return {ignore: true};
        }
        if (hasSection && bus.loopFresh) {
            // busStart and its first busRepeat share the same VP data
            return {sectionIndex: bus.sectionIndex, sectionLength: bus.sectionLength, loopFresh: false};
        }
        if (hasSection) {
            const end = bus.sectionIndex + bus.sectionLength;

            if (nextIndex <= end) {
                return {sectionIndex: end, sectionLength: 0, loopFresh: false};
            }
        } else if (nextIndex === -1) {
            return;
        }
        return {
            sectionIndex: Math.max(nextIndex - 1, 0),
            sectionLength: nextIndex > 0 ? 1 : 0,
            loopFresh: !hasSection
        };
    }

    if (!hasSection) {
        if (nextIndex === -1) {
            return;
        }
        return planStand(offsets, Math.min(Math.max(bus.offset, offsets[0]), offsets[last]), 'teleport');
    }

    if (onTick && renderedDistance !== undefined) {
        return planTick(bus, renderedDistance);
    }
    const distance = Math.min(Math.max(bus.endDistance, offsets[0]), offsets[last]);

    // A speed-matched move that ended between two stops goes on at the observed speed until the next tick
    return planFrom(bus, distance, undefined, bus.speedKMPH !== undefined && isMidSection(offsets, distance) ? getObservedSpeed(bus) : undefined);
}
/**
 * Updates the section (sectionIndex, sectionLength and, for timetable
 * vehicles, departureTime and nextDepartureTime) of a vehicle. Realtime
 * vehicles (bus.stop is set) follow planRealtimeMove and also get
 * startDistance and endDistance.
 * @param {Object} bus - Vehicle
 * @param {number} now - Time offset in milliseconds
 * @param {number} index - Section index for timetable vehicles (optional)
 * @param {number} renderedDistance - Rendered distance of a realtime vehicle in km (optional)
 * @param {boolean} onTick - True if called for a new VP tick (optional)
 * @returns {boolean|Object} Truthy (the realtime plan, or true for a timetable vehicle)  if the vehicle has a section to run, undefined otherwise. A realtime plan with ignore set left the vehicle untouched.
 */
export function updateBusSection(bus, now, index, renderedDistance, onTick) {
    const stopSequences = bus.trip.stopSequences;

    if (bus.stop === undefined) {
        const departureTimes = bus.trip.departureTimes,
            currentSection = index === undefined ? departureTimes.reduce(
                (acc, cur, i) => cur <= now ? i : acc, 0
            ) : index;

        // Guard for an unexpected error
        // Potential data quality issue
        if (currentSection === -1) {
            console.log('no bus stop', bus);
        }

        if (currentSection !== stopSequences.length - 1) {
            bus.sectionIndex = currentSection;
            bus.sectionLength = 1;
            bus.departureTime = departureTimes[currentSection];
            bus.nextDepartureTime = departureTimes[currentSection + 1];

            return true;
        }
        return;
    }

    // Guard for an unexpected error
    // Potential data quality issue
    if (stopSequences.indexOf(bus.stop) === -1) {
        console.log('no bus stop', bus);
    }

    const plan = planRealtimeMove(bus, renderedDistance, onTick);

    if (plan && !plan.ignore) {
        bus.sectionIndex = plan.sectionIndex;
        bus.sectionLength = plan.sectionLength;
        bus.startDistance = plan.startDistance;
        bus.endDistance = plan.endDistance;
        if (plan.loopFresh !== undefined) {
            bus.loopFresh = plan.loopFresh;
        }
        if (plan.behindFixes !== undefined) {
            bus.behindFixes = plan.behindFixes;
        }
        bus.speedKMPH = plan.speedKMPH;
        if (plan.resetSpeed) {
            bus.observedSpeed = undefined;
        }
    }
    return plan;
}
/**
 * Returns the cruise speed of a vehicle in km/h. Only realtime vehicles
 * (bus.stop is set) have no timetable to clamp their duration, so only they
 * use the per-type speeds; timetable vehicles keep maxBusSpeedKMPH.
 * @param {Object} bus - Vehicle
 * @param {number} routeType - GTFS route type of the vehicle (optional)
 * @returns {number} Cruise speed in km/h
 */
export function getCruiseSpeedKMPH(bus, routeType) {
    if (bus.stop !== undefined) {
        if (routeType === 2) {
            return configs.maxTrainSpeedKMPH;
        }
        if (routeType === 3) {
            return configs.maxGoBusSpeedKMPH;
        }
    }
    return configs.maxBusSpeedKMPH;
}

/**
 * Returns the distances (km on the shape) a vehicle's current move starts and
 * ends at. Timetable vehicles never set startDistance/endDistance, so they
 * move between the stop offsets of their section.
 * @param {Object} bus - Vehicle with its section set
 * @returns {number[]} [startDistance, endDistance]
 */
export function getMoveDistances(bus) {
    const {offsets, sectionIndex, sectionLength, startDistance, endDistance} = bus;

    return [
        startDistance !== undefined ? startDistance : offsets[sectionIndex],
        endDistance !== undefined ? endDistance : offsets[sectionIndex + sectionLength]
    ];
}

/**
 * Returns the distance a vehicle has covered at the given time, replicating
 * the interpolation of compute-fragment.glsl without a GPU readback.
 * @param {Object} motion - {startDistance, endDistance, startTime, duration, accT, accN, decT, decN}
 * @param {number} now - Time offset in milliseconds
 * @returns {Object} {distance, t}
 */
export function getMotionDistance(motion, now) {
    const {startDistance, endDistance, startTime, duration, accT, accN, decT, decN} = motion,
        elapsed = Math.min(Math.max(now - startTime, 0), duration),
        left = Math.min(Math.max(startTime + duration - now, 0), duration);
    let t;

    if (elapsed < accT) {
        t = accN / 2 * elapsed * elapsed;
    } else if (left < decT) {
        t = 1 - decN / 2 * left * left;
    } else {
        t = Math.max(accN * accT, decN * decT) * (elapsed - accT / 2);
    }
    return {distance: startDistance + (endDistance - startDistance) * t, t};
}

/**
 * Remaps the interpolation factor t of a move (startDistance to endDistance)
 * to a factor between the stop offsets of the vehicle's section. Vehicles
 * without startDistance keep t unchanged.
 * @param {Object} bus - Vehicle with its section set
 * @param {number} t - Interpolation factor of the move
 * @returns {number} Interpolation factor of the section
 */
export function getSectionT(bus, t) {
    const {offsets, sectionIndex, sectionLength, startDistance, endDistance} = bus;

    if (startDistance === undefined || !(sectionLength > 0)) {
        return t;
    }

    const sectionStart = offsets[sectionIndex],
        sectionEnd = offsets[sectionIndex + 1];

    // The bus's doubles are used (not the Float32 texture) so endpoints stay exactly 0/1
    return (startDistance + (endDistance - startDistance) * t - sectionStart) / (sectionEnd - sectionStart);
}
/**
 * Returns the animation of a vehicle's current section (accelerate, cruise,
 * decelerate), or undefined if the vehicle does not move in this section.
 * @param {Object} bus - Vehicle with its section set
 * @param {number} now - Time offset in milliseconds
 * @param {number} index - Section index passed to busRepeat (optional)
 * @param {number} clockSpeed - Clock speed (1 in realtime mode)
 * @param {number} routeType - GTFS route type of the vehicle (optional)
 * @param {boolean} startAtSpeed - True to start at cruise speed (a moving vehicle re-anchored on a VP tick): no acceleration, only deceleration (optional)
 * @param {number} speedKMPH - Constant speed in km/h of a speed-matched move: no acceleration, nearly no deceleration (optional)
 * @returns {Object} {startTime, duration, accelerationTime, normalizedAcceleration, decelerationTime, normalizedDeceleration}
 */
export function getBusMotion(bus, now, index, clockSpeed, routeType, startAtSpeed, speedKMPH) {
    const minBusStandingDuration = configs.minBusStandingDuration,
        {sectionLength} = bus,
        [startDistance, endDistance] = getMoveDistances(bus),
        distance = Math.abs(endDistance - startDistance);

    // Sometimes distance becomes 0 because the busroute coordinates
    // are incorrect and a few busstops shares the same coordinates.
    if (sectionLength > 0 && distance === 0 && bus.startDistance === undefined) {
        console.log('bus zero interval:', bus);
    }

    if (!(sectionLength > 0 && distance > 0)) {
        return;
    }

    const minDelay = configs.minDelay,
        {departureTime, nextDepartureTime} = bus,
        actualDepartureTime = index !== undefined ?
            Math.max(departureTime, now + (clockSpeed === 1 ? minBusStandingDuration : 0)) :
            departureTime === undefined ? now : departureTime,
        cruiseSpeed = getCruiseSpeedKMPH(bus, routeType) / 3600000,
        maxBusAccelerationTime = cruiseSpeed / configs.busAcceleration;
    let maxBusSpeed = cruiseSpeed,
        busAcceleration = configs.busAcceleration,
        maxBusAccDistance = maxBusAccelerationTime * cruiseSpeed / 2,
        duration, maxDuration, accelerationTime;

    if (nextDepartureTime !== undefined) {
        maxDuration = nextDepartureTime - minBusStandingDuration + 60000 - minDelay - actualDepartureTime;
    }

    if (speedKMPH > 0 && nextDepartureTime === undefined) {
        const speed = speedKMPH / 3600000;

        return {
            startTime: actualDepartureTime,
            duration: distance / speed + CONSTANT_SPEED_END_MS / 2,
            accelerationTime: 0,
            normalizedAcceleration: 0,
            decelerationTime: CONSTANT_SPEED_END_MS,
            normalizedDeceleration: speed / distance / CONSTANT_SPEED_END_MS
        };
    }

    if (startAtSpeed && nextDepartureTime === undefined) {
        // Enter at cruise speed, or slower if the distance is too short to stop from it
        const entrySpeed = distance >= maxBusAccDistance ? cruiseSpeed : Math.sqrt(2 * busAcceleration * distance),
            decelerationTime = entrySpeed / busAcceleration;

        return {
            startTime: actualDepartureTime,
            duration: (distance - entrySpeed * decelerationTime / 2) / entrySpeed + decelerationTime,
            accelerationTime: 0,
            normalizedAcceleration: 0,
            decelerationTime,
            normalizedDeceleration: busAcceleration / distance
        };
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
        normalizedAcceleration: busAcceleration / distance,
        decelerationTime: accelerationTime,
        normalizedDeceleration: busAcceleration / distance
    };
}

/**
 * Returns how long a vehicle that does not move in its current section
 * waits before busRepeat runs again.
 * @param {Object} bus - Vehicle
 * @param {number} now - Time offset in milliseconds
 * @param {boolean} final - True if the vehicle is about to be removed
 * @returns {number} Wait duration in milliseconds
 */
export function getBusWaitDuration(bus, now, final) {
    const minBusStandingDuration = configs.minBusStandingDuration;

    return bus.stop === undefined ?
        Math.max(bus.nextDepartureTime - now, minBusStandingDuration) :
        final ? minBusStandingDuration : configs.realtimeCheckInterval;
}
