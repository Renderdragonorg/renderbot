import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_ANSWER_CHARS = 200_000;

/** Whitelisted ORDER BY expressions for the admin dashboard (never user input). */
const ADMIN_SORTS = {
  date: 'id',
  user: 'COALESCE(display_name, username, user_id) COLLATE NOCASE',
  guild: 'COALESCE(guild_name, guild_id) COLLATE NOCASE',
  command: 'command COLLATE NOCASE',
  duration: 'duration_ms',
  status: 'status COLLATE NOCASE',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  username      TEXT,
  display_name  TEXT,
  avatar_url    TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  username     TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  guild_id     TEXT,
  guild_name   TEXT,
  channel_id   TEXT,
  command      TEXT NOT NULL,
  source       TEXT,
  request      TEXT,
  status       TEXT NOT NULL,
  from_cache   INTEGER,
  duration_ms  INTEGER,
  answer       TEXT,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_user    ON requests (user_id);
CREATE INDEX IF NOT EXISTS idx_requests_guild   ON requests (guild_id);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at);
`;

function serializeAnswer(value) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length > MAX_ANSWER_CHARS) text = `${text.slice(0, MAX_ANSWER_CHARS)}\u2026`;
  return text;
}

function parseAnswer(text) {
  if (text === undefined || text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Maps a raw `requests` row to the shape the public API serves. Only the
 * fields listed here ever leave the process; Discord identity is dropped.
 */
function publicCheck(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    command: row.command,
    source: row.source,
    request: row.request,
    from_cache: row.from_cache === null ? null : Boolean(row.from_cache),
    duration_ms: row.duration_ms,
    answer: parseAnswer(row.answer),
  };
}

/**
 * Compact, table-friendly projection of a stored answer: enough to show a
 * verdict and summary column without shipping the whole research payload.
 */
function compactResult(text) {
  const parsed = parseAnswer(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const research = parsed.research ?? {};
  const usage = research.usage_assessment ?? {};
  return {
    status: research.status ?? null,
    summary: research.summary ?? null,
    verdicts: {
      video: usage.video_verdict ?? null,
      social: usage.social_media_verdict ?? null,
      reality: usage.reality_tv_verdict ?? null,
    },
    creator_declared_license: usage.creator_declared_license ?? null,
    provider: parsed.ai_meta?.provider ?? null,
    cache_hit: typeof parsed.ai_meta?.cache_hit === 'boolean' ? parsed.ai_meta.cache_hit : null,
  };
}

/** Full admin row: everything the audit trail holds, including Discord identity. */
function adminRow(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    },
    guild: row.guild_id ? { id: row.guild_id, name: row.guild_name } : null,
    channel_id: row.channel_id,
    command: row.command,
    source: row.source,
    request: row.request,
    status: row.status,
    from_cache: row.from_cache === null ? null : Boolean(row.from_cache),
    duration_ms: row.duration_ms,
    error: row.error,
    result: compactResult(row.answer),
  };
}

/**
 * Pulls the fields we log out of an interaction or a message. Both expose a
 * `user`/`author`, a guild (null in DMs) and a channel id.
 */
export function actorFrom(entity) {
  const user = entity?.user ?? entity?.author ?? null;
  const guild = entity?.guild ?? null;
  return {
    userId: user?.id ? String(user.id) : 'unknown',
    username: user?.username ?? null,
    displayName: user?.globalName ?? user?.displayName ?? user?.username ?? null,
    avatarUrl: user?.displayAvatarURL?.({ size: 128, extension: 'png' }) ?? null,
    guildId: (entity?.guildId ?? guild?.id) ? String(entity.guildId ?? guild.id) : null,
    guildName: guild?.name ?? null,
    channelId: entity?.channelId ? String(entity.channelId) : null,
  };
}

/**
 * SQLite-backed audit trail of every check: who asked, from where, what they
 * asked, the answer the engine produced, and whether it came from cache.
 *
 * Logging must never break a check, so writes are best-effort and any failure
 * is reported on stderr instead of thrown.
 */
export class RequestLogger {
  constructor(filePath) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.upsertUserStatement = this.db.prepare(`
      INSERT INTO users (user_id, username, display_name, avatar_url, first_seen_at, last_seen_at, request_count)
      VALUES (:user_id, :username, :display_name, :avatar_url, :now, :now, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        username      = excluded.username,
        display_name  = excluded.display_name,
        avatar_url    = excluded.avatar_url,
        last_seen_at  = excluded.last_seen_at,
        request_count = users.request_count + 1
    `);
    this.insertStatement = this.db.prepare(`
      INSERT INTO requests (
        created_at, user_id, username, display_name, avatar_url,
        guild_id, guild_name, channel_id, command, source, request,
        status, from_cache, duration_ms, answer, error
      ) VALUES (
        :created_at, :user_id, :username, :display_name, :avatar_url,
        :guild_id, :guild_name, :channel_id, :command, :source, :request,
        :status, :from_cache, :duration_ms, :answer, :error
      )
    `);
  }

  /**
   * @param {object} entry
   * @param {object} entry.actor   result of {@link actorFrom}
   * @param {string} entry.command slash command or prefix command that ran
   * @param {string} [entry.source] 'url' or 'file'
   * @param {string} [entry.request] the raw user input / attachment name
   * @param {object} [entry.result] the engine result object
   * @param {Error}  [entry.error]  the failure, if the check errored
   * @param {number} [entry.durationMs]
   * @returns {number|null} the inserted row id
   */
  record({ actor, command, source = null, request = null, result = null, error = null, durationMs = null }) {
    try {
      const now = new Date().toISOString();
      const user = {
        user_id: actor.userId,
        username: actor.username ?? null,
        display_name: actor.displayName ?? null,
        avatar_url: actor.avatarUrl ?? null,
        now,
      };
      this.upsertUserStatement.run(user);

      const fromCache =
        typeof result?.ai_meta?.cache_hit === 'boolean' ? (result.ai_meta.cache_hit ? 1 : 0) : null;

      const info = this.insertStatement.run({
        created_at: now,
        user_id: actor.userId,
        username: actor.username ?? null,
        display_name: actor.displayName ?? null,
        avatar_url: actor.avatarUrl ?? null,
        guild_id: actor.guildId ?? null,
        guild_name: actor.guildName ?? null,
        channel_id: actor.channelId ?? null,
        command,
        source,
        request,
        status: error ? 'error' : 'ok',
        from_cache: fromCache,
        duration_ms: durationMs === null ? null : Math.round(durationMs),
        answer: serializeAnswer(result),
        error: error ? String(error.message ?? error) : null,
      });
      return Number(info.lastInsertRowid);
    } catch (writeError) {
      console.error(`[audit] failed to record request: ${writeError.message}`);
      return null;
    }
  }

  recent(limit = 20) {
    return this.db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT ?').all(limit);
  }

  /**
   * Public, PII-free projection of completed checks. Deliberately omits
   * user_id/username/display_name/avatar_url/guild/channel — this is the
   * boundary the public API reads through.
   *
   * @param {object} [options]
   * @param {number} [options.limit]  page size (already clamped by the caller)
   * @param {number} [options.offset]
   * @param {string} [options.source] 'url' | 'file'
   * @param {boolean} [options.cache] filter on `from_cache`
   * @param {string} [options.query]  substring match on the raw request
   */
  findPublicChecks({ limit = 20, offset = 0, source = null, cache = null, query = null } = {}) {
    const where = ["status = 'ok'"];
    const params = [];
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    if (cache === true) where.push('from_cache = 1');
    else if (cache === false) where.push('(from_cache = 0 OR from_cache IS NULL)');
    if (query) {
      where.push("request LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query)}%`);
    }
    const clause = where.join(' AND ');
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${clause}`)
      .get(...params).n;
    const rows = this.db
      .prepare(
        `SELECT id, created_at, command, source, request, from_cache, duration_ms, answer
         FROM requests WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return { total, checks: rows.map(publicCheck) };
  }

  /** @returns {object|null} one public check by id, or null if not found. */
  getPublicCheck(id) {
    const row = this.db
      .prepare(
        `SELECT id, created_at, command, source, request, from_cache, duration_ms, answer
         FROM requests WHERE id = ? AND status = 'ok'`,
      )
      .get(id);
    return row ? publicCheck(row) : null;
  }

  /**
   * Admin listing with Discord identity, sortable by date/user/guild. Unlike
   * {@link findPublicChecks} this is for the local dashboard only — it is never
   * served by the public API.
   *
   * @param {object} [options]
   * @param {string} [options.sort]  one of the ADMIN_SORTS keys
   * @param {'asc'|'desc'} [options.dir]
   */
  adminChecks({
    limit = 50,
    offset = 0,
    sort = 'date',
    dir = 'desc',
    userId = null,
    guildId = null,
    status = null,
    source = null,
    query = null,
    from = null,
    to = null,
  } = {}) {
    const orderBy = ADMIN_SORTS[sort] ?? ADMIN_SORTS.date;
    const direction = dir === 'asc' ? 'ASC' : 'DESC';
    const where = [];
    const params = [];
    if (userId) {
      where.push('user_id = ?');
      params.push(String(userId));
    }
    if (guildId) {
      where.push('guild_id = ?');
      params.push(String(guildId));
    }
    if (status === 'ok' || status === 'error') {
      where.push('status = ?');
      params.push(status);
    }
    if (source === 'url' || source === 'file') {
      where.push('source = ?');
      params.push(source);
    }
    if (query) {
      where.push("request LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query)}%`);
    }
    if (from) {
      where.push('created_at >= ?');
      params.push(String(from));
    }
    if (to) {
      where.push('created_at <= ?');
      params.push(String(to));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM requests ${clause}`).get(...params).n;
    const rows = this.db
      .prepare(
        `SELECT id, created_at, user_id, username, display_name, avatar_url,
                guild_id, guild_name, channel_id, command, source, request,
                status, from_cache, duration_ms, answer, error
         FROM requests ${clause}
         ORDER BY ${orderBy} ${direction}, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return { total, rows: rows.map(adminRow) };
  }

  /** One admin row plus the full stored answer, for the detail panel. */
  adminCheck(id) {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!row) return null;
    return { ...adminRow(row), answer: parseAnswer(row.answer) };
  }

  /** Aggregate counts for the dashboard overview: totals, by user, guild, day. */
  adminSummary() {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(status = 'ok') AS ok,
                SUM(status = 'error') AS errors,
                SUM(from_cache = 1) AS cached,
                COUNT(DISTINCT user_id) AS users,
                COUNT(DISTINCT guild_id) AS guilds
         FROM requests`,
      )
      .get();
    const byUser = this.db
      .prepare(
        `SELECT user_id, COALESCE(display_name, username, user_id) AS name, avatar_url,
                COUNT(*) AS total, SUM(status = 'ok') AS ok, SUM(status = 'error') AS errors,
                SUM(from_cache = 1) AS cached, MAX(created_at) AS last_seen
         FROM requests GROUP BY user_id ORDER BY total DESC, name COLLATE NOCASE LIMIT 100`,
      )
      .all();
    const byGuild = this.db
      .prepare(
        `SELECT COALESCE(guild_id, 'dm') AS guild_id,
                COALESCE(guild_name, CASE WHEN guild_id IS NULL THEN 'Direct messages' ELSE guild_id END) AS name,
                COUNT(*) AS total, SUM(status = 'ok') AS ok, SUM(status = 'error') AS errors,
                SUM(from_cache = 1) AS cached, MAX(created_at) AS last_seen
         FROM requests GROUP BY COALESCE(guild_id, 'dm') ORDER BY total DESC, name COLLATE NOCASE LIMIT 100`,
      )
      .all();
    const byDay = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS total,
                SUM(status = 'ok') AS ok, SUM(status = 'error') AS errors, SUM(from_cache = 1) AS cached
         FROM requests GROUP BY day ORDER BY day DESC LIMIT 60`,
      )
      .all();
    return { totals, byUser, byGuild, byDay };
  }

  countCompleted() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'ok'").get().n;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
