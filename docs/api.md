# API

All routes are served by `server.js` on `PORT` (plain HTTP, behind a reverse proxy that terminates TLS).

## `POST /`

The telemetry of one installation. RedMatic sends it once at every start of the addon.

Headers:

- `Content-Type: application/json`
- `User-Agent: curl/…` (RedMatic sends with curl; anything else is refused)
- `X-RedMatic-uuid: <id>`: the installation's telemetry id, a UUID (`8-4-4-4-12` hex digits, stored in lower case)

Body (the output of RedMatic's `bin/redmaticVersions`):

```json
{
  "ccu": {
    "VERSION": "3.89.11",
    "PRODUCT": "lite-rpi4",
    "PLATFORM": "rpi4-aarch64",
    "LITE": "1.0.0",
    "deviceTypes": ["HmIP-BSM"]
  },
  "redmatic": "9.10.0",
  "nodejs": "24.10.0",
  "node-red": "4.1.0",
  "node-red-contrib-ccu": "3.5.0"
}
```

| Field                               | Stored as              | Rule                                                                                                                                                           |
| ----------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redmatic`                          | `redmatic` (`initial`) | required, version-like: `^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$`                                                                                                  |
| `ccu.VERSION`                       | `ccu`                  | may be missing or empty, else version-like                                                                                                                     |
| `ccu.PRODUCT`                       | `product`              | may be missing or empty, else `^[A-Za-z0-9_.+-]{1,40}$`                                                                                                        |
| `ccu.PLATFORM`                      | `platform`             | as `PRODUCT`; the bare 2019 names `rpi0`, `rpi3`, `rpi4`, `tinkerboard`, `ova` get an architecture                                                             |
| `ccu.LITE`                          | `lite`                 | openccu-lite's version (RedMatic 18 on): `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`, ≤ 32, else NULL                                                                   |
| `ccu.deviceTypes`                   | —                      | dropped                                                                                                                                                        |
| `nodejs`, `node-red`, `npm`, `ain2` | —                      | dropped                                                                                                                                                        |
| every other key                     | a `node` row           | an installed npm module and its version; at most 500. A key that is not an npm package name, or a version that is not a string of ≤ 64 characters, is left out |

The country comes from the client address (`req.ip`, see `TRUST_PROXY`); the address itself is not stored.

Answers: `200` stored (a new installation or an update of a known one); `400` a missing or wrong header, or a body
that breaks a rule (nothing is stored); `413` a body over 64 kB; `429` more than `RATE_LIMIT` POSTs from the address
in the hour; `500` a database error. The client ignores the answer.

## `GET /data?timespan=<days>`

The aggregates the page shows, over the installations first **or** last seen in the timespan. `timespan` is one of
`1`, `7`, `30`, `90`, `365`, `36500` (all; also when it is missing); anything else answers `400`. Cached for five
minutes (`Cache-Control: max-age=300`).

```json
{
  "total": 11699,
  "versions": [
    ["9.10.0", 812],
    ["…", 0]
  ],
  "ccuVersions": [["3.89.11", 1543, 12]],
  "platforms": [["rpi4-aarch64", 2231]],
  "products": [["ccu3", 3620]],
  "countries": [["DE", "Germany", 8123]],
  "nodes": [["node-red-contrib-ccu", 9876]],
  "liteVersions": [["1.0.0", 12]],
  "families": [
    ["ccu3", 3620],
    ["openccu", 5000],
    ["pivccu3", 300],
    ["lite", 12],
    ["other", 2767]
  ],
  "litePlatforms": [["rpi4-aarch64", 8]],
  "byday": [[1790150400000, 31]]
}
```

- Each list is `[value, count]`, sorted by count, versions newest first. `ccuVersions` has a third number: how many
  of them are openccu-lite (a lite system reports its OpenCCU base version).
- `nodes`: only `redmatic-*` and `node-red-*` modules.
- `families`: `ccu3`, `openccu` (RaspberryMatic/OpenCCU), `pivccu3`, `lite` (openccu-lite), `other`; derived from the
  product and the lite version when queried.
- `byday`: new installations per day (per hour for 7 days and less), `[epoch ms, count]`.

## `GET /data/trend?dimension=<dimension>&days=<days>`

The history of the page: the server takes a snapshot of the aggregates once a day (the first run after 00:00 UTC,
checked hourly). **Active** means first or last seen in the 180 days before the snapshot.

- `dimension`: `active` (the default: the active installations), `new` (new installations per day, exact), or the
  active installations per `redmatic` version, `ccu` version (major.minor), `family`, `lite` version, `platform` or
  `country` (code). Values with fewer than 5 installations on a day are summed into `(other)`.
- `days`: `30`, `90`, `180`, `365` (the default), `730`, `1825` or `36500` (all). Anything else answers `400`.

```json
{
  "dimension": "redmatic",
  "days": 365,
  "dates": ["2026-09-29", "2026-09-30"],
  "estimated": [0, 0],
  "series": [
    ["9.10.0", [812, 815]],
    ["(other)", [40, 41]]
  ],
  "snapshotsSince": "2026-09-29"
}
```

- `dates`: the days with a snapshot (UTC), oldest first; a day the server did not run is missing.
- `series`: `[value, [count per date]]`, sorted by the latest count, `(other)` last; a value missing on a day
  counts 0.
- `estimated`: `1` for a day before the first snapshot. Only `active` has such days: a rough curve backfilled once
  from the first and last contact of each installation (an installation counts from its first contact until 180 days
  after its last). It overcounts installations that were silent in between.
- `snapshotsSince`: the day of the first real snapshot, `null` before it.

Cached like `/data`.

## `GET /export.json`, `GET /export.csv`

The anonymised export: the `/data` aggregates for every timespan, with no ids and no per-installation rows. JSON:
`{generated, description, timespans: {"1": <data>, "7": …, "365": …, "all": …}}`. CSV: one line per
`timespan,dimension,value,count`, the dimensions `total`, `redmatic`, `ccu`, `platform`, `product`, `node`, `lite`,
`lite-platform`, `family`, `country` and `new` (per day). Cached like `/data`.

## `GET /total.svg`

The `installs` badge in RedMatic's README: the number of installations ever recorded (`999`, `1.0k`, `12k`).
Cached for an hour.

## `GET /healthz`

For the container's `HEALTHCHECK`: `200 {"db":"ok","version":"<package version>"}` while the database answers,
`500` otherwise.

## `GET /`

The page, `www/`.

## Removed

- `GET /database` (the raw database file) answers `404` since B-1: it held every installation's id.
- `POST /log` and `/logs/…` (the log upload of RedMatic's `redmatic-logupload`) answer `404`.
