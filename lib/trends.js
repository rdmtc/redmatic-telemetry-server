'use strict';

// Daily aggregate snapshots (task 11): the history the installation table cannot keep, because it holds only the
// latest state of each installation. Counts only, never an id.

const {familyExpression} = require('./stats.js');

const DAY = 86400000;
// "active": seen (first or last contact) in this many days before the snapshot (maintainer, 2026-09-29)
const ACTIVE_DAYS = 180;
// values with fewer installations than this are summed into OTHER, so a single installation cannot be singled out
const MIN_COUNT = 5;
const OTHER = '(other)';

// the dimensions /data/trend serves; the first two have the one value ''
const DIMENSIONS = ['active', 'new', 'redmatic', 'ccu', 'family', 'lite', 'platform', 'country'];

/** 'YYYY-MM-DD' of a Date, in UTC (the database's timestamps are UTC). */
const isoDay = (date) => date.toISOString().slice(0, 10);
/** 'YYYY-MM-DD HH:MM:SS' in UTC: CURRENT_TIMESTAMP's format, so it compares as text with created/updated. */
const sqlTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const dayNumber = (day) => Math.floor(Date.parse(day + 'T00:00:00Z') / DAY);
const dayString = (n) => isoDay(new Date(n * DAY));

const majorMinor = (v) => {
    const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? m[1] + '.' + m[2] : String(v || '');
};

/**
 * The counts per value of the active installations for one snapshot: { dimension: Map(value → count) }.
 */
function activeCounts(q, now) {
    const since = sqlTime(new Date(now.getTime() - ACTIVE_DAYS * DAY));
    const rows = q.all(
        'SELECT redmatic, ccu, lite, platform, cc, ' +
            familyExpression +
            ' AS family FROM installation WHERE created > ? OR updated > ?;',
        [since, since],
    );
    const counts = {redmatic: new Map(), ccu: new Map(), family: new Map(), lite: new Map(), platform: new Map()};
    counts.country = new Map();
    const add = (dimension, value) => {
        const key = value === null || value === undefined ? '' : String(value);
        counts[dimension].set(key, (counts[dimension].get(key) || 0) + 1);
    };
    for (const row of rows) {
        add('redmatic', row.redmatic);
        add('ccu', majorMinor(row.ccu));
        add('family', row.family);
        if (row.lite) {
            add('lite', row.lite);
        }
        add('platform', row.platform);
        add('country', row.cc);
    }
    return {total: rows.length, counts};
}

/** Values below MIN_COUNT go into OTHER. */
function withOther(map) {
    const out = [];
    let other = 0;
    for (const [value, count] of map) {
        if (count < MIN_COUNT || value === OTHER) {
            other += count;
        } else {
            out.push([value, count]);
        }
    }
    if (other) {
        out.push([OTHER, other]);
    }
    return out;
}

/**
 * Takes today's snapshot, unless there is one. Returns the number of rows written (0: there was one).
 */
function snapshot(q, now) {
    const date = isoDay(now);
    if (q.get("SELECT 1 AS x FROM daily_stats WHERE dimension='active' AND date=? AND estimated=0;", [date])) {
        return 0;
    }
    const {total, counts} = activeCounts(q, now);
    const insert = (dimension, value, count, estimated = 0) =>
        q.run('INSERT OR REPLACE INTO daily_stats (dimension, date, value, count, estimated) VALUES (?,?,?,?,?);', [
            dimension,
            date,
            value,
            count,
            estimated,
        ]);
    let written = 0;
    insert('active', '', total);
    written += 1;
    for (const [dimension, map] of Object.entries(counts)) {
        for (const [value, count] of withOther(map)) {
            insert(dimension, value, count);
            written += 1;
        }
    }
    return written;
}

/**
 * The new installations per complete day (up to yesterday) that are not recorded yet, zeros included: exact, as
 * long as the installations are still there (the retention keeps 24 months; this runs daily).
 */
