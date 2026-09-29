'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {database, migrate} = require('../lib/db.js');
const trends = require('../lib/trends.js');
const {startDaily} = require('../server.js');
const {makeDb, uuid, startServer} = require('./helpers.js');

// The fake clock: every timestamp below is absolute, relative to this.
const NOW = new Date('2026-09-29T00:10:00Z');

/** Inserts an installation with absolute timestamps ('YYYY-MM-DD HH:MM:SS', UTC). */
async function insertAt(db, n, {created, updated = null, ...fields}) {
    const row = {redmatic: '8.0.0', ccu: '3.89.11', platform: 'rpi4-aarch64', product: 'ccu3', lite: null, cc: 'DE'};
    Object.assign(row, fields);
    await db.run(
        'INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, lite, created, updated, counter, cc, country) VALUES (?,?,?,?,?,?,?,?,?,0,?,?);',
        [
            uuid(n),
            row.redmatic,
            row.redmatic,
            row.ccu,
            row.platform,
            row.product,
            row.lite,
            created,
            updated,
            row.cc,
            row.cc,
        ],
    );
}

async function freshDb() {
    const db = await makeDb();
    migrate(db.raw);
    return db;
}

const rows = (db, dimension) =>
    db.all('SELECT date, value, count, estimated FROM daily_stats WHERE dimension=? ORDER BY date, value;', [
        dimension,
    ]);

describe('daily snapshots (task 11)', () => {
    it('counts the installations seen in the last 180 days, per dimension, small values as (other)', async () => {
        const db = await freshDb();
        let n = 0;
        // 6 on RedMatic 8.0.0 / CCU 3.89, seen yesterday
        for (let i = 0; i < 6; i++) {
            await insertAt(db, ++n, {created: '2025-01-01 10:00:00', updated: '2026-09-28 12:00:00'});
        }
        // 5 openccu-lite, created 100 days ago, never updated
        for (let i = 0; i < 5; i++) {
            await insertAt(db, ++n, {
                created: '2026-06-21 10:00:00',
                product: 'lite-rpi4',
                lite: '1.0.0',
                ccu: '3.89.2',
                redmatic: '8.1.0',
                cc: 'AT',
            });
        }
        // 2 on an old version: below 5, so (other)
        for (let i = 0; i < 2; i++) {
            await insertAt(db, ++n, {created: '2026-09-01 10:00:00', redmatic: '7.0.0', ccu: '3.61.7', cc: 'CH'});
        }
        // 4 last seen 200 days ago: not active
        for (let i = 0; i < 4; i++) {
            await insertAt(db, ++n, {created: '2024-01-01 10:00:00', updated: '2026-03-13 10:00:00'});
        }
        const q = database(db.raw);
        trends.snapshot(q, NOW);
        const at = async (dimension) => Object.fromEntries((await rows(db, dimension)).map((r) => [r.value, r.count]));
        assert.deepEqual(await at('active'), {'': 13});
        assert.deepEqual(await at('redmatic'), {'8.0.0': 6, '8.1.0': 5, '(other)': 2});
        assert.deepEqual(await at('ccu'), {3.89: 11, '(other)': 2});
        assert.deepEqual(await at('family'), {ccu3: 8, lite: 5});
        assert.deepEqual(await at('lite'), {'1.0.0': 5});
        assert.deepEqual(await at('country'), {DE: 6, AT: 5, '(other)': 2});
        assert.equal((await rows(db, 'active'))[0].date, '2026-09-29');
        assert.equal((await rows(db, 'active'))[0].estimated, 0);
        // no id anywhere in the table
        const all = await db.all('SELECT * FROM daily_stats;');
        assert.ok(all.every((r) => !String(r.value).startsWith('00000000-')));
        await db.close();
    });

    it('writes each day once, however often the job runs', async () => {
        const db = await freshDb();
        await insertAt(db, 1, {created: '2026-09-20 10:00:00'});
        const q = database(db.raw);
        const first = trends.daily(q, NOW);
        assert.ok(first.snapshot > 0);
        const count = (await db.get('SELECT COUNT(*) AS n FROM daily_stats;')).n;
        const again = trends.daily(q, new Date('2026-09-29T13:00:00Z'));
        assert.deepEqual(again, {new: 0, backfilled: 0, snapshot: 0});
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM daily_stats;')).n, count);
        // the next day: a new snapshot and one more "new" day
        const next = trends.daily(q, new Date('2026-09-30T00:05:00Z'));
        assert.equal(next.new, 1);
        assert.equal(next.backfilled, 0);
        assert.ok(next.snapshot > 0);
        await db.close();
    });

    it('records the new installations of every complete day, zeros included', async () => {
        const db = await freshDb();
        await insertAt(db, 1, {created: '2026-09-25 10:00:00'});
        await insertAt(db, 2, {created: '2026-09-25 23:59:59'});
        await insertAt(db, 3, {created: '2026-09-27 00:00:00'});
        // today: not complete, not recorded yet
        await insertAt(db, 4, {created: '2026-09-29 00:05:00'});
        trends.recordNew(database(db.raw), NOW);
        assert.deepEqual(
            (await rows(db, 'new')).map((r) => [r.date, r.count]),
            [
                ['2026-09-25', 2],
                ['2026-09-26', 0],
                ['2026-09-27', 1],
                ['2026-09-28', 0],
            ],
        );
        await db.close();
    });

    it('backfills a rough active curve once, marked estimated', async () => {
        const db = await freshDb();
        // active 2026-01-01 .. 2026-01-01 + 180 days (updated never)
        await insertAt(db, 1, {created: '2026-01-01 10:00:00'});
        // active 2026-01-03 .. 2026-09-28 (last seen yesterday)
        await insertAt(db, 2, {created: '2026-01-03 10:00:00', updated: '2026-09-28 10:00:00'});
        const q = database(db.raw);
        const result = trends.daily(q, NOW);
        const active = await rows(db, 'active');
        const byDate = Object.fromEntries(active.map((r) => [r.date, r]));
        assert.equal(result.backfilled, 271); // 2026-01-01 .. 2026-09-28
        assert.equal(byDate['2026-01-01'].count, 1);
        assert.equal(byDate['2026-01-01'].estimated, 1);
        assert.equal(byDate['2026-01-03'].count, 2);
        assert.equal(byDate['2026-06-29'].count, 2); // day 180 of the first: its last active day
        assert.equal(byDate['2026-06-30'].count, 1);
        assert.equal(byDate['2026-09-28'].count, 1);
        assert.equal(byDate['2026-09-28'].estimated, 1);
        // today: the real snapshot (only the second is seen in the last 180 days)
        assert.equal(byDate['2026-09-29'].count, 1);
        assert.equal(byDate['2026-09-29'].estimated, 0);
        // a later run does not backfill again
        assert.equal(trends.daily(q, new Date('2026-09-30T00:05:00Z')).backfilled, 0);
        await db.close();
    });

    it('does nothing on an empty database but the snapshot of 0', async () => {
        const db = await freshDb();
        assert.deepEqual(trends.daily(database(db.raw), NOW), {new: 0, backfilled: 0, snapshot: 1});
        assert.deepEqual(await rows(db, 'active'), [{date: '2026-09-29', value: '', count: 0, estimated: 0}]);
        await db.close();
    });

    it('returns a dimension over a timespan, series sorted by the latest count', async () => {
        const db = await freshDb();
        const q = database(db.raw);
        const put = (dimension, date, value, count, estimated = 0) =>
            q.run('INSERT INTO daily_stats (dimension, date, value, count, estimated) VALUES (?,?,?,?,?);', [
                dimension,
                date,
                value,
                count,
                estimated,
            ]);
        put('redmatic', '2025-01-01', '7.0.0', 50);
        put('redmatic', '2026-09-27', '8.0.0', 10);
        put('redmatic', '2026-09-27', '(other)', 30);
        put('redmatic', '2026-09-28', '8.0.0', 12);
        put('redmatic', '2026-09-28', '8.1.0', 20);
        put('active', '2026-09-27', '', 40, 1);
        put('active', '2026-09-28', '', 32);
        const t = trends.trend(q, 'redmatic', 30, NOW);
        assert.deepEqual(t.dates, ['2026-09-27', '2026-09-28']);
        assert.deepEqual(t.series, [
            ['8.1.0', [0, 20]],
            ['8.0.0', [10, 12]],
            ['(other)', [30, 0]],
        ]);
        assert.equal(t.snapshotsSince, '2026-09-28');
        assert.deepEqual(trends.trend(q, 'active', 30, NOW).estimated, [1, 0]);
        assert.equal(trends.trend(q, 'redmatic', 36500, NOW).dates.length, 3);
        await db.close();
    });
});

