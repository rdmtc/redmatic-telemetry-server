#!/usr/bin/env node
'use strict';

// Writes a synthetic telemetry database for development, the page and benchmarks: invented ids, versions and
// modules only, never data from the server.
//
//   node scripts/synthetic-db.js <file> [installations=40000] [modules per installation=15]

const fs = require('fs');
const {open} = require('../lib/db.js');

const [file, count = '40000', modules = '15'] = process.argv.slice(2);
if (!file) {
    console.error('usage: synthetic-db.js <file> [installations] [modules]');
    process.exit(1);
}
fs.rmSync(file, {force: true});
const db = open(file);

// a small deterministic generator, so two runs give the same database
let seed = 42;
const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};
const pick = (list) => {
    // weighted towards the start of the list
    const i = Math.floor(Math.pow(random(), 2) * list.length);
    return list[i];
};

const redmatic = ['8.0.0', '7.4.0', '7.3.2', '7.2.1', '7.0.0', '6.2.0', '5.4.1', '4.3.0', '8.1.0-beta.2'];
const ccu = ['3.89.11', '3.87.6', '3.85.7', '3.83.6', '3.79.6', '3.75.7', '3.71.12', '3.61.7', '3.55.10', '2.61.7'];
const products = [
    ['ccu3', 'ccu3-armv7l'],
    ['raspmatic_rpi4', 'rpi4-aarch64'],
    ['raspmatic_rpi3', 'rpi3-armv7l'],
    ['rpi4', 'rpi4-aarch64'],
    ['raspmatic_ova', 'ova-x86_64'],
    ['pivccu3', 'lxc-aarch64'],
    ['lite-rpi4', 'rpi4-aarch64'],
    ['raspmatic_oci_amd64', 'oci-x86_64'],
    ['lite-ova', 'ova-x86_64'],
    ['rpi5', 'rpi5-aarch64'],
    ['', ''],
    ['raspmatic_tinkerboard', 'tinkerboard-armv7l'],
];
const lite = ['1.0.0-dev.31', '1.0.0-dev.30', '1.0.0-beta.0', '1.0.0-dev.28'];
const countries = [
    ['DE', 'Germany'],
    ['AT', 'Austria'],
    ['CH', 'Switzerland'],
    ['NL', 'Netherlands'],
    ['-', '-'],
    ['FR', 'France'],
    ['IT', 'Italy'],
    ['PL', 'Poland'],
];
const nodes = [];
for (let i = 0; i < 120; i++) {
    nodes.push((i % 3 === 0 ? 'redmatic-module-' : 'node-red-contrib-example-') + i);
}

const insertInstallation = db.prepare(
    "INSERT INTO installation (uuid, redmatic, initial, ccu, platform, product, lite, created, updated, counter, cc, country) VALUES (?,?,?,?,?,?,?,DATETIME('now', ?),DATETIME('now', ?),?,?,?);",
);
const insertNode = db.prepare('INSERT INTO node (name, version, installation_uuid) VALUES (?,?,?);');

db.exec('BEGIN;');
for (let i = 0; i < Number(count); i++) {
    const id = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
    const [product, platform] = pick(products);
    const createdDays = Math.floor(random() * 2500);
    const updatedDays = Math.floor(random() * createdDays);
    const [cc, country] = pick(countries);
    const version = pick(redmatic);
    insertInstallation.run(
        id,
        version,
        version,
        pick(ccu),
        platform,
        product,
        product.startsWith('lite-') ? pick(lite) : null,
        '-' + createdDays + ' day',
        '-' + updatedDays + ' day',
        Math.floor(random() * 100),
        cc,
        country,
    );
    const own = new Set();
    for (let m = 0; m < Number(modules); m++) {
        own.add(pick(nodes));
    }
    own.add('my-private-module-' + i);
    for (const name of own) {
        insertNode.run(name, '1.' + Math.floor(random() * 10) + '.0', id);
    }
}
db.exec('COMMIT;');
db.close();
console.log('wrote', file);
