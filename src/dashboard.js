import fs from 'node:fs';
import http from 'node:http';

const PAGE = fs.readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

function parseLimit(raw) {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

function parseOffset(raw) {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Admin dashboard over the audit log. Unlike the public `CheckApi` it shows
 * Discord identity (user, guild, channel), so it binds to localhost by default
 * and can require a shared token. Reach it over an SSH tunnel or a private
 * network; never publish it as-is.
 */
export class Dashboard {
  constructor({ audit, host = '127.0.0.1', port = 8890, token = null, logger = console } = {}) {
    this.audit = audit;
    this.host = host;
    this.port = port;
    this.token = token || null;
    this.logger = logger;
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
    return new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  #authorized(req, url) {
    if (!this.token) return true;
    const header = req.headers.authorization;
    if (typeof header === 'string' && header === `Bearer ${this.token}`) return true;
    return url.searchParams.get('token') === this.token;
  }

  #send(res, status, type, body) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, {
      'content-type': type,
      'content-length': payload.length,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    });
    res.end(payload);
  }

  #json(res, body, status = 200) {
    this.#send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
  }

  #handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (!this.#authorized(req, url)) {
        this.#send(res, 401, 'text/plain; charset=utf-8', 'Unauthorized');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.#send(res, 405, 'text/plain; charset=utf-8', 'Use GET.');
        return;
      }

      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/') {
        this.#send(res, 200, 'text/html; charset=utf-8', PAGE);
        return;
      }
      if (path === '/api/summary') {
        this.#json(res, this.audit.adminSummary());
        return;
      }
      if (path === '/api/checks') {
        this.#list(url, res);
        return;
      }
      const match = /^\/api\/checks\/(\d+)$/.exec(path);
      if (match) {
        const row = this.audit.adminCheck(Number(match[1]));
        if (!row) this.#json(res, { error: 'not_found' }, 404);
        else this.#json(res, row);
        return;
      }
      this.#send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error) {
      this.logger.error(`[dashboard] ${error.stack ?? error.message}`);
      if (!res.headersSent) this.#json(res, { error: 'internal_error' }, 500);
      else res.end();
    }
  }

  #list(url, res) {
    const params = url.searchParams;
    const { total, rows } = this.audit.adminChecks({
      limit: parseLimit(params.get('limit')),
      offset: parseOffset(params.get('offset')),
      sort: params.get('sort') || 'date',
      dir: params.get('dir') === 'asc' ? 'asc' : 'desc',
      userId: params.get('user_id')?.trim() || null,
      guildId: params.get('guild_id')?.trim() || null,
      status: params.get('status')?.trim() || null,
      source: params.get('source')?.trim() || null,
      query: params.get('q')?.trim() || null,
      from: params.get('from')?.trim() || null,
      to: params.get('to')?.trim() || null,
    });
    this.#json(res, { total, limit: parseLimit(params.get('limit')), offset: parseOffset(params.get('offset')), rows });
  }
}
