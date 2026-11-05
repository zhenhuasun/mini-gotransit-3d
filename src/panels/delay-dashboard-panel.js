import Panel from './panel';

const REFRESH_MS = 15000,
    CORRIDOR_ORDER = ['BR', 'KI', 'LE', 'LW', 'MI', 'RH', 'ST'],
    BUS_KEY = 'Bus',
    BUS_COLOR = '#9e9e9e',
    CHART_WIDTH = 640,
    CHART_HEIGHT = 220,
    PLOT_LEFT = 30,
    PLOT_TOP = 8,
    PLOT_BOTTOM = 22,
    PLOT_RIGHT = 8;

function cssColor(color, fallback) {
    if (!color) {
        return fallback;
    }
    return color.charAt(0) === '#' ? color : `#${color}`;
}

function minuteLabel(minute) {
    return minute > 0 ? `+${minute}` : `${minute}`;
}

export default class extends Panel {

    constructor(options) {
        super(Object.assign({modal: true, className: 'delay-dashboard-panel'}, options));
        this._selectedCorridors = new Set(CORRIDOR_ORDER);
        this._busOn = false;
        this._selectedMinute = null;
        this._binByMinute = new Map();
    }

    addTo(map) {
        const me = this;

        super.addTo(map);
        me.setTitle('Delay dashboard');
        me._renderShell();
        me.updateContent();
        me._timer = setInterval(() => me.updateContent(), REFRESH_MS);
        return me;
    }

    remove() {
        const me = this,
            map = me._map;

        if (me._timer) {
            clearInterval(me._timer);
            delete me._timer;
        }
        if (map) {
            map.highlightDelayVehicles(null);
        }
        return super.remove();
    }

    _renderShell() {
        const me = this,
            container = me._container;

        me.setHTML([
            '<div class="delay-toggles"></div>',
            '<div class="delay-chart-wrap">',
            '<div class="delay-chart"></div>',
            '<div class="delay-tooltip" hidden></div>',
            '</div>',
            '<div class="delay-detail">Click a bar to highlight its vehicles on the map.</div>',
            '<div class="delay-footnote"></div>'
        ].join(''));
        me._renderToggles();
        const chart = container.querySelector('.delay-chart');

        chart.addEventListener('mouseover', e => me._onBarHover(e));
        chart.addEventListener('mousemove', e => me._onBarHover(e));
        chart.addEventListener('mouseleave', () => me._hideTooltip());
        chart.addEventListener('click', e => me._onBarClick(e));
        container.querySelector('.delay-toggles').addEventListener('click', e => me._onToggleClick(e));
    }

    _corridorColors() {
        const me = this,
            map = me._map,
            colors = {};

        for (const gtfs of map.gtfs.values()) {
            for (const route of gtfs.routes.getAll()) {
                if (route.type === 2 && CORRIDOR_ORDER.includes(route.shortName) && !colors[route.shortName]) {
                    colors[route.shortName] = cssColor(route.color, '#00a651');
                }
            }
        }
        for (const key of CORRIDOR_ORDER) {
            colors[key] = colors[key] || '#666666';
        }
        return colors;
    }

    _renderToggles() {
        const me = this,
            colors = me._corridorColors(),
            chips = ['<button type="button" class="delay-chip" data-toggle="all"><span class="delay-dot" style="background:#333333"></span>All trains</button>'];

        for (const key of CORRIDOR_ORDER) {
            chips.push(`<button type="button" class="delay-chip" data-toggle="${key}"><span class="delay-dot" style="background:${colors[key]}"></span>${key}</button>`);
        }
        chips.push(`<button type="button" class="delay-chip" data-toggle="bus"><span class="delay-dot" style="background:${BUS_COLOR}"></span>Bus</button>`);
        me._container.querySelector('.delay-toggles').innerHTML = chips.join('');
        me._syncToggleClasses();
    }

