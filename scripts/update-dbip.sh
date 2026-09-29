#!/bin/sh
# Downloads DB-IP's free "IP to Country Lite" database (CC BY 4.0, https://db-ip.com; no account needed) into the
# directory the server reads it from, as dbip-country-lite.csv.gz. DB-IP publishes it monthly; run this monthly,
# e.g. from the host's crontab on the 3rd:
#
#   0 5 3 * *  DBIP_CONTAINER=redmatic-telemetry /srv/redmatic-telemetry/update-dbip.sh /srv/redmatic-telemetry/geo
#
#   update-dbip.sh [directory]     default: $DBIP_DIR, else the current directory
#
# DBIP_CONTAINER   when set, the container that gets a SIGHUP afterwards (the server then reloads the file)
# DBIP_BASE_URL    where the files are (default https://download.db-ip.com/free)
#
# The current month's file is tried first, then the previous month's (the new one appears in the first days of a
# month). The file is checked (gzip, the CSV's first line, at least 1000 lines) before it replaces the old one.
set -eu

dir=${1:-${DBIP_DIR:-.}}
base=${DBIP_BASE_URL:-https://download.db-ip.com/free}
target="$dir/dbip-country-lite.csv.gz"

year=$(date -u +%Y)
month=$(date -u +%m)
month=${month#0}
current=$(printf '%04d-%02d' "$year" "$month")
if [ "$month" -eq 1 ]; then
    previous=$(printf '%04d-12' $((year - 1)))
else
    previous=$(printf '%04d-%02d' "$year" $((month - 1)))
fi

tmp=$(mktemp "$dir/.dbip-country-lite.XXXXXX")
trap 'rm -f "$tmp"' EXIT

got=
for ym in "$current" "$previous"; do
    if curl -fsSL --retry 3 --max-time 300 -o "$tmp" "$base/dbip-country-lite-$ym.csv.gz"; then
        got=$ym
        break
    fi
done
if [ -z "$got" ]; then
    echo "update-dbip: no file for $current or $previous at $base" >&2
    exit 1
fi

gzip -t "$tmp"
if ! gzip -dc "$tmp" | head -n 1 | grep -Eq '^[0-9a-fA-F.:]+,[0-9a-fA-F.:]+,[A-Z]{2}$'; then
    echo "update-dbip: dbip-country-lite-$got.csv.gz is not a DB-IP country CSV" >&2
    exit 1
fi
lines=$(gzip -dc "$tmp" | wc -l)
if [ "$lines" -lt 1000 ]; then
    echo "update-dbip: dbip-country-lite-$got.csv.gz has only $lines lines" >&2
    exit 1
fi

chmod 0644 "$tmp"
mv -f "$tmp" "$target"
trap - EXIT
echo "update-dbip: $target is dbip-country-lite-$got ($lines ranges)"

if [ -n "${DBIP_CONTAINER:-}" ]; then
    docker kill --signal HUP "$DBIP_CONTAINER" > /dev/null
    echo "update-dbip: sent SIGHUP to $DBIP_CONTAINER"
fi
