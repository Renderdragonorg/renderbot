import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveFromRoot(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

const defaultBin = path.join(
  projectRoot,
  'vendor',
  'music-copyright-checker-0.3.1-macos-x86_64',
  'music-copyright-checker',
);

export const projectRootPath = projectRoot;

export const config = {
  token: process.env.DISCORD_TOKEN?.trim() ?? '',
  clientId: process.env.DISCORD_CLIENT_ID?.trim() ?? '',
  guildId: process.env.DISCORD_GUILD_ID?.trim() || null,
  prefix: process.env.BOT_PREFIX || '!',
  engine: {
    url: process.env.LOONEY_URL?.trim() || null,
    bin: resolveFromRoot(process.env.LOONEY_BIN) || defaultBin,
    port: int(process.env.LOONEY_PORT, 8799),
    aiBackend: process.env.LOONEY_AI_BACKEND || 'openrouter',
    model: process.env.LOONEY_MODEL || 'openrouter/free',
    timeoutSec: int(process.env.LOONEY_TIMEOUT, 300),
    cachePath: process.env.LOONEY_CACHE_PATH?.trim() || null,
    noCache: bool(process.env.LOONEY_NO_CACHE, false),
    noAi: bool(process.env.LOONEY_NO_AI, false),
    jobs: bool(process.env.LOONEY_JOBS, true),
    startupTimeoutMs: int(process.env.LOONEY_STARTUP_TIMEOUT_MS, 240_000),
    requestTimeoutMs: int(process.env.LOONEY_REQUEST_TIMEOUT_MS, 780_000),
    openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || '',
    opencodeGoApiKey: process.env.OPENCODE_GO_API_KEY?.trim() || '',
    youtubeApiKey: process.env.YOUTUBE_API_KEY?.trim() || '',
    logLines: int(process.env.LOONEY_LOG_LINES, 80),
  },
  contextTtlMs: int(process.env.REQUEST_CONTEXT_TTL_MS, 6 * 60 * 60 * 1000),
  maxContextFileBytes: int(process.env.MAX_CONTEXT_FILE_BYTES, 25 * 1024 * 1024),
  db: {
    path: resolveFromRoot(process.env.DB_PATH) || path.join(projectRoot, 'data', 'renderbot.json'),
    retentionDays: int(process.env.DB_RETENTION_DAYS, 30),
  },
  audit: {
    path: resolveFromRoot(process.env.AUDIT_DB_PATH) || path.join(projectRoot, 'data', 'requests.sqlite3'),
  },
  api: {
    enabled: bool(process.env.API_ENABLED, false),
    host: process.env.API_HOST?.trim() || '127.0.0.1',
    port: int(process.env.API_PORT, 8800),
    rateLimitPerMinute: int(process.env.API_RATE_LIMIT_PER_MINUTE, 120),
    trustProxy: bool(process.env.API_TRUST_PROXY, true),
  },
  quota: {
    dailyLimit: int(process.env.QUOTA_DAILY_LIMIT, 5),
    bypassUserIds: new Set(
      (process.env.QUOTA_BYPASS_USER_IDS ?? '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  },
};

export function validateConfig() {
  const problems = [];
  if (!config.token) problems.push('DISCORD_TOKEN is not set');
  if (!config.clientId) problems.push('DISCORD_CLIENT_ID is not set');
  if (
    !config.engine.url &&
    config.engine.aiBackend === 'openrouter' &&
    !config.engine.openrouterApiKey
  ) {
    problems.push('OPENROUTER_API_KEY is not set (the engine AI research step will fail)');
  }
  if (
    !config.engine.url &&
    config.engine.aiBackend === 'opencode-go' &&
    !config.engine.opencodeGoApiKey
  ) {
    problems.push('OPENCODE_GO_API_KEY is not set (the engine AI research step will fail)');
  }
  return problems;
}
