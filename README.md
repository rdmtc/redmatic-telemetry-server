# redmatic-telemetry-server

> Server for gathering usage statistics of [RedMatic](https://github.com/rdmtc/redmatic) installations.

This site or product includes IP2Location LITE data available from http://www.ip2location.com.

## Running it

The server is configured by the environment only:

| Variable          | Default                               | Meaning                                                                                                       |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PORT`            | `8080`                                | HTTP port (plain HTTP: TLS is the reverse proxy's)                                                            |
| `DB_PATH`         | `redmatic.db` next to `server.js`     | the SQLite database; created with the schema when missing, migrated at start. The old name `DB` works as well |
| `IP2LOCATION_CSV` | `IP2LOCATION-LITE-DB1.CSV` next to it | the country database; without it no country is stored                                                         |
| `TRUST_PROXY`     | `loopback, linklocal, uniquelocal`    | which peers may set `X-Forwarded-For`: Express' `trust proxy`, a hop count or a list                          |
| `RATE_LIMIT`      | `10`                                  | telemetry POSTs per client address and hour, `0` turns it off                                                 |

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
