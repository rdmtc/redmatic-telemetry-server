# redmatic-telemetry-server

> Receives the usage statistics of [RedMatic](https://github.com/rdmtc/redmatic) installations and shows them at
> [telemetry.redmatic.de](https://telemetry.redmatic.de): "RedMatic Usage Statistics".

RedMatic sends, once at every start of the addon, its version, the CCU firmware's version, product and platform, the
openccu-lite version where there is one, and the installed npm modules, with the installation's random telemetry id.
The server keeps one row per installation and shows aggregates only.

- [docs/api.md](docs/api.md): the routes, what is sent and what is stored;
- [docs/data.md](docs/data.md): what is stored, who sees it, how to ask for deletion;
- [CHANGELOG.md](CHANGELOG.md).

## Running it

The server is configured by the environment only:

| Variable      | Default                               | Meaning                                                                                                       |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PORT`        | `8080`                                | HTTP port (plain HTTP: TLS is the reverse proxy's)                                                            |
| `DB_PATH`     | `redmatic.db` next to `server.js`     | the SQLite database; created with the schema when missing, migrated at start. The old name `DB` works as well |
| `DBIP_CSV`    | `dbip-country-lite.csv.gz` next to it | DB-IP's IP to Country Lite, gzipped or not; without it no country is stored; reloaded on `SIGHUP`             |
| `BACKUP_DIR`  | empty: no backups                     | the directory of the daily backups (a host volume)                                                            |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal`    | which peers may set `X-Forwarded-For`: Express' `trust proxy`, a hop count or a list                          |
| `RATE_LIMIT`  | `10`                                  | telemetry POSTs per client address and hour, `0` turns it off                                                 |

Once a day (checked at start and every hour) the server writes the day's aggregate snapshot into `daily_stats`
([docs/api.md](docs/api.md#get-datatrenddimensiondimensiondaysdays)). The first run after the upgrade also
backfills an estimated active curve from the existing rows; it takes about a tenth of a second on a synthetic database of 40 000
installations.

The database's directory must be writable by the server (SQLite's WAL files live next to it). In the image the
country database is `/geo/dbip-country-lite.csv.gz`: mounted (see below), or baked in when the build context has the
file. `compose.example.yaml` shows the volumes. The image is published to `ghcr.io/rdmtc/redmatic-telemetry-server` by
the `docker` workflow: `edge` and the short commit sha for every push to master, `latest`, `<version>` and
`<major>.<minor>` for a tag `v<version>` (amd64 and arm64). `build-push.sh` still builds and pushes by hand. The container's `HEALTHCHECK` asks `/healthz`.

The log has no ids, countries or addresses: routine requests are counted and logged once a minute
(`requests {"insert":3,"update":41}`), the daily job logs its counts, errors are logged in full.

## On the host

**Backups.** With `BACKUP_DIR` set (the image: mount a host directory at `/backup` and set `BACKUP_DIR=/backup`), the
daily job writes `redmatic-YYYYMMDD.db` there with `VACUUM INTO`: a complete, compact SQLite file, consistent while
the server writes. It keeps the newest 7 daily copies and the newest copy of each of the newest 8 weeks, and deletes
older ones (only files named like a copy). The directory must be writable by the container's uid. Copying them off
the host is up to you. To restore: stop the container, replace the database file with a copy (and remove the
`-wal`/`-shm` files beside it), start it.

**The country database.** [DB-IP](https://db-ip.com)'s free IP to Country Lite (CC BY 4.0, no account). The page
carries the attribution the licence asks for. It is published monthly;
`scripts/update-dbip.sh <dir>` downloads the current month's file (or the previous month's in the first days of a
month), checks it, replaces `<dir>/dbip-country-lite.csv.gz` and, with `DBIP_CONTAINER` set, sends the container a
`SIGHUP` so the server reloads it. A monthly cron line on the host:

```sh
0 5 3 * *  DBIP_CONTAINER=redmatic-telemetry /srv/redmatic-telemetry/update-dbip.sh /srv/redmatic-telemetry/geo
```

## Rate limit

The app allows 10 telemetry POSTs per client address and hour (`RATE_LIMIT`, `0` turns it off). nginx can add an
outer layer in front of it:

```nginx
# http {}: only POSTs count, the page (GET /) is not limited
map $request_method $telemetry_client {
    POST    $binary_remote_addr;
    default "";
}
limit_req_zone $telemetry_client zone=telemetry:10m rate=30r/h;

# server {}
location = / {
    limit_req zone=telemetry burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Development

Node.js 22.13 or newer.

```sh
npm ci
npm run lint    # ESLint and Prettier (npm run format rewrites)
npm test        # node:test; the app on port 0 with a temporary database
node scripts/synthetic-db.js dev.db 40000 15   # invented data, for the page
DB_PATH=dev.db npm start
```

Tests and development use invented data only, never a copy of the live database.

## Credits

[IP Geolocation by DB-IP](https://db-ip.com): the country database, DB-IP's IP to Country Lite, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## License

MIT
