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

/**
 * Creates the Express app.
 * @param {object} options
 * @param {object} options.db the telemetry database (sqlite3.Database)
 * @param {{lookup: function(string): {code: string, country: string}}} options.ip2cc the country lookup
 * @param {function(...*)} [options.log] logger
 * @returns {object} the Express app
 */
function createApp({db, ip2cc, log = defaultLog}) {
    const app = express();
    let exportCache = null;

    app.use(express.static(path.join(__dirname, 'www')));

    app.get('/total.svg', (req, res) => {
        db.get('SELECT COUNT(redmatic) AS total FROM installation;', (error, row) => {
            const installs = formatInstalls(row.total);
            res.set('Cache-Control', 'max-age=3600');
            res.set('Content-Type', 'image/svg+xml;charset=utf-8');
            res.status(200).send(badge(installs));
        });
    });

    app.get('/data', (req, res) => {
        log('get /data');
        const timespan = parseInt(req.query.timespan, 10) || 36500;
        aggregate(db, timespan, (data) => res.json(data));
    });

    // The raw database is not served (B-1): it holds every installation's telemetry id. What can be downloaded is
    // this anonymised export, the same aggregates the page shows, for every timespan the page offers.
    app.get(['/export.json', '/export.csv'], (req, res) => {
        log('get', req.path);
        const send = () => {
            res.set('Cache-Control', 'max-age=' + exportMaxAge);
            if (req.path === '/export.csv') {
                res.set('Content-Type', 'text/csv;charset=utf-8');
                res.set('Content-Disposition', 'attachment; filename="redmatic-telemetry-export.csv"');
                res.send(exportCsv(exportCache.data));
            } else {
                res.set('Content-Disposition', 'attachment; filename="redmatic-telemetry-export.json"');
                res.json(exportCache.data);
            }
        };

        if (exportCache && Date.now() - exportCache.time < exportMaxAge * 1000) {
            return send();
        }

        const timespans = {};
        const next = (i) => {
            if (i >= exportTimespans.length) {
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
                return send();
            }
            const timespan = exportTimespans[i];
            aggregate(db, timespan, (data) => {
                timespans[timespan === 36500 ? 'all' : String(timespan)] = data;
                next(i + 1);
            });
        };
        next(0);
    });

    app.post('/', bodyParser.json(), (req, res) => {
        res.send('');
        const clientAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        processData(req.headers, req.body, clientAddress.replace('::ffff:', ''));
    });

    function processData(headers, data, ip) {
        if (
            headers['user-agent'].startsWith('curl/') &&
            headers['x-redmatic-uuid'].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}/) &&
            data &&
            data.ccu &&
            data.redmatic
        ) {
            const country = ip2cc.lookup(ip);
            const installation = {
                cc: (country && country.code) || null,
                country: (country && country.country) || null,
                uuid: headers['x-redmatic-uuid'],
                redmatic: data.redmatic,
                ccu: data.ccu.VERSION,
                platform: normalizePlatform(data.ccu.PLATFORM),
                product: data.ccu.PRODUCT,
            };
            delete data['ccu'];
            delete data['redmatic'];
            delete data['node-red'];
            delete data.nodejs;
            delete data.ain2;
            delete data.npm;
            db.get('SELECT redmatic FROM installation WHERE uuid=?;', installation.uuid, (error, res) => {
                if (res) {
                    updateData(installation, data);
                } else {
                    insertData(installation, data);
                }
            });
        } else {
            log('invalid request');
        }
    }

    function insertData(inst, nodes) {
        log('insert', inst.cc);
        db.serialize(() => {
            db.run('BEGIN TRANSACTION;');
            db.run(
                'INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, created, counter, cc, country) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,0,?,?);',
                [inst.uuid, inst.redmatic, inst.redmatic, inst.ccu, inst.platform, inst.product, inst.cc, inst.country],
            );
            updateNodes(inst.uuid, nodes);
            db.run('COMMIT;');
        });
    }

    function updateData(inst, nodes) {
        log('update', inst.cc);
        db.serialize(() => {
            db.run('BEGIN TRANSACTION;');
            db.run(
                'UPDATE installation SET redmatic=?, ccu=?, platform=?, product=?, cc=?, country=?, updated=CURRENT_TIMESTAMP, counter=counter+1 WHERE uuid=?;',
                [inst.redmatic, inst.ccu, inst.platform, inst.product, inst.cc, inst.country, inst.uuid],
            );
            updateNodes(inst.uuid, nodes);
            db.run('COMMIT;');
        });
    }

    function updateNodes(uuid, nodes) {
        db.run('DELETE FROM node WHERE installation_uuid=?', uuid);
        Object.keys(nodes).forEach((name) => {
            db.run('INSERT INTO node (name, version, installation_uuid) VALUES (?,?,?);', [name, nodes[name], uuid]);
        });
    }

    return app;
}

/**
 * The aggregates of the page (and the export) for one timespan.
 */
function aggregate(db, timespan, callback) {
    const data = {};
    const since = '(SELECT DATETIME("now", "-' + timespan + ' day"))';
    const where = 'WHERE (created > ' + since + ' OR (updated > ' + since + '))';
    db.serialize(() => {
        db.get('SELECT COUNT(redmatic) AS total FROM installation ' + where + ';', (error, row) => {
            Object.assign(data, row);
        });
        db.all(
            'SELECT product, COUNT(uuid) AS count FROM installation ' +
                where +
                ' GROUP BY product ORDER BY count DESC;',
            (error, rows) => {
                data.products = rows.map((o) => [o.product, o.count]);
            },
        );
        db.all(
            'SELECT cc, country, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY cc ORDER BY count DESC;',
            (error, rows) => {
                data.countries = rows.map((o) => [o.cc, o.country, o.count]);
            },
        );
        db.all(
            'SELECT platform, COUNT(uuid) AS count FROM installation ' +
                where +
                ' GROUP BY platform ORDER BY count DESC;',
            (error, rows) => {
                data.platforms = rows.map((o) => [o.platform, o.count]);
            },
        );
        db.all(
            'SELECT ccu, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY ccu ORDER BY count DESC;',
            (error, rows) => {
                data.ccuVersions = rows.map((o) => [o.ccu, o.count]).sort((a, b) => semverCompare(b[0], a[0]));
            },
        );
        db.all(
            'SELECT node.name AS name, COUNT(node.installation_uuid) AS count FROM node LEFT JOIN installation ON installation.uuid = node.installation_uuid ' +
                where +
                ' GROUP BY name ORDER BY count DESC;',
            (error, rows) => {
                data.nodes = rows
                    .filter((o) => o.name.startsWith('redmatic-') || o.name.startsWith('node-red-'))
                    .map((o) => [o.name, o.count]);
            },
        );
        db.all(
            'SELECT redmatic AS version, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY redmatic;',
            (error, rows) => {
                data.versions = rows.map((o) => [o.version, o.count]).sort((a, b) => semverCompare(b[0], a[0]));
            },
        );
        const format = timespan > 7 ? '%Y-%m-%d' : '%Y-%m-%d %H:00:00';
        const query =
            'SELECT strftime("' +
            format +
            '", created) AS date, strftime("%s", strftime("' +
            format +
            '", created)) AS ts, COUNT(created) AS count FROM installation WHERE created > ' +
            since +
            ' GROUP BY date ORDER BY date;';
        db.all(query, (error, rows) => {
            data.byday = rows.map((o) => [parseInt(o.ts, 10) * 1000, o.count]);
            callback(data);
        });
    });
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

    const app = createApp({db, ip2cc});
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

module.exports = {createApp, aggregate, exportCsv, normalizePlatform, formatInstalls};
