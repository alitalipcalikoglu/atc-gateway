# Public route with an injected service key

Scenario: your single-page app calls auth directly for login and registration, but auth only accepts backend API keys. The gateway adds the key.

## Route

```json
{ "id": "auth-public", "pathPrefix": "/api/auth/", "stripPrefix": "/api/auth",
  "upstreams": ["http://10.0.0.2:3002"], "methods": ["POST", "OPTIONS"],
  "injectApiKey": "AUTH_API_KEY", "cors": ["https://shop.example.com"], "rateLimit": 60, "bodyLimit": 16384 }
```

`.env` on the gateway host:

```
AUTH_API_KEY=<the secret of the "atc-gateway" entry in auth's AUTH_API_KEYS>
```

## From the browser

```js
const res = await fetch('https://api.example.com/api/auth/v1/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const { tokens } = await res.json();
```

What auth receives:

```
POST /v1/auth/login
Authorization: Bearer <AUTH_API_KEY>        ← added by the gateway; whatever the browser sent is dropped
X-Client-IP: 203.0.113.9                    ← real client address, spoof-proof
X-Client-User-Agent: Mozilla/5.0 …
X-Forwarded-For: 203.0.113.9
X-Forwarded-Proto: https
X-Forwarded-Host: api.example.com
X-Request-Id: 2b1c…
Via: 1.1 atc-gateway
```

auth stores `X-Client-IP` in its audit log and shows it in password-reset mails; because the gateway overwrites the header, a client cannot forge it.

## Keep it narrow

A public route with an injected key hands that key's power to anyone. Limit the blast radius:

- `methods`: only what the flow needs (`POST`, plus `OPTIONS` for CORS).
- `rateLimit`: login and registration are brute-force targets; 60/min per IP is generous.
- `bodyLimit`: login bodies are tiny.
- Use a **dedicated** key (`gateway:…`) so rotating it does not affect other callers.
- Do not expose administrative paths this way. `GET /api/auth/v1/users` on the route above answers `405` because `GET` is not listed; a separate route for admin traffic should use `auth: "user"` and an upstream that checks `X-User-*`.

## Error responses you will see

| Status | Source | Meaning |
|---|---|---|
| 405 `METHOD_NOT_ALLOWED` | gateway | method not in the route's list |
| 413 `TOO_LARGE` | gateway | body over `bodyLimit` |
| 429 `RATE_LIMITED` | gateway | per-IP limit hit, `Retry-After` set |
| 401 / 423 / 409 … | auth | passed through unchanged |

## Read-only: translation bundles for a browser app

The same pattern serves published strings from `atc-content` without giving the browser a key. Only `/v1/bundles/` is behind the prefix, so nothing else of the content service is reachable, and the injected key has the `read` role only.

```json
{ "id": "content-bundles", "pathPrefix": "/api/content/v1/bundles/", "stripPrefix": "/api/content",
  "upstreams": ["http://10.0.0.13:3013"], "methods": ["GET", "HEAD", "OPTIONS"],
  "injectApiKey": "CONTENT_API_KEY", "cors": ["*"], "rateLimit": 600,
  "policy": { "name": "public-content", "subject": "ip", "failOpen": true } }
```

```
CONTENT_API_KEY=<the secret of the "atc-gateway" entry in content's CONTENT_API_KEYS, role read>
```

```js
const res = await fetch('https://api.example.com/api/content/v1/bundles/web/tr-CY', { headers: etag ? { 'if-none-match': etag } : {} });
if (res.status === 304) return cached;
const { strings, release } = await res.json();
```

`ETag` and `Cache-Control: public, max-age=60` from the content service pass through unchanged, so browsers and CDNs revalidate with `304`. Create the `public-content` policy in the ratelimit service before deploying the route (a missing policy counts as unavailable; with `failOpen: true` requests still pass). The local stack generates this route without a policy, relying on the per-IP `rateLimit`.
