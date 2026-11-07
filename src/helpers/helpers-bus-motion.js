// Pure motion logic for GTFS vehicles (buses and GO trains), shared by
// map.js and scripts/replay-vp.mjs. Imports carry explicit .js extensions
// so the module also loads in Node without the bundler.
import configs from '../configs.js';
import nearestCloserPointOnLine from '../turf/nearest-closer-point-on-line.js';

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
 */
export function applyVehiclePosition(bus, vp, trip, feature) {
    const stop = vp.currentStopSequence,
        position = vp.position;

    bus.status = vp.currentStatus;
    if (stop) {
        bus.stop = stop;
    } else {
        // Use the current bus.offset to calulate a weight and pick a closer point
        const offset = bus.offset = snapToShape(feature, [position.longitude, position.latitude], bus.offset);

        bus.stop = trip.stopSequences[getNextStopIndex(bus.offsets, offset)];
    }
}

/**
 * Updates the section (sectionIndex, sectionLength and, for timetable
 * vehicles, departureTime and nextDepartureTime) of a vehicle.
 * @param {Object} bus - Vehicle
 * @param {number} now - Time offset in milliseconds
 * @param {number} index - Section index for timetable vehicles (optional)
 * @param {boolean} final - True if a realtime vehicle is no longer reported
 * @returns {boolean} True if the vehicle has a section to run, undefined otherwise
 */
export function updateBusSection(bus, now, index, final) {
    const stopSequences = bus.trip.stopSequences;
    let departureTimes, currentSection;

    if (bus.stop === undefined) {
        departureTimes = bus.trip.departureTimes;
        currentSection = index === undefined ? departureTimes.reduce(
            (acc, cur, i) => cur <= now ? i : acc, 0
        ) : index;
    } else {
        currentSection = stopSequences.indexOf(bus.stop);
    }

    // Guard for an unexpected error
    // Potential data quality issue
    if (currentSection === -1) {
        console.log('no bus stop', bus);
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
}

/**
 * Returns the animation of a vehicle's current section (accelerate, cruise,
 * decelerate), or undefined if the vehicle does not move in this section.
 * @param {Object} bus - Vehicle with its section set
 * @param {number} now - Time offset in milliseconds
 * @param {number} index - Section index passed to busRepeat (optional)
 * @param {number} clockSpeed - Clock speed (1 in realtime mode)
 * @returns {Object} {startTime, duration, accelerationTime, normalizedAcceleration}
 */
export function getBusMotion(bus, now, index, clockSpeed) {
    const minBusStandingDuration = configs.minBusStandingDuration,
        {offsets, sectionIndex, sectionLength} = bus,
        distance = Math.abs(offsets[sectionIndex + sectionLength] - offsets[sectionIndex]);

    // Sometimes distance becomes 0 because the busroute coordinates
    // are incorrect and a few busstops shares the same coordinates.
    if (sectionLength > 0 && distance === 0) {
        console.log('bus zero interval:', bus);
    }

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
