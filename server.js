'use strict';

const path = require('path');
const http = require('http');

const sqlite3 = require('sqlite3');
const express = require('express');
const bodyParser = require('body-parser');
const semverCompare = require('semantic-compare');
const Ip2cc = require('ip2countrycode');

const pkg = require('./package.json');

// The timespans (days) the export covers; 36500 is "all".
const exportTimespans = [1, 7, 30, 90, 365, 36500];
const exportMaxAge = 3600;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What a telemetry body may carry (task 6). Every stored string ends up on the public page, so nothing else passes.
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$/;
const namePattern = /^[A-Za-z0-9_.+-]{1,40}$/;
// npm package names; legacy names may have capitals
const nodeNamePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const maxNodes = 500;
// Keys of the body that are not installed modules
const notNodes = ['ccu', 'redmatic', 'node-red', 'nodejs', 'ain2', 'npm'];

/**
 * Creates the Express app.
 * @param {object} options
 * @param {object} options.db the telemetry database (sqlite3.Database)
 * @param {{lookup: function(string): {code: string, country: string}}} options.ip2cc the country lookup
 * @param {function(...*)} [options.log] logger
 * @param {boolean|number|string} [options.trustProxy] Express' "trust proxy": which peers may set X-Forwarded-For
 * @param {{limit: number, windowMs: number}|false} [options.rateLimit] telemetry POSTs per client address and window
 * @returns {object} the Express app
 */
function createApp({
    db,
    ip2cc,
    log = defaultLog,
    trustProxy = 'loopback, linklocal, uniquelocal',
    rateLimit = {limit: 10, windowMs: 3600 * 1000},
}) {
    const app = express();
    const allowed = rateLimit ? rateLimiter(rateLimit) : () => true;
    const q = promisify(db);
    const exclusive = mutex();
    let exportCache = null;

    // Only the reverse proxy's X-Forwarded-For counts: req.ip is the client address it saw (B-4).
    app.set('trust proxy', trustProxy);

    app.use(express.static(path.join(__dirname, 'www')));

    app.get(
        '/total.svg',
        route(async (req, res) => {
            const row = await q.get('SELECT COUNT(redmatic) AS total FROM installation;');
            res.set('Cache-Control', 'max-age=3600');
            res.set('Content-Type', 'image/svg+xml;charset=utf-8');
            res.status(200).send(badge(formatInstalls(row.total)));
        }),
    );

    app.get(
        '/data',
        route(async (req, res) => {
            log('get /data');
            const timespan = parseInt(req.query.timespan, 10) || 36500;
            res.json(await aggregate(q, timespan));
        }),
    );

    // The raw database is not served (B-1): it holds every installation's telemetry id. What can be downloaded is
    // this anonymised export, the same aggregates the page shows, for every timespan the page offers.
    app.get(
        ['/export.json', '/export.csv'],
        route(async (req, res) => {
            log('get', req.path);
            if (!exportCache || Date.now() - exportCache.time >= exportMaxAge * 1000) {
                const timespans = {};
                for (const timespan of exportTimespans) {
                    timespans[timespan === 36500 ? 'all' : String(timespan)] = await aggregate(q, timespan);
                }
                exportCache = {
                    time: Date.now(),
                    data: {
                        generated: new Date().toISOString(),
                        description:
                            'Anonymised aggregates of the RedMatic telemetry: counts of installations first or last ' +
                            'seen in the timespan, per value. No telemetry ids, no per-installation rows.',
                        timespans,
                    },
                };
            }
            res.set('Cache-Control', 'max-age=' + exportMaxAge);
            if (req.path === '/export.csv') {
                res.set('Content-Type', 'text/csv;charset=utf-8');
                res.set('Content-Disposition', 'attachment; filename="redmatic-telemetry-export.csv"');
                res.send(exportCsv(exportCache.data));
            } else {
                res.set('Content-Disposition', 'attachment; filename="redmatic-telemetry-export.json"');
                res.json(exportCache.data);
            }
        }),
    );

    app.post(
        '/',
        (req, res, next) => {
            if (allowed(clientAddress(req))) {
                return next();
            }
            log('rate limited');
            res.status(429).send('');
        },
        bodyParser.json({limit: '64kb'}),
        route(async (req, res) => {
            const userAgent = String(req.get('user-agent') || '');
            const uuid = String(req.get('x-redmatic-uuid') || '');
            const body = userAgent.startsWith('curl/') && uuidPattern.test(uuid) ? validate(req.body) : null;
            if (!body) {
                log('invalid request');
                return res.status(400).send('');
            }
            await store(uuid.toLowerCase(), body, clientAddress(req));
            res.send('');
        }),
    );

    // Errors: a malformed body is the client's (400), everything else is ours (500). The process stays up.
    app.use((err, req, res, _next) => {
        const status = err.status >= 400 && err.status < 500 ? err.status : 500;
        log(req.method, req.path, status, err.message);
        if (!res.headersSent) {
            res.status(status).send('');
        }
    });

    function clientAddress(req) {
        return String(req.ip || '').replace(/^::ffff:/, '');
    }

    async function store(uuid, {fields, nodes}, ip) {
        const country = ip2cc.lookup(ip);
        const installation = {
            cc: (country && country.code) || null,
            country: (country && country.country) || null,
            ...fields,
        };
        await exclusive(() =>
            transaction(q, async () => {
                const known = await q.get('SELECT redmatic FROM installation WHERE uuid=?;', [uuid]);
                const i = installation;
                if (known) {
                    log('update', i.cc);
                    await q.run(
                        'UPDATE installation SET redmatic=?, ccu=?, platform=?, product=?, cc=?, country=?, updated=CURRENT_TIMESTAMP, counter=counter+1 WHERE uuid=?;',
                        [i.redmatic, i.ccu, i.platform, i.product, i.cc, i.country, uuid],
                    );
                } else {
                    log('insert', i.cc);
                    await q.run(
                        'INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, created, counter, cc, country) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,0,?,?);',
                        [uuid, i.redmatic, i.redmatic, i.ccu, i.platform, i.product, i.cc, i.country],
                    );
                }
                await q.run('DELETE FROM node WHERE installation_uuid=?', [uuid]);
                for (const [name, version] of Object.entries(nodes)) {
                    await q.run('INSERT INTO node (name, version, installation_uuid) VALUES (?,?,?);', [
                        name,
                        version,
                        uuid,
                    ]);
                }
            }),
        );
    }

    return app;
}

