import Panel from './panel';

const ROUTE_TYPE_TRAIN = 2,
    ROUTE_TYPE_BUS = 3;

function compareRoutes(a, b) {
    const aNum = parseInt(a.shortName, 10),
        bNum = parseInt(b.shortName, 10);

    if (!isNaN(aNum) && !isNaN(bNum) && aNum !== bNum) {
        return aNum - bNum;
    }
    return (a.shortName || '').localeCompare(b.shortName || '');
}

function cssColor(color, fallback) {
    if (!color) {
        return fallback;
    }
    return color.charAt(0) === '#' ? color : `#${color}`;
}

/**
 * Layer panel for GO Transit: per-route visibility of GO Train corridors
 * and GO Bus routes (route shapes and their vehicles together).
 */
export default class extends Panel {

    constructor(options) {
        super(Object.assign({
            className: 'go-layer-panel',
            modal: true
        }, options));
    }

    addTo(map) {
        const me = this;

        super.addTo(map).setTitle(map.dict['layers'] || 'Layers');
        me.render(map);
        return me;
    }

    render(map) {
        const me = this,
            container = me._container;
        let html = '';

        for (const gtfsId of map.gtfs.keys()) {
            html += me.groupHTML(map, gtfsId, 'GO Train', ROUTE_TYPE_TRAIN);
            html += me.groupHTML(map, gtfsId, 'GO Bus', ROUTE_TYPE_BUS);
        }
        me.setHTML(html || '<div class="go-layer-empty">No routes loaded yet.</div>');

        container.querySelector('#panel-content').addEventListener('click', e => {
            const row = e.target.closest('[data-gtfs]');

            if (!row) {
                return;
            }
            const {gtfs: gtfsId, route: routeId} = row.dataset,
                routeType = +row.dataset.type;

            if (routeId) {
                map.toggleGoRoute(gtfsId, routeId);
            } else {
                map.setGoGroupVisible(gtfsId, routeType, !map.isGoGroupAllVisible(gtfsId, routeType));
            }
            me.syncClasses(map);
        });
        return me;
    }

    syncClasses(map) {
        const container = this._container;

        if (!container) {
            return;
        }
        for (const element of container.querySelectorAll('.go-layer-route-row')) {
            element.classList.toggle('go-layer-off', map.isGoRouteHidden(element.dataset.gtfs, element.dataset.route));
        }
        for (const element of container.querySelectorAll('.go-layer-toggle-all')) {
            element.classList.toggle('go-layer-off', !map.isGoGroupAllVisible(element.dataset.gtfs, +element.dataset.type));
        }
    }

    groupHTML(map, gtfsId, title, routeType) {
        const routes = [...map.getGoRoutesOfType(gtfsId, routeType)].sort((a, b) => compareRoutes(a[1], b[1]));

        if (!routes.length) {
            return '';
        }
        return [
            '<div class="go-layer-group">',
            `<div class="go-layer-group-header go-layer-toggle-all${map.isGoGroupAllVisible(gtfsId, routeType) ? '' : ' go-layer-off'}" data-gtfs="${gtfsId}" data-type="${routeType}">`,
            `<span class="go-layer-title">${title}</span>`,
            '<span class="go-layer-check"></span>',
            '</div>',
            ...routes.map(([key, route]) => [
                `<div class="go-layer-row go-layer-route-row${map.isGoRouteHidden(gtfsId, key) ? ' go-layer-off' : ''}" data-gtfs="${gtfsId}" data-route="${key}" data-type="${routeType}">`,
                `<span class="go-layer-badge" style="background-color: ${cssColor(route.color, '#666')}; color: ${cssColor(route.textColor, '#fff')};">${route.shortName}</span>`,
                `<span class="go-layer-name">${route.longName || ''}</span>`,
                '<span class="go-layer-check"></span>',
                '</div>'
            ].join('')),
            '</div>'
        ].join('');
    }

}
