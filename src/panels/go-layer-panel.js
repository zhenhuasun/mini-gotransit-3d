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
            html += me.groupHTML(map, gtfs.id, 'GO Train', 2, trains, 'corridors');
            html += me.groupHTML(map, gtfs.id, 'GO Bus', 3, buses, 'routes');
        }
        if (!html) {
            html = '<div class="go-layer-row">No routes loaded yet.</div>';
        }
        me.setHTML(html);

        const container = me._container;

        container.querySelectorAll('.go-layer-row').forEach(element => {
            element.addEventListener('click', () => {
                const gtfsId = element.dataset.gtfs,
                    routeType = +element.dataset.type,
                    visible = !map.isGoGroupVisible(gtfsId, routeType);

                map.setGoGroupVisible(gtfsId, routeType, visible);
                element.classList.toggle('go-layer-off', !visible);
                element.querySelector('.go-layer-toggle').textContent = visible ? 'On' : 'Off';
            });
        });
    }

    groupHTML(map, gtfsId, name, routeType, routes, unit) {
        if (!routes.length) {
            return '';
        }
        const visible = map.isGoGroupVisible(gtfsId, routeType),
            swatches = routes.map(route => `<span class="go-layer-swatch" style="background:${route.color || '#00a651'}"></span>`).join('');

        return [
            `<div class="go-layer-row${visible ? '' : ' go-layer-off'}" data-gtfs="${gtfsId}" data-type="${routeType}">`,
            `<span class="go-layer-name">${name}</span>`,
            `<span class="go-layer-swatches">${swatches}</span>`,
            `<span class="go-layer-count">${routes.length} ${unit}</span>`,
            `<span class="go-layer-toggle">${visible ? 'On' : 'Off'}</span>`,
            '</div>'
        ].join('');
    }

}
