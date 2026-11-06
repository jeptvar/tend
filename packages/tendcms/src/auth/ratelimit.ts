export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const DEFAULT_MAX_KEYS = 10_000;

// Oldest-touched entries go first, so a flood of made-up keys can't use up memory.
function evictOldest<K, V>(map: Map<K, V>, maxKeys: number): void {
  while (map.size > maxKeys) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/** In-memory token buckets. Tend is a single process, so nothing has to be shared. */
export class TokenBuckets {
  readonly #capacity: number;
  readonly #msPerToken: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: {
    perMinute: number;
    maxKeys?: number;
    now?: () => number;
  }) {
    this.#capacity = options.perMinute;
    this.#msPerToken = 60_000 / options.perMinute;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#now = options.now ?? Date.now;
  }

  #current(key: string): { tokens: number; updatedAt: number } {
    const now = this.#now();
    const bucket = this.#buckets.get(key);
    const tokens = bucket
      ? Math.min(this.#capacity, bucket.tokens + (now - bucket.updatedAt) / this.#msPerToken)
      : this.#capacity;
    return { tokens, updatedAt: now };
  }

  #store(key: string, bucket: { tokens: number; updatedAt: number }): void {
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    evictOldest(this.#buckets, this.#maxKeys);
  }

  /** Spends a token up front, so a burst of parallel guesses can't all slip through. */
  take(key: string): LimitResult {
    const bucket = this.#current(key);
    if (bucket.tokens < 1) {
      this.#store(key, bucket);
      const seconds = Math.ceil(((1 - bucket.tokens) * this.#msPerToken) / 1000);
      return { allowed: false, retryAfterSeconds: seconds };
    }
    this.#store(key, { ...bucket, tokens: bucket.tokens - 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Gives a token back after a success: only wrong guesses should count. */
  refund(key: string): void {
    const bucket = this.#current(key);
    this.#store(key, { ...bucket, tokens: Math.min(this.#capacity, bucket.tokens + 1) });
  }
}

const BACKOFF_AFTER_FAILURES = 10;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
// Old failures stop counting, so one typo weeks after an attack doesn't cost an hour.
const BACKOFF_FORGET_AFTER_MS = 24 * 3_600_000;

/**
 * Slows repeated failures against one account from unknown devices: after 10, wait
 * 1 minute, doubling up to 1 hour. Devices that have signed in before skip this
 * (see device-cookie.ts), so an attacker can't lock the Owner out of their own laptop.
 */
export class AccountBackoff {
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #accounts = new Map<
    string,
    { failures: number; lockedUntil: number; lastFailureAt: number }
  >();

  constructor(options: { maxKeys?: number; now?: () => number } = {}) {
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#now = options.now ?? Date.now;
  }

  /** Seconds to wait, or 0 when an attempt is allowed. */
  retryAfterSeconds(key: string): number {
    const lockedUntil = this.#accounts.get(key)?.lockedUntil ?? 0;
    return Math.max(0, Math.ceil((lockedUntil - this.#now()) / 1000));
  }

  recordFailure(key: string): void {
    const now = this.#now();
    const previous = this.#accounts.get(key);
    const stale = previous && now - previous.lastFailureAt > BACKOFF_FORGET_AFTER_MS;
    const failures = (stale ? 0 : (previous?.failures ?? 0)) + 1;
    const doublings = failures - BACKOFF_AFTER_FAILURES;
    const lockedUntil =
      doublings >= 0
        ? now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(doublings, 12))
        : 0;
    this.#accounts.delete(key);
    this.#accounts.set(key, { failures, lockedUntil, lastFailureAt: now });
    evictOldest(this.#accounts, this.#maxKeys);
  }

  reset(key: string): void {
    this.#accounts.delete(key);
  }
}

/**
 * Limits how many password checks run at once. Each one holds about 19 MB for tens of
 * milliseconds, so an unlimited queue lets a flood delay every sign-in and exhaust a
 * small host's memory. Known devices get slots of their own, so a flood can't keep the
 * Owner out of their own laptop.
 */
export class WorkGate {
  readonly #limit: number;
  readonly #reserved: number;
  #running = 0;

  constructor(options: { limit: number; reservedForPriority: number }) {
    this.#limit = options.limit;
    this.#reserved = options.reservedForPriority;
  }

  tryEnter(priority: boolean): boolean {
    const limit = priority ? this.#limit + this.#reserved : this.#limit;
    if (this.#running >= limit) return false;
    this.#running++;
    return true;
  }

  leave(): void {
    this.#running--;
  }
}
