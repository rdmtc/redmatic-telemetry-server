'use strict';

// Task 10: the country lookup (DB-IP), its update script, the backups, the log without ids, /healthz.

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {execFileSync} = require('child_process');
const {DatabaseSync} = require('node:sqlite');

const {countryLookup, parseIPv6} = require('../lib/geo.js');
const {backup, rotate, isoWeek, fileName} = require('../lib/backup.js');
const {tally, startDaily} = require('../server.js');
const {migrate} = require('../lib/db.js');
const {startServer, postTelemetry, telemetryBody, insertInstallation, makeDb} = require('./helpers.js');

const fixture = path.join(__dirname, 'fixtures', 'dbip-country.csv');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rts-ops-'));

describe('country lookup from DB-IP (task 10)', () => {
    const geo = countryLookup(fixture);

    it('finds IPv4 and IPv6 ranges, with the English name', () => {
        assert.deepEqual(geo.lookup('192.0.2.10'), {code: 'DE', country: 'Germany'});
        assert.deepEqual(geo.lookup('198.51.100.255'), {code: 'AT', country: 'Austria'});
        assert.deepEqual(geo.lookup('2001:db8::1'), {code: 'CH', country: 'Switzerland'});
        assert.deepEqual(geo.lookup('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'), {code: 'CH', country: 'Switzerland'});
        // a range smaller than a /64
        assert.deepEqual(geo.lookup('2001:db9::ff'), {code: 'NL', country: 'Netherlands'});
        assert.deepEqual(geo.lookup('2001:db9::100'), {code: '-', country: '-'});
    });

    it('answers "-" for ZZ, unknown and malformed addresses', () => {
        for (const address of ['10.1.2.3', '203.0.113.1', '127.0.0.1', '::1', '', 'garbage', '999.1.1.1', undefined]) {
            assert.deepEqual(geo.lookup(address), {code: '-', country: '-'}, String(address));
        }
    });

    it('parses IPv6 with an embedded IPv4 address', () => {
        assert.deepEqual(parseIPv6('::ffff:192.0.2.1'), [0n, 0xffffc0000201n]);
        assert.deepEqual(parseIPv6('2001:db8::'), [0x20010db800000000n, 0n]);
        assert.equal(parseIPv6('192.0.2.1'), null);
    });

    it('reads the gzipped file as DB-IP publishes it', () => {
        const dir = tmpdir();
        const file = path.join(dir, 'dbip-country-lite.csv.gz');
        fs.writeFileSync(file, zlib.gzipSync(fs.readFileSync(fixture)));
        assert.deepEqual(countryLookup(file).lookup('192.0.2.1').code, 'DE');
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('without a file: no country, and the reason in the log', () => {
        const logs = [];
        const none = countryLookup('/nonexistent/dbip.csv.gz', (...a) => logs.push(a.join(' ')));
        assert.equal(none.loaded, false);
        assert.equal(none.lookup('192.0.2.1'), null);
        assert.match(logs[0], /^country database not loaded:/);
    });

    it('reloads the file, and keeps the old data when the new file is broken', () => {
        const dir = tmpdir();
        const file = path.join(dir, 'dbip.csv');
        fs.copyFileSync(fixture, file);
        const g = countryLookup(file);
        fs.writeFileSync(file, '192.0.2.0,192.0.2.255,FR\n');
        assert.equal(g.reload(), true);
        assert.equal(g.lookup('192.0.2.1').code, 'FR');
        fs.writeFileSync(file, '<html>not found</html>\n');
        assert.equal(g.reload(), false);
        assert.equal(g.lookup('192.0.2.1').code, 'FR');
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('stores the country of a POST', async () => {
        const server = await startServer();
        await postTelemetry(server, 1, telemetryBody(), {'X-Forwarded-For': '2001:db8::7'});
        const row = await server.db.get('SELECT cc, country FROM installation;');
        assert.deepEqual(row, {cc: 'CH', country: 'Switzerland'});
        await server.close();
    });
});

describe('scripts/update-dbip.sh (task 10)', () => {
    const script = path.join(__dirname, '..', 'scripts', 'update-dbip.sh');
    const month = (offset) => {
        const d = new Date();
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() + offset);
        return d.toISOString().slice(0, 7);
    };
    const csv = (lines) =>
        zlib.gzipSync(Array.from({length: lines}, (_, i) => `10.0.${i >> 8}.${i & 255},10.0.0.0,DE`).join('\n') + '\n');
    const run = (source, target) =>
        execFileSync('sh', [script, target], {env: {...process.env, DBIP_BASE_URL: 'file://' + source}}).toString();

    it("takes the current month's file", () => {
        const source = tmpdir();
        const target = tmpdir();
        fs.writeFileSync(path.join(source, `dbip-country-lite-${month(0)}.csv.gz`), csv(1200));
        assert.match(run(source, target), new RegExp(`is dbip-country-lite-${month(0)} \\(1200 ranges\\)`));
        assert.ok(fs.existsSync(path.join(target, 'dbip-country-lite.csv.gz')));
        assert.deepEqual(
            fs.readdirSync(target).filter((f) => f.startsWith('.')),
            [],
        );
        fs.rmSync(source, {recursive: true, force: true});
        fs.rmSync(target, {recursive: true, force: true});
    });

    it("falls back to the previous month's, and refuses a broken file without touching the old one", () => {
        const source = tmpdir();
        const target = tmpdir();
        fs.writeFileSync(path.join(source, `dbip-country-lite-${month(-1)}.csv.gz`), csv(1000));
        assert.match(run(source, target), new RegExp(`dbip-country-lite-${month(-1)}`));
        const before = fs.readFileSync(path.join(target, 'dbip-country-lite.csv.gz'));
        fs.writeFileSync(path.join(source, `dbip-country-lite-${month(0)}.csv.gz`), zlib.gzipSync('<html>\n'));
        assert.throws(() => run(source, target));
        fs.writeFileSync(path.join(source, `dbip-country-lite-${month(0)}.csv.gz`), csv(10));
        assert.throws(() => run(source, target));
        assert.deepEqual(fs.readFileSync(path.join(target, 'dbip-country-lite.csv.gz')), before);
        assert.deepEqual(fs.readdirSync(target), ['dbip-country-lite.csv.gz']);
        fs.rmSync(source, {recursive: true, force: true});
        fs.rmSync(target, {recursive: true, force: true});
    });
});

describe('backups (task 10)', () => {
    it('a backup of a synthetic database opens and has the same row counts', () => {
        const dir = tmpdir();
        const file = path.join(dir, 'syn.db');
        execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'synthetic-db.js'), file, '500', '10']);
        const db = new DatabaseSync(file);
        db.exec('PRAGMA journal_mode = WAL;');
        // a write that is still in the WAL
        db.exec("UPDATE installation SET redmatic = '9.0.0' WHERE rowid <= 10;");
        const counts = (d) =>
            ['installation', 'node', 'daily_stats'].map((t) => d.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n);
        const out = path.join(dir, 'backup');
        fs.mkdirSync(out);
        const copy = backup(db, out, new Date('2026-09-29T00:10:00Z'));
        assert.equal(path.basename(copy), 'redmatic-20260929.db');
        // once a day
        assert.equal(backup(db, out, new Date('2026-09-29T13:00:00Z')), null);
        const restored = new DatabaseSync(copy, {readOnly: true});
        assert.deepEqual(counts(restored), counts(db));
        assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM installation WHERE redmatic = '9.0.0'").get().n, 10);
        assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        restored.close();
        db.close();
        assert.deepEqual(fs.readdirSync(out), ['redmatic-20260929.db']);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('keeps 7 daily and 8 weekly copies, and nothing else is touched', () => {
        const dir = tmpdir();
        // 120 days of copies, up to 2026-09-29 (a Tuesday), and two other files
        const names = [];
        for (let i = 0; i < 120; i++) {
            const d = new Date(Date.UTC(2026, 8, 29 - i));
            const name = 'redmatic-' + d.toISOString().slice(0, 10).replace(/-/g, '') + '.db';
            names.push(name);
            fs.writeFileSync(path.join(dir, name), '');
        }
        fs.writeFileSync(path.join(dir, 'notes.txt'), '');
        fs.writeFileSync(path.join(dir, 'redmatic.db'), '');
        const deleted = rotate(dir);
        const left = fs.readdirSync(dir).sort();
        assert.deepEqual(left, [
            'notes.txt',
            // the newest of each of the newest 8 weeks: the Sundays (this week's and last week's are daily copies)
            'redmatic-20260816.db',
            'redmatic-20260823.db',
            'redmatic-20260830.db',
            'redmatic-20260906.db',
            'redmatic-20260913.db',
            'redmatic-20260920.db',
            // the newest 7 days
            'redmatic-20260923.db',
            'redmatic-20260924.db',
            'redmatic-20260925.db',
            'redmatic-20260926.db',
            'redmatic-20260927.db',
            'redmatic-20260928.db',
            'redmatic-20260929.db',
            'redmatic.db',
        ]);
        assert.equal(deleted.length, 120 - 13);
        assert.deepEqual(rotate(dir), []);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('knows the ISO week', () => {
        assert.equal(isoWeek(new Date('2026-09-29T00:00:00Z')), '2026-W40');
        assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
        assert.equal(isoWeek(new Date('2024-12-30T00:00:00Z')), '2025-W01');
    });

    it('runs in the daily job, before the retention, and logs no id', async () => {
        const db = await makeDb();
        migrate(db.raw);
        await insertInstallation(db, 1, {created: '-900 day'});
        const out = path.join(db.dir, 'backup');
        fs.mkdirSync(out);
        const logs = [];
        const name = fileName(new Date());
        const stop = startDaily(db.raw, {log: (...a) => logs.push(a.join(' ')), backupDir: out});
        await new Promise((resolve) => setTimeout(resolve, 50));
        stop();
        assert.deepEqual(fs.readdirSync(out), [name]);
        // the copy still has the installation the retention then deleted
        const copy = new DatabaseSync(path.join(out, name), {readOnly: true});
        assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM installation').get().n, 1);
        copy.close();
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM installation;')).n, 0);
        const line = logs.find((l) => l.startsWith('backup '));
        assert.equal(line.replace(/"size":\d+/, '"size":1'), `backup {"file":"${name}","size":1,"removed":0}`);
        assert.ok(logs.every((l) => !l.includes('00000000-')));
        await db.close();
    });

    it('logs a failed backup and still runs the retention', async () => {
        const db = await makeDb();
        migrate(db.raw);
        await insertInstallation(db, 1, {created: '-900 day'});
        const logs = [];
        const stop = startDaily(db.raw, {log: (...a) => logs.push(a.join(' ')), backupDir: '/nonexistent/backup'});
        await new Promise((resolve) => setTimeout(resolve, 50));
        stop();
        assert.ok(logs.some((l) => l.startsWith('backup failed:')));
        assert.ok(logs.some((l) => l.startsWith('retention ')));
        await db.close();
    });
});

describe('the log: counts, no ids (task 10)', () => {
    it('tallies routine events into one line a minute', () => {
        const logs = [];
        const count = tally((...a) => logs.push(a.join(' ')), 60000);
        count('insert');
        count('update');
        count('update');
        count.flush();
        count.flush();
        count.stop();
        assert.deepEqual(logs, ['requests {"insert":1,"update":2}']);
    });

    it('logs no id, country or address for POSTs', async () => {
        const server = await startServer();
        await postTelemetry(server, 1, telemetryBody(), {'X-Forwarded-For': '192.0.2.10'});
        await postTelemetry(server, 1, telemetryBody(), {'X-Forwarded-For': '192.0.2.10'});
        await postTelemetry(server, 2, {redmatic: 1});
        assert.deepEqual(server.logs, []);
        server.flush();
        assert.deepEqual(server.logs, ['requests {"insert":1,"update":1,"invalid":1}']);
        await server.close();
    });
});

describe('GET /healthz (task 10)', () => {
    it('answers 500 when the database does not', async () => {
        const server = await startServer();
        assert.equal((await server.fetch('/healthz')).status, 200);
        server.db.raw.close();
        assert.equal((await server.fetch('/healthz')).status, 500);
        await server.close();
    });
});
