import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ version: 1, updatedAt: new Date().toISOString(), users: {}, daily: {} });

/**
 * Tiny JSON-file-backed store for users and daily usage.
 *
 * Shape:
 * {
 *   "version": 1,
 *   "updatedAt": "2026-09-14T21:00:00.000Z",
 *   "users": { "<userId>": { username, firstSeenAt, lastSeenAt, totalChecks } },
 *   "daily": { "2026-09-14": { "<userId>": 3 } }
 * }
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt
 * the file. The bot is single-process, so no locking is required.
 */
export class JsonStore {
  #pruned = false;

  constructor(filePath, { retentionDays = 30, pretty = true } = {}) {
    this.filePath = filePath;
    this.pretty = pretty;
    this.retentionDays = retentionDays;
    this.data = this.#load();
    this.#prune();
    if (this.#pruned) this.#save();
  }

  #load() {
    if (this.filePath === ':memory:') return EMPTY();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return EMPTY();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        version: 1,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
        daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {},
      };
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
      console.error(`[db] ${this.filePath} was unreadable (${error.message}); moved to ${backup} and started fresh.`);
      return EMPTY();
    }
  }

  #prune() {
    this.#pruned = false;
    if (!Number.isFinite(this.retentionDays) || this.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const date of Object.keys(this.data.daily)) {
      if (date < cutoff) {
        delete this.data.daily[date];
        this.#pruned = true;
      }
    }
  }

  #save() {
    if (this.filePath === ':memory:') return;
    this.data.updatedAt = new Date().toISOString();
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, this.pretty ? 2 : 0));
    fs.renameSync(tmp, this.filePath);
  }

  touchUser(userId, username) {
    const id = String(userId);
    const now = new Date().toISOString();
    const user = this.data.users[id] ?? { firstSeenAt: now, totalChecks: 0 };
    user.username = username ?? user.username ?? null;
    user.lastSeenAt = now;
    this.data.users[id] = user;
    this.#save();
  }

  getDailyCount(userId, usageDate) {
    return this.data.daily[usageDate]?.[String(userId)] ?? 0;
  }

  getTotalCount(userId) {
    return this.data.users[String(userId)]?.totalChecks ?? 0;
  }

  increment(userId, usageDate) {
    const id = String(userId);
    const bucket = (this.data.daily[usageDate] ??= {});
    bucket[id] = (bucket[id] ?? 0) + 1;
    const user = (this.data.users[id] ??= { firstSeenAt: new Date().toISOString(), totalChecks: 0 });
    user.totalChecks = (user.totalChecks ?? 0) + 1;
    this.#save();
  }

  decrement(userId, usageDate) {
    const id = String(userId);
    const bucket = this.data.daily[usageDate];
    if (bucket && bucket[id]) {
      bucket[id] = Math.max(bucket[id] - 1, 0);
      if (bucket[id] === 0) delete bucket[id];
      if (Object.keys(bucket).length === 0) delete this.data.daily[usageDate];
    }
    const user = this.data.users[id];
    if (user) user.totalChecks = Math.max((user.totalChecks ?? 0) - 1, 0);
    this.#save();
  }

  getLeaderboard(limit = 10) {
    return Object.entries(this.data.users)
      .map(([user_id, user]) => ({ user_id, username: user.username ?? null, total_checks: user.totalChecks ?? 0 }))
      .sort((a, b) => b.total_checks - a.total_checks)
      .slice(0, limit);
  }

  close() {
    this.#save();
  }
}
