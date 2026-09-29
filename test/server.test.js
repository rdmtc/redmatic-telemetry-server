'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {formatInstalls, normalizePlatform, exportCsv, validate, rateLimiter} = require('../server.js');
const {startServer, insertInstallation, uuid, telemetryBody, postTelemetry, waitFor} = require('./helpers.js');

describe('static page', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    it('answers /healthz while the database does', async () => {
        const res = await server.fetch('/healthz');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {db: 'ok', version: require('../package.json').version});
    });

    it('serves the page', async () => {
        const res = await server.fetch('/');
        assert.equal(res.status, 200);
        assert.match(await res.text(), /RedMatic Usage Statistics/);
    });
});

describe('POST / (telemetry)', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    const row = (n) => server.db.get('SELECT * FROM installation WHERE uuid=?;', [uuid(n)]);
    const nodes = (n) =>
        server.db.all('SELECT name, version FROM node WHERE installation_uuid=? ORDER BY name;', [uuid(n)]);

    it('inserts a new installation with its nodes', async () => {
        const res = await postTelemetry(server, 1, telemetryBody(), {'X-Forwarded-For': '192.0.2.10'});
        assert.equal(res.status, 200);
        const inst = await waitFor(() => row(1));
        assert.equal(inst.redmatic, '8.0.0');
        assert.equal(inst.initial, '8.0.0');
        assert.equal(inst.ccu, '3.89.11');
        assert.equal(inst.product, 'ccu3');
        assert.equal(inst.platform, 'ccu3-armv7l');
        assert.equal(inst.counter, 0);
        assert.equal(inst.cc, 'DE');
        assert.equal(inst.country, 'Germany');
        assert.ok(inst.created);
        assert.equal(inst.updated, null);
        // ccu, redmatic, nodejs, node-red and npm are not stored as nodes
        assert.deepEqual(await waitFor(async () => ((await nodes(1)).length === 2 ? nodes(1) : null)), [
            {name: 'node-red-contrib-ccu', version: '3.5.0'},
            {name: 'redmatic-homekit', version: '2.1.0'},
        ]);
    });

    it('updates a known installation and replaces its nodes', async () => {
        await postTelemetry(
            server,
            1,
            telemetryBody({redmatic: '8.1.0', 'redmatic-homekit': undefined, 'node-red-dashboard': '3.6.0'}),
            {'X-Forwarded-For': '198.51.100.7'},
        );
        const inst = await waitFor(async () => {
            const r = await row(1);
            return r.counter === 1 ? r : null;
        });
        assert.equal(inst.redmatic, '8.1.0');
        assert.equal(inst.initial, '8.0.0');
        assert.equal(inst.cc, 'AT');
        assert.ok(inst.updated);
        assert.deepEqual(await nodes(1), [
            {name: 'node-red-contrib-ccu', version: '3.5.0'},
            {name: 'node-red-dashboard', version: '3.6.0'},
        ]);
    });

    it('stores an unknown address as country "-"', async () => {
        await postTelemetry(server, 2, telemetryBody(), {'X-Forwarded-For': '203.0.113.1'});
        const inst = await waitFor(() => row(2));
        assert.equal(inst.cc, '-');
    });

    it('refuses a request without a curl user agent', async () => {
        const res = await postTelemetry(server, 3, telemetryBody(), {'User-Agent': 'Mozilla/5.0'});
        assert.equal(res.status, 400);
        assert.equal(await row(3), undefined);
    });

    it('refuses a body without ccu or redmatic', async () => {
        assert.equal((await postTelemetry(server, 4, {redmatic: '8.0.0'})).status, 400);
        assert.equal((await postTelemetry(server, 5, {ccu: {VERSION: '3.89.11'}})).status, 400);
        assert.equal((await postTelemetry(server, 5, [1, 2])).status, 400);
        assert.equal(await row(4), undefined);
        assert.equal(await row(5), undefined);
    });
});

