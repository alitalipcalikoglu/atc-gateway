# Upstream failover

## Several upstreams per route

```json
{ "id": "web", "host": "shop.example.com", "pathPrefix": "/", "upstreams": ["http://10.0.0.10:8080", "http://10.0.0.11:8080"] }
```

Requests alternate between the two (round-robin) over keep-alive connections.

## When one goes away

1. The connection to `10.0.0.10` is refused or reset, or no headers arrive within the timeout.
2. That upstream is marked down for `UPSTREAM_COOLDOWN_MS` (default 10 s) and the failure is counted in `gateway_upstream_errors_total{route="web"}`.
3. If the request is `GET`, `HEAD` or `OPTIONS` **and** no request body has been sent, it is retried once on the next upstream. The client sees a normal `200`.
4. Otherwise the client gets `502 UPSTREAM_UNREACHABLE` (or `504 UPSTREAM_TIMEOUT`).

While in cooldown the upstream is skipped. When every upstream is down the gateway still tries one, so the client gets a truthful 502 rather than a guess; the first success clears the cooldown.

## Active health checks

Every `UPSTREAM_HEALTH_INTERVAL_MS` (default 5 s) the gateway calls each upstream's route `healthPath` (default `/health`). A failed check opens that upstream's breaker, so clients are steered away before any of their requests hit it; a passing check closes it again, so a repaired or restarted upstream rejoins within one interval without waiting for client traffic. Each transition logs `cause: "health-check"` and counts in `gateway_breaker_transitions_total`.

For a primary and a warm standby (see the stack README, "High availability"), list both and keep the standby's service stopped or failing `/ready`-style checks until promoted:

```json
{ "id": "auth-public", "pathPrefix": "/api/auth/", "upstreams": ["http://10.0.0.10:3002", "http://10.0.0.20:3002"], "healthPath": "/health" }
```

Pitfall: both upstreams of a SQLite-backed service must never accept writes at the same time. The standby runs only after promotion; until then its health check fails and it gets no traffic.

## Why POST is not retried

A `POST` may have reached the upstream before the connection dropped; sending it again could create a second order or a second user. Clients that need safe retries use idempotency keys at the application level (notify's `idempotencyKey`, for example).

## Watching it

```bash
curl -s $GW/ready
# {"status":"unavailable","upstreams":{"web":"1/2","files":"1/1"}}
```

```bash
curl -s $GW/metrics -H "Authorization: Bearer $METRICS_TOKEN" | grep upstream_errors
# gateway_upstream_errors_total{route="web"} 7
```

Access log line for a retried request shows the upstream that finally answered:

```json
{ "msg": "access", "route": "web", "method": "GET", "path": "/", "status": 200, "durationMs": 12.4, "upstream": "http://10.0.0.11:8080", "reqId": "…" }
```

## Tuning

| Setting | Effect |
|---|---|
| `UPSTREAM_COOLDOWN_MS` | How long a failed upstream is skipped. Shorter = faster recovery, more probing failures. |
| `UPSTREAM_HEALTH_INTERVAL_MS` | Active health check period; `0` leaves only the passive breaker. |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | Keep-alive socket idle timeout for the agents. |
| `UPSTREAM_TIMEOUT_MS` / `timeoutMs` | Header timeout; the failing upstream is also put in cooldown. |
