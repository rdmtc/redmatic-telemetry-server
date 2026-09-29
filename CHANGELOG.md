# Changelog

## Unreleased

- **Security:** the raw database download (`/database`) is gone; an anonymised export (`/export.json`,
  `/export.csv`) of the page's aggregates replaces it.
- **Security:** the log upload (`POST /log`) and the log listing (`/logs`) are gone.
- Malformed requests answer `400`, database errors `500`; the process no longer dies on them. The id must be a
  whole UUID and is stored in lower case. Only the reverse proxy's `X-Forwarded-For` counts (`TRUST_PROXY`).
- The telemetry body is validated before anything is stored; 10 POSTs per address and hour (`RATE_LIMIT`). The page
  escapes every value.
- openccu-lite: `ccu.LITE` is stored; `/data` has `liteVersions`, `families` and `litePlatforms`, and the lite share of
  every CCU version; the page shows them.
- Node.js 22.13 or newer, `node:sqlite` instead of `sqlite3`, Express 5.
- Schema migrations (`schema/`), indexes, WAL; `/data` accepts only the page's timespans and is cached for five
  minutes.
- The image: multi-stage on `node:24-slim`, a `HEALTHCHECK` on `/healthz`, configuration by environment
  (`DB_PATH`, `IP2LOCATION_CSV`, `TRUST_PROXY`, `RATE_LIMIT`; `DB` still works).
- Tests, lint and CI.
