'use strict';

// The country of a client address, from DB-IP's free "IP to Country Lite" database (CC BY 4.0, https://db-ip.com;
// task 10). The file is the CSV as DB-IP publishes it, gzipped or not: `first,last,country code` per line, IPv4 and
// IPv6, sorted. Only the country is looked up; the address is never stored.

const fs = require('fs');
const net = require('net');
const zlib = require('zlib');

const UNKNOWN = {code: '-', country: '-'};
const names = new Intl.DisplayNames(['en'], {type: 'region'});

/** The English name of a country code, or the code when there is none. */
function countryName(code) {
    try {
        return names.of(code) || code;
    } catch {
        return code;
    }
}

function parseIPv4(address) {
    if (!net.isIPv4(address)) {
        return null;
    }
    return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

/** An IPv6 address as [upper 64 bits, lower 64 bits]. */
function parseIPv6(address) {
    if (!net.isIPv6(address)) {
        return null;
    }
    let text = address;
    // an embedded IPv4 address in the last 32 bits
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (v4) {
        const n = parseIPv4(v4[1]);
        text = text.slice(0, -v4[1].length) + (n >>> 16).toString(16) + ':' + (n & 0xffff).toString(16);
    }
    const [head, tail] = text.split('::');
    const a = head ? head.split(':') : [];
    const b = tail === undefined ? [] : tail ? tail.split(':') : [];
    const groups = tail === undefined ? a : [...a, ...new Array(8 - a.length - b.length).fill('0'), ...b];
    let hi = 0n;
    let lo = 0n;
    groups.forEach((group, i) => {
        const value = BigInt(parseInt(group, 16));
        if (i < 4) {
            hi = (hi << 16n) | value;
        } else {
            lo = (lo << 16n) | value;
        }
    });
    return [hi, lo];
}

/**
 * Reads the database into sorted typed arrays: about 20 MB for the 720 000 ranges of 2026, and a binary search per
 * lookup.
 */
function load(file) {
    let data = fs.readFileSync(file);
    if (data[0] === 0x1f && data[1] === 0x8b) {
        data = zlib.gunzipSync(data);
    }
    // an upper bound for the arrays: one range per line; filled in place, without an array of lines
    let lines = 1;
    for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, i + 1)) {
        lines += 1;
    }
    const codes = [];
    const codeIndex = new Map();
    const v4 = {start: new Uint32Array(lines), end: new Uint32Array(lines), code: new Uint16Array(lines)};
    const v6 = {
        startHi: new BigUint64Array(lines),
        startLo: new BigUint64Array(lines),
        endHi: new BigUint64Array(lines),
        endLo: new BigUint64Array(lines),
        code: new Uint16Array(lines),
    };
    let n4 = 0;
    let n6 = 0;
    const refuse = (line) => {
        throw new Error('not a DB-IP country CSV: ' + line.slice(0, 80));
    };
    for (let pos = 0; pos < data.length;) {
        let next = data.indexOf(10, pos);
        if (next === -1) {
            next = data.length;
        }
        const line = data.toString('latin1', pos, next).trim();
        pos = next + 1;
        if (!line) {
            continue;
        }
        const [first, last, cc] = line.split(',');
        if (!/^[A-Z]{2}$/.test(cc || '')) {
            refuse(line);
        }
        let c = codeIndex.get(cc);
        if (c === undefined) {
            c = codes.length;
            codes.push(cc);
            codeIndex.set(cc, c);
        }
        if (first.includes(':')) {
            const s = parseIPv6(first);
            const e = parseIPv6(last);
            if (!s || !e) {
                refuse(line);
            }
            [v6.startHi[n6], v6.startLo[n6]] = s;
            [v6.endHi[n6], v6.endLo[n6]] = e;
            v6.code[n6] = c;
            n6 += 1;
        } else {
            const s = parseIPv4(first);
            const e = parseIPv4(last);
            if (s === null || e === null) {
                refuse(line);
            }
            v4.start[n4] = s;
            v4.end[n4] = e;
            v4.code[n4] = c;
            n4 += 1;
        }
    }
    if (!n4 && !n6) {
        throw new Error('empty country database: ' + file);
    }
    const cut = (obj, n) => Object.fromEntries(Object.entries(obj).map(([k, a]) => [k, a.slice(0, n)]));
    return {codes, v4: cut(v4, n4), v6: cut(v6, n6), ranges: n4 + n6};
}

/** The index of the last range whose start is <= the address, or -1. */
function lastAtOrBelow(length, isAtOrBelow) {
    let lo = 0;
    let hi = length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (isAtOrBelow(mid)) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

function find(db, address) {
    const n4 = parseIPv4(address);
    if (n4 !== null) {
        const {start, end, code} = db.v4;
        const i = lastAtOrBelow(start.length, (k) => start[k] <= n4);
        return i >= 0 && end[i] >= n4 ? db.codes[code[i]] : null;
    }
    const n6 = parseIPv6(address);
    if (n6) {
        const [hi, lo] = n6;
        const {startHi, startLo, endHi, endLo, code} = db.v6;
        const i = lastAtOrBelow(startHi.length, (k) => startHi[k] < hi || (startHi[k] === hi && startLo[k] <= lo));
        if (i >= 0 && (endHi[i] > hi || (endHi[i] === hi && endLo[i] >= lo))) {
            return db.codes[code[i]];
        }
    }
    return null;
}

/**
 * The lookup the app uses: lookup(address) → {code, country}; '-' for an address DB-IP does not place (ZZ, private,
 * reserved) or that is not an address. reload() reads the file again (SIGHUP) and keeps the old data on an error.
 * Without a readable file at start, every lookup answers null and nothing is stored as the country.
 */
function countryLookup(file, log = () => {}) {
    let db = null;
    const reload = () => {
        try {
            db = load(file);
            log('country database:', db.ranges, 'ranges');
            return true;
        } catch (err) {
            log('country database not loaded:', err.message);
            return false;
        }
    };
    reload();
    return {
        lookup(address) {
            if (!db) {
                return null;
            }
            const cc = find(db, String(address || ''));
            return !cc || cc === 'ZZ' ? UNKNOWN : {code: cc, country: countryName(cc)};
        },
        reload,
        get loaded() {
            return Boolean(db);
        },
    };
}

module.exports = {countryLookup, countryName, load, parseIPv4, parseIPv6};