describe('normalizePlatform', () => {
    it('appends the architecture to the bare 2019 names only', () => {
        assert.equal(normalizePlatform('rpi0'), 'rpi0-armv6l');
        assert.equal(normalizePlatform('rpi3'), 'rpi3-armv7l');
        assert.equal(normalizePlatform('rpi4'), 'rpi4-armv7l');
        assert.equal(normalizePlatform('tinkerboard'), 'tinkerboard-armv7l');
        assert.equal(normalizePlatform('ova'), 'ova-i686');
        assert.equal(normalizePlatform('rpi4-aarch64'), 'rpi4-aarch64');
        assert.equal(normalizePlatform(undefined), undefined);
    });
});

describe('GET /data', () => {
    let server;
    before(async () => {
        server = await startServer();
        const db = server.db;
        await insertInstallation(db, 1, {
            created: '-2 hour',
            redmatic: '8.0.0',
            nodes: {'node-red-contrib-ccu': '3.5.0'},
        });
        await insertInstallation(db, 2, {
            created: '-3 day',
            redmatic: '7.10.0',
            product: 'raspmatic_rpi4',
            ccu: '3.87.6',
            cc: 'AT',
            country: 'Austria',
            nodes: {'node-red-contrib-ccu': '3.4.0', 'my-private-module': '1.0.0'},
        });
        await insertInstallation(db, 3, {
            created: '-60 day',
            redmatic: '7.2.0',
            platform: 'ova-x86_64',
            nodes: {'redmatic-homekit': '2.1.0'},
        });
        // created long ago, but seen 20 hours ago: counted in the short timespans too
        await insertInstallation(db, 4, {created: '-400 day', updated: '-20 hour', redmatic: '8.0.0'});
        // neither created nor seen in the last 365 days
        await insertInstallation(db, 5, {created: '-800 day', redmatic: '6.0.0'});
    });
    after(() => server.close());

    const data = async (timespan) => {
        const res = await server.fetch('/data' + (timespan ? '?timespan=' + timespan : ''));
        assert.equal(res.status, 200);
        return res.json();
    };

    it('counts installations created or updated in the timespan', async () => {
        assert.equal((await data(1)).total, 2);
        assert.equal((await data(7)).total, 3);
        assert.equal((await data(90)).total, 4);
        assert.equal((await data(365)).total, 4);
        assert.equal((await data()).total, 5);
    });

    it('groups versions, products, platforms, countries and CCU versions', async () => {
        const d = await data(90);
        assert.deepEqual(d.versions, [
            ['8.0.0', 2],
            ['7.10.0', 1],
            ['7.2.0', 1],
        ]);
        assert.deepEqual(d.products, [
            ['ccu3', 3],
            ['raspmatic_rpi4', 1],
        ]);
        assert.deepEqual(d.platforms, [
            ['rpi4-aarch64', 3],
            ['ova-x86_64', 1],
        ]);
        assert.deepEqual(d.countries, [
            ['DE', 'Germany', 3],
            ['AT', 'Austria', 1],
        ]);
        assert.deepEqual(d.ccuVersions, [
            ['3.89.11', 3, 0],
            ['3.87.6', 1, 0],
        ]);
    });

    it('lists only redmatic-* and node-red-* nodes', async () => {
        const d = await data(90);
        assert.deepEqual(d.nodes, [
            ['node-red-contrib-ccu', 2],
            ['redmatic-homekit', 1],
        ]);
    });

    it('counts new installations per day, or per hour up to 7 days', async () => {
        const week = await data(7);
        assert.equal(week.byday.length, 2);
        assert.ok(week.byday.every(([ts]) => ts % 3600000 === 0));
        const quarter = await data(90);
        assert.equal(quarter.byday.length, 3);
        assert.ok(quarter.byday.every(([ts]) => ts % 86400000 === 0));
        assert.equal(
            quarter.byday.reduce((sum, [, count]) => sum + count, 0),
            3,
        );
    });
});

