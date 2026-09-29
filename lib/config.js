'use strict';

const path = require('path');

const root = path.join(__dirname, '..');

/**
 * The configuration, from the environment only. The names before 2026 (DB) still work for one release, so a running
 * container keeps its settings.
 */
function config(env = process.env) {
    const int = (value, fallback) => {
        if (value === undefined || value === '') {
            return fallback;
        }
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
            throw new Error('not a non-negative integer: ' + value);
        }
        return n;
    };
    const trustProxy = env.TRUST_PROXY;
    const rateLimit = int(env.RATE_LIMIT, 10);
    return {
        port: int(env.PORT, 8080),
        dbPath: env.DB_PATH || env.DB || path.join(root, 'redmatic.db'),
        // DB-IP's IP to Country Lite, gzipped or not (scripts/update-dbip.sh)
        dbipCsv: env.DBIP_CSV || path.join(root, 'dbip-country-lite.csv.gz'),
        // the daily backups' directory; empty: no backups
        backupDir: env.BACKUP_DIR || '',
        // Express' "trust proxy": a hop count or a list of addresses/names
        trustProxy: !trustProxy
            ? 'loopback, linklocal, uniquelocal'
            : /^\d+$/.test(trustProxy)
              ? Number(trustProxy)
              : trustProxy,
        // telemetry POSTs per client address and hour; 0 turns the limit off
        rateLimit: rateLimit > 0 ? {limit: rateLimit, windowMs: 3600 * 1000} : false,
    };
}

module.exports = {config};
