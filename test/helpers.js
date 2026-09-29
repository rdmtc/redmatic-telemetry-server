'use strict';

// Test helpers: a temporary database made from the schema, the app on port 0, and invented ids only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sqlite3 = require('sqlite3');
const Ip2cc = require('ip2countrycode');

const {createApp, prepare} = require('../server.js');

const root = path.join(__dirname, '..');

// The live database has cc and country in addition to the 2019 schema file (task 4 adds them there).
const liveColumns = [
    'ALTER TABLE installation ADD COLUMN cc VARCHAR (2);',
    'ALTER TABLE installation ADD COLUMN country VARCHAR (255);',
];

function promisify(db) {
    return {
        raw: db,
        exec: (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve()))),
        run: (sql, params = []) =>
            new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve()))),
        get: (sql, params = []) =>
            new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))),
        all: (sql, params = []) =>
            new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))),
        close: () => new Promise((resolve) => db.close(() => resolve())),
    };
}

async function makeDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-test-'));
    const file = path.join(dir, 'test.db');
    const db = promisify(new sqlite3.Database(file));
    await db.exec(fs.readFileSync(path.join(root, 'redmatic-telemetry.sql')).toString());
    for (const sql of liveColumns) {
        await db.exec(sql);
    }
    db.dir = dir;
    return db;
}

/** An invented telemetry id: 00000000-0000-4000-8000-<n, 12 digits>. */
function uuid(n) {
    return '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
}

/** Inserts an installation row directly; created/updated as SQLite modifiers relative to now (e.g. '-3 day'). */
async function insertInstallation(db, n, fields = {}) {
    const row = {
        redmatic: '8.0.0',
        initial: '7.0.0',
        ccu: '3.89.11',
        platform: 'rpi4-aarch64',
        product: 'ccu3',
        created: '-1 day',
        updated: null,
        counter: 0,
        cc: 'DE',
        country: 'Germany',
        nodes: {},
        ...fields,
    };
    await db.run(
        "INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, created, updated, counter, cc, country) VALUES (?,?,?,?,?,?,DATETIME('now', ?),CASE WHEN ? IS NULL THEN NULL ELSE DATETIME('now', ?) END,?,?,?);",
        [
            uuid(n),
            row.redmatic,
            row.initial,
            row.ccu,
            row.platform,
            row.product,
            row.created,
            row.updated,
            row.updated,
            row.counter,
            row.cc,
            row.country,
        ],
    );
    if (row.lite) {
        await db.run('UPDATE installation SET lite=? WHERE uuid=?;', [row.lite, uuid(n)]);
    }
    for (const [name, version] of Object.entries(row.nodes)) {
        await db.run('INSERT INTO node (name, version, installation_uuid) VALUES (?,?,?);', [name, version, uuid(n)]);
    }
}

async function startServer(options = {}) {
    const db = options.db || (await makeDb());
    await prepare(db.raw);
    const logs = [];
    const ip2cc = new Ip2cc(path.join(__dirname, 'fixtures', 'ip2location.csv'));
    const app = createApp({
        db: db.raw,
        ip2cc,
        log: (...args) => logs.push(args.join(' ')),
        rateLimit: false,
        ...options.app,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    return {
        db,
        logs,
        base,
        fetch: (url, init) => fetch(base + url, init),
        async close() {
            await new Promise((resolve) => server.close(resolve));
            await db.close();
            fs.rmSync(db.dir, {recursive: true, force: true});
        },
    };
}

/** A RedMatic telemetry body in redmaticVersions.js's shape, with invented values. */
function telemetryBody(overrides = {}) {
    return {
        ccu: {VERSION: '3.89.11', PRODUCT: 'ccu3', PLATFORM: 'ccu3-armv7l', deviceTypes: {'HmIP-BSM': 2}},
        redmatic: '8.0.0',
        nodejs: '22.20.0',
        'node-red': '4.1.0',
        npm: '10.9.3',
        'node-red-contrib-ccu': '3.5.0',
        'redmatic-homekit': '2.1.0',
        ...overrides,
    };
}

function postTelemetry(server, n, body, headers = {}) {
    return server.fetch('/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'curl/8.9.1',
            'X-RedMatic-uuid': uuid(n),
            ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

/** Polls fn until it returns a truthy value; the telemetry POST answers before it stores. */
async function waitFor(fn, timeout = 2000) {
    const start = Date.now();
    for (;;) {
        const result = await fn();
        if (result) {
            return result;
        }
        if (Date.now() - start > timeout) {
            throw new Error('waitFor: timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

module.exports = {makeDb, uuid, insertInstallation, startServer, telemetryBody, postTelemetry, waitFor};
