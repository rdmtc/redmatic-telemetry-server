# redmatic-telemetry-server

> Server for gathering usage statistics of [RedMatic](https://github.com/rdmtc/redmatic) installations.

This site or product includes IP2Location LITE data available from http://www.ip2location.com.

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
