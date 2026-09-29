'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const www = path.join(__dirname, '..', 'www');

describe('the page (task 8)', () => {
    const files = fs.readdirSync(www);
    const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(www, 'app.js'), 'utf8');

    it('loads nothing from another origin', () => {
        for (const m of html.matchAll(/<(script|link|img|iframe)\b[^>]*>/g)) {
            assert.doesNotMatch(m[0], /(src|href)="(https?:)?\/\//, m[0]);
        }
        assert.doesNotMatch(js, /\bimport\b.*from\s+['"]https?:/);
        assert.doesNotMatch(js, /fetch\(\s*['"]https?:/);
    });

    it('has no jQuery or flot left', () => {
        assert.deepEqual(
            files.filter((f) => /jquery|flot/i.test(f)),
            [],
        );
        assert.doesNotMatch(html, /node_modules|jquery|flot/i);
    });

    it('never inserts a value as HTML', () => {
        assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    });

    it('declares the language and the viewport', () => {
        assert.match(html, /<html lang="en">/);
        assert.match(html, /<meta name="viewport"/);
        assert.match(html, /<title>RedMatic Usage Statistics<\/title>/);
    });
});
