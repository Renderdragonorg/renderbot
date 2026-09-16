import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_ANSWER_CHARS = 200_000;

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
