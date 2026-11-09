export default class {

    constructor(params) {
        const me = this;

        /**
         * Stop ID.
         * @type {string}
         */
        me.id = params.id;

        /**
         * Stop name.
         * @type {string}
         */
        me.name = params.name;

        /**
         * Stop coordinates. These coordinates use longitude, latitude coordinate order.
         * @type {Array<number>}
         */
        me.coord = params.coord;

        if (params.color) {
            /**
             * Dominant rail route color of the stop, if any.
             * @type {string}
             */
            me.color = params.color;
        }
    }

}
