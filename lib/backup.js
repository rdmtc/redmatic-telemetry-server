'use strict';

// The daily backup (task 10): VACUUM INTO a file of its own in BACKUP_DIR (a host volume), consistent while the
// server writes (WAL), compact, and a plain SQLite file to restore. Kept: the newest 7 daily copies, and the newest
// copy of each of the newest 8 weeks.

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 7;
const KEEP_WEEKS = 8;
const pattern = /^redmatic-(\d{4})(\d{2})(\d{2})\.db$/;

const fileName = (date) => 'redmatic-' + date.toISOString().slice(0, 10).replace(/-/g, '') + '.db';

/**
 * Writes today's copy, unless it exists. Returns its path, or null when there was one. The copy is written under a
 * temporary name and renamed, so a file with the final name is always complete.
 */
function backup(db, dir, now = new Date()) {
    const file = path.join(dir, fileName(now));
    if (fs.existsSync(file)) {
        return null;
    }
    const tmp = path.join(dir, '.' + fileName(now) + '.tmp');
    fs.rmSync(tmp, {force: true});
    try {
        db.prepare('VACUUM INTO ?;').run(tmp);
        fs.renameSync(tmp, file);
    } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw err;
    }
    return file;
}

/** The ISO week of a UTC date, as 'YYYY-Www'. */
function isoWeek(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const year = d.getUTCFullYear();
    const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return year + '-W' + String(week).padStart(2, '0');
}

/**
 * Deletes the copies beyond the newest KEEP_DAYS and the newest copy of each of the newest KEEP_WEEKS weeks. Only
 * files named like a copy are touched. Returns the names deleted.
 */
function rotate(dir) {
    const copies = fs
        .readdirSync(dir)
        .map((name) => {
            const m = pattern.exec(name);
            return m && {name, date: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))};
        })
        .filter(Boolean)
        .sort((a, b) => b.date - a.date);
    const keep = new Set(copies.slice(0, KEEP_DAYS).map((c) => c.name));
    const weeks = new Set();
    for (const copy of copies) {
        const week = isoWeek(copy.date);
        if (!weeks.has(week) && weeks.size < KEEP_WEEKS) {
            weeks.add(week);
            keep.add(copy.name);
        }
    }
    const deleted = [];
    for (const copy of copies) {
        if (!keep.has(copy.name)) {
            fs.rmSync(path.join(dir, copy.name), {force: true});
            deleted.push(copy.name);
        }
    }
    return deleted;
}

module.exports = {KEEP_DAYS, KEEP_WEEKS, backup, rotate, isoWeek, fileName};