describe('GET /total.svg', () => {
    let server;
    before(async () => {
        server = await startServer();
        for (let i = 1; i <= 3; i++) {
            await insertInstallation(server.db, i, {created: '-' + i * 400 + ' day'});
        }
    });
    after(() => server.close());

    it('answers the badge with every row ever', async () => {
        const res = await server.fetch('/total.svg');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
        assert.match(await res.text(), /textLength="210">3<\/text>/);
    });

    it('formats the number', () => {
        assert.equal(formatInstalls(0), '0');
        assert.equal(formatInstalls(999), '999');
        assert.equal(formatInstalls(1000), '1.0k');
        assert.equal(formatInstalls(1234), '1.2k');
        assert.equal(formatInstalls(9999), '10.0k');
        assert.equal(formatInstalls(12345), '12k');
        assert.equal(formatInstalls(36498), '36k');
    });
});

describe('the database is not downloadable (B-1)', () => {
    let server;
    before(async () => {
        server = await startServer();
        await insertInstallation(server.db, 1, {nodes: {'node-red-contrib-ccu': '3.5.0', 'my-private-module': '1.0'}});
        await insertInstallation(server.db, 2, {created: '-100 day', product: 'raspmatic_rpi4'});
    });
    after(() => server.close());

    it('GET /database answers 404', async () => {
        const res = await server.fetch('/database');
        assert.equal(res.status, 404);
    });

    it('/export.json holds the aggregates of every timespan, without ids', async () => {
        const res = await server.fetch('/export.json');
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(!text.includes(uuid(1)) && !text.includes(uuid(2)));
        assert.ok(!text.includes('my-private-module'));
        const data = JSON.parse(text);
        assert.deepEqual(Object.keys(data.timespans), ['1', '7', '30', '90', '365', 'all']);
        assert.equal(data.timespans['30'].total, 1);
        assert.equal(data.timespans.all.total, 2);
        assert.deepEqual(data.timespans.all.nodes, [['node-red-contrib-ccu', 1]]);
    });

    it('/export.csv holds the same, one line per value', async () => {
        const res = await server.fetch('/export.csv');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^text\/csv/);
        const text = await res.text();
        assert.ok(!text.includes(uuid(1)) && !text.includes('my-private-module'));
        const lines = text.trim().split('\r\n');
        assert.equal(lines[0], 'timespan,dimension,value,count');
        assert.ok(lines.includes('all,total,,2'));
        assert.ok(lines.includes('all,product,raspmatic_rpi4,1'));
        assert.ok(lines.includes('all,country,DE,2'));
        assert.ok(lines.includes('all,node,node-red-contrib-ccu,1'));
    });

    it('quotes CSV fields with commas and quotes', () => {
        const csv = exportCsv({timespans: {all: {total: 1, products: [['a,"b"', 1]]}}});
        assert.ok(csv.includes('all,product,"a,""b""",1\r\n'));
    });
});

describe('the log upload is gone (B-2, B-3)', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    it('POST /log answers 404', async () => {
        const res = await server.fetch('/log', {
            method: 'POST',
            headers: {'User-Agent': 'curl/8.9.1', 'X-RedMatic-nick': '..', 'Content-Type': 'application/octet-stream'},
            body: Buffer.from([0x1f, 0x8b, 0]),
        });
        assert.equal(res.status, 404);
    });

    it('/logs answers 404', async () => {
        assert.equal((await server.fetch('/logs/')).status, 404);
        assert.equal((await server.fetch('/logs/nick/20260101-000000.log.gz')).status, 404);
    });
});

