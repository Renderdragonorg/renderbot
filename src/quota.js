/** UTC calendar day used for the daily quota, e.g. "2026-09-14". */
export function usageDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Next 00:00 UTC as a Date. */
export function nextResetAt(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

export function formatResetIn(ms) {
  if (ms <= 0) return 'now';
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * Atomically checks and consumes one check for a user.
 * Returns the post-consumption state; `allowed: false` means the limit is hit.
 */
export function reserveQuota(store, { userId, username, limit, bypassUserIds = new Set() }) {
  const id = String(userId);
  const date = usageDate();
  const resetAt = nextResetAt();
  store.touchUser(id, username);

  if (bypassUserIds.has(id)) {
    return {
      allowed: true,
      bypass: true,
      limit,
      used: store.getDailyCount(id, date),
      remaining: Infinity,
      usageDate: date,
      resetAt,
    };
  }

  const used = store.getDailyCount(id, date);
  if (used >= limit) {
    return { allowed: false, bypass: false, limit, used, remaining: 0, usageDate: date, resetAt };
  }

  store.increment(id, date);
  const after = used + 1;
  return { allowed: true, bypass: false, limit, used: after, remaining: limit - after, usageDate: date, resetAt };
}

/** Gives a consumed check back (e.g. the engine errored before producing a result). */
export function refundQuota(store, { userId, usageDate: date }) {
  if (!date) return;
  store.decrement(String(userId), date);
}
