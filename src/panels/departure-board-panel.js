import {getTimeString} from '../helpers/helpers';
import Panel from './panel';

const WINDOW_SECONDS = 2 * 3600,
    MAX_ROWS = 40,
    REFRESH_MS = 60000,
    WORKER_FALLBACK_ORIGIN = 'https://go-3d-tracker-proxy.zhenhuasun.workers.dev';

// 'KI - Mount Pleasant GO' -> 'Mount Pleasant GO';
// 'Union Station GO 19:34 - Mount Pleasant GO 20:25' -> 'Mount Pleasant GO'.
function cleanDestination(headsign) {
    if (!headsign) {
        return '';
    }
    let dest = headsign;
    const dash = dest.lastIndexOf(' - ');
    if (dash >= 0) {
        dest = dest.slice(dash + 3);
    }
    dest = dest.replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '');
    return dest || headsign;
}

function toMinutes(hhmm) {
    if (!hhmm || hhmm.indexOf(':') < 0) {
        return null;
    }
    const [h, m] = hhmm.split(':');
    return (+h) * 60 + (+m);
}

function workerOrigin(gtfs) {
    try {
        return new URL(gtfs.vehiclePositionUrl).origin;
    } catch (e) {
        return WORKER_FALLBACK_ORIGIN;
    }
}

// UnionDepartures ServiceType values are not documented precisely;
// match tolerantly so unknown values fall through to the static fallback
// instead of showing the wrong mode's board.
function isTrainRow(row) {
    const t = row.serviceType || '';
    return /train|rail/i.test(t) || t === 'T';
}

function isBusRow(row) {
    const t = row.serviceType || '';
    return /bus/i.test(t) || t === 'B';
}

export default class extends Panel {

    constructor(options) {
        super(Object.assign({className: 'departure-board-panel'}, options));
    }

    addTo(map) {
        const me = this;

        super.addTo(map);
        me.updateContent();
        me._timer = setInterval(() => me.updateContent(), REFRESH_MS);
        return me;
    }

    remove() {
        const me = this;

        if (me._timer) {
            clearInterval(me._timer);
            delete me._timer;
        }
        return super.remove();
    }