describe('malformed requests and database errors (B-4)', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    const count = async () => (await server.db.get('SELECT COUNT(*) AS n FROM installation;')).n;

    it('answers 400 without the headers, and stores nothing', async () => {
        const noAgent = await server.fetch('/', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-RedMatic-uuid': uuid(1)},
            body: JSON.stringify(telemetryBody()),
        });
        assert.equal(noAgent.status, 400);
        const noId = await server.fetch('/', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'User-Agent': 'curl/8.9.1'},
            body: JSON.stringify(telemetryBody()),
        });
        assert.equal(noId.status, 400);
        assert.equal(await count(), 0);
    });

    it('accepts only a whole id, and stores it in lower case', async () => {
        const res = await postTelemetry(server, 1, telemetryBody(), {'X-RedMatic-uuid': 'xx' + uuid(1) + 'yy'});
        assert.equal(res.status, 400);
        assert.equal((await postTelemetry(server, 1, telemetryBody(), {'X-RedMatic-uuid': 'not-an-id'})).status, 400);
        const upper = '0000000A-0000-4000-8000-00000000000B';
        assert.equal((await postTelemetry(server, 1, telemetryBody(), {'X-RedMatic-uuid': upper})).status, 200);
        const row = await server.db.get('SELECT uuid FROM installation;');
        assert.equal(row.uuid, upper.toLowerCase());
    });

    it('answers 400 to a malformed JSON body', async () => {
        const res = await postTelemetry(server, 2, '{"redmatic":');
        assert.equal(res.status, 400);
    });

    it('takes the client address the proxy appended to X-Forwarded-For', async () => {
        // a client-sent value on the left, the address the proxy saw on the right
        await postTelemetry(server, 3, telemetryBody(), {'X-Forwarded-For': '198.51.100.7, 192.0.2.10'});
        const row = await server.db.get('SELECT cc FROM installation WHERE uuid=?;', [uuid(3)]);
        assert.equal(row.cc, 'DE');
    });

    it('rolls back a failed store, and the next one works', async () => {
        await server.db.exec('ALTER TABLE node RENAME TO node_away;');
        const res = await postTelemetry(server, 4, telemetryBody());
        assert.equal(res.status, 500);
        assert.equal(await server.db.get('SELECT uuid FROM installation WHERE uuid=?;', [uuid(4)]), undefined);
        await server.db.exec('ALTER TABLE node_away RENAME TO node;');
        assert.equal((await postTelemetry(server, 4, telemetryBody())).status, 200);
        assert.ok(await server.db.get('SELECT uuid FROM installation WHERE uuid=?;', [uuid(4)]));
    });
});

describe('X-Forwarded-For from an untrusted peer (B-4)', () => {
    let server;
    before(async () => {
        server = await startServer({app: {trustProxy: false}});
    });
    after(() => server.close());

    it('is ignored', async () => {
        await postTelemetry(server, 1, telemetryBody(), {'X-Forwarded-For': '192.0.2.10'});
        const row = await server.db.get('SELECT cc FROM installation WHERE uuid=?;', [uuid(1)]);
        assert.notEqual(row.cc, 'DE');
    });
});

describe('a closed database (B-4)', () => {
    let server;
    before(async () => {
        server = await startServer();
        server.db.raw.close();
    });
    after(() => server.close());

    it('/total.svg, /data and POST / answer 500, and the server stays up', async () => {
        assert.equal((await server.fetch('/total.svg')).status, 500);
        assert.equal((await server.fetch('/data?timespan=7')).status, 500);
        assert.equal((await server.fetch('/export.json')).status, 500);
        assert.equal((await server.fetch('/healthz')).status, 500);
        assert.equal((await postTelemetry(server, 1, telemetryBody())).status, 500);
        assert.equal((await server.fetch('/')).status, 200);
    });
});

