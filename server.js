const pkg = require('./package.json');

const fs = require('fs');
const path = require('path');
const http = require('http');

const mkdirp = require('mkdirp');

const sqlite3 = require('sqlite3').verbose();

const express = require('express');
const bodyParser = require('body-parser');
const serveIndex = require('serve-index');

const semverCompare = require('semantic-compare');

const Ip2cc = require('ip2countrycode');
const ip2cc = new Ip2cc(path.join(__dirname, 'IP2LOCATION-LITE-DB1.CSV'));

const port = parseInt(process.env.PORT, 10) || 8080;
const dbfile = process.env.DB || path.join(__dirname, 'redmatic.db');
const certfile = process.env.CERT || path.join(__dirname, '/server.cert');
const keyfile = process.env.KEY || path.join(__dirname, '/server.key');

const logPath = process.env.LOGPATH || path.join(__dirname, '/logs');

const db = new sqlite3.Database(dbfile);

db.on('error', err => {
    log(err.message);
});

//db.exec(fs.readFileSync(path.join(__dirname, '/redmatic-telemetry.sql')).toString());


const app = express();

app.use(express.static(path.join(__dirname, 'www')));

app.use('/logs', express.static(logPath));
app.use('/logs', (req, res, next) => {
    const auth = {login: process.env.USER || 'logs', password: process.env.PASS || 'changeme'};

    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = new Buffer.from(b64auth, 'base64').toString().split(':');

    if (login && password && login === auth.login && password === auth.password) {
        return next()
    }

    res.set('WWW-Authenticate', 'Basic realm="RedMatic Logs"');
    res.status(401).send('Authentication required.');
});

app.use('/logs', serveIndex(logPath, {
    view: 'details',
    filter: (filename, index, files, dir) => {
        return filename !== 'lost+found'
    }
}));


app.get('/total.svg', (req, res) => {
    db.get('SELECT COUNT(redmatic) AS total FROM installation;', (error, row) => {
        let installs;
        if (row.total > 9999) {
            installs = Math.round(row.total / 1000) + 'k'
        } else if (row.total > 999) {
            installs = (row.total / 1000).toFixed(1) + 'k'
        } else {
            installs = row.total;
        }
        res.set('Cache-Control', 'max-age=3600');
        res.set('Content-Type', 'image/svg+xml;charset=utf-8');
        res.status(200).send(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="20"><linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="a"><rect width="80" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#a)"><path fill="#555" d="M0 0h49v20H0z"/><path fill="#007ec6" d="M49 0h31v20H49z"/><path fill="url(#b)" d="M0 0h80v20H0z"/></g><g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110"><text x="255" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="390">installs</text><text x="255" y="140" transform="scale(.1)" textLength="390">installs</text><text x="635" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="210">${installs}</text><text x="635" y="140" transform="scale(.1)" textLength="210">${installs}</text></g></svg>`);
    });
});

// The raw database is not served (B-1): it holds every installation's telemetry id. What can be downloaded is the
// anonymised export below, the same aggregates the page shows, for every timespan the page offers.
const exportTimespans = [1, 7, 30, 90, 365, 36500];
const exportMaxAge = 3600;
let exportCache = null;

app.get('/data', (req, res) => {
    log('get /data');
    const timespan = parseInt(req.query.timespan, 10) || 36500;
    aggregate(timespan, data => res.json(data));
});

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
    if (exportCache && (Date.now() - exportCache.time) < exportMaxAge * 1000) {
        return send();
    }
    const timespans = {};
    const next = i => {
        if (i >= exportTimespans.length) {
            exportCache = {time: Date.now(), data: {
                generated: new Date().toISOString(),
                description: 'Anonymised aggregates of the RedMatic telemetry: counts of installations first or last seen in the timespan, per value. No telemetry ids, no per-installation rows.',
                timespans
            }};
            return send();
        }
        const timespan = exportTimespans[i];
        aggregate(timespan, data => {
            timespans[timespan === 36500 ? 'all' : String(timespan)] = data;
            next(i + 1);
        });
    };
    next(0);
});

