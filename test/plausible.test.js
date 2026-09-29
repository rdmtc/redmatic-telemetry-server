'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {database, migrate, open} = require('../lib/db.js');
const {plausibleRedmatic, plausibleCcu, redmaticRules, removeImplausible} = require('../lib/plausible.js');
const known = require('../data/redmatic-versions.json');
const {startDaily} = require('../server.js');
const {makeDb, uuid, insertInstallation, startServer, telemetryBody, postTelemetry} = require('./helpers.js');

const count = async (db, table) => (await db.get('SELECT COUNT(*) AS n FROM ' + table + ';')).n;
const node = {'node-red-contrib-ccu': '3.5.0', 'redmatic-homekit': '2.1.0'};

describe('the known RedMatic versions (task 12)', () => {
    it('are the tags, in order, and the community builds', () => {
        assert.ok(known.releases.includes('7.2.1'));
        assert.ok(known.releases.includes('7.2.0-beta.1'));
        assert.ok(known.releases.includes('0.0.3-9'));
        assert.equal(known.releases[0], '0.0.3-9');
        assert.ok(!known.releases.includes('26.1.0'));
        const community = known.community.flatMap((c) => c.versions);
        for (const v of ['7.3.4', '7.3.5', '7.3.6', '7.4.0', '7.4.1']) {
            assert.ok(community.includes(v), v);
        }
    });

    it('allow one major above the newest known one', () => {
        const rules = redmaticRules({releases: ['1.0.0', '9.10.0', '9.0.0-alpha.1'], community: []});
        assert.equal(rules.maxMajor, 10);
    });
});

describe('plausibleRedmatic (task 12)', () => {
    const rules = redmaticRules({
        releases: ['7.2.1', '8.0.0-alpha.3', '9.10.0'],
        community: [{versions: ['7.4.1'], note: 'test'}],
    });

    for (const [version, expected] of [
        // known
        ['7.2.1', true],
        ['9.10.0', true],
        ['7.4.1', true],
        // not listed, but plausible: kept
        ['8.0.0', true],
        ['9.11.0', true],
        ['9.10.1-dev.0', true],
        ['10.0.0', true],
        ['10.0.0-beta.1', true],
        ['1.0.0-beta.0+68', true],
        // impossible
        ['26.1.0', false],
        ['11.0.0', false],
        ['2026.1.0', false],
        ['9.10', false],
        ['v9.10.0', false],
        ['latest', false],
        ['', false],
        [null, false],
        [9, false],
    ]) {
        it(`${JSON.stringify(version)} → ${expected}`, () => {
            assert.equal(plausibleRedmatic(version, rules), expected);
        });
    }

    it('keeps every RedMatic version the public page shows (2026-09-29) except 26.1.0', () => {
        const live = [
            '26.1.0',
            '9.10.0',
            '9.9.0',
            '9.4.1',
            '9.0.0',
            '8.0.0',
            '7.4.1',
            '7.4.0',
            '7.3.6',
            '7.3.5',
            '7.3.4',
            '7.2.1',
            '7.2.0-beta.2',
            '7.2.0-beta.1',
            '5.6.0-beta.2',
            '4.3.1',
        ];
        assert.deepEqual(
            live.filter((v) => !plausibleRedmatic(v)),
            ['26.1.0'],
        );
    });
});

describe('plausibleCcu (task 12)', () => {
    for (const [version, expected] of [
        ['3.89.11', true],
        ['3.89.11.20260919', true],
        ['3.90.2007', true],
        ['3.88.1836', true],
        ['2.35.16.20180826', true],
        ['4.0.0', true],
        [null, true],
        [undefined, true],
        ['', true],
        ['1.2.3', false],
        ['5.0.0', false],
        ['30.1.0', false],
        ['3.89', false],
        ['3.89.11.2026', false],
        ['3.89.11-beta', false],
    ]) {
        it(`${JSON.stringify(version)} → ${expected}`, () => {
            assert.equal(plausibleCcu(version), expected);
        });
    }
});

describe('removeImplausible (task 12)', () => {
    it('deletes the impossible installations with their modules, and reports counts and values only', async () => {
        const db = await makeDb();
        migrate(db.raw);
        await insertInstallation(db, 1, {redmatic: '26.1.0', nodes: node});
        await insertInstallation(db, 2, {redmatic: '26.1.0', nodes: node});
        await insertInstallation(db, 3, {redmatic: '8.0.0', nodes: node});
        await insertInstallation(db, 4, {redmatic: '7.4.1', nodes: node});
        await insertInstallation(db, 5, {redmatic: '9.10.0', ccu: '30.1.0', nodes: node});
        await insertInstallation(db, 6, {redmatic: '26.1.0', ccu: '30.1.0'});
        await insertInstallation(db, 7, {redmatic: '9.10.0', ccu: null});
        await insertInstallation(db, 8, {redmatic: null});
        const result = removeImplausible(database(db.raw));
        assert.deepEqual(result, {
            installations: 4,
            nodes: 6,
            redmatic: {'26.1.0': 3},
            ccu: {'30.1.0': 1},
        });
        assert.doesNotMatch(JSON.stringify(result), /00000000-/);
        const left = (await db.all('SELECT uuid FROM installation ORDER BY uuid;')).map((r) => r.uuid);
        assert.deepEqual(left, [uuid(3), uuid(4), uuid(7), uuid(8)]);
        assert.equal(await count(db, 'node'), 4);
        assert.deepEqual(removeImplausible(database(db.raw)), {installations: 0, nodes: 0, redmatic: {}, ccu: {}});
        await db.close();
    });
});

