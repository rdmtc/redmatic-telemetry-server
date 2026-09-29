# What is stored, and who sees it

## What arrives

RedMatic sends its telemetry once at every start of the addon (`bin/redmatic` `Start`), when the installation has a
telemetry id: a random UUID created at the first start, in `/etc/config/rdmtc.uuid` on a CCU and OpenCCU, in the
addon's own `var/` on openccu-lite. The request carries the id, the RedMatic, Node.js and CCU firmware versions, the
product and platform, openccu-lite's version where there is one, and the name and version of every installed npm
module. [docs/api.md](api.md) lists the fields.

## What is stored

Per installation (`installation`):

- the telemetry id;
- the RedMatic version (the current one and the first one seen), the CCU firmware version, product and platform,
  openccu-lite's version;
- the country (code and name), looked up from the client address at the time of the request in DB-IP's IP to
  Country Lite database, on the server itself (no request goes elsewhere). **The address itself is
  not stored**, and it is not in the logs;
- the time of the first and of the last contact, and a counter of contacts.

Per installed public module (`node`: `redmatic-*`, `node-red-*`, `@scope/node-red-*`): its name and version, for
the installation. Every contact replaces them. Other modules (private or self-written ones) are not stored.

Per day (`daily_stats`): counts only, no ids: how many installations were active (first or last seen
in the 180 days before), how many were new, and the active ones per RedMatic version, CCU version, firmware family,
openccu-lite version, platform and country. A value with fewer than 5 installations is counted as `(other)`, so no
single installation shows. These counts are kept when installation rows are deleted.

Not stored: the address, `deviceTypes`, the Node.js and Node-RED versions.

The server's log has no ids, no addresses and no countries: counts of the requests once a minute, the daily job's
counts, and errors.

## Who sees what

- **The page and `/data`:** aggregates only: counts per version, product, platform, country, openccu-lite version and
  public module (`redmatic-*`, `node-red-*`), and new installations per day.
- **The history** (`/data/trend`): the daily counts above.
- **The export** (`/export.json`, `/export.csv`): the same aggregates, for every timespan. No ids, no
  per-installation rows.
- **Nobody** gets the database over HTTP. The raw download at `/database` was removed; copies of the database are
  the server operator's backups.

## How long

- **An installation not seen for 24 months** is deleted with its modules, once a day. So the page's "all" view
  covers the installations seen in the last two years. The daily counts (`daily_stats`) keep them as counts, without
  the id. The server logs how many rows it deleted, never which.
- **Modules:** only public ones are stored (`redmatic-*`, `node-red-*`, `@scope/node-red-*`), the ones the page
  shows. The modules of other names that older versions of the server stored were deleted once (schema migration 5).
- **Obviously wrong entries:** an installation that reports a version that cannot exist (a RedMatic version more
  than one major above the newest release, such as `26.1.0`, or a CCU version outside `2.x`–`4.x`) is refused, and
  such rows already stored were deleted (schema migration 6); the daily job deletes any left. The log names the
  versions and the counts, never an id.
- **The daily counts** are kept.
- **Backups:** a copy of the database a day, on the server's host, kept 7 days, and one a week kept 8 weeks. A
  deleted installation is gone from the last copy 8 weeks later.

## Deletion

RedMatic deletes its installation when you turn the telemetry off (`DELETE /`, see [api.md](api.md#delete-)). By
hand, with the id from `/etc/config/rdmtc.uuid` (a CCU, OpenCCU) or the addon's `var/` id file (openccu-lite):

```sh
curl -X DELETE -H "X-RedMatic-uuid: <your id>" https://telemetry.redmatic.de/
```

Or ask the maintainer (Sebastian Raff, see the RedMatic repository) with your telemetry id: the content of
`/etc/config/rdmtc.uuid` (a CCU, OpenCCU) or of the addon's `var/` id file (openccu-lite).
