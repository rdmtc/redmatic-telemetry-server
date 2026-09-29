'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const {database, migrate, open} = require('../lib/db.js');
const {applyRetention} = require('../lib/retention.js');
const {startDaily} = require('../server.js');
const {makeDb, uuid, startServer, insertInstallation, telemetryBody, postTelemetry} = require('./helpers.js');

const NOW = new Date('2026-09-29T00:10:00Z');

async function insertAt(db, n, {created, updated = null, nodes = {}}) {
    await db.run(
        "INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, created, updated, counter, cc, country) VALUES (?, '8.0.0', '8.0.0', '3.89.11', 'rpi4-aarch64', 'ccu3', ?, ?, 0, 'DE', 'Germany');",
        [uuid(n), created, updated],
    );
    for (const [name, version] of Object.entries(nodes)) {
        await db.run('INSERT INTO node (name, version, installation_uuid) VALUES (?,?,?);', [name, version, uuid(n)]);
    }
}

const count = async (db, table) => (await db.get('SELECT COUNT(*) AS n FROM ' + table + ';')).n;
const ids = async (db) => (await db.all('SELECT uuid FROM installation ORDER BY uuid;')).map((r) => r.uuid);

describe('retention (task 9)', () => {
    it('deletes installations not seen for 24 months, with their nodes', async () => {
        const db = await makeDb();
        migrate(db.raw);
        const node = {'node-red-contrib-ccu': '3.5.0', 'redmatic-homekit': '2.1.0'};
        // last contact 2024-09-28: older than 24 months
        await insertAt(db, 1, {created: '2020-01-01 10:00:00', updated: '2024-09-28 10:00:00', nodes: node});
        // never updated, created 2024-09-01: older
        await insertAt(db, 2, {created: '2024-09-01 10:00:00', nodes: node});
        // last contact 2024-09-30: within
        await insertAt(db, 3, {created: '2020-01-01 10:00:00', updated: '2024-09-30 10:00:00', nodes: node});
        // created within, never updated
        await insertAt(db, 4, {created: '2026-01-01 10:00:00', nodes: node});
        // no timestamps at all: left alone
        await insertAt(db, 5, {created: null});
        const result = applyRetention(database(db.raw), NOW);
        assert.deepEqual(result, {installations: 2, nodes: 4});
        assert.deepEqual(await ids(db), [uuid(3), uuid(4), uuid(5)]);
        assert.equal(await count(db, 'node'), 4);
        // again: nothing left to delete
        assert.deepEqual(applyRetention(database(db.raw), NOW), {installations: 0, nodes: 0});
        await db.close();
    });

    it('runs after the snapshot in the daily job, so the counts survive, and logs counts only', async () => {
        const db = await makeDb();
        migrate(db.raw);
        await insertAt(db, 1, {created: '2023-05-01 10:00:00', nodes: {'node-red-contrib-ccu': '3.5.0'}});
        await insertAt(db, 2, {created: '2026-09-01 10:00:00'});
        const logs = [];
        const stop = startDaily(db.raw, {log: (...a) => logs.push(a.join(' ')), now: () => NOW.getTime()});
        await new Promise((resolve) => setTimeout(resolve, 20));
        stop();
        assert.deepEqual(await ids(db), [uuid(2)]);
        // the deleted installation is still in the history: new on its day, and in the backfilled active curve
        const created = await db.get("SELECT count FROM daily_stats WHERE dimension='new' AND date='2023-05-01';");
        assert.equal(created.count, 1);
        const active = await db.get("SELECT count FROM daily_stats WHERE dimension='active' AND date='2023-06-01';");
        assert.equal(active.count, 1);
        assert.equal(logs.length, 2);
        assert.match(logs[0], /^daily /);
        assert.equal(logs[1], 'retention {"installations":1,"nodes":1}');
        assert.ok(logs.every((l) => !l.includes('00000000-')));
        await db.close();
    });
});

