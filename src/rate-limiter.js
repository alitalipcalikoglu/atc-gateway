/**
 * In-memory fixed-window rate limiter keyed by client. Windows are one minute; counters are
 * swept lazily; the table is also capped (MAX_BUCKETS) so a flood of distinct addresses cannot grow
 * memory without bound between sweeps: when full, expired entries are dropped first, then the oldest.
 */
export class RateLimiter {
  static WINDOW_MS = 60_000;
  static MAX_BUCKETS = 100_000;

  constructor() {
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.buckets = new Map();
    this.lastSweep = 0;
  }

  /**
   * @param {string} key
   * @param {number} max
   * @param {number} [now]
   * @returns {{ allowed: boolean, remaining: number, resetAt: number, retryAfterSec: number }}
   */
  hit(key, max, now = Date.now()) {
    this.#sweep(now);
    let b = this.buckets.get(key);
    if (!b && this.buckets.size >= RateLimiter.MAX_BUCKETS) this.#evict(now);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + RateLimiter.WINDOW_MS };
      this.buckets.set(key, b);
    }
    b.count += 1;
    const allowed = b.count <= max;
    return { allowed, remaining: Math.max(0, max - b.count), resetAt: b.resetAt, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }

  /** Make room: expired buckets first; if everything is live, the oldest insertions go (Map keeps insertion order). @param {number} now */
  #evict(now) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    for (const k of this.buckets.keys()) {
      if (this.buckets.size < RateLimiter.MAX_BUCKETS * 0.9) break;
      this.buckets.delete(k);
    }
  }

  /** @param {number} now */
  #sweep(now) {
    if (now - this.lastSweep < RateLimiter.WINDOW_MS) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }

  get size() {
    return this.buckets.size;
  }
}
