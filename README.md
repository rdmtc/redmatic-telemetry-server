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

| Variable          | Default                               | Meaning                                                                                                       |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PORT`            | `8080`                                | HTTP port (plain HTTP: TLS is the reverse proxy's)                                                            |
| `DB_PATH`         | `redmatic.db` next to `server.js`     | the SQLite database; created with the schema when missing, migrated at start. The old name `DB` works as well |
| `IP2LOCATION_CSV` | `IP2LOCATION-LITE-DB1.CSV` next to it | the country database; without it no country is stored                                                         |
| `TRUST_PROXY`     | `loopback, linklocal, uniquelocal`    | which peers may set `X-Forwarded-For`: Express' `trust proxy`, a hop count or a list                          |
| `RATE_LIMIT`      | `10`                                  | telemetry POSTs per client address and hour, `0` turns it off                                                 |

Once a day (checked at start and every hour) the server writes the day's aggregate snapshot into `daily_stats`
([docs/api.md](docs/api.md#get-datatrenddimensiondimensiondaysdays)). The first run after the upgrade also
backfills an estimated active curve from the existing rows; it takes about a tenth of a second on a synthetic database of 40 000
installations.

The database's directory must be writable by the server (SQLite's WAL files live next to it). In the image the
country CSV is `/geo/IP2LOCATION-LITE-DB1.CSV`: baked in when the build context has the file, or mounted.
`compose.example.yaml` shows the volumes, `build-push.sh` builds and pushes the image as `latest` and the package
version. The container's `HEALTHCHECK` asks `/healthz`.

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

This site or product includes IP2Location LITE data available from https://lite.ip2location.com.

## License

MIT
