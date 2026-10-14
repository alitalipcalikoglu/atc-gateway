import { randomUUID } from 'node:crypto';

/**
 * @typedef {{ type: string, id: string }} AuditParty
 * @typedef {{ action: string, outcome?: 'success'|'failure'|'denied', actor?: AuditParty, target?: AuditParty, ip?: string, userAgent?: string, requestId?: string, meta?: object }} AuditEvent
 */

/**
 * Forwards audit events to atc-audit without slowing down or failing a request. The gateway keeps no
 * dependency on atc-service-core, so this is a trimmed copy of that package's buffered AuditClient:
 * `record()` fills a bounded in-memory buffer, a timer sends it in batches with backoff, a batch the
 * audit service rejects outright is dropped, and with no target every call is a no-op. A crash loses
 * the events still in the buffer (the access log has them too).
 */
export class AuditClient {
  static MAX_BUFFER = 5_000;
  static MAX_ATTEMPTS = 4;

  /**
   * @param {object} o
   * @param {{ url: string, apiKey: string }|null} o.target
   * @param {number} [o.flushMs] @param {number} [o.batchSize] @param {number} [o.timeoutMs]
   * @param {{ warn: (o: object, m?: string) => void, error: (o: object, m?: string) => void }} [o.logger]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {(ms: number) => Promise<void>} [o.sleep]
   */
  constructor({ target, flushMs = 2_000, batchSize = 200, timeoutMs = 5_000, logger = console, fetchImpl = fetch, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }) }) {
    this.target = target;
    this.flushMs = flushMs;
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    /** @type {(AuditEvent & { id: string, at: string })[]} */
    this.buffer = [];
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    this.flushing = false;
    this.stats = { recorded: 0, sent: 0, dropped: 0, failed: 0 };
  }

  get enabled() { return this.target !== null; }

  /** @param {AuditEvent} e */
  record(e) {
    if (!this.target) return false;
    if (this.buffer.length >= AuditClient.MAX_BUFFER) {
      this.buffer.shift();
      this.stats.dropped += 1;
    }
    this.buffer.push({ id: randomUUID(), at: new Date().toISOString(), ...e });
    this.stats.recorded += 1;
    return true;
  }

  start() {
    if (!this.target || this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushMs);
    this.timer.unref();
  }

  async flush() {
    if (!this.target || this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length) {
        const events = this.buffer.slice(0, this.batchSize);
        if (!(await this.#send(events))) return;
        this.buffer.splice(0, events.length);
      }
    } finally {
      this.flushing = false;
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** @param {object[]} events @returns {Promise<boolean>} true when accepted or dropped for good */
  async #send(events) {
    const target = /** @type {{ url: string, apiKey: string }} */ (this.target);
    for (let attempt = 0; attempt < AuditClient.MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.sleep(Math.min(10_000, 500 * 2 ** attempt));
      try {
        const res = await this.fetch(`${target.url}/v1/events/batch`, {
          method: 'POST',
          headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) { this.stats.sent += events.length; return true; }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.logger.error({ status: res.status, events: events.length }, 'audit batch rejected, dropping');
          this.stats.dropped += events.length;
          return true;
        }
      } catch (err) {
        if (attempt === AuditClient.MAX_ATTEMPTS - 1) this.logger.warn({ err: err instanceof Error ? err.message : String(err), events: events.length }, 'audit service unreachable, keeping events for the next flush');
      }
    }
    this.stats.failed += 1;
    return false;
  }

  /** Prometheus lines. @returns {string[]} */
  metricLines() {
    return [
      '# HELP audit_forward_enabled 1 when AUDIT_URL is configured and events are forwarded.', '# TYPE audit_forward_enabled gauge',
      `audit_forward_enabled ${this.enabled ? 1 : 0}`,
      '# HELP audit_forward_events_total Audit events by forwarding outcome (dropped = lost for good).', '# TYPE audit_forward_events_total counter',
      ...(/** @type {const} */ (['recorded', 'sent', 'dropped', 'failed'])).map((r) => `audit_forward_events_total{result="${r}"} ${this.stats[r]}`),
      '# HELP audit_forward_pending Audit events waiting to be delivered.', '# TYPE audit_forward_pending gauge',
      `audit_forward_pending ${this.buffer.length}`,
    ];
  }
}
