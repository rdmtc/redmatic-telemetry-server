'use strict';

// Obviously wrong telemetry (task 12): versions that cannot exist. Conservative on purpose: only what is provably
// wrong is refused or deleted. A version missing from the known list is kept as long as it is plausible, so a new
// release is accepted before the list is regenerated, and an unlisted build (a dev build, a community patch) stays.

const known = require('../data/redmatic-versions.json');

// x.y.z with an optional prerelease and build part, as every RedMatic tag since 0.0.3-9
const semverPattern = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(-[0-9A-Za-z.-]{1,40})?(\+[0-9A-Za-z.-]{1,40})?$/;
// the CCU firmware's VERSION: 3.89.11, or OpenCCU's 3.89.11.20260919
const ccuPattern = /^(\d{1,2})\.(\d{1,3})\.(\d{1,5})(\.\d{8})?$/;
// CCU2 (2.x) and CCU3/OpenCCU (3.x); one major above that is accepted for a future firmware
const CCU_MAJORS = {min: 2, max: 4};

const major = (version) => Number(String(version).split('.')[0]);

/**
 * The known RedMatic versions and the highest plausible major (the newest known one + 1), from a versions list in
 * data/redmatic-versions.json's shape.
 */
function redmaticRules(list = known) {
    const versions = new Set(list.releases || []);
    for (const group of list.community || []) {
        for (const version of group.versions) {
            versions.add(version);
        }
    }
    const newestMajor = Math.max(...[...versions].filter((v) => semverPattern.test(v)).map(major));
    return {versions, maxMajor: newestMajor + 1};
}

const defaultRules = redmaticRules();

/**
 * Whether a RedMatic version can exist: a known version, or a semver whose major is at most one above the newest
 * known one. 26.1.0 cannot; 9.11.0 and 10.0.0 can, before the list knows them.
 */
function plausibleRedmatic(version, rules = defaultRules) {
    if (typeof version !== 'string') {
        return false;
    }
    if (rules.versions.has(version)) {
        return true;
    }
    return semverPattern.test(version) && major(version) <= rules.maxMajor;
}

/**
 * Whether a CCU firmware version can exist. Missing is fine: old RedMatic versions sent no ccu block.
 */
function plausibleCcu(version) {
    if (version === undefined || version === null || version === '') {
        return true;
    }
    const m = ccuPattern.exec(String(version));
    return Boolean(m) && Number(m[1]) >= CCU_MAJORS.min && Number(m[1]) <= CCU_MAJORS.max;
}

/** Whether an installation's stored fields ({redmatic, ccu}) are plausible. */
function plausible(fields, rules = defaultRules) {
    return plausibleRedmatic(fields.redmatic, rules) && plausibleCcu(fields.ccu);
}

/**
 * Deletes the installations with an impossible RedMatic or CCU version, and their modules. A row without a RedMatic
 * version is left alone: it is not wrong, only old. Returns the counts and the values removed (versions, never an
 * id): {installations, nodes, redmatic: {value: n}, ccu: {value: n}}.
 */
function removeImplausible(q, rules = defaultRules) {
    const checks = {
        redmatic: (v) => v === null || plausibleRedmatic(v, rules),
        ccu: plausibleCcu,
    };
    return q.transaction(() => {
        const result = {installations: 0, nodes: 0, redmatic: {}, ccu: {}};
        // one column after the other, so a row wrong in both is counted once
        for (const [column, ok] of Object.entries(checks)) {
            const rows = q.all(
                'SELECT ' + column + ' AS value, COUNT(*) AS n FROM installation GROUP BY ' + column + ';',
            );
            for (const {value, n} of rows.filter((row) => !ok(row.value))) {
                result[column][String(value)] = n;
                result.nodes += Number(
                    q.run(
                        'DELETE FROM node WHERE installation_uuid IN (SELECT uuid FROM installation WHERE ' +
                            column +
                            ' = ?);',
                        [value],
                    ).changes,
                );
                result.installations += Number(
                    q.run('DELETE FROM installation WHERE ' + column + ' = ?;', [value]).changes,
                );
            }
        }
        return result;
    });
}

module.exports = {plausible, plausibleRedmatic, plausibleCcu, redmaticRules, removeImplausible, CCU_MAJORS};
