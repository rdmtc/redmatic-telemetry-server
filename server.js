'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const express = require('express');

const pkg = require('./package.json');
const {database, migrate, open} = require('./lib/db.js');
const {aggregate, exportCsv, publicNodePattern} = require('./lib/stats.js');
const {applyRetention, deleteInstallation} = require('./lib/retention.js');
const {countryLookup} = require('./lib/geo.js');
const backups = require('./lib/backup.js');
const trends = require('./lib/trends.js');
const {config} = require('./lib/config.js');

// The timespans (days) the page offers, and the export covers; 36500 is "all".
const timespans = [1, 7, 30, 90, 365, 36500];
// The ranges (days) /data/trend serves
const trendDays = [30, 90, 180, 365, 730, 1825, 36500];
// /data and the export are cached this long (seconds): telemetry arrives only when an addon starts
const defaultCacheSeconds = 300;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What a telemetry body may carry (task 6). Every stored string ends up on the public page, so nothing else passes.
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$/;
const namePattern = /^[A-Za-z0-9_.+-]{1,40}$/;
// npm package names; legacy names may have capitals
const nodeNamePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
// openccu-lite's own version (ccu.LITE, RedMatic 18 on): stored only when it is one, else NULL
const litePattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const maxNodes = 500;
// Keys of the body that are not installed modules
const notNodes = ['ccu', 'redmatic', 'node-red', 'nodejs', 'ain2', 'npm'];

/**
 * Creates the Express app.
 * @param {object} options
 * @param {object} options.db the telemetry database (node:sqlite DatabaseSync), migrated
 * @param {{lookup: function(string): ?{code: string, country: string}}} options.geo the country lookup
 * @param {function(...*)} [options.log] logger, for errors
 * @param {function(string)} [options.count] counts a routine event (insert, update, …); by default a tally that the
 *   log gets once a minute
 * @param {boolean|number|string} [options.trustProxy] Express' "trust proxy": which peers may set X-Forwarded-For
 * @param {{limit: number, windowMs: number}|false} [options.rateLimit] telemetry POSTs per client address and window
 * @param {number} [options.cacheSeconds] how long /data and the export are cached
 * @param {function(): number} [options.now] clock, for the cache
 * @returns {object} the Express app
 */
