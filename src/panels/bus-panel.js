import {getTimeString, lerp} from '../helpers/helpers';
import Panel from './panel';

export default class extends Panel {

    constructor(options) {
        super(Object.assign({className: 'bus-panel'}, options));
    }

    addTo(map) {
        const me = this,
            busstopHTML = [],
            offsets = [],
            bus = me._options.object,
            gtfs = map.gtfs.get(bus.gtfsId),
            trip = bus.trip,
            {route, stops: stopIds, departureTimes} = trip,
            color = gtfs.routes.get(route).color,
            stops = gtfs.stops;

        for (let i = 0, ilen = stopIds.length; i < ilen; i++) {
            const stop = stops.get(stopIds[i]),
                departureTime = getTimeString(departureTimes[i]);

            busstopHTML.push([
                '<div class="busstop-row">',
                `<div class="busstop-title-box">${stop.name}</div>`,
                `<div class="busstop-time-box">${departureTime}</div>`,
                '</div>'
            ].join(''));
        }

        super.addTo(map);
        me.updateHeader();
        me.setHTML([
            '<div id="timetable-content">',
            ...busstopHTML,
            '</div>',
            '<svg id="busroute-mark"></svg>',
            '<svg id="bus-mark"></svg>'
        ].join(''));

        const container = me._container,
            bodyElement = container.querySelector('#panel-body');

        for (const child of container.querySelector('#timetable-content').children) {
            offsets.push(child.offsetTop + child.getBoundingClientRect().height / 2);
        }
        container.querySelector('#busroute-mark').innerHTML = [
            `<line id="busroute-mark-passed" stroke="#9e9e9e" stroke-width="10" x1="12" y1="${offsets[0]}" x2="12" y2="${offsets[0]}" stroke-linecap="round" />`,
            `<line id="busroute-mark-remaining" stroke="${color || gtfs.color}" stroke-width="10" x1="12" y1="${offsets[0]}" x2="12" y2="${offsets[offsets.length - 1]}" stroke-linecap="round" />`
        ].concat(offsets.map(offset =>
            `<circle cx="12" cy="${offset}" r="3" fill="#ffffff" />`
        )).join('');
        me._routeCircles = [...container.querySelectorAll('#busroute-mark circle')];
        me._passedLine = container.querySelector('#busroute-mark-passed');
        me._remainingLine = container.querySelector('#busroute-mark-remaining');
        me._nextIndex = bus.sectionIndex + bus.sectionLength;
        me._lastDelay = bus.delay;
        me._clockMode = map.getClockMode();
        me.updateTimes(me._nextIndex);

        (function repeat() {
            const height = bodyElement.getBoundingClientRect().height,
                nextIndex = bus.sectionIndex + bus.sectionLength,
                curr = offsets[Math.max(0, nextIndex - 1)],
                next = offsets[nextIndex],
                y = lerp(curr, next, bus._t),
                p = performance.now() % 1500 / 1500;

            // The route line splits at the dot: the passed part is grey.
            me._passedLine.setAttribute('y2', y);
            me._remainingLine.setAttribute('y1', y);
            // Times and passed styling refresh only when the section,
            // the delay or the clock mode changed.
            if (nextIndex !== me._nextIndex || bus.delay !== me._lastDelay || map.getClockMode() !== me._clockMode) {
                me._nextIndex = nextIndex;
                me._lastDelay = bus.delay;
                me._clockMode = map.getClockMode();
                me.updateTimes(nextIndex);
            }
            container.querySelector('#bus-mark').innerHTML =
                `<circle cx="22" cy="${y}" r="${7 + p * 15}" fill="#ffffff" opacity="${1 - p}" />` +
                `<circle cx="22" cy="${y}" r="7" fill="#ffffff" />`;
            if (me._scrollTop === undefined || me._scrollTop === bodyElement.scrollTop) {
                me._scrollTop = bodyElement.scrollTop = Math.round(y - height / 2 + 4);
            }
            if (me._container) {
                requestAnimationFrame(repeat);
            }
        })();

        return me;
    }

    updateTimes(nextIndex) {
        const me = this,
            map = me._map,
            bus = me._options.object,
            gtfs = map.gtfs.get(bus.gtfsId),
            trip = bus.trip,
            {departureTimes} = trip,
            live = map.getClockMode() === 'realtime',
            rows = me._container.querySelectorAll('.busstop-row');

        for (let i = 0, ilen = Math.min(rows.length, departureTimes.length); i < ilen; i++) {
            const row = rows[i],
                timeBox = row.querySelector('.busstop-time-box'),
                passed = i < nextIndex;

            row.classList.toggle('passed', passed);
            if (me._routeCircles && i < me._routeCircles.length) {
                me._routeCircles[i].setAttribute('fill', passed ? '#9e9e9e' : '#ffffff');
            }
            if (!live) {
                timeBox.textContent = getTimeString(departureTimes[i]);
                timeBox.style.removeProperty('color');
                continue;
            }
            const tripDelay = map.getTripDelay(gtfs, trip.id, departureTimes[i]);
            if (!tripDelay) {
                timeBox.textContent = getTimeString(departureTimes[i]);
                timeBox.style.removeProperty('color');
                continue;
            }
            const delay = tripDelay.delay,
                eta = getTimeString(departureTimes[i] + delay * 1000),
                mins = Math.floor(Math.abs(delay) / 60);

            timeBox.textContent = mins >= 1 ?
                `${eta} (${delay > 0 ? '+' : '-'}${mins}m)` : eta;
            if (passed) {
                // Passed rows are grey; the time is the scheduled time
                // plus the trip's current delay, an estimate, not a
                // measured actual — the API keeps no per-stop actuals.
                timeBox.style.removeProperty('color');
            } else {
                timeBox.style.color = delay >= 900 ? '#ff6b6b' :
                    delay >= 180 ? '#ffd54f' :
                    delay < 0 ? '#1976d2' : '#00a651';
            }
        }
    }

    updateHeader() {
        const me = this,
            map = me._map,
            bus = me._options.object,
            gtfs = map.gtfs.get(bus.gtfsId),
            {route, headsigns} = bus.trip,
            {shortName, longName, color, textColor} = gtfs.routes.get(route),
            labelStyle = [
                textColor ? `color: ${textColor};` : '',
                color ? `background-color: ${color};` : ''
            ].join(' ');

        this.setTitle([
            '<div class="desc-header">',
            `<div style="background-color: ${gtfs.color};"></div>`,
            '<div><div class="desc-first-row">',
            gtfs.agency,
            bus.stop !== undefined ? '<span class="realtime-icon"></span>' : '',
            '</div><div class="desc-second-row">',
            shortName || longName ? ` <span class="bus-route-label" style="${labelStyle}">${shortName || longName}</span> ` : '',
            headsigns.length === 0 ? longName : headsigns[headsigns.length === 1 ? 0 : bus.sectionIndex],
            '</div></div></div>'
        ].join(''));
    }

    reset() {
        delete this._scrollTop;
    }

}