function exportCsv(data) {
    const dimensions = {
        versions: 'redmatic',
        ccuVersions: 'ccu',
        platforms: 'platform',
        products: 'product',
        nodes: 'node'
    };
    const field = value => {
        const str = value === null || value === undefined ? '' : String(value);
        return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = ['timespan,dimension,value,count'];
    Object.keys(data.timespans).forEach(timespan => {
        const t = data.timespans[timespan];
        lines.push([timespan, 'total', '', t.total].map(field).join(','));
        Object.keys(dimensions).forEach(key => {
            (t[key] || []).forEach(([value, count]) => {
                lines.push([timespan, dimensions[key], value, count].map(field).join(','));
            });
        });
        (t.countries || []).forEach(([cc, country, count]) => {
            lines.push([timespan, 'country', cc, count].map(field).join(','));
        });
        (t.byday || []).forEach(([ts, count]) => {
            lines.push([timespan, 'new', new Date(ts).toISOString(), count].map(field).join(','));
        });
    });
    return lines.join('\r\n') + '\r\n';
}

function aggregate(timespan, callback) {
    const data = {};
    const where = 'WHERE (created > (SELECT DATETIME("now", "-' + timespan + ' day")) OR (updated > (SELECT DATETIME("now", "-' + timespan + ' day"))))';
    db.serialize(() => {
        db.get('SELECT COUNT(redmatic) AS total FROM installation ' + where + ';', (error, row) => {
            Object.assign(data, row);
        });
        db.all('SELECT product, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY product ORDER BY count DESC;', (error, rows) => {
            data.products = rows.map(o => [o.product, o.count]);
        });
        db.all('SELECT cc, country, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY cc ORDER BY count DESC;', (error, rows) => {
            data.countries = rows.map(o => [o.cc, o.country, o.count]);
        });
        db.all('SELECT platform, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY platform  ORDER BY count DESC;', (error, rows) => {
            data.platforms = rows.map(o => [o.platform, o.count]);
        });
        db.all('SELECT ccu, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY ccu ORDER BY count DESC;', (error, rows) => {
            data.ccuVersions = rows.map(o => [o.ccu, o.count]);
            data.ccuVersions = data.ccuVersions.sort((a, b) => semverCompare(b[0], a[0]));
        });
        db.all('SELECT node.name AS name, COUNT(node.installation_uuid) AS count FROM node LEFT JOIN installation ON installation.uuid = node.installation_uuid ' + where + ' GROUP BY name ORDER BY count DESC;', (error, rows) => {
            data.nodes = rows.filter(o => {
                return (o.name.startsWith('redmatic-') || o.name.startsWith('node-red-'));
            }).map(o => [o.name, o.count]);
        });
        db.all('SELECT redmatic AS version, COUNT(uuid) AS count FROM installation ' + where + ' GROUP BY redmatic;', (error, rows) => {
            data.versions = rows.map(o => [o.version, o.count]).sort((a, b) => semverCompare(b[0], a[0]));
        });
        let query;
        if (timespan > 7) {
            query = 'SELECT strftime("%Y-%m-%d", created) AS date, strftime("%s", strftime("%Y-%m-%d", created)) AS ts, COUNT(created) AS count FROM installation WHERE created > (SELECT DATETIME("now", "-' + timespan + ' day")) GROUP BY date ORDER BY date;'
        } else {
            query = 'SELECT strftime("%Y-%m-%d %H:00:00", created) AS date, strftime("%s", strftime("%Y-%m-%d %H:00:00", created)) AS ts, COUNT(created) AS count FROM installation WHERE created > (SELECT DATETIME("now", "-' + timespan + ' day")) GROUP BY date ORDER BY date;'
        }
        db.all(query, (error, rows) => {
            data.byday = rows.map(o => [parseInt(o.ts, 10) * 1000, o.count]);
            callback(data);
        });
    });
}

app.post('/', bodyParser.json(), (req, res) => {
    res.send('');
    const clientAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    processData(req.headers, req.body, clientAddress.replace('::ffff:', ''));
});

app.post('/log', bodyParser.raw({limit: '100kb', inflate: false}), (req, res) => {
    if (req.headers['user-agent'].startsWith('curl/') && req.headers['x-redmatic-nick']) {
        const [nickname] = req.headers['x-redmatic-nick'].split('/');
        const logfile = path.join(nickname, ts() + '.log');
        const clientAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        log(`upload ${clientAddress} ${logfile} ${req.body && req.body.length}`);

        mkdirp(path.join(logPath, nickname), err => {
            if (err) {
                log(err.message);
                res.status(500).send(err.message);
            } else {
                if (err) {
                    log(err.message);
                    res.status(500).send(err.message);
                } else {
                    fs.writeFile(path.join(logPath, logfile + '.gz'), req.body, err => {
                        if (err) {
                            log(err.message);
                            res.status(500).send(err.message);
                        } else {
                            log(`wrote ${logfile}.gz`);
                            res.send(logfile);
                        }
                    });
                }
            }
        });
    } else {
        res.status(401).send('unauthorized');
    }
});

http.createServer({
   // key: fs.readFileSync(keyfile),
   // cert: fs.readFileSync(certfile)
}, app).listen(port, function () {
    log(pkg.name, 'listening on', 'https://localhost:' + port);
});

function processData(headers, data, ip) {
    if (
        headers['user-agent'].startsWith('curl/')
        && headers['x-redmatic-uuid'].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}/)
        && data && data.ccu && data.redmatic
    ) {
        const country = ip2cc.lookup(ip);
        let platform = data.ccu.PLATFORM;
        switch (platform) {
            case 'rpi0':
                platform = platform + '-armv6l';
                break;
            case 'rpi3':
            case 'rpi4':
            case 'tinkerboard':
                platform = platform + '-armv7l';
                break;
            case 'ova':
                platform = platform + '-i686';
                break;
            default:

        }
        const installation = {
            cc: (country && country.code) || null,
            country: (country && country.country) || null,
            uuid: headers['x-redmatic-uuid'],
            redmatic: data.redmatic,
            ccu: data.ccu.VERSION,
            platform,
            product: data.ccu.PRODUCT
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
        log(ip + ' invalid request');
    }
}

