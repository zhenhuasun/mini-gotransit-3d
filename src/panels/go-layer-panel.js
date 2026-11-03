import Panel from './panel';

export default class extends Panel {

    constructor(options) {
        super(Object.assign({
            className: 'go-layer-panel',
            modal: true
        }, options));
    }

    addTo(map) {
        const me = this;

        super.addTo(map).setTitle('Layers');
        me.render(map);
        return me;
    }

    render(map) {
        const me = this;

        let html = '';

        for (const gtfs of map.gtfs.values()) {
            const trains = [],
                buses = [];

            for (const route of gtfs.routes.getAll()) {
                if (route.type === 2) {
                    trains.push(route);
                } else if (route.type === 3) {
                    buses.push(route);
                }
            }
            trains.sort((a, b) => a.shortName.localeCompare(b.shortName));
            buses.sort((a, b) => a.shortName.localeCompare(b.shortName));
            html += me.groupHTML(map, gtfs.id, 'GO Train', 2, trains);
            html += me.groupHTML(map, gtfs.id, 'GO Bus', 3, buses);
        }
        if (!html) {
            html = '<div class="go-layer-row">No routes loaded yet.</div>';
        }
        html += [
            '<div class="go-layer-group">',
            '<div class="go-layer-group-header">Live Camera</div>',
            `<div class="go-layer-row go-layer-cam-row${map.isGoCamsEnabled() ? '' : ' go-layer-off'}">`,
            '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 7h3l2-2h6l2 2h3v12H4z" fill="#00a6ff"/><circle cx="12" cy="13" r="3.5" fill="#fff"/></svg>',
            '<span class="go-layer-name">Live Camera</span>',
            `<span class="go-layer-cam-count">${me.camCountText(map)}</span>`,
            '</div>',
            '</div>'
        ].join('');

        me.setHTML(html);

        const container = me._container;

        container.querySelectorAll('.go-layer-toggle-all').forEach(element => {
            element.addEventListener('click', () => {
                const gtfsId = element.dataset.gtfs,
                    routeType = +element.dataset.type,
                    group = element.closest('.go-layer-group');

                map.setGoGroupVisible(gtfsId, routeType, !map.isGoGroupAllVisible(gtfsId, routeType));
                group.querySelectorAll('.go-layer-route-row').forEach(row => {
                    row.classList.toggle('go-layer-off', map.isGoRouteHidden(row.dataset.gtfs, row.dataset.route));
                });
                element.classList.toggle('go-layer-off', !map.isGoGroupAllVisible(gtfsId, routeType));
            });
        });
        container.querySelectorAll('.go-layer-route-row').forEach(element => {
            element.addEventListener('click', () => {
                const gtfsId = element.dataset.gtfs,
                    routeId = element.dataset.route,
                    routeType = +element.dataset.type,
                    group = element.closest('.go-layer-group');

                map.toggleGoRoute(gtfsId, routeId);
                element.classList.toggle('go-layer-off', map.isGoRouteHidden(gtfsId, routeId));
                group.querySelector('.go-layer-toggle-all').classList.toggle('go-layer-off', !map.isGoGroupAllVisible(gtfsId, routeType));
            });
        });
        container.querySelector('.go-layer-cam-row').addEventListener('click', () => {
            map.toggleGoCams();
            container.querySelector('.go-layer-cam-row').classList.toggle('go-layer-off', !map.isGoCamsEnabled());
        });
        return me;
    }

    groupHTML(map, gtfsId, title, routeType, routes) {
        if (!routes.length) {
            return '';
        }
        const allVisible = map.isGoGroupAllVisible(gtfsId, routeType);

        return [
            '<div class="go-layer-group">',
            `<div class="go-layer-group-header">${title}</div>`,
            `<div class="go-layer-row go-layer-toggle-all${allVisible ? '' : ' go-layer-off'}" data-gtfs="${gtfsId}" data-type="${routeType}">Toggle All</div>`,
            ...routes.map(route => {
                const hidden = map.isGoRouteHidden(gtfsId, route.id);

                return `<div class="go-layer-row go-layer-route-row${hidden ? ' go-layer-off' : ''}" data-gtfs="${gtfsId}" data-route="${route.id}" data-type="${routeType}"><span class="go-layer-badge" style="background-color: ${route.color || '#666'};${route.textColor ? `color: ${route.textColor};` : ''}">${route.shortName}</span><span class="go-layer-name">${route.longName}</span></div>`;
            }),
            '</div>'
        ].join('');
    }

    camCountText(map) {
        const live = map.liveCamIds;

        if (!live || map.liveCamTotal === undefined) {
            return '';
        }
        return `${live.length} of ${map.liveCamTotal} live`;
    }

    updateCamRow(map, liveCount) {
        const me = this,
            element = me._container && me._container.querySelector('.go-layer-cam-count');

        if (element) {
            element.textContent = `${liveCount} of ${map.liveCamTotal || liveCount} live`;
        }
    }

}