function recordNew(q, now) {
    const today = dayNumber(isoDay(now));
    const last = q.get("SELECT MAX(date) AS date FROM daily_stats WHERE dimension='new';").date;
    let from;
    if (last) {
        from = dayNumber(last) + 1;
    } else {
        const first = q.get('SELECT MIN(created) AS created FROM installation;').created;
        if (!first) {
            return 0;
        }
        from = dayNumber(first.slice(0, 10));
    }
    if (from >= today) {
        return 0;
    }
    const perDay = new Map(
        q
            .all(
                'SELECT date(created) AS day, COUNT(*) AS count FROM installation WHERE created >= ? AND created < ? GROUP BY day;',
                [dayString(from), dayString(today)],
            )
            .map((r) => [r.day, r.count]),
    );
    for (let d = from; d < today; d++) {
        const day = dayString(d);
        q.run("INSERT OR REPLACE INTO daily_stats (dimension, date, value, count) VALUES ('new', ?, '', ?);", [
            day,
            perDay.get(day) || 0,
        ]);
    }
    return today - from;
}

/**
 * The rough active curve before the first snapshot (maintainer, 2026-09-29): an installation counts as active from
 * the day it was first seen until ACTIVE_DAYS after it was last seen. It overcounts installations that were silent
 * for a long time in between, which the table cannot tell. Runs once, while there is no active row at all; the rows
 * are marked estimated.
 */
function backfillActive(q, now) {
    if (q.get("SELECT 1 AS x FROM daily_stats WHERE dimension='active' LIMIT 1;")) {
        return 0;
    }
    const today = dayNumber(isoDay(now));
    const rows = q.all(
        'SELECT date(created) AS first, date(COALESCE(updated, created)) AS last FROM installation WHERE created IS NOT NULL;',
    );
    if (!rows.length) {
        return 0;
    }
    const start = rows.reduce((min, r) => Math.min(min, dayNumber(r.first)), Infinity);
    if (start >= today) {
        return 0;
    }
    const diff = new Array(today - start + 1).fill(0);
    for (const r of rows) {
        const from = dayNumber(r.first) - start;
        const until = Math.max(dayNumber(r.last), dayNumber(r.first)) + ACTIVE_DAYS - start;
        if (from < diff.length) {
            diff[from] += 1;
            if (until < diff.length) {
                diff[until] -= 1;
            }
        }
    }
    let active = 0;
    for (let d = 0; d < today - start; d++) {
        active += diff[d];
        q.run(
            "INSERT OR REPLACE INTO daily_stats (dimension, date, value, count, estimated) VALUES ('active', ?, '', ?, 1);",
            [dayString(start + d), active],
        );
    }
    return today - start;
}

/**
 * The daily job: new installations per day, the backfill on the first run, today's snapshot. Idempotent: run it
 * as often as you like, it writes each day once.
 */
function daily(q, now = new Date()) {
    return q.transaction(() => ({
        new: recordNew(q, now),
        backfilled: backfillActive(q, now),
        snapshot: snapshot(q, now),
    }));
}

/**
 * The history of one dimension over the last `days` days: {dimension, days, dates, estimated, series, snapshotsSince}.
 * `series` is [[value, [count per date]]], sorted by the latest count; a value missing on a date counts 0.
 */
function trend(q, dimension, days, now = new Date()) {
    const since = isoDay(new Date(now.getTime() - days * DAY));
    const rows = q.all(
        'SELECT date, value, count, estimated FROM daily_stats WHERE dimension=? AND date > ? ORDER BY date;',
        [dimension, since],
    );
    const dates = [...new Set(rows.map((r) => r.date))];
    const index = new Map(dates.map((d, i) => [d, i]));
    const estimated = dates.map(() => 0);
    const series = new Map();
    for (const r of rows) {
        const i = index.get(r.date);
        if (r.estimated) {
            estimated[i] = 1;
        }
        if (!series.has(r.value)) {
            series.set(
                r.value,
                dates.map(() => 0),
            );
        }
        series.get(r.value)[i] = r.count;
    }
    const last = dates.length - 1;
    const first = q.get("SELECT MIN(date) AS date FROM daily_stats WHERE dimension='active' AND estimated=0;").date;
    return {
        dimension,
        days,
        dates,
        estimated,
        series: [...series].sort((a, b) => (a[0] === OTHER) - (b[0] === OTHER) || b[1][last] - a[1][last]),
        snapshotsSince: first || null,
    };
}

module.exports = {
    ACTIVE_DAYS,
    MIN_COUNT,
    OTHER,
    DIMENSIONS,
    daily,
    snapshot,
    recordNew,
    backfillActive,
    trend,
    isoDay,
    sqlTime,
};