function insertData(inst, nodes) {
    log('insert', JSON.stringify(inst));
    db.serialize(() => {
        db.run('BEGIN TRANSACTION;');
        db.run('INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, created, counter, cc, country) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,0,?,?);', [inst.uuid, inst.redmatic, inst.redmatic, inst.ccu, inst.platform, inst.product, inst.cc, inst.country]);
        updateNodes(inst.uuid, nodes);
        db.run('COMMIT;');
    });
}

function updateData(inst, nodes) {
    log('update', inst.uuid, inst.cc);
    db.serialize(() => {
        db.run('BEGIN TRANSACTION;');
        db.run('UPDATE installation SET redmatic=?, ccu=?, platform=?, product=?, cc=?, country=?, updated=CURRENT_TIMESTAMP, counter=counter+1 WHERE uuid=?;', [inst.redmatic, inst.ccu, inst.platform, inst.product, inst.cc, inst.country, inst.uuid]);
        updateNodes(inst.uuid, nodes);
        db.run('COMMIT;');
    });
}

function updateNodes(uuid, nodes) {
    db.run('DELETE FROM node WHERE installation_uuid=?', uuid);
    Object.keys(nodes).forEach(name => {
        db.run('INSERT INTO node (name, version, installation_uuid) VALUES (?,?,?);', [name, nodes[name], uuid]);
    });
}

function log() {
    console.log([ts(), ...arguments].join(' '));
}

function ts() {
    const d = new Date();
    return d.getFullYear() +
        ('0' + (d.getMonth() + 1)).slice(-2) +
        ('0' + d.getDate()).slice(-2) + '-' +
        ('0' + d.getHours()).slice(-2) +
        ('0' + d.getMinutes()).slice(-2) +
        ('0' + d.getSeconds()).slice(-2);
}

function exit(signal) {
    process.on(signal, () => {
        log('received', signal);
        db.close(err => {
            log('db.close', err);
            process.exit(0);
        });
    });
}

exit('SIGTERM');
exit('SIGINT');