describe('migration 6 (task 12)', () => {
    it('deletes the impossible rows of an existing database and logs the counts', async () => {
        const db = await makeDb();
        migrate(db.raw);
        await db.exec('PRAGMA user_version = 5;');
        await insertInstallation(db, 1, {redmatic: '26.1.0', nodes: node});
        await insertInstallation(db, 2, {redmatic: '26.1.0'});
        await insertInstallation(db, 3, {redmatic: '8.0.0', nodes: node});
        await insertInstallation(db, 4, {redmatic: '7.3.5'});
        const file = db.file;
        await db.close();
        const logs = [];
        const opened = open(file, {log: (...a) => logs.push(a.join(' '))});
        assert.equal(opened.prepare('PRAGMA user_version;').get().user_version, 6);
        assert.equal(opened.prepare('SELECT COUNT(*) AS n FROM installation;').get().n, 2);
        assert.equal(opened.prepare('SELECT COUNT(*) AS n FROM node;').get().n, 2);
        assert.deepEqual(logs, ['migration 6 {"installations":2,"nodes":2,"redmatic":{"26.1.0":2},"ccu":{}}']);
        opened.close();
        fs.rmSync(path.dirname(file), {recursive: true, force: true});
    });

    it('runs in the chain from an empty database', async () => {
        const db = await makeDb();
        const logs = [];
        migrate(db.raw, {log: (...a) => logs.push(a.join(' '))});
        assert.deepEqual(logs, [
            'migration 1 001-initial.sql',
            'migration 2 002-lite.sql',
            'migration 3 003-indexes.sql',
            'migration 4 004-daily-stats.sql',
            'migration 5 005-public-nodes.sql',
            'migration 6 {"installations":0,"nodes":0,"redmatic":{},"ccu":{}}',
        ]);
        await db.close();
    });
});

describe('the daily job re-applies the rule (task 12)', () => {
    it('deletes an impossible row that arrived after the migration, and logs counts only', async () => {
        const db = await makeDb();
        migrate(db.raw);
        await insertInstallation(db, 1, {redmatic: '26.1.0', nodes: node});
        await insertInstallation(db, 2, {redmatic: '9.10.0', nodes: node});
        const logs = [];
        const stop = startDaily(db.raw, {log: (...a) => logs.push(a.join(' '))});
        await new Promise((resolve) => setTimeout(resolve, 30));
        stop();
        assert.equal(await count(db, 'installation'), 1);
        assert.ok(logs.includes('implausible {"installations":1,"nodes":2,"redmatic":{"26.1.0":1},"ccu":{}}'), logs);
        assert.doesNotMatch(logs.join('\n'), /00000000-/);
        await db.close();
    });
});

describe('POST / refuses an impossible version (task 12)', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    it('answers 400, stores nothing and counts it', async () => {
        assert.equal((await postTelemetry(server, 1, telemetryBody({redmatic: '26.1.0'}))).status, 400);
        const ccu = {VERSION: '30.1.0', PRODUCT: 'ccu3', PLATFORM: 'ccu3-armv7l'};
        assert.equal((await postTelemetry(server, 2, telemetryBody({ccu}))).status, 400);
        assert.equal(await count(server.db, 'installation'), 0);
        server.flush();
        assert.ok(server.logs.includes('requests {"implausible":2}'), server.logs);
    });

    it('keeps the old row when a known installation sends an impossible version', async () => {
        assert.equal((await postTelemetry(server, 3, telemetryBody({redmatic: '9.10.0'}))).status, 200);
        assert.equal((await postTelemetry(server, 3, telemetryBody({redmatic: '26.1.0'}))).status, 400);
        const row = await server.db.get('SELECT redmatic FROM installation WHERE uuid=?;', [uuid(3)]);
        assert.equal(row.redmatic, '9.10.0');
    });

    it('accepts a community build, an unlisted older version and a new release', async () => {
        for (const [n, redmatic] of [
            [4, '7.4.1'],
            [5, '8.0.0'],
            [6, '9.11.0'],
            [7, '10.0.0'],
        ]) {
            assert.equal((await postTelemetry(server, n, telemetryBody({redmatic}))).status, 200, redmatic);
        }
    });
});
