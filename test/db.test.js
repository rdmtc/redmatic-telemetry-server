'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {migrate, open} = require('../lib/db.js');
const {makeDb, uuid} = require('./helpers.js');

const indexes = ['installation_created', 'installation_updated', 'node_installation_uuid'];

async function shape(db) {
    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")).map(
        (r) => r.name,
    );
    const columns = (await db.all('PRAGMA table_info(installation);')).map((c) => c.name);
    const idx = (await db.all("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';")).map(
        (r) => r.name,
    );
    const version = (await db.get('PRAGMA user_version;')).user_version;
    return {tables, columns, idx, version};
}

describe('schema migrations (task 4)', () => {
    it('gives an empty file the full schema', async () => {
        const db = await makeDb();
        assert.deepEqual(migrate(db.raw), [1, 2, 3]);
        const s = await shape(db);
        assert.deepEqual(s.tables, ['installation', 'node']);
        assert.deepEqual(s.columns, [
            'uuid',
            'redmatic',
            'initial',
            'ccu',
            'platform',
            'product',
            'created',
            'updated',
            'counter',
            'cc',
            'country',
            'lite',
        ]);
        assert.deepEqual(s.idx.sort(), [...indexes].sort());
        assert.equal(s.version, 3);
        await db.close();
    });

    it('migrates a database in the live shape without losing rows', async () => {
        const db = await makeDb({legacy: true});
        for (let i = 1; i <= 50; i++) {
            await db.run(
                "INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, created, counter, cc, country) VALUES (?, '8.0.0', '7.0.0', '3.89.11', 'rpi4-aarch64', 'ccu3', CURRENT_TIMESTAMP, 0, 'DE', 'Germany');",
                [uuid(i)],
            );
            await db.run(
                "INSERT INTO node (name, version, installation_uuid) VALUES ('node-red-contrib-ccu', '3.5.0', ?);",
                [uuid(i)],
            );
        }
        assert.deepEqual(migrate(db.raw), [1, 2, 3]);
        const s = await shape(db);
        assert.ok(s.columns.includes('lite'));
        assert.deepEqual(s.idx.sort(), [...indexes].sort());
        assert.equal(s.version, 3);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM installation;')).n, 50);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM node;')).n, 50);
        assert.equal((await db.get('SELECT cc FROM installation WHERE uuid=?;', [uuid(7)])).cc, 'DE');
        await db.close();
    });

    it('recognises a lite column added before the migrations', async () => {
        const db = await makeDb({legacy: true});
        await db.exec('ALTER TABLE installation ADD COLUMN lite VARCHAR (32);');
        assert.deepEqual(migrate(db.raw), [1, 2, 3]);
        assert.equal((await shape(db)).version, 3);
        await db.close();
    });

    it('is idempotent', async () => {
        const db = await makeDb();
        migrate(db.raw);
        assert.deepEqual(migrate(db.raw), []);
        assert.equal((await shape(db)).version, 3);
        await db.close();
    });

    it('opens a file in WAL mode with the schema', async () => {
        const db = await makeDb();
        const file = db.file;
        await db.close();
        const opened = open(file);
        assert.equal(opened.prepare('PRAGMA journal_mode;').get().journal_mode, 'wal');
        assert.equal(opened.prepare('PRAGMA user_version;').get().user_version, 3);
        opened.close();
        fs.rmSync(db.dir, {recursive: true, force: true});
    });
});
