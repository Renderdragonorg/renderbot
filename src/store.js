import { randomBytes } from 'node:crypto';

/**
 * Short-lived, in-memory store that lets a Refresh button re-run the original
 * request. Entries expire; nothing is persisted to disk.
 */
export class ContextStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref?.();
  }

  put(context) {
    const id = randomBytes(6).toString('hex');
    this.entries.set(id, { ...context, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  sweep() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(id);
    }
  }
}