    async updateContent() {
        const me = this,
            map = me._map,
            {gtfsId, stopId, stopName} = me._options,
            gtfs = map.gtfs.get(gtfsId);

        if (!gtfs) {
            return me;
        }

        const origin = workerOrigin(gtfs),
            isUnion = stopName.indexOf('Union Station') === 0,
            stopCode = /^[A-Z]{2,4}$/.test(stopId) ? stopId : null;
        let nextRows = null,
            platformByTrip = new Map(),
            unionRows = null;

        // Primary: per-stop realtime predictions.
        if (stopCode) {
            try {
                const res = await fetch(`${origin}/api/departures?stop=${stopCode}`);
                if (res.ok) {
                    const data = await res.json();
                    nextRows = Array.isArray(data.departures) ? data.departures : [];
                }
            } catch (e) {
                nextRows = null;
            }
        }

        // Platform source (Union only): UnionDepartures joined by trip number.
        if (isUnion) {
            try {
                const res = await fetch(`${origin}/api/union-departures`);
                if (res.ok) {
                    const data = await res.json();
                    unionRows = Array.isArray(data.departures) ? data.departures : [];
                    for (const row of unionRows) {
                        if (row.trip && row.platform) {
                            platformByTrip.set(row.trip, row.platform);
                        }
                    }
                }
            } catch (e) {
                unionRows = null;
            }
        }

        let rows = [],
            sourceNote = '';

        if (nextRows) {
            // NextService rows are authoritative for this stop.
            rows = nextRows.map(d => ({
                line: d.line,
                destination: d.dest,
                scheduled: d.scheduled || '',
                expected: d.expected || d.time || '',
                status: d.status || '',
                platform: platformByTrip.get(d.trip) || '',
                color: '',
                textColor: ''
            }));
            // Attach route colors from static GTFS where the line matches.
            for (const row of rows) {
                for (const route of gtfs.routes.getAll()) {
                    if (route.shortName === row.line) {
                        row.color = route.color || gtfs.color;
                        row.textColor = route.textColor;
                        break;
                    }
                }
            }
            sourceNote = '实时 · Live';
        } else if (unionRows) {
            // No per-stop predictions (e.g. Bus Terminal code unknown):
            // use UnionDepartures rows of this mode, if recognizable.
            const modeRows = stopId === 'UN' ?
                unionRows.filter(isTrainRow) :
                unionRows.filter(isBusRow);
            if (modeRows.length) {
                rows = modeRows.map(d => ({
                    line: d.service || d.line || '',
                    destination: d.info || d.dest || '',
                    scheduled: '',
                    expected: d.time || '',
                    status: '',
                    platform: d.platform || '',
                    color: '',
                    textColor: ''
                }));
                sourceNote = '实时 · Live';
            }
        }

        if (!rows.length) {
            // Fallback: GTFS static timetable for this stop.
            rows = me.computeStaticRows(gtfs, stopId);
            sourceNote = 'API 暂不可用，显示时刻表 · Timetable (API unavailable)';
        }

        rows = rows.slice(0, MAX_ROWS);
        me.setTitle(`${stopName} Departures 出发`);
        me.setHTML([
            '<div style="padding:8px 12px;opacity:.7">',
            `${sourceNote} · ${rows.length} 班次`,
            '</div>',
            '<div style="display:flex;align-items:center;gap:8px;padding:4px 12px;opacity:.6;font-size:12px">',
            '<span style="flex:1">线路 · 目的地</span>',
            '<span style="min-width:52px;text-align:right">时刻</span>',
            '<span style="min-width:64px;text-align:right">预计</span>',
            '<span style="min-width:40px;text-align:right">站台</span>',
            '</div>',
            ...rows.map(row => {
                const schedMin = toMinutes(row.scheduled),
                    expMin = toMinutes(row.expected);
                let expectedHTML = row.expected || '—';

                if (/cancel/i.test(row.status || '')) {
                    expectedHTML = '<span style="color:#d00">Cancelled</span>';
                } else if (schedMin !== null && expMin !== null) {
                    if (expMin === schedMin) {
                        expectedHTML = '<span style="color:#0a0">On Time</span>';
                    } else if (expMin > schedMin) {
                        expectedHTML = `<span style="color:#d00">${row.expected}</span>`;
                    } else {
                        expectedHTML = `<span style="color:#06c">${row.expected}</span>`;
                    }
                }
                return [
                    '<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid rgba(0,0,0,.06)">',
                    `<span style="display:inline-block;background:${row.color || '#666'};color:${row.textColor || '#fff'};padding:2px 8px;border-radius:10px;font-weight:bold">${row.line}</span>`,
                    `<span style="flex:1">${row.destination}</span>`,
                    `<span style="min-width:52px;text-align:right">${row.scheduled || '—'}</span>`,
                    `<span style="min-width:64px;text-align:right">${expectedHTML}</span>`,
                    `<span style="min-width:40px;text-align:right">${row.platform || '—'}</span>`,
                    '</div>'
                ].join('');
            }),
            rows.length ? '' : '<div style="padding:8px 12px">暂无出发班次 · No departures</div>'
        ].join(''));

        return me;
    }

    // Static fallback: departures from this stop in the next 2 hours,
    // excluding terminating arrivals (last stop of a trip).
    computeStaticRows(gtfs, stopId) {
        const now = this._map.clock.getDate(),
            nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(),
            rows = [];

        for (const trip of gtfs.trips.getAll()) {
            const {stops, departureTimes, headsigns, route} = trip,
                routeInfo = gtfs.routes.get(route);

            if (!routeInfo) {
                continue;
            }
            for (let i = 0, ilen = stops.length; i < ilen; i++) {
                if (stops[i] !== stopId || i >= ilen - 1) {
                    continue;
                }
                const dep = departureTimes[i],
                    depMod = ((dep % 86400) + 86400) % 86400,
                    key = depMod >= nowSec ? depMod : depMod + 86400;

                if (key >= nowSec && key < nowSec + WINDOW_SECONDS) {
                    const rawHeadsign = headsigns.length > 1 ? headsigns[i] : headsigns[0];
                    rows.push({
                        key,
                        line: routeInfo.shortName,
                        destination: cleanDestination(rawHeadsign) || routeInfo.longName,
                        scheduled: getTimeString(depMod),
                        expected: '',
                        status: '',
                        platform: '',
                        color: routeInfo.color || gtfs.color,
                        textColor: routeInfo.textColor
                    });
                }
            }
        }

        rows.sort((a, b) => a.key - b.key);
        return rows;
    }

}
