'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {config} = require('../lib/config.js');

const root = path.join(__dirname, '..');

describe('configuration from the environment (task 5)', () => {
    it('has defaults that run without any variable', () => {
        const c = config({});
        assert.equal(c.port, 8080);
        assert.equal(c.dbPath, path.join(root, 'redmatic.db'));
        assert.equal(c.ip2locationCsv, path.join(root, 'IP2LOCATION-LITE-DB1.CSV'));
        assert.equal(c.trustProxy, 'loopback, linklocal, uniquelocal');
        assert.deepEqual(c.rateLimit, {limit: 10, windowMs: 3600000});
    });

    it('reads the variables', () => {
        const c = config({
            PORT: '9000',
            DB_PATH: '/data/t.db',
            IP2LOCATION_CSV: '/geo/x.csv',
            TRUST_PROXY: '1',
            RATE_LIMIT: '0',
        });
        assert.equal(c.port, 9000);
        assert.equal(c.dbPath, '/data/t.db');
        assert.equal(c.ip2locationCsv, '/geo/x.csv');
        assert.equal(c.trustProxy, 1);
        assert.equal(c.rateLimit, false);
        assert.equal(config({TRUST_PROXY: '172.16.0.0/12'}).trustProxy, '172.16.0.0/12');
    });

    it('keeps the old DB name working, DB_PATH first', () => {
        assert.equal(config({DB: '/old.db'}).dbPath, '/old.db');
        assert.equal(config({DB: '/old.db', DB_PATH: '/new.db'}).dbPath, '/new.db');
    });

    it('refuses a number that is not one', () => {
        assert.throws(() => config({PORT: 'eighty'}));
        assert.throws(() => config({RATE_LIMIT: '-1'}));
    });
});