describe('validation of the telemetry body (task 6)', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    const count = async () => (await server.db.get('SELECT COUNT(*) AS n FROM installation;')).n;

    it('stores a normal RedMatic body', async () => {
        assert.equal((await postTelemetry(server, 1, telemetryBody())).status, 200);
        assert.equal(await count(), 1);
    });

    it('refuses HTML in a stored field, and stores nothing', async () => {
        const html = '<img src=x onerror=alert(1)>';
        for (const body of [
            telemetryBody({ccu: {VERSION: '3.89.11', PRODUCT: html, PLATFORM: 'rpi4-aarch64'}}),
            telemetryBody({ccu: {VERSION: html, PRODUCT: 'ccu3', PLATFORM: 'rpi4-aarch64'}}),
            telemetryBody({ccu: {VERSION: '3.89.11', PRODUCT: 'ccu3', PLATFORM: html}}),
            telemetryBody({redmatic: html}),
            telemetryBody({redmatic: 8}),
        ]) {
            assert.equal((await postTelemetry(server, 2, body)).status, 400);
        }
        assert.equal(await count(), 1);
    });

    it('refuses more than 500 nodes', async () => {
        const nodes = {};
        // 499 + the two of telemetryBody() = 501
        for (let i = 0; i < 499; i++) {
            nodes['node-red-contrib-n' + i] = '1.0.0';
        }
        assert.equal((await postTelemetry(server, 3, telemetryBody(nodes))).status, 400);
        delete nodes['node-red-contrib-n0'];
        assert.equal((await postTelemetry(server, 3, telemetryBody(nodes))).status, 200);
        assert.equal(await count(), 2);
    });

    it('refuses a body over 64 kB', async () => {
        const res = await postTelemetry(server, 4, telemetryBody({'node-red-contrib-big': 'x'.repeat(70000)}));
        assert.equal(res.status, 413);
    });

    it('leaves out a node that is not a package name or has no short version', async () => {
        const body = telemetryBody({
            'node-red-contrib-samsungTV': '1.0.0',
            '@scope/node-red-contrib-x': '0.1.0',
            '<b>node-red-contrib-x</b>': '1.0.0',
            'node-red-contrib-y ': '1.0.0',
            'node-red-contrib-z': {nested: true},
            'node-red-contrib-long': '1'.repeat(65),
        });
        assert.equal((await postTelemetry(server, 5, body)).status, 200);
        const rows = await server.db.all('SELECT name FROM node WHERE installation_uuid=? ORDER BY name;', [uuid(5)]);
        assert.deepEqual(
            rows.map((r) => r.name),
            ['@scope/node-red-contrib-x', 'node-red-contrib-ccu', 'node-red-contrib-samsungTV', 'redmatic-homekit'],
        );
    });

    it('accepts missing or empty CCU fields, as old clients send them', () => {
        assert.ok(validate({redmatic: '4.0.0', ccu: {}}));
        assert.ok(validate({redmatic: '4.0.0', ccu: {VERSION: '2.45.7', PRODUCT: '', PLATFORM: ''}}));
        assert.ok(
            validate({redmatic: '8.0.0-beta.1', ccu: {VERSION: '3.89.11.20260919', PRODUCT: 'raspmatic_odroid-n2'}}),
        );
        assert.equal(validate({redmatic: '8.0.0', ccu: 'ccu3'}), null);
        assert.equal(validate(null), null);
    });
});

describe('rate limit (task 6)', () => {
    let server;
    before(async () => {
        server = await startServer({app: {rateLimit: {limit: 10, windowMs: 3600 * 1000}}});
    });
    after(() => server.close());

    it('answers 429 to the 11th POST in an hour from one address', async () => {
        for (let i = 1; i <= 10; i++) {
            const res = await postTelemetry(server, i, telemetryBody(), {'X-Forwarded-For': '192.0.2.20'});
            assert.equal(res.status, 200);
        }
        const res = await postTelemetry(server, 11, telemetryBody(), {'X-Forwarded-For': '192.0.2.20'});
        assert.equal(res.status, 429);
        // another address is not affected
        const other = await postTelemetry(server, 12, telemetryBody(), {'X-Forwarded-For': '192.0.2.21'});
        assert.equal(other.status, 200);
    });

    it('opens again in the next window', () => {
        let time = 0;
        const allowed = rateLimiter({limit: 2, windowMs: 1000, now: () => time});
        assert.ok(allowed('a') && allowed('a'));
        assert.equal(allowed('a'), false);
        time = 1000;
        assert.ok(allowed('a'));
    });
});

