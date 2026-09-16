import http from 'node:http';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parseLimit(raw) {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

function parseOffset(raw) {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseBool(raw) {
  if (raw === null) return null;
  return /^(1|true|yes|on)$/i.test(raw);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(payload);
}

/**
 * Fixed-window, per-IP limiter. Purely a safety valve for the public read API;
 * when the limit is 0 the limiter is disabled.
 */
class RateLimiter {
  constructor(limitPerMinute) {
    this.enabled = Number.isFinite(limitPerMinute) && limitPerMinute > 0;
    this.limit = limitPerMinute;
    this.windowMs = 60_000;
    this.hits = new Map();
    if (this.enabled) {
      this.sweeper = setInterval(() => this.sweep(), this.windowMs);
      this.sweeper.unref?.();
    }
  }

  allow(key) {
    if (!this.enabled) return true;
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  stop() {
    clearInterval(this.sweeper);
  }
}

/**
 * Read-only HTTP API over completed ("ok") checks. It intentionally exposes
 * only the track reference, the engine answer and the cache flag — never the
 * Discord user, avatar, guild or channel. Bind it to localhost and put a
 * tunnel / reverse proxy in front when publishing it.
 */
export class CheckApi {
  constructor({ audit, host = '127.0.0.1', port = 8800, rateLimitPerMinute = 120, trustProxy = true, logger = console } = {}) {
    this.audit = audit;
    this.host = host;
    this.port = port;
    this.logger = logger;
    this.trustProxy = trustProxy;
    this.limiter = new RateLimiter(rateLimitPerMinute);
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  start() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve(this.server.address());
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
  }

  close() {
    this.limiter.stop();
    return new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  async #handle(req, res) {
    try {
      const ip = this.#clientIp(req);
      if (!this.limiter.allow(ip)) {
        sendJson(res, 429, { error: 'rate_limited', message: 'Too many requests. Slow down.' });
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed', message: 'Use GET.' });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/') return this.#describe(res);
      if (path === '/health') return this.#health(res);
      if (path === '/checks') return this.#list(url, res);

      const match = /^\/checks\/(\d+)$/.exec(path);
      if (match) return this.#one(match[1], res);

      sendJson(res, 404, { error: 'not_found', message: 'Unknown endpoint.' });
    } catch (error) {
      this.logger.error(`[api] ${error.stack ?? error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    }
  }

  #clientIp(req) {
    if (this.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  #describe(res) {
    sendJson(res, 200, {
      name: 'renderbot checks API',
      description: 'Public, read-only results of completed music copyright checks.',
      endpoints: {
        'GET /health': 'Service status and number of completed checks.',
        'GET /checks': 'Paginated completed checks. Query: limit, offset, source (url|file), cache (true|false), q.',
        'GET /checks/:id': 'One completed check by id.',
      },
    });
  }

  #health(res) {
    sendJson(res, 200, {
      status: 'ok',
      completed_checks: this.audit.countCompleted(),
      uptime_seconds: Math.round(process.uptime()),
    });
  }

  #list(url, res) {
    const params = url.searchParams;
    const limit = parseLimit(params.get('limit'));
    const offset = parseOffset(params.get('offset'));
    const sourceParam = params.get('source');
    const source = sourceParam === 'url' || sourceParam === 'file' ? sourceParam : null;
    const { total, checks } = this.audit.findPublicChecks({
      limit,
      offset,
      source,
      cache: parseBool(params.get('cache')),
      query: params.get('q')?.trim() || null,
    });
    sendJson(res, 200, { total, limit, offset, count: checks.length, checks });
  }

  #one(id, res) {
    const check = this.audit.getPublicCheck(Number(id));
    if (!check) {
      sendJson(res, 404, { error: 'not_found', message: `No completed check with id ${id}.` });
      return;
    }
    sendJson(res, 200, check);
  }
}
