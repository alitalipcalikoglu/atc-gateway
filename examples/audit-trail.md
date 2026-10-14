# Audit trail

```bash
AUDIT_URL=http://audit.internal:3005
AUDIT_API_KEY=<a write-role key: AUDIT_API_KEYS=atc-gateway:...:write>
AUDIT_SAMPLE_SEC=10
```

The gateway answers 401, 413 and 429 on its own; without a trail those refusals exist only in the access log. With the audit service configured each one becomes an event:

| Action | Outcome | Meta |
|---|---|---|
| `atc-gateway.request.denied` | `denied` | `reason` (`unauthorized`: no or bad token; `rate_limited`: the per-IP limit of the route; `policy_limited` / `blocked`: the central ratelimit service; `too_large`: body over the limit), `status`, `suppressed` |
| `atc-gateway.routes.reload` | `success` / `failure` | `revision`, `routes`, or `error` for a rejected file |

The actor is the client IP (`type: ip`), the target the route (`type: route`), `userAgent` and `requestId` come from the request.

## Sampling

A scan can produce thousands of refusals a minute. One event is recorded per route, reason and client IP per window of `AUDIT_SAMPLE_SEC`; the first refusal after the window carries `suppressed`, the number left out. Use `0` to record every refusal (busy sites will want the default).

```bash
curl -s -H "Authorization: Bearer $AUDIT_READ" "$AUDIT/v1/events?source=atc-gateway&outcome=denied&limit=20"
```

atc-audit raises `ops.audit.denied_spike` when one source (here `atc-gateway`) stores many denied events in a short window, and atc-status turns that into an alert.

Pitfalls:
- Events are buffered in memory and sent in batches; a crash loses the last seconds of them. The access log has every refusal.
- The gateway needs the audit key before it can report; a wrong key shows as `audit_forward_events_total{result="dropped"}` on `/metrics`.
- Requests for a path no route matches (404) are not denials and are not recorded.