/**
 * Checks a telemetry body. Returns the installation's fields and its nodes, or null when the body is refused.
 * A node entry that is not an npm package name with a short version string is left out, not refused: old
 * installations send local modules with odd names, and those are never shown.
 */
function validate(data) {
    const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
    const optional = (value, pattern) =>
        value === undefined || value === null || value === '' || (typeof value === 'string' && pattern.test(value));
    if (!isObject(data) || !isObject(data.ccu)) {
        return null;
    }
    const {ccu} = data;
    if (
        typeof data.redmatic !== 'string' ||
        !versionPattern.test(data.redmatic) ||
        !optional(ccu.VERSION, versionPattern) ||
        !optional(ccu.PRODUCT, namePattern) ||
        !optional(ccu.PLATFORM, namePattern)
    ) {
        return null;
    }
    const names = Object.keys(data).filter((key) => !notNodes.includes(key));
    if (names.length > maxNodes) {
        return null;
    }
    const nodes = {};
    for (const name of names) {
        const version = data[name];
        if (name.length <= 214 && nodeNamePattern.test(name) && typeof version === 'string' && version.length <= 64) {
            nodes[name] = version;
        }
    }
    return {
        fields: {
            redmatic: data.redmatic,
            ccu: ccu.VERSION,
            platform: normalizePlatform(ccu.PLATFORM),
            product: ccu.PRODUCT,
        },
        nodes,
    };
}

/**
 * A fixed-window counter per key: true while the key has had at most `limit` calls in the current window.
 */
function rateLimiter({limit, windowMs, now = Date.now}) {
    const windows = new Map();
    return (key) => {
        const time = now();
        let entry = windows.get(key);
        if (!entry || entry.reset <= time) {
            if (windows.size >= 10000) {
                for (const [k, e] of windows) {
                    if (e.reset <= time) {
                        windows.delete(k);
                    }
                }
            }
            entry = {count: 0, reset: time + windowMs};
            windows.set(key, entry);
        }
        entry.count += 1;
        return entry.count <= limit;
    };
}

/** An Express handler from an async function: a rejection goes to the error handler (Express 4 does not). */
function route(fn) {
    return (req, res, next) => fn(req, res).catch(next);
}

/** Runs the calls one after another, so two transactions on the one connection never interleave. */
function mutex() {
    let last = Promise.resolve();
    return (fn) => {
        const result = last.then(fn);
        last = result.catch(() => {});
        return result;
    };
}

async function transaction(q, fn) {
    await q.run('BEGIN TRANSACTION;');
    try {
        await fn();
        await q.run('COMMIT;');
    } catch (err) {
        await q.run('ROLLBACK;').catch(() => {});
        throw err;
    }
}

function promisify(db) {
    return {
        get: (sql, params = []) =>
            new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))),
        all: (sql, params = []) =>
            new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))),
        run: (sql, params = []) =>
            new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve()))),
    };
}

/**
 * The aggregates of the page (and the export) for one timespan.
 */
