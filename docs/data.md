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
- the country (code and name), looked up from the client address at the time of the request. **The address itself is
  not stored**, and it is not in the logs;
- the time of the first and of the last contact, and a counter of contacts.

Per installed module (`node`): its name and version, for the installation. Every contact replaces them.

Not stored: the address, `deviceTypes`, the Node.js and Node-RED versions.

The server's log has no ids and no addresses: one line per insert or update with the country code, and errors.

## Who sees what

- **The page and `/data`:** aggregates only: counts per version, product, platform, country, openccu-lite version and
  public module (`redmatic-*`, `node-red-*`), and new installations per day.
- **The export** (`/export.json`, `/export.csv`): the same aggregates, for every timespan. No ids, no
  per-installation rows.
- **Nobody** gets the database over HTTP. The raw download at `/database` was removed; copies of the database are
  the server operator's backups.

## How long

The rows are kept until the retention (not yet in effect) removes them; the page's "all" view covers every row.

## Deletion

Ask the maintainer (Sebastian Raff, see the RedMatic repository) with your telemetry id: the content of
`/etc/config/rdmtc.uuid` (a CCU, OpenCCU) or of the addon's `var/` id file (openccu-lite).
