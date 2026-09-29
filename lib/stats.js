'use strict';

// The aggregates the page, /data and the export show. Counts only: nothing here returns an id.

const semverCompare = require('semantic-compare');

// openccu-lite: a lite-<upstream product> PRODUCT or a LITE version (task 2)
const liteCondition = "(product LIKE 'lite-%' OR lite IS NOT NULL)";

// The firmware family, derived when queried, never stored: ccu3, openccu (RaspberryMatic/OpenCCU with or without the
// raspmatic_ prefix), pivccu3, lite or other.
const familyExpression =
    'CASE WHEN ' +
    liteCondition +
    " THEN 'lite'" +
    " WHEN product = 'ccu3' THEN 'ccu3'" +
    " WHEN product = 'pivccu3' THEN 'pivccu3'" +
    " WHEN product LIKE 'raspmatic%' OR product GLOB 'rpi[0-9]*' OR product IN ('ova', 'intelnuc')" +
    " OR product GLOB 'tinkerboard*' OR product GLOB 'odroid-*' OR product GLOB 'oci_*' OR product GLOB 'lxc_*'" +
    " OR product GLOB 'generic-*' THEN 'openccu'" +
    " ELSE 'other' END";

/**
 * The aggregates of the page (and the export) for one timespan.
 */
function aggregate(q, timespan) {
    const data = {};
    const since = ['-' + timespan + ' day'];
    const where = "WHERE (created > DATETIME('now', ?) OR updated > DATETIME('now', ?))";
    const both = [...since, ...since];
    const group = (column) =>
        q.all(
            'SELECT ' +
                column +
                ', COUNT(uuid) AS count FROM installation ' +
                where +
                ' GROUP BY ' +
                column +
                ' ORDER BY count DESC;',
            both,
        );

    Object.assign(data, q.get('SELECT COUNT(redmatic) AS total FROM installation ' + where + ';', both));
    data.products = group('product').map((o) => [o.product, o.count]);
    data.countries = q
        .all(
            'SELECT cc, country, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY cc ORDER BY count DESC;',
            both,
        )
        .map((o) => [o.cc, o.country, o.count]);
    data.platforms = group('platform').map((o) => [o.platform, o.count]);
    // [version, installations, of them openccu-lite]: a lite system reports its OpenCCU base version here
    data.ccuVersions = q
        .all(
            'SELECT ccu, COUNT(uuid) AS count, SUM(' +
                liteCondition +
                ') AS lite FROM installation ' +
                where +
                ' GROUP BY ccu ORDER BY count DESC;',
            both,
        )
        .map((o) => [o.ccu, o.count, o.lite])
        .sort((a, b) => semverCompare(b[0], a[0]));
    // Driven from the installations in the timespan (CROSS JOIN fixes that order): scanning node first and looking
    // up each row's installation took ten times as long. Only the public module names are counted.
    data.nodes = q
        .all(
            'SELECT node.name AS name, COUNT(*) AS count FROM installation CROSS JOIN node ON node.installation_uuid = installation.uuid ' +
                where +
                " AND (node.name GLOB 'redmatic-*' OR node.name GLOB 'node-red-*') GROUP BY node.name ORDER BY count DESC, name;",
            both,
        )
        .map((o) => [o.name, o.count]);
    data.versions = group('redmatic')
        .map((o) => [o.redmatic, o.count])
        .sort((a, b) => semverCompare(b[0], a[0]));
    data.liteVersions = q
        .all(
            'SELECT lite, COUNT(uuid) AS count FROM installation ' +
                where +
                ' AND lite IS NOT NULL GROUP BY lite ORDER BY count DESC;',
            both,
        )
        .map((o) => [o.lite, o.count])
        .sort((a, b) => semverCompare(b[0], a[0]));
    data.families = q
        .all(
            'SELECT ' +
                familyExpression +
                ' AS family, COUNT(uuid) AS count FROM installation ' +
                where +
                ' GROUP BY family ORDER BY count DESC;',
            both,
        )
        .map((o) => [o.family, o.count]);
    data.litePlatforms = q
        .all(
            'SELECT platform, COUNT(uuid) AS count FROM installation ' +
                where +
                ' AND ' +
                liteCondition +
                ' GROUP BY platform ORDER BY count DESC;',
            both,
        )
        .map((o) => [o.platform, o.count]);
    const format = timespan > 7 ? '%Y-%m-%d' : '%Y-%m-%d %H:00:00';
    const rows = q.all(
        "SELECT strftime(?, created) AS date, strftime('%s', strftime(?, created)) AS ts, COUNT(created) AS count " +
            "FROM installation WHERE created > DATETIME('now', ?) GROUP BY date ORDER BY date;",
        [format, format, ...since],
    );
    data.byday = rows.map((o) => [parseInt(o.ts, 10) * 1000, o.count]);
    return data;
}

/**
 * The export as CSV: one line per timespan, dimension and value.
 */
function exportCsv(data) {
    const dimensions = {
        versions: 'redmatic',
        ccuVersions: 'ccu',
        platforms: 'platform',
        products: 'product',
        nodes: 'node',
        liteVersions: 'lite',
        litePlatforms: 'lite-platform',
        families: 'family',
    };
    const field = (value) => {
        const str = value === null || value === undefined ? '' : String(value);
        return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = ['timespan,dimension,value,count'];
    Object.keys(data.timespans).forEach((timespan) => {
        const t = data.timespans[timespan];
        lines.push([timespan, 'total', '', t.total].map(field).join(','));
        Object.keys(dimensions).forEach((key) => {
            (t[key] || []).forEach(([value, count]) => {
                lines.push([timespan, dimensions[key], value, count].map(field).join(','));
            });
        });
        (t.countries || []).forEach(([cc, , count]) => {
            lines.push([timespan, 'country', cc, count].map(field).join(','));
        });
        (t.byday || []).forEach(([time, count]) => {
            lines.push([timespan, 'new', new Date(time).toISOString(), count].map(field).join(','));
        });
    });
    return lines.join('\r\n') + '\r\n';
}

module.exports = {aggregate, exportCsv, liteCondition, familyExpression};