describe('the node table keeps only public modules (task 9)', () => {
    it('migration 5 deletes the other rows and the orphans of a live-shaped database', async () => {
        const db = await makeDb({legacy: true});
        await db.run(
            "INSERT INTO installation (uuid, redmatic, created, cc) VALUES (?, '8.0.0', CURRENT_TIMESTAMP, 'DE');",
            [uuid(1)],
        );
        const names = [
            'node-red-contrib-ccu',
            'redmatic-homekit',
            '@flowfuse/node-red-dashboard',
            'my-private-module',
            '@scope/private',
            'mynode-red-thing',
            'Node-RED-contrib-caps',
        ];
        for (const name of names) {
            await db.run("INSERT INTO node (name, version, installation_uuid) VALUES (?, '1.0.0', ?);", [
                name,
                uuid(1),
            ]);
        }
        // an orphan: its installation is gone (the old sqlite3 server ran without foreign keys; node:sqlite has them on)
        await db.exec('PRAGMA foreign_keys = OFF;');
        await db.run("INSERT INTO node (name, version, installation_uuid) VALUES ('node-red-x', '1.0.0', ?);", [
            uuid(9),
        ]);
        migrate(db.raw);
        const left = (await db.all('SELECT name FROM node ORDER BY name;')).map((r) => r.name);
        assert.deepEqual(left, ['@flowfuse/node-red-dashboard', 'node-red-contrib-ccu', 'redmatic-homekit']);
        await db.close();
    });

    it('migration 5 on a synthetic database: only public names remain, every installation stays', async () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rts-syn-'));
        const file = path.join(dir, 'syn.db');
        execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'synthetic-db.js'), file, '300', '10']);
        // the generator writes the newest schema, then a private module per installation, as the live database has
        // them; step back to version 4 so the next open runs migration 5
        let db = open(file);
        db.exec('PRAGMA user_version = 4;');
        const nodes = (where) => db.prepare('SELECT COUNT(*) AS n FROM node' + where + ';').get().n;
        const isPublic = " WHERE (name GLOB 'redmatic-*' OR name GLOB 'node-red-*' OR name GLOB '@*/node-red-*')";
        const publicBefore = nodes(isPublic);
        assert.ok(nodes('') >= publicBefore + 300);
        const installations = db.prepare('SELECT COUNT(*) AS n FROM installation;').get().n;
        db.close();
        db = open(file);
        assert.equal(db.prepare('PRAGMA user_version;').get().user_version >= 5, true);
        assert.equal(nodes(''), publicBefore);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM installation;').get().n, installations);
        db.close();
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('/data counts @scope/node-red-* modules', async () => {
        const server = await startServer();
        await insertInstallation(server.db, 1, {nodes: {'@flowfuse/node-red-dashboard': '1.0.0'}});
        const d = await (await server.fetch('/data?timespan=30')).json();
        assert.deepEqual(d.nodes, [['@flowfuse/node-red-dashboard', 1]]);
        await server.close();
    });
});

describe('DELETE / (task 9)', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    const del = (headers) => server.fetch('/', {method: 'DELETE', headers});

    it('deletes the installation and its nodes', async () => {
        assert.equal((await postTelemetry(server, 1, telemetryBody())).status, 200);
        assert.equal((await postTelemetry(server, 2, telemetryBody())).status, 200);
        assert.equal(await count(server.db, 'node'), 4);
        // the id in upper case is the same id
        const res = await del({'X-RedMatic-uuid': uuid(1).toUpperCase(), 'User-Agent': 'curl/8.9.1'});
        assert.equal(res.status, 204);
        assert.deepEqual(await ids(server.db), [uuid(2)]);
        assert.equal(await count(server.db, 'node'), 2);
        server.flush();
        assert.ok(server.logs.includes('requests {"insert":2,"delete":1}'), server.logs.join('|'));
        assert.ok(server.logs.every((l) => !l.includes('00000000-')));
    });

    it('answers the same for an unknown id', async () => {
        const res = await del({'X-RedMatic-uuid': uuid(77)});
        assert.equal(res.status, 204);
        assert.deepEqual(await ids(server.db), [uuid(2)]);
    });

    it('refuses a missing or malformed id', async () => {
        assert.equal((await del({})).status, 400);
        assert.equal((await del({'X-RedMatic-uuid': 'abc'})).status, 400);
        assert.equal((await del({'X-RedMatic-uuid': uuid(2) + 'x'})).status, 400);
        assert.deepEqual(await ids(server.db), [uuid(2)]);
    });

    it('is rate-limited like POST /', async () => {
        const limited = await startServer({app: {rateLimit: {limit: 2, windowMs: 3600 * 1000}}});
        const headers = {'X-RedMatic-uuid': uuid(1), 'X-Forwarded-For': '192.0.2.30'};
        assert.equal((await limited.fetch('/', {method: 'DELETE', headers})).status, 204);
        assert.equal((await limited.fetch('/', {method: 'DELETE', headers})).status, 204);
        assert.equal((await limited.fetch('/', {method: 'DELETE', headers})).status, 429);
        await limited.close();
    });
});
