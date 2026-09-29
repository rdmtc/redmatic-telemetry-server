'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('docs (task 7)', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'docs', 'api.md'), 'utf8');

    // every app.get/post/… route: a string or an array of strings
    const routes = [];
    for (const m of server.matchAll(/app\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*')/g)) {
        const method = m[1].toUpperCase();
        for (const r of m[2].matchAll(/'([^']*)'/g)) {
            routes.push(method + ' ' + r[1]);
        }
    }

    it('finds the routes', () => {
        assert.ok(routes.includes('POST /'));
        assert.ok(routes.includes('GET /data'));
    });

    it('names every route in docs/api.md', () => {
        for (const route of routes) {
            assert.ok(api.includes('`' + route), route + ' is not in docs/api.md');
        }
    });

    it('lists every environment variable in the README', () => {
        const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
        const config = fs.readFileSync(path.join(root, 'lib', 'config.js'), 'utf8');
        const names = [...config.matchAll(/env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]).filter((n) => n !== 'DB');
        assert.ok(names.length >= 5);
        for (const name of new Set(names)) {
            assert.ok(readme.includes('`' + name + '`'), name + ' is not in the README');
        }
    });
});