    _syncToggleClasses() {
        const me = this,
            container = me._container;

        if (!container) {
            return;
        }
        const allOn = CORRIDOR_ORDER.every(key => me._selectedCorridors.has(key));

        for (const chip of container.querySelectorAll('.delay-chip')) {
            const key = chip.dataset.toggle;
            let on;

            if (key === 'all') {
                on = allOn;
            } else if (key === 'bus') {
                on = me._busOn;
            } else {
                on = me._selectedCorridors.has(key);
            }
            chip.classList.toggle('off', !on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    _onToggleClick(e) {
        const me = this,
            chip = e.target.closest('.delay-chip');

        if (!chip) {
            return;
        }
        const key = chip.dataset.toggle;

        if (key === 'all') {
            if (CORRIDOR_ORDER.every(k => me._selectedCorridors.has(k))) {
                me._selectedCorridors.clear();
            } else {
                for (const k of CORRIDOR_ORDER) {
                    me._selectedCorridors.add(k);
                }
            }
        } else if (key === 'bus') {
            me._busOn = !me._busOn;
        } else if (me._selectedCorridors.has(key)) {
            me._selectedCorridors.delete(key);
        } else {
            me._selectedCorridors.add(key);
        }
        me._syncToggleClasses();
        me.updateContent();
    }

    _computeBins(map) {
        const me = this,
            bins = new Map();
        let noDelayCount = 0;

        for (const gtfs of map.gtfs.values()) {
            for (const bus of gtfs.activeBusLookup.values()) {
                if (typeof bus.delay !== 'number') {
                    noDelayCount++;
                    continue;
                }
                const route = gtfs.routes.get(bus.trip.route);

                if (!route) {
                    noDelayCount++;
                    continue;
                }
                const isTrain = route.type === 2,
                    key = isTrain ? route.shortName : BUS_KEY;

                if (isTrain) {
                    if (!me._selectedCorridors.has(key)) {
                        continue;
                    }
                } else if (!me._busOn) {
                    continue;
                }
                const minute = Math.floor(bus.delay / 60);
                let bin = bins.get(minute);

                if (!bin) {
                    bin = {minute, total: 0, corridors: new Map()};
                    bins.set(minute, bin);
                }
                let entry = bin.corridors.get(key);

                if (!entry) {
                    entry = {
                        count: 0,
                        color: isTrain ? cssColor(route.color, '#00a651') : BUS_COLOR,
                        vehicles: []
                    };
                    bin.corridors.set(key, entry);
                }
                entry.count++;
                entry.vehicles.push(bus);
                bin.total++;
            }
        }
        return {bins, noDelayCount};
    }

    updateContent() {
        const me = this,
            map = me._map;

        if (!map || !map.gtfs) {
            return;
        }
        const {bins, noDelayCount} = me._computeBins(map),
            minutes = [...bins.keys()].sort((a, b) => a - b),
            minMinute = minutes.length ? minutes[0] : 0,
            maxMinute = minutes.length ? minutes[minutes.length - 1] : 0;

        let maxCount = 0;
        for (const bin of bins.values()) {
            maxCount = Math.max(maxCount, bin.total);
        }
        me._binByMinute = bins;
        me._renderChart(minMinute, maxMinute, Math.max(maxCount, 1));
        me._renderFootnote(noDelayCount, map.clockMode);
        // Re-apply the selection against the fresh data: vehicles move
        // between bins as delays change, so a bus that left the bin
        // drops out of the highlight and one that joined comes in.
        if (me._selectedMinute !== null) {
            const bin = bins.get(me._selectedMinute);

            if (bin && bin.total) {
                me._applyHighlight(bin);
                me._renderDetail(bin);
            } else {
                me._selectedMinute = null;
                me._applyHighlight(null);
                me._renderDetail(null);
            }
        } else {
            me._renderDetail(null);
        }
    }

    _applyHighlight(bin) {
        const me = this,
            map = me._map;

        if (!map) {
            return;
        }
        if (!bin) {
            map.highlightDelayVehicles(null);
            return;
        }
        const vehicles = [];

        for (const entry of bin.corridors.values()) {
            vehicles.push(...entry.vehicles);
        }
        map.highlightDelayVehicles(vehicles);
    }

    _renderChart(minMinute, maxMinute, maxCount) {
        const me = this,
            container = me._container;

        if (!container) {
            return;
        }
        const plotW = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT,
            plotH = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM,
            n = maxMinute - minMinute + 1,
            barW = plotW / n,
            parts = [`<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" width="100%" role="img" aria-label="Delay distribution">`];

        // Zero (on-time) guide line.
        if (minMinute <= 0 && 0 <= maxMinute) {
            const x = PLOT_LEFT + (0 - minMinute + 0.5) * barW;

            parts.push(`<line x1="${x.toFixed(1)}" y1="${PLOT_TOP}" x2="${x.toFixed(1)}" y2="${PLOT_TOP + plotH}" stroke="#999999" stroke-dasharray="3 3" />`);
        }
        for (let i = 0; i < n; i++) {
            const minute = minMinute + i,
                bin = me._binByMinute.get(minute),
                x = PLOT_LEFT + i * barW,
                w = Math.max(1, barW - 1);

            parts.push(`<g data-minute="${minute}">`);
            // Full-height hit area so a thin bar is still easy to hover/tap.
            parts.push(`<rect x="${x.toFixed(1)}" y="${PLOT_TOP}" width="${barW.toFixed(1)}" height="${plotH}" fill="transparent" />`);
            if (bin) {
                let y = PLOT_TOP + plotH;

                for (const key of [...CORRIDOR_ORDER, BUS_KEY]) {
                    const entry = bin.corridors.get(key);

                    if (!entry) {
                        continue;
                    }
                    const h = entry.count / maxCount * plotH;

                    y -= h;
                    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${entry.color}" />`);
                }
                if (minute === me._selectedMinute) {
                    parts.push(`<rect x="${x.toFixed(1)}" y="${PLOT_TOP}" width="${w.toFixed(1)}" height="${plotH}" fill="rgba(255,255,255,0.12)" stroke="#ffffff" stroke-width="1.5" />`);
                }
            }
            parts.push('</g>');
        }
        // X labels (thinned when there are many minutes).
        const step = Math.max(1, Math.ceil(n / 18));

        for (let i = 0; i < n; i += step) {
            const minute = minMinute + i,
                x = PLOT_LEFT + (i + 0.5) * barW;

            parts.push(`<text x="${x.toFixed(1)}" y="${CHART_HEIGHT - 6}" text-anchor="middle" fill="#cccccc" font-size="11">${minuteLabel(minute)}</text>`);
        }
        parts.push(`<text x="${PLOT_LEFT - 4}" y="${PLOT_TOP + 10}" text-anchor="end" fill="#cccccc" font-size="11">${maxCount}</text>`);
        parts.push(`<text x="${PLOT_LEFT - 4}" y="${PLOT_TOP + plotH}" text-anchor="end" fill="#cccccc" font-size="11">0</text>`);
        parts.push('</svg>');
        container.querySelector('.delay-chart').innerHTML = parts.join('');
    }

    _renderFootnote(noDelayCount, clockMode) {
        const me = this,
            container = me._container;

        if (!container) {
            return;
        }
        const notes = [];

        if (clockMode !== 'realtime') {
            notes.push('Live delays are only available in realtime mode.');
        }
        if (noDelayCount) {
            notes.push(`${noDelayCount} vehicle${noDelayCount === 1 ? '' : 's'} without live delay data are not shown.`);
        }
        container.querySelector('.delay-footnote').textContent = notes.join(' ');
    }

    _breakdownHTML(bin) {
        const rows = [];

        for (const key of [...CORRIDOR_ORDER, BUS_KEY]) {
            const entry = bin.corridors.get(key);

            if (entry) {
                rows.push(`<div class="delay-row"><span class="delay-dot" style="background:${entry.color}"></span>${key}<span class="delay-count">${entry.count}</span></div>`);
            }
        }
        return `<div class="delay-breakdown-title">Delay ${minuteLabel(bin.minute)} min · ${bin.total} vehicle${bin.total === 1 ? '' : 's'}</div>${rows.join('')}`;
    }

    _renderDetail(bin) {
        const me = this,
            container = me._container;

        if (!container) {
            return;
        }
        container.querySelector('.delay-detail').innerHTML = bin ?
            me._breakdownHTML(bin) :
            'Click a bar to highlight its vehicles on the map.';
    }

    _barFromEvent(e) {
        const group = e.target.closest ? e.target.closest('[data-minute]') : null;

        if (!group) {
            return null;
        }
        const minute = +group.dataset.minute,
            bin = this._binByMinute.get(minute);

        return bin ? {minute, bin} : null;
    }

    _onBarHover(e) {
        const me = this,
            hit = me._barFromEvent(e),
            tooltip = me._container.querySelector('.delay-tooltip');

        if (!hit) {
            me._hideTooltip();
            return;
        }
        tooltip.innerHTML = me._breakdownHTML(hit.bin);
        tooltip.hidden = false;
        const wrap = me._container.querySelector('.delay-chart-wrap').getBoundingClientRect(),
            x = e.clientX - wrap.left + 12,
            y = e.clientY - wrap.top + 12;

        tooltip.style.left = `${Math.min(x, wrap.width - 150)}px`;
        tooltip.style.top = `${y}px`;
    }

    _hideTooltip() {
        const tooltip = this._container.querySelector('.delay-tooltip');

        if (tooltip) {
            tooltip.hidden = true;
        }
    }

    _onBarClick(e) {
        const me = this,
            hit = me._barFromEvent(e);

        if (!hit) {
            return;
        }
        me._selectedMinute = me._selectedMinute === hit.minute ? null : hit.minute;
        me.updateContent();
    }

}
