import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EngineError extends Error {
  constructor(message, { status = null, detail = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Owns the looney-checks process. Spawns one warm `server` instance and keeps it
 * running so a check only pays the AI/lookup cost, not the (slow) cold start.
 */
export class LooneyEngine {
  constructor(engineConfig) {
    this.config = engineConfig;
    this.baseUrl = engineConfig.url
      ? engineConfig.url.replace(/\/+$/, '')
      : `http://127.0.0.1:${engineConfig.port}`;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.stopping = false;
    this.restarts = 0;
    this.logs = [];
  }

  get external() {
    return Boolean(this.config.url);
  }

  ensureReady() {
    if (this.ready) return Promise.resolve();
    if (!this.startPromise) {
      this.startPromise = this.#start().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    return this.startPromise;
  }

  async #start() {
    if (this.external) {
      await this.#waitForHealth();
      this.ready = true;
      return;
    }
    if (!fs.existsSync(this.config.bin)) {
      throw new EngineError(
        `Engine binary not found at ${this.config.bin}. Run "npm run fetch-engine" or set LOONEY_BIN.`,
      );
    }
    this.#spawnChild();
    await this.#waitForHealth();
    this.ready = true;
  }

  #spawnChild() {
    const stem = path.basename(this.config.bin).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    const serverEntry = stem.endsWith('-server') || stem.endsWith('_server');
    const args = [];
    if (!serverEntry) args.push('server');
    args.push(
      '--host', '127.0.0.1',
      '--port', String(this.config.port),
      '--ai-backend', this.config.aiBackend,
      '--timeout', String(this.config.timeoutSec),
    );
    // `--model` only overrides the primary backend. Token Harbor (and any
    // OpenAI-compatible gateway) takes its base URL/model from dedicated flags,
    // which must be passed whenever it appears anywhere in the chain — primary
    // or fallback.
    if (this.config.aiBackend !== 'openai-compatible') {
      args.push('--model', this.config.model);
    }
    const chain = [this.config.aiBackend, ...(this.config.aiFallbackBackends ?? [])];
    if (chain.includes('openai-compatible')) {
      if (this.config.openaiCompatBaseUrl) {
        args.push('--openai-compatible-base-url', this.config.openaiCompatBaseUrl);
      }
      if (this.config.openaiCompatModel) {
        args.push('--openai-compatible-model', this.config.openaiCompatModel);
      }
    }
    for (const backend of this.config.aiFallbackBackends ?? []) {
      args.push('--fallback-ai-backend', backend);
    }
    if (this.config.searchBackend) args.push('--search-backend', this.config.searchBackend);
    if (this.config.noCache) args.push('--no-cache');
    else if (this.config.cachePath) args.push('--cache-path', this.config.cachePath);
    if (this.config.noAi) args.push('--no-ai');
    if (this.config.jobs) args.push('--jobs');

    const env = { ...process.env };
    if (this.config.openrouterApiKey) env.OPENROUTER_API_KEY = this.config.openrouterApiKey;
    if (this.config.opencodeGoApiKey) env.OPENCODE_GO_API_KEY = this.config.opencodeGoApiKey;
    if (this.config.youtubeApiKey) env.YOUTUBE_API_KEY = this.config.youtubeApiKey;
    if (this.config.openaiCompatApiKey) env.OPENAI_COMPAT_API_KEY = this.config.openaiCompatApiKey;
    if (this.config.exaApiKey) env.EXA_API_KEY = this.config.exaApiKey;
    if (this.config.fallbackRetries) env.MUSIC_CHECKER_FALLBACK_RETRIES = String(this.config.fallbackRetries);

    this.child = spawn(this.config.bin, args, {
      env,
      cwd: path.dirname(this.config.bin),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const modelLabel =
      this.config.aiBackend === 'openai-compatible' ? this.config.openaiCompatModel : this.config.model;
    this.#log(`spawning engine on port ${this.config.port} (${chain.join(' -> ')} / ${modelLabel})`);
    this.child.stdout.on('data', (chunk) => this.#log(chunk.toString()));
    this.child.stderr.on('data', (chunk) => this.#log(chunk.toString()));

    this.child.on('error', (error) => this.#log(`engine process error: ${error.message}`));

    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.#log(`engine stopped (${code ?? signal})`);
        return;
      }
      this.ready = false;
      this.startPromise = null;
      this.#log(`engine exited unexpectedly (${code ?? signal})`);
      if (this.restarts < 3) {
        this.restarts += 1;
        setTimeout(() => {
          this.ensureReady().catch((error) => this.#log(`engine restart failed: ${error.message}`));
        }, 3_000);
      }
    });
  }

  async #waitForHealth() {
    const started = Date.now();
    const deadline = started + this.config.startupTimeoutMs;
    let lastError = null;
    let badResponses = 0;
    let lastNotice = 0;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          const body = await response.json().catch(() => ({}));
          this.#log(`engine ready (model: ${body.ai_model ?? 'unknown'})`);
          return;
        }
        badResponses += 1;
        if (badResponses >= 3) {
          throw new EngineError(
            `Something else is listening on port ${this.config.port} (it answered HTTP ${response.status} on /health). ` +
              'Set LOONEY_PORT in .env to a free port and restart.',
          );
        }
      } catch (error) {
        if (error instanceof EngineError) throw error;
        lastError = error;
      }
      const elapsed = Date.now() - started;
      if (elapsed - lastNotice >= 10_000) {
        lastNotice = elapsed;
        this.#log(`waiting for engine to start (${Math.round(elapsed / 1000)}s)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const seconds = Math.round(this.config.startupTimeoutMs / 1000);
    throw new EngineError(
      `Engine did not become ready within ${seconds}s${lastError ? `: ${lastError.message}` : ''}`,
      { detail: this.tailLogs(12) },
    );
  }

  #log(line) {
    for (const raw of String(line).split('\n')) {
      const text = raw.replace(/\s+$/, '');
      if (!text) continue;
      this.logs.push(text);
      if (this.logs.length > this.config.logLines) {
        this.logs.splice(0, this.logs.length - this.config.logLines);
      }
      process.stdout.write(`[engine] ${text}\n`);
    }
  }

  tailLogs(count = 10) {
    return this.logs.slice(-count).join('\n');
  }

  async #request(pathname, init) {
    await this.ensureReady();
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const message = body?.error || `Engine request failed (HTTP ${response.status})`;
      throw new EngineError(message, { status: response.status, detail: body ?? text.slice(0, 500) });
    }
    if (body === null) {
      throw new EngineError('Engine returned a non-JSON response', { detail: text.slice(0, 500) });
    }
    return body;
  }

  /**
   * Run a URL/id/query check. Transient engine failures — the free router
   * returning an empty or truncated completion, 5xx/429 responses, dropped
   * connections — are retried automatically so a flaky AI response does not
   * surface to the user (quota is reserved once and only refunded if every
   * attempt fails).
   */
  check(payload, { refresh = false, onProgress } = {}) {
    const attempt = () => {
      const sync = () => {
        const body = { ...payload };
        if (refresh) body.refresh = true;
        return this.#request('/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      };
      return this.#jobsThenSync(
        () => this.#runJob({ json: { ...payload, ...(refresh ? { refresh: true } : {}) } }, onProgress),
        sync,
      );
    };
    return this.#withRetry(attempt, { onProgress });
  }

  /** File-upload equivalent of {@link check} (also retried on transient failures). */
  checkFile({ data, filename, contentType }, { refresh = false, onProgress } = {}) {
    const attempt = () => {
      const sync = () => {
        const form = new FormData();
        form.append('file', new Blob([data], contentType ? { type: contentType } : undefined), filename);
        if (refresh) form.append('refresh', 'true');
        return this.#request('/check', { method: 'POST', body: form });
      };
      return this.#jobsThenSync(
        () => this.#runJob({ file: { data, filename, contentType }, refresh }, onProgress),
        sync,
      );
    };
    return this.#withRetry(attempt, { onProgress });
  }

  /**
   * Ask the engine for YouTube search candidates (v0.3.2+ `POST /youtube/search`).
   * Returns an array of `{ video_id, url, title, channel, thumbnail_url, ... }`.
   * Throws an EngineError with `status === 404` when the engine predates the
   * endpoint, so callers can fall back to the auto-resolving check.
   */
  async searchYouTube(query, { limit = 5 } = {}) {
    const body = await this.#request('/youtube/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    return Array.isArray(body?.results) ? body.results : [];
  }

  async #jobsThenSync(runJob, sync) {
    if (!this.config.jobs) return sync();
    try {
      return await runJob();
    } catch (error) {
      if (error instanceof EngineError && error.status === 404) {
        this.#log('engine has no /jobs endpoint; falling back to synchronous /check');
        this.config.jobs = false;
        return sync();
      }
      throw error;
    }
  }

  /**
   * Whether a failed attempt is worth retrying. Bad input and our own hard
   * limits (missing binary, health/job timeouts on an already-broken engine)
   * are permanent; everything else — empty/truncated AI completions, 5xx, 429,
   * dropped sockets — is treated as transient free-router flakiness.
   */
  #isRetryable(error) {
    if (!(error instanceof EngineError)) return true;
    if (typeof error.status === 'number') {
      if (error.status === 404) return false;
      if (error.status >= 400 && error.status < 500 && error.status !== 429) return false;
    }
    const message = String(error.message ?? '');
    return !/engine binary not found|did not finish within|did not become ready|something else is listening/i.test(
      message,
    );
  }

  /** Retries `attempt()` on transient failures, bounded by attempts and a time budget. */
  async #withRetry(attempt, { onProgress } = {}) {
    const total = Math.max(1, this.config.retryAttempts ?? 1);
    const budgetMs = this.config.retryBudgetMs ?? 0;
    const startedAt = Date.now();
    let lastError = null;
    for (let attemptNumber = 1; attemptNumber <= total; attemptNumber += 1) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        const canRetry =
          attemptNumber < total && this.#isRetryable(error) && Date.now() - startedAt < budgetMs;
        if (!canRetry) throw error;
        const delayMs = Math.min(30_000, 3_000 * 2 ** (attemptNumber - 1));
        this.#log(
          `transient failure on attempt ${attemptNumber}/${total} (${error.message}); retrying in ${delayMs}ms`,
        );
        if (onProgress) {
          try {
            await onProgress({
              status: 'running',
              stage: 'retry',
              message: `Transient engine error — retrying automatically (attempt ${attemptNumber + 1}/${total})…`,
            });
          } catch {
            /* progress updates are best-effort */
          }
        }
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  async #runJob({ json, file, refresh = false }, onProgress) {
    await this.ensureReady();
    const init = json
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }
      : (() => {
          const form = new FormData();
          form.append('file', new Blob([file.data], file.contentType ? { type: file.contentType } : undefined), file.filename);
          if (refresh) form.append('refresh', 'true');
          return { method: 'POST', body: form };
        })();

    const created = await this.#request('/jobs', init);
    const jobId = created?.job_id;
    if (!jobId) throw new EngineError('Engine did not return a job id for the check.');
    return this.#pollJob(jobId, onProgress);
  }

  async #pollJob(jobId, onProgress) {
    const deadline = Date.now() + this.config.requestTimeoutMs;
    let lastProgress = null;
    let transientErrors = 0;
    while (Date.now() < deadline) {
      await sleep(2_000);
      let job;
      try {
        job = await this.#request(`/jobs/${jobId}`, { method: 'GET' });
        transientErrors = 0;
      } catch (error) {
        if (error instanceof EngineError && error.status === 404) {
          throw new EngineError('The engine restarted and lost this job. Please try again.');
        }
        transientErrors += 1;
        if (transientErrors >= 5) throw error;
        continue;
      }

      const key = `${job.status}:${job.progress?.stage}:${job.progress?.message}`;
      if (onProgress && key !== lastProgress) {
        lastProgress = key;
        await onProgress({ status: job.status, stage: job.progress?.stage, message: job.progress?.message });
      }

      if (job.status === 'complete') return job.result;
      if (job.status === 'failed') {
        throw new EngineError(job.progress?.message || 'The engine failed to complete the check.');
      }
    }
    throw new EngineError(
      `The engine did not finish within ${Math.round(this.config.requestTimeoutMs / 1000)}s. Please try again.`,
    );
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