describe('openccu-lite (task 2)', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    const lite = (n) => server.db.get('SELECT product, platform, lite FROM installation WHERE uuid=?;', [uuid(n)]);
    const body = (product, liteVersion, platform = 'rpi4-aarch64') =>
        telemetryBody({ccu: {VERSION: '3.89.11', PRODUCT: product, PLATFORM: platform, LITE: liteVersion}});

    it('stores ccu.LITE and counts a lite system everywhere', async () => {
        assert.equal((await postTelemetry(server, 1, body('lite-rpi4', '1.0.0-dev.31'))).status, 200);
        assert.deepEqual({...(await lite(1))}, {product: 'lite-rpi4', platform: 'rpi4-aarch64', lite: '1.0.0-dev.31'});
        await postTelemetry(server, 2, body('lite-ova', '1.0.0-beta.0', 'ova-x86_64'));
        await postTelemetry(server, 3, body('ccu3', undefined, 'ccu3-armv7l'));
        await postTelemetry(server, 4, body('raspmatic_rpi4', undefined));
        await postTelemetry(server, 5, body('rpi5', undefined, 'rpi5-aarch64'));
        await postTelemetry(server, 6, body('pivccu3', undefined, 'lxc-aarch64'));
        await postTelemetry(server, 7, body('', undefined, ''));

        const d = await (await server.fetch('/data?timespan=7')).json();
        assert.equal(d.total, 7);
        assert.deepEqual(
            d.products.find((p) => p[0] === 'lite-rpi4'),
            ['lite-rpi4', 1],
        );
        assert.deepEqual(d.liteVersions, [
            ['1.0.0-dev.31', 1],
            ['1.0.0-beta.0', 1],
        ]);
        assert.deepEqual(Object.fromEntries(d.families), {lite: 2, openccu: 2, ccu3: 1, pivccu3: 1, other: 1});
        assert.deepEqual(d.litePlatforms.sort(), [
            ['ova-x86_64', 1],
            ['rpi4-aarch64', 1],
        ]);
        assert.deepEqual(d.ccuVersions, [['3.89.11', 7, 2]]);
    });

    it('stores NULL for a CCU3 or OpenCCU body and for a LITE that is not a version', async () => {
        assert.equal((await lite(3)).lite, null);
        assert.equal((await lite(4)).lite, null);
        for (const [n, value] of [
            [8, 'dev'],
            [9, '<b>1.0.0</b>'],
            [10, 1],
            [11, '1.0.0-' + 'x'.repeat(30)],
        ]) {
            assert.equal((await postTelemetry(server, n, body('lite-rpi3', value, 'rpi3-aarch64'))).status, 200);
            assert.equal((await lite(n)).lite, null);
        }
    });

    it('counts a lite product without a LITE version as lite', async () => {
        const d = await (await server.fetch('/data?timespan=7')).json();
        assert.equal(Object.fromEntries(d.families).lite, 6);
        assert.deepEqual(
            d.litePlatforms.find((p) => p[0] === 'rpi3-aarch64'),
            ['rpi3-aarch64', 4],
        );
    });

    it('updates the lite version on the next contact', async () => {
        await postTelemetry(server, 1, body('lite-rpi4', '1.0.0'));
        assert.equal((await lite(1)).lite, '1.0.0');
    });

    it('is in the export', async () => {
        const text = await (await server.fetch('/export.csv')).text();
        assert.ok(text.includes('\r\n7,lite,1.0.0,1\r\n'));
        assert.ok(text.includes('\r\n7,family,lite,6\r\n'));
    });
});

describe('GET /data: timespans and the cache (task 4)', () => {
    let server;
    let time = 1e12;
    before(async () => {
        server = await startServer({app: {cacheSeconds: 300, now: () => time}});
        await insertInstallation(server.db, 1);
    });
    after(() => server.close());

    it('answers 400 to a timespan the page does not offer', async () => {
        for (const t of ['5', 'abc', '36501', '-1', '7;DROP TABLE node']) {
            assert.equal((await server.fetch('/data?timespan=' + encodeURIComponent(t))).status, 400, t);
        }
        for (const t of ['1', '7', '30', '90', '365', '36500']) {
            assert.equal((await server.fetch('/data?timespan=' + t)).status, 200, t);
        }
    });

    it('serves the aggregates from the cache for five minutes', async () => {
        const first = await server.fetch('/data?timespan=30');
        assert.equal(first.headers.get('cache-control'), 'max-age=300');
        assert.equal((await first.json()).total, 1);
        await insertInstallation(server.db, 2);
        time += 299 * 1000;
        assert.equal((await (await server.fetch('/data?timespan=30')).json()).total, 1);
        time += 2 * 1000;
        assert.equal((await (await server.fetch('/data?timespan=30')).json()).total, 2);
    });
});