async function aggregate(q, timespan) {
    const data = {};
    const since = '(SELECT DATETIME("now", "-' + timespan + ' day"))';
    const where = 'WHERE (created > ' + since + ' OR (updated > ' + since + '))';
    const group = (column) =>
        q.all(
            'SELECT ' +
                column +
                ', COUNT(uuid) AS count FROM installation ' +
                where +
                ' GROUP BY ' +
                column +
                ' ORDER BY count DESC;',
        );

    Object.assign(data, await q.get('SELECT COUNT(redmatic) AS total FROM installation ' + where + ';'));
    data.products = (await group('product')).map((o) => [o.product, o.count]);
    data.countries = (
        await q.all(
            'SELECT cc, country, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY cc ORDER BY count DESC;',
        )
    ).map((o) => [o.cc, o.country, o.count]);
    data.platforms = (await group('platform')).map((o) => [o.platform, o.count]);
    data.ccuVersions = (await group('ccu')).map((o) => [o.ccu, o.count]).sort((a, b) => semverCompare(b[0], a[0]));
    data.nodes = (
        await q.all(
            'SELECT node.name AS name, COUNT(node.installation_uuid) AS count FROM node LEFT JOIN installation ON installation.uuid = node.installation_uuid ' +
                where +
                ' GROUP BY name ORDER BY count DESC;',
        )
    )
        .filter((o) => o.name.startsWith('redmatic-') || o.name.startsWith('node-red-'))
        .map((o) => [o.name, o.count]);
    data.versions = (await group('redmatic'))
        .map((o) => [o.redmatic, o.count])
        .sort((a, b) => semverCompare(b[0], a[0]));
    const format = timespan > 7 ? '%Y-%m-%d' : '%Y-%m-%d %H:00:00';
    const rows = await q.all(
        'SELECT strftime("' +
            format +
            '", created) AS date, strftime("%s", strftime("' +
            format +
            '", created)) AS ts, COUNT(created) AS count FROM installation WHERE created > ' +
            since +
            ' GROUP BY date ORDER BY date;',
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

/**
 * The five bare platform names of 2019 get the architecture RedMatic sends since.
 */
function normalizePlatform(platform) {
    switch (platform) {
        case 'rpi0':
            return platform + '-armv6l';
        case 'rpi3':
        case 'rpi4':
        case 'tinkerboard':
            return platform + '-armv7l';
        case 'ova':
            return platform + '-i686';
        default:
            return platform;
    }
}

/**
 * The badge's number: 999, 1.0k … 9.9k, 10k …
 */
function formatInstalls(total) {
    if (total > 9999) {
        return Math.round(total / 1000) + 'k';
    }
    if (total > 999) {
        return (total / 1000).toFixed(1) + 'k';
    }
    return String(total);
}

function badge(installs) {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="20"><linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="a"><rect width="80" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#a)"><path fill="#555" d="M0 0h49v20H0z"/><path fill="#007ec6" d="M49 0h31v20H49z"/><path fill="url(#b)" d="M0 0h80v20H0z"/></g><g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110"><text x="255" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="390">installs</text><text x="255" y="140" transform="scale(.1)" textLength="390">installs</text><text x="635" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="210">${installs}</text><text x="635" y="140" transform="scale(.1)" textLength="210">${installs}</text></g></svg>`;
}

function defaultLog(...args) {
    console.log([ts(), ...args].join(' '));
}

function ts() {
    const d = new Date();
    return (
        d.getFullYear() +
        ('0' + (d.getMonth() + 1)).slice(-2) +
        ('0' + d.getDate()).slice(-2) +
        '-' +
        ('0' + d.getHours()).slice(-2) +
        ('0' + d.getMinutes()).slice(-2) +
        ('0' + d.getSeconds()).slice(-2)
    );
}

function main() {
    const port = parseInt(process.env.PORT, 10) || 8080;
    const dbfile = process.env.DB || path.join(__dirname, 'redmatic.db');
    const db = new sqlite3.Database(dbfile);
    db.on('error', (err) => defaultLog(err.message));
    const ip2cc = new Ip2cc(path.join(__dirname, 'IP2LOCATION-LITE-DB1.CSV'));

    const trustProxy = process.env.TRUST_PROXY;
    // telemetry POSTs per client address and hour; 0 turns the limit off
    const rateLimit = process.env.RATE_LIMIT === undefined ? 10 : parseInt(process.env.RATE_LIMIT, 10) || 0;
    const app = createApp({
        db,
        ip2cc,
        rateLimit: rateLimit > 0 ? {limit: rateLimit, windowMs: 3600 * 1000} : false,
        ...(trustProxy ? {trustProxy: /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy} : {}),
    });
    http.createServer(app).listen(port, () => {
        defaultLog(pkg.name, 'listening on port', port);
    });

    const exit = (signal) => {
        process.on(signal, () => {
            defaultLog('received', signal);
            db.close((err) => {
                defaultLog('db.close', err || '');
                process.exit(0);
            });
        });
    };
    exit('SIGTERM');
    exit('SIGINT');
}

if (require.main === module) {
    main();
}

module.exports = {
    createApp,
    validate,
    rateLimiter,
    aggregate,
    exportCsv,
    normalizePlatform,
    formatInstalls,
};
