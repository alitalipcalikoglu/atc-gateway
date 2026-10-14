/**
 * What the edge refused, as audit events: `atc-gateway.request.denied` (401, 413, 429 and blocked clients)
 * and `atc-gateway.routes.reload`. A scan or a broken client can produce thousands of refusals a minute, so
 * denials are sampled: one event per (route, reason, client IP) per window, and the next event of that
 * key says how many were left out (`suppressed`). The access log and the metrics still count every one.
 */
export class DenialAudit {
  static MAX_KEYS = 10_000;

  /**
   * @param {import('./audit-client.js').AuditClient} client
   * @param {{ sampleSec: number, now?: () => number }} o  sampleSec 0 = no sampling
   */
  constructor(client, { sampleSec, now = Date.now }) {
    this.client = client;
    this.windowMs = sampleSec * 1000;
    this.now = now;
    /** @type {Map<string, { at: number, left: number }>} */
    this.seen = new Map();
  }

  /**
   * @param {'unauthorized'|'rate_limited'|'policy_limited'|'blocked'|'too_large'} reason
   * @param {{ ip: string, id: unknown, headers: Record<string, unknown> }} request
   * @param {{ id: string }|null} route
   * @param {number} status
   */
  denied(reason, request, route, status) {
    if (!this.client.enabled) return;
    const key = `${route?.id ?? '-'}|${reason}|${request.ip}`;
    const now = this.now();
    const prev = this.seen.get(key);
    if (prev && now - prev.at < this.windowMs) { prev.left += 1; return; }
    if (this.seen.size >= DenialAudit.MAX_KEYS) this.seen.delete(/** @type {string} */ (this.seen.keys().next().value));
    this.seen.set(key, { at: now, left: 0 });
    const ua = request.headers['user-agent'];
    this.client.record({
      action: 'atc-gateway.request.denied',
      outcome: 'denied',
      actor: { type: 'ip', id: request.ip },
      target: route ? { type: 'route', id: route.id } : undefined,
      ip: request.ip,
      userAgent: typeof ua === 'string' ? ua.slice(0, 512) : undefined,
      requestId: String(request.id),
      meta: { reason, status, suppressed: prev?.left ?? 0 },
    });
  }

  /** @param {boolean} ok @param {{ revision?: string, routes?: number, error?: string }} detail */
  reload(ok, detail) {
    if (!this.client.enabled) return;
    this.client.record({ action: 'atc-gateway.routes.reload', outcome: ok ? 'success' : 'failure', target: { type: 'config', id: 'routes' }, meta: detail });
  }
}