describe('GET /data/trend', () => {
    let server;
    before(async () => {
        const db = await makeDb();
        server = await startServer({db});
        const q = database(server.db.raw);
        const today = trends.isoDay(new Date());
        q.run("INSERT INTO daily_stats (dimension, date, value, count) VALUES ('redmatic', ?, '8.0.0', 7);", [today]);
    });
    after(() => server.close());

    it('serves a dimension', async () => {
        const res = await server.fetch('/data/trend?dimension=redmatic&days=365');
        assert.equal(res.status, 200);
        const t = await res.json();
        assert.equal(t.dimension, 'redmatic');
        assert.equal(t.days, 365);
        assert.deepEqual(t.series, [['8.0.0', [7]]]);
        assert.match(res.headers.get('cache-control'), /max-age=/);
    });

    it('defaults to the active installations of a year', async () => {
        const t = await (await server.fetch('/data/trend')).json();
        assert.equal(t.dimension, 'active');
        assert.equal(t.days, 365);
    });

    it('refuses an unknown dimension or range', async () => {
        assert.equal((await server.fetch('/data/trend?dimension=uuid')).status, 400);
        assert.equal((await server.fetch('/data/trend?dimension=node')).status, 400);
        assert.equal((await server.fetch('/data/trend?days=12')).status, 400);
        assert.equal((await server.fetch('/data/trend?days=abc')).status, 400);
    });
});

describe('startDaily', () => {
    it('runs the job at once and logs what it wrote', async () => {
        const db = await freshDb();
        await insertAt(db, 1, {created: '2026-09-20 10:00:00'});
        const logs = [];
        const stop = startDaily(db.raw, {log: (...a) => logs.push(a.join(' ')), now: () => NOW.getTime()});
        await new Promise((resolve) => setTimeout(resolve, 20));
        stop();
        assert.equal(logs.length, 1);
        assert.match(logs[0], /^daily \{"new":9,"backfilled":9,"snapshot":/);
        assert.doesNotMatch(logs[0], /00000000-/);
        await db.close();
    });

    it('logs a failure and keeps going', async () => {
        const db = await makeDb(); // not migrated: no daily_stats
        const logs = [];
        const stop = startDaily(db.raw, {log: (...a) => logs.push(a.join(' '))});
        await new Promise((resolve) => setTimeout(resolve, 20));
        stop();
        assert.match(logs[0], /^daily job failed:/);
        await db.close();
    });
});
