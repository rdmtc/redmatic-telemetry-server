#!/bin/sh
# Regenerates data/redmatic-versions.json from the release and prerelease tags of github.com/rdmtc/RedMatic.
# The "community" list of the existing file (versions published outside that repository) is kept as it is.
#
#   scripts/update-redmatic-versions.sh [repository URL]
set -eu

repo=${1:-https://github.com/rdmtc/RedMatic}
dir=$(cd "$(dirname "$0")/.." && pwd)
file="$dir/data/redmatic-versions.json"
tags=$(mktemp)
trap 'rm -f "$tags"' EXIT

git ls-remote --tags "$repo" > "$tags"
if [ ! -s "$tags" ]; then
    echo "no tags from $repo" >&2
    exit 1
fi

node - "$file" "$tags" "$repo" <<'JS'
'use strict';
const fs = require('fs');
const [file, tagsFile, repo] = process.argv.slice(2);
const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const versions = new Set();
for (const line of fs.readFileSync(tagsFile, 'utf8').split('\n')) {
    const m = /refs\/tags\/v?(\d+\.\d+\.\d+[^^\s]*)(\^\{\})?$/.exec(line);
    if (m) {
        versions.add(m[1]);
    }
}
const parse = (v) => {
    const [main, ...pre] = v.split('+')[0].split('-');
    return {nums: main.split('.').map(Number), pre: pre.join('-')};
};
const compare = (a, b) => {
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) {
        if (x.nums[i] !== y.nums[i]) {
            return x.nums[i] - y.nums[i];
        }
    }
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return x.pre.localeCompare(y.pre, 'en', {numeric: true});
};
const out = {
    description: previous.description,
    source: repo,
    updated: new Date().toISOString().slice(0, 10),
    releases: [...versions].sort(compare),
    community: previous.community || [],
};
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(file + ': ' + out.releases.length + ' releases, newest ' + out.releases[out.releases.length - 1]);
JS
