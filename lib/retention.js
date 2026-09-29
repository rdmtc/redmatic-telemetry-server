'use strict';

// The retention (task 9, maintainer 2026-09-29): an installation not seen for 24 months is deleted with its modules.
// Its counts stay in the daily snapshots (task 11), which the daily job writes before this runs.

const RETENTION_MONTHS = 24;

const sqlTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

// last contact before the cut-off; a row without any timestamp is left alone
const expired =
    '(updated IS NOT NULL AND updated < DATETIME(?, ?)) OR (updated IS NULL AND created IS NOT NULL AND created < DATETIME(?, ?))';

/**
 * Deletes the installations whose last contact is older than RETENTION_MONTHS, and their node rows. Returns the
 * counts, never an id.
 */
function applyRetention(q, now = new Date()) {
    const at = sqlTime(now);
    const months = '-' + RETENTION_MONTHS + ' months';
    const params = [at, months, at, months];
    return q.transaction(() => {
        const nodes = q.run(
            'DELETE FROM node WHERE installation_uuid IN (SELECT uuid FROM installation WHERE ' + expired + ');',
            params,
        ).changes;
        const installations = q.run('DELETE FROM installation WHERE ' + expired + ';', params).changes;
        return {installations: Number(installations), nodes: Number(nodes)};
    });
}

/**
 * Deletes one installation and its modules (DELETE /, on the installation's request). Returns whether there was one.
 */
function deleteInstallation(q, uuid) {
    return q.transaction(() => {
        q.run('DELETE FROM node WHERE installation_uuid=?;', [uuid]);
        return Number(q.run('DELETE FROM installation WHERE uuid=?;', [uuid]).changes) > 0;
    });
}

module.exports = {RETENTION_MONTHS, applyRetention, deleteInstallation};