function createApp({
    db,
    geo,
    log = defaultLog,
    count = tally(log),
    trustProxy = 'loopback, linklocal, uniquelocal',
    rateLimit = {limit: 10, windowMs: 3600 * 1000},
    cacheSeconds = defaultCacheSeconds,
    now = Date.now,
}) {
    const app = express();
    app.locals.count = count;
    const allowed = rateLimit ? rateLimiter(rateLimit) : () => true;
    const q = database(db);
    const cache = new Map();

    // The aggregates of one timespan, from the cache while it is fresh.
    const stats = (timespan) => {
        const hit = cache.get(timespan);
        if (hit && now() - hit.time < cacheSeconds * 1000) {
            return hit.data;
        }
        const data = aggregate(q, timespan);
        cache.set(timespan, {time: now(), data});
        return data;
    };

    // Only the reverse proxy's X-Forwarded-For counts: req.ip is the client address it saw (B-4).
    app.set('trust proxy', trustProxy);

    app.use(express.static(path.join(__dirname, 'www')));

    // For the container's HEALTHCHECK: the database answers.
    app.get('/healthz', (req, res) => {
        q.get('SELECT 1 AS ok;');
        res.set('Cache-Control', 'no-store');
        res.json({db: 'ok', version: pkg.version});
    });

    app.get('/total.svg', (req, res) => {
        // the installations active in the last 365 days (task 9): with the retention, "ever" would shrink
        const row = q.get(
            "SELECT COUNT(*) AS total FROM installation WHERE created > DATETIME('now', '-365 day') OR updated > DATETIME('now', '-365 day');",
        );
        res.set('Cache-Control', 'max-age=3600');
        res.set('Content-Type', 'image/svg+xml;charset=utf-8');
        res.status(200).send(badge(formatInstalls(row.total)));
    });

    // The daily snapshots of one dimension (task 11)
    app.get('/data/trend', (req, res) => {
        const dimension = req.query.dimension === undefined ? 'active' : String(req.query.dimension);
        const days = req.query.days === undefined ? 365 : Number(req.query.days);
        if (!trends.DIMENSIONS.includes(dimension) || !trendDays.includes(days)) {
            return res.status(400).send('');
        }
        const key = 'trend ' + dimension + ' ' + days;
        let hit = cache.get(key);
        if (!hit || now() - hit.time >= cacheSeconds * 1000) {
            hit = {time: now(), data: trends.trend(q, dimension, days, new Date(now()))};
            cache.set(key, hit);
        }
        res.set('Cache-Control', 'max-age=' + cacheSeconds);
        res.json(hit.data);
    });

    app.get('/data', (req, res) => {
        const timespan = req.query.timespan === undefined ? 36500 : Number(req.query.timespan);
        if (!timespans.includes(timespan)) {
            return res.status(400).send('');
        }
        res.set('Cache-Control', 'max-age=' + cacheSeconds);
        res.json(stats(timespan));
    });

    // The raw database is not served (B-1): it holds every installation's telemetry id. What can be downloaded is
    // this anonymised export, the same aggregates the page shows, for every timespan the page offers.
    app.get(['/export.json', '/export.csv'], (req, res) => {
        const data = {
            generated: new Date(now()).toISOString(),
            description:
                'Anonymised aggregates of the RedMatic telemetry: counts of installations first or last ' +
                'seen in the timespan, per value. No telemetry ids, no per-installation rows.',
            timespans: Object.fromEntries(timespans.map((t) => [t === 36500 ? 'all' : String(t), stats(t)])),
        };
        res.set('Cache-Control', 'max-age=' + cacheSeconds);
        if (req.path === '/export.csv') {
            res.set('Content-Type', 'text/csv;charset=utf-8');
            res.set('Content-Disposition', 'attachment; filename="redmatic-telemetry-export.csv"');
            res.send(exportCsv(data));
        } else {
            res.set('Content-Disposition', 'attachment; filename="redmatic-telemetry-export.json"');
            res.json(data);
        }
    });

    app.post(
        '/',
        (req, res, next) => {
            if (allowed(clientAddress(req))) {
                return next();
            }
            count('rate-limited');
            res.status(429).send('');
        },
        express.json({limit: '64kb'}),
        (req, res) => {
            const userAgent = String(req.get('user-agent') || '');
            const uuid = String(req.get('x-redmatic-uuid') || '');
            const body = userAgent.startsWith('curl/') && uuidPattern.test(uuid) ? validate(req.body) : null;
            if (!body) {
                count('invalid');
                return res.status(400).send('');
            }
            store(uuid.toLowerCase(), body, clientAddress(req));
            res.send('');
        },
    );

    // Deletion on request (task 9): RedMatic calls it when the user turns the telemetry off. The id is the only
    // credential; the answer is the same whether it was known or not.
    app.delete(
        '/',
        (req, res, next) => {
            if (allowed(clientAddress(req))) {
                return next();
            }
            count('rate-limited');
            res.status(429).send('');
        },
        (req, res) => {
            const uuid = String(req.get('x-redmatic-uuid') || '');
            if (!uuidPattern.test(uuid)) {
                count('invalid');
                return res.status(400).send('');
            }
            count(deleteInstallation(q, uuid.toLowerCase()) ? 'delete' : 'delete-unknown');
            res.status(204).send();
        },
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

    function store(uuid, {fields, nodes}, ip) {
        const country = geo.lookup(ip);
        const installation = {
            cc: (country && country.code) || null,
            country: (country && country.country) || null,
            ...fields,
        };
        q.transaction(() => {
            const known = q.get('SELECT redmatic FROM installation WHERE uuid=?;', [uuid]);
            const i = installation;
            if (known) {
                count('update');
                q.run(
                    'UPDATE installation SET redmatic=?, ccu=?, platform=?, product=?, lite=?, cc=?, country=?, updated=CURRENT_TIMESTAMP, counter=counter+1 WHERE uuid=?;',
                    [i.redmatic, i.ccu, i.platform, i.product, i.lite, i.cc, i.country, uuid],
                );
            } else {
                count('insert');
                q.run(
                    'INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, lite, created, counter, cc, country) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,0,?,?);',
                    [uuid, i.redmatic, i.redmatic, i.ccu, i.platform, i.product, i.lite, i.cc, i.country],
                );
            }
            q.run('DELETE FROM node WHERE installation_uuid=?', [uuid]);
            for (const [name, version] of Object.entries(nodes)) {
                q.run('INSERT INTO node (name, version, installation_uuid) VALUES (?,?,?);', [name, version, uuid]);
            }
        });
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
        if (
            name.length <= 214 &&
            nodeNamePattern.test(name) &&
            publicNodePattern.test(name) &&
            typeof version === 'string' &&
            version.length <= 64
        ) {
            nodes[name] = version;
        }
    }
    return {
        fields: {
            redmatic: data.redmatic,
            ccu: ccu.VERSION,
            platform: normalizePlatform(ccu.PLATFORM),
            product: ccu.PRODUCT,
            lite: typeof ccu.LITE === 'string' && ccu.LITE.length <= 32 && litePattern.test(ccu.LITE) ? ccu.LITE : null,
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

/**
 * Counts routine events and logs them once a minute as one line, `requests {"insert":3,"update":41}`: no ids, no
 * countries, no addresses (task 10). flush() logs at once, stop() ends the timer.
 */
function tally(log, intervalMs = 60 * 1000) {
    let counts = {};
    const flush = () => {
        if (Object.keys(counts).length) {
            log('requests', JSON.stringify(counts));
            counts = {};
        }
    };
    const timer = setInterval(flush, intervalMs);
    timer.unref();
    const count = (event) => {
        counts[event] = (counts[event] || 0) + 1;
    };
    count.flush = flush;
    count.stop = () => {
        clearInterval(timer);
        flush();
    };
    return count;
}

/**
 * Runs the daily job now and then every hour: task 11's snapshot first, so the counts of what the retention (task 9)
 * deletes are kept; each run writes what the day still lacks. Logs counts only. Returns a function that stops it.
 */
function startDaily(db, {log = defaultLog, now = Date.now, intervalMs = 3600 * 1000, backupDir = ''} = {}) {
    const q = database(db);
    const run = () => {
        try {
            const at = new Date(now());
            const done = trends.daily(q, at);
            if (done.new || done.backfilled || done.snapshot) {
                log('daily', JSON.stringify(done));
            }
            // the backup before the retention: yesterday's rows are in one copy more if the retention goes wrong
            if (backupDir) {
                try {
                    const file = backups.backup(db, backupDir, at);
                    const removed = backups.rotate(backupDir);
                    if (file || removed.length) {
                        const size = file ? fs.statSync(file).size : 0;
                        log(
                            'backup',
                            JSON.stringify({file: file && path.basename(file), size, removed: removed.length}),
                        );
                    }
                } catch (err) {
                    log('backup failed:', err.message);
                }
            }
            const deleted = applyRetention(q, at);
            if (deleted.installations || deleted.nodes) {
                log('retention', JSON.stringify(deleted));
            }
        } catch (err) {
            log('daily job failed:', err.message);
        }
    };
    const first = setTimeout(run, 0);
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return () => {
        clearTimeout(first);
        clearInterval(timer);
    };
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
    const {port, dbPath, dbipCsv, backupDir, trustProxy, rateLimit} = config();
    const db = open(dbPath);
    const geo = countryLookup(dbipCsv, defaultLog);
    const app = createApp({db, geo, trustProxy, rateLimit});
    startDaily(db, {backupDir});
    // the monthly update script sends SIGHUP after it replaced the file
    process.on('SIGHUP', () => {
        defaultLog('received SIGHUP');
        geo.reload();
    });
    http.createServer(app).listen(port, () => {
        defaultLog(pkg.name, 'listening on port', port);
    });

    const exit = (signal) => {
        process.on(signal, () => {
            defaultLog('received', signal);
            app.locals.count.stop();
            db.close();
            process.exit(0);
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
    tally,
    startDaily,
    migrate,
    validate,
    rateLimiter,
    aggregate,
    exportCsv,
    normalizePlatform,
    formatInstalls,
};
