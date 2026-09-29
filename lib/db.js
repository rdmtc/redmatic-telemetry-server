'use strict';

const fs = require('fs');
const path = require('path');
const {DatabaseSync} = require('node:sqlite');

/**
 * A thin layer over node:sqlite: cached statements, plain row objects, undefined bound as NULL, and transactions
 * that roll back on an error. Synchronous: a transaction never interleaves with another request.
 */
function database(db) {
    const statements = new Map();
    const statement = (sql) => {
        let stmt = statements.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            statements.set(sql, stmt);
        }
        return stmt;
    };
    const bind = (params) => params.map((v) => (v === undefined ? null : v));
    let inTransaction = false;
    return {
        get: (sql, params = []) => {
            const row = statement(sql).get(...bind(params));
            return row && {...row};
        },
        all: (sql, params = []) =>
            statement(sql)
                .all(...bind(params))
                .map((row) => ({...row})),
        run: (sql, params = []) => statement(sql).run(...bind(params)),
        exec: (sql) => db.exec(sql),
        transaction(fn) {
            // nested: part of the enclosing transaction (a migration step that calls a function with its own)
            if (inTransaction) {
                return fn();
            }
            db.exec('BEGIN;');
            inTransaction = true;
            try {
                const result = fn();
                inTransaction = false;
                db.exec('COMMIT;');
                return result;
            } catch (err) {
                inTransaction = false;
                try {
                    db.exec('ROLLBACK;');
                } catch {
                    // the error that rolled it back is the one to report
                }
                throw err;
            }
        },
    };
}

/**
 * The schema migrations, applied in order and tracked in PRAGMA user_version. `applied` recognises a database that
 * already has a step without the version saying so: the live database (version 0) was changed by hand and has
 * 001's shape, and task 2's lite column may have been added before the migrations existed.
 */
const migrations = [
    {
        version: 1,
        file: '001-initial.sql',
        applied: (q) => q.all("SELECT name FROM sqlite_master WHERE type='table' AND name='installation';").length > 0,
    },
    {
        version: 2,
        file: '002-lite.sql',
        applied: (q) => q.all('PRAGMA table_info(installation);').some((c) => c.name === 'lite'),
    },
    {version: 3, file: '003-indexes.sql'},
    {version: 4, file: '004-daily-stats.sql'},
    {version: 5, file: '005-public-nodes.sql'},
    // task 12: the installations with a version that cannot exist, e.g. RedMatic 26.1.0 (lib/plausible.js)
    {version: 6, run: (q) => require('./plausible.js').removeImplausible(q)},
];

/**
 * Brings a database to the newest schema. Each step runs in its own transaction; returns the versions applied. A
 * step with `run` is JavaScript instead of a schema file; what it returns (counts, never an id) is logged.
 */
function migrate(db, {log = () => {}} = {}) {
    const q = database(db);
    const done = [];
    let current = q.get('PRAGMA user_version;').user_version;
    // a database from before the migrations: recognise what it already has
    const legacy = current === 0;
    for (const step of migrations) {
        if (step.version <= current) {
            continue;
        }
        const result = q.transaction(() => {
            let out;
            if (step.run) {
                out = step.run(q);
            } else if (!(legacy && step.applied && step.applied(q))) {
                q.exec(fs.readFileSync(path.join(__dirname, '..', 'schema', step.file)).toString());
            }
            q.exec('PRAGMA user_version = ' + step.version + ';');
            return out;
        });
        log('migration', step.version, result === undefined ? step.file : JSON.stringify(result));
        current = step.version;
        done.push(step.version);
    }
    return done;
}

/**
 * Opens the database file: WAL (a backup can read beside the server), a busy timeout, foreign keys, the schema.
 */
function open(file, {log} = {}) {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db, {log});
    return db;
}

module.exports = {database, migrate, migrations, open};
