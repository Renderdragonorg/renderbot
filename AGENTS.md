# AGENTS.md — Renderbot

Working notes, rules, and know-how for anyone (human or agent) changing this repo.

## 1. What this is

`renderbot` is a Discord bot (discord.js v14, **Components V2**) that answers
"can I use this track?" questions. It takes a Spotify/YouTube URL, a YouTube
search query, or an uploaded audio file, hands it to the **looney-checks**
copyright engine, and renders the engine's JSON as a Discord container message.

It owns three pieces of state:

- **Daily quota** — per-user check counter (JSON file, resets 00:00 UTC).
- **Refresh contexts** — short-lived in-memory map so the "Refresh research"
  button can re-run the exact request.
- **Audit log** — SQLite table of every check: who, where, what, the answer,
  and whether it came from the engine cache.

## 2. Repo layout

```
src/
  index.js      entrypoint: config validation, Discord client, wiring, shutdown
  config.js     env -> config object; validateConfig()
  engine.js     LooneyEngine: spawns/owns the looney-checks server, /jobs polling
  handlers.js   source detection -> engine payloads; attachments; search
  sources.js    Spotify/YouTube detection + isSearchQuery() for free-text queries
  quota.js      usageDate/nextResetAt + reserveQuota/refundQuota
  db.js         JsonStore: users + daily usage (atomic temp+rename writes)
  audit.js      RequestLogger: SQLite audit trail + public read queries
  api.js        CheckApi: read-only public HTTP API over completed checks
  dashboard.js  Dashboard: localhost admin audit page + JSON (with PII)
  dashboard.html  the dashboard page, served verbatim
  store.js      ContextStore: in-memory refresh + search-pick contexts (TTL)
  commands.js   slash commands (/check /file /help), refresh + pick buttons, audit
  prefix.js     legacy `!check` `!file` `!help` text commands
  render.js     Components V2 builders (budget/truncation/markdown escaping)
scripts/
  fetch-engine.sh   downloads/verifies/extracts the prebuilt engine for this OS/arch
data/               runtime state (git-ignored): renderbot.json, requests.sqlite3
vendor/             extracted engine bundles (git-ignored)
```

Interactions flow through `commands.js` / `prefix.js`, which share
`handlers.js`, `quota.js`, and the render builders. `index.js` builds the
`deps` object `{ engine, store, db, audit, config }` passed everywhere.

**Direct messages** are off by default: the guild allowlist refuses a null
guild, and the bot does not request the Direct Messages intent. Set
`ALLOW_DMS=true` to accept them (the intent is always requested, so enabling is
env-only). DMs use the prefix commands (`!check` / `!file`); slash commands only
appear there because `registerCommands()` also pushes a **global** copy with the
`BotDM` context — guild-scoped commands never reach DMs.

## 3. Configuration

All config comes from `.env` (see `.env.example`); `config.js` loads it via
dotenv and resolves relative paths from the project root. Real env always wins.

| Var | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DISCORD_CLIENT_ID` | — | Application id (required) |
| `DISCORD_GUILD_ID` | — | Guild for instant slash-command registration; blank = global |
| `BOT_PREFIX` | `!` | Prefix for legacy text commands |
| `BOT_STATUS` | `/check` | Bot presence activity, shown as "Playing &lt;value&gt;" |
| `ALLOWED_GUILD_IDS` | — (all) | Comma/space guild ids the bot may serve; blank = every guild + DMs |
| `ALLOW_DMS` | `false` | Accept DMs even when `ALLOWED_GUILD_IDS` restricts guilds (needs the Direct Messages intent) |
| `LOONEY_BIN` | macOS vendor path | Engine executable; relative = from project root |
| `LOONEY_URL` | — | Point at an already-running engine instead of spawning one |
| `LOONEY_PORT` | `8799` | Port for the managed engine |
| `LOONEY_AI_BACKEND` | `openrouter` | `openrouter` \| `opencode-go` \| `openai-compatible` \| `opencode` |
| `LOONEY_FALLBACK_BACKENDS` | — | Comma/space secondary backends (live: `openai-compatible`) |
| `MUSIC_CHECKER_FALLBACK_RETRIES` | `1` | Engine retries per backend on a transient failure before advancing the chain |
| `LOONEY_MODEL` | `openrouter/free` | Model for every backend except `openai-compatible` |
| `TOKEN_HARBOR_BASE_URL` | — | OpenAI-compatible gateway base URL (e.g. `https://tokenharbor.ai/v1`) |
| `TOKEN_HARBOR_MODEL` | — | Model id for the `openai-compatible` backend |
| `TOKEN_HARBOR_API_KEY` | — | Gateway key; forwarded to the engine as `OPENAI_COMPAT_API_KEY` |
| `LOONEY_SEARCH_BACKEND` | `auto` | `auto` \| `server` \| `exa` \| `none`; `auto` = Exa for `openai-compatible` |
| `EXA_API_KEY` | — | Exa web search key (forwarded to the engine) |
| `LOONEY_TIMEOUT` | `300` | Engine `--timeout` (AI research timeout, seconds) |
| `LOONEY_JOBS` | `true` | Use the engine `/jobs` queue (recommended) |
| `LOONEY_REQUEST_TIMEOUT_MS` | `780000` | How long the bot waits for a job (13 min) |
| `LOONEY_STARTUP_TIMEOUT_MS` | `240000` | Engine boot deadline |
| `LOONEY_RETRY_ATTEMPTS` | `3` | Attempts per check when a transient AI failure occurs (`1` disables) |
| `LOONEY_RETRY_BUDGET_MS` | `600000` | Wall-clock cap for the whole retry sequence |
| `LOONEY_CACHE_PATH` | engine default | Override the engine's SQLite research cache |
| `LOONEY_NO_CACHE` / `LOONEY_NO_AI` | `false` | Engine flags (debug/smoke tests) |
| `LOONEY_LOG_LINES` | `80` | Engine stdout lines kept for error tails |
| `OPENROUTER_API_KEY` | — | Forwarded to the engine (openrouter backend) |
| `OPENCODE_GO_API_KEY` | — | Forwarded to the engine (opencode-go backend) |
| `YOUTUBE_API_KEY` | — | Forwarded to the engine (YouTube metadata) |
| `REQUEST_CONTEXT_TTL_MS` | `6h` | Refresh-button context lifetime |
| `MAX_CONTEXT_FILE_BYTES` | `26214400` | Uploaded file kept in memory for refresh |
| `DB_PATH` | `data/renderbot.json` | Quota/user JSON store |
| `DB_RETENTION_DAYS` | `30` | Prune daily usage rows past this age |
| `AUDIT_DB_PATH` | `data/requests.sqlite3` | SQLite audit log |
| `API_ENABLED` | `false` | Serve the read-only public checks API |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `8800` | API bind address (localhost by default) |
| `API_RATE_LIMIT_PER_MINUTE` | `120` | Per-IP request cap; `0` disables |
| `API_TRUST_PROXY` | `true` | Trust `x-forwarded-for` for client IPs |
| `DASHBOARD_ENABLED` | `false` | Serve the admin audit dashboard (localhost) |
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | `127.0.0.1` / `8890` | Dashboard bind address |
| `DASHBOARD_TOKEN` | — | If set, require `?token=` or a `Bearer` header |
| `QUEUE_CONCURRENCY` | `2` | Max checks running at once; extras wait in the queue |
| `QUOTA_DAILY_LIMIT` | `5` | Checks per user per UTC day |
| `QUOTA_BYPASS_USER_IDS` | — | Comma/space list of user ids that skip the limit |

`validateConfig()` fails fast on a missing token/client id, or a missing API
key for the selected engine backend (skipped when `LOONEY_URL` is set).

## 4. The engine (looney-checks)

The AI work lives in a **separate repo**: `/Users/techspot/looney-checks`
(`Renderdragonorg/looney-checks`, Python). This bot only talks to its local
JSON server; it never vendors that source.

### Lifecycle
`LooneyEngine` (`engine.js`) spawns **one warm server** and keeps it running
(cold start is slow). It waits for `GET /health` to return `200`, restarts up
to 3 times if the child exits unexpectedly, and re-spawns the process if a
request fails with a broken pipe. Spawn args:

```
<bin> [server] --host 127.0.0.1 --port <LOONEY_PORT> --ai-backend <backend>
      [--model <model> | --openai-compatible-base-url <url> --openai-compatible-model <id>]
      [--fallback-ai-backend <backend> ...] [--search-backend auto|server|exa|none]
      --timeout <sec> [--cache-path ...|--no-cache] [--no-ai] [--jobs]
```

If `LOONEY_BIN`'s basename ends in `-server`/`_server` (pip
`music-copyright-checker-server` console script) the `server` subcommand is
omitted. `LOONEY_URL` switches to external mode (no spawn).

### Backends
- `openrouter` (default) — direct REST to `openrouter.ai`, needs
  `OPENROUTER_API_KEY`. Uses the `openrouter:web_search` server tool.
- `opencode-go` — direct REST to `opencode.ai/zen/go/v1` (OpenRouter-compatible),
  needs `OPENCODE_GO_API_KEY`. The engine sends a `User-Agent` +
  `x-opencode-session` header (Cloudflare rejects the stock Python UA with
  error 1010), disables `reasoning` (mimo is a reasoning model) and sets
  `max_tokens` so the research JSON isn't truncated.
- `openai-compatible` — any OpenAI-compatible chat-completions gateway, e.g.
  **Token Harbor** (`https://tokenharbor.ai/v1`, model `mimo-v2.5:free`). Needs
  `TOKEN_HARBOR_BASE_URL`, `TOKEN_HARBOR_MODEL`, and `TOKEN_HARBOR_API_KEY`
  (forwarded as `OPENAI_COMPAT_API_KEY`). These endpoints have no
  `openrouter:web_search` server tool, so web search uses the client-side **Exa**
  function tool (`EXA_API_KEY`); `--search-backend auto` already resolves to Exa.
- `opencode` — local `opencode` CLI agent; needs the binary + provider auth.

Any primary backend can name secondaries with `--fallback-ai-backend` (repeatable),
tried in order by the engine's `FallbackResearcher`. The bot sets
`LOONEY_FALLBACK_BACKENDS`; the live config is **primary `openrouter`
(`openrouter/free`) → fallback `openai-compatible` (Token Harbor
`mimo-v2.5:free`)**.

`FallbackResearcher` (engine **v0.3.5**) retries a *transient* failure on the
**same** endpoint before advancing the chain — an empty completion
(`OpenRouter returned an empty completion`), truncated/invalid JSON, 429/5xx, or
a dropped socket. So an OpenRouter empty completion re-runs OpenRouter, it does
not immediately fall through to Token Harbor; only a hard failure (or an
exhausted retry budget) advances. Retries per backend come from
`MUSIC_CHECKER_FALLBACK_RETRIES` (default `1`; the bot forwards it to the engine
via the inherited environment). The bot's own `#withRetry` still wraps the whole
chain, and `ai_meta` reports `retry_failures` (same-backend) vs
`fallback_failures`/`fallback_used` (different backend).

The bot forwards `OPENROUTER_API_KEY`, `OPENCODE_GO_API_KEY`, `YOUTUBE_API_KEY`,
`OPENAI_COMPAT_API_KEY` (from `TOKEN_HARBOR_API_KEY`), and `EXA_API_KEY` into the
child process environment (`engine.js`).

### Endpoints used
- `GET /health` → `{ status, ai_model }`
- `POST /jobs` → `202 { job_id, status_url }`; `GET /jobs/{id}` → status +
  `progress.stage/message`, and `result` when complete. Preferred path.
- `POST /check` → synchronous; used as a fallback if `/jobs` 404s.
- `POST /youtube/search` (`{ query, limit }`, limit capped at 5) →
  `{ query, results[] }` where each result has `video_id`, `url`, `title`,
  `channel`, `channel_id`, `description`, `published_at`, `thumbnail_url`.
  Added in engine **v0.3.2**; used by the search-then-pick flow below.

### Transient-failure retries
`LooneyEngine.check()` / `checkFile()` wrap each attempt in `#withRetry`. A
failed attempt is retried when the error is *transient* — the free-router
`OpenRouter returned an empty completion`, truncated/invalid JSON, HTTP `5xx`
or `429`, or a dropped socket. Permanent errors (missing binary, `4xx`
validation, job/health timeouts) are never retried. Bounded by
`LOONEY_RETRY_ATTEMPTS` (default 3, `1` disables) and `LOONEY_RETRY_BUDGET_MS`
(default 10 min); backoff is 3s then 6s. Retries emit a progress update
("retrying automatically (attempt n/m)…") and log `transient failure on
attempt …` to the engine log.

Quota is unaffected: it is reserved once before the check and refunded only if
**every** attempt fails, so a successful retry still counts as one check.
Retrying re-runs the engine's AI research, so a failed attempt is never cached.

### YouTube search-then-pick (v0.3.2)

A free-text query (not a Spotify/YouTube URL or an 11-char video id) is no
longer auto-resolved. `sources.js`'s `isSearchQuery()` routes it through
`engine.searchYouTube()`, and the bot renders up to five candidates (thumbnail +
title + channel) with numbered pick buttons (`buildSearchResults`). Clicking a
number runs the normal check on that candidate's `url` (`handlePick` in
`commands.js` / the `looney:pick:<ctx>:<i>` custom id).

- **Search does not consume quota; the picked check does** (reserve on pick).
- Candidates are held in the `ContextStore` (`rememberSearch`), so the picker
  expires with `REQUEST_CONTEXT_TTL_MS`.
- If the engine predates the endpoint (`searchYouTube` throws a `404`), the
  handler falls back to the old auto-resolving `/check`, so v0.3.1 engines keep
  working.
- Empty results render `buildSearchEmpty(query)`.

### Research cache
The engine caches research in SQLite (default
`~/.cache/music-copyright-checker/cache.sqlite3`, override with
`LOONEY_CACHE_PATH`) keyed by recording identity + model chain + prompt version +
a hash of the request payload, TTL 7 days. A repeat check returns in ~1.5s with
`ai_meta.cache_hit: true`; the Refresh button passes `refresh: true` to bypass
it. The cache is engine-wide (shared across every guild on that instance), not
per-server; separate hosts have separate cache files. Engine **v0.3.4** stopped
hashing volatile YouTube fields (`view_count`, `description`, `tags`,
`thumbnail_url`, `external_ids`, `raw`), which previously re-keyed every
YouTube check and defeated caching. Cross-source (Spotify vs YouTube) and
per-model-chain keys still differ by design. When the AI backend/model chain
changes, older entries are orphaned (same rows, different key). Engine **v0.3.6**
trims every length-capped AI string on a word boundary with a trailing `…`
(`_clip` in `ai_researcher.py`) instead of the old blunt `value[:limit]`, and
raises the summary cap to 600 chars (prompt version `3`). Bumping the prompt
version re-keys the cache once, so existing entries re-run research the next time
they're checked. Engine **v0.3.7** fetches the video's pinned/relevant comments
and scans the description + comments for creator licence phrases ("royalty
free", "free to use", "CC BY", …), storing them as `TrackMetadata.top_comments`
/ `license_statements`; it adds `usage_assessment.creator_declared_license` and
the `free_to_use` / `permitted_with_conditions` verdicts, and raises the
description cap to 4000 chars (prompt version `6`). `top_comments` is excluded
from the cache key. The bot renders the new verdicts and the creator-declared
line (`render.js`).

### Source vs prebuilt binary
`scripts/fetch-engine.sh` downloads the prebuilt release bundle for the current
OS/arch (`macos-x86_64`, `linux-x86_64`, ...). Two caveats:

- **Prebuilt v0.3.1 bundles predate `POST /youtube/search`**, so the bot's
  search-then-pick flow falls back to auto-resolving on them. Use v0.3.2+ for
  the picker.
- **No prebuilt bundle ships the `opencode-go` backend** — it is a local,
  uncommitted addition to this checkout's engine source. A machine using
  `opencode-go` (or the picker on an old release) must run the engine from
  source (see §7).

## 5. State stores

### Quota — `data/renderbot.json` (`db.js`)
`{ version, updatedAt, users{}, daily{}, channels{} }`. Atomic writes (temp + rename),
corrupt files are quarantined and recreated, daily rows older than
`DB_RETENTION_DAYS` pruned on load. `reserveQuota` increments **before** the
work; `refundQuota` decrements when the result isn't delivered. `refundIfCached`
also gives the check back when the engine served research from its cache
(`result.ai_meta.cache_hit === true`), so cached answers are free. Bypass users
never decrement and get `remaining: Infinity`. Reset is 00:00 UTC.

### Command channel — `channels{}` in the same JSON (`db.js`)
Per-guild command channel (`{ "<guildId>": { commandChannelId, updatedAt } }`).
When set, prefix `check`/`file` and slash `check`/`file` are only accepted in
that channel; `help` and the management command always work. Unset = any
channel. Managed with the prefix command `!channel set #channel|clear|show`
requires the Discord **Manage Server** permission; it works from any channel so
admins can recover a mis-set restriction.

### Audit — `data/requests.sqlite3` (`audit.js`)
`RequestLogger` uses Node's built-in **`node:sqlite`** (`DatabaseSync`), WAL
mode. Two tables:

- `users` — `user_id` PK, `username`, `display_name`, `avatar_url`,
  `first_seen_at`, `last_seen_at`, `request_count` (upserted per request).
- `requests` — `id` PK autoincrement, `created_at`, user snapshot
  (`user_id`, `username`, `display_name`, `avatar_url`), `guild_id`,
  `guild_name`, `channel_id`, `command`, `source`, `request`, `status`
  (`ok`/`error`), `from_cache` (nullable), `duration_ms`, `answer` (JSON, capped
  at 200 000 chars), `error`.

Indexed on user_id, guild_id, created_at. Recorded from slash, prefix, and
refresh handlers via `recordCheck(...)` + `actorFrom(entity)`.

**Rules for the audit log:**
- Logging must **never break a check** — `record()` is best-effort and
  swallows write failures to stderr.
- It is an append-only trail; there is no pruning yet. Don't add heavy writes
  to the request path.
- Inspect with any SQLite client, e.g.
  `sqlite3 data/requests.sqlite3 'select created_at, command, status, from_cache, duration_ms from requests order by id desc limit 20;'`.

### Refresh contexts — in-memory (`store.js`)
`ContextStore` maps a random id → original request, expiring after
`REQUEST_CONTEXT_TTL_MS`. Only the button custom id `looney:refresh:<id>`
references it; nothing is persisted.

### Check queue — in-memory (`queue.js`)
`CheckQueue` is a global (all guilds) concurrency limiter: at most
`QUEUE_CONCURRENCY` checks run at once; the rest wait. The engine runs each
`/jobs` job in its own thread, so this is real parallelism. Each waiting check
gets an `onState` callback with `{ position, total }` on every queue change, and
`runQueuedCheck()` (`handlers.js`) keeps its message in sync — a
`buildQueueStatus` container while waiting ("You are #n of m"), then the normal
progress container once it starts. Every check path goes through it: slash/prefix
`check`/`file`, and the refresh/pick buttons. The queue is not persisted; a
restart drops it (in-flight engine jobs are lost too).

### Public API — `src/api.js` (`CheckApi`)
Read-only HTTP server over the audit log; off unless `API_ENABLED=true`. Binds
`API_HOST:API_PORT` (localhost by default) — put a tunnel/reverse proxy in front
to publish it. There is **no auth**; a fixed-window per-IP limiter caps requests
at `API_RATE_LIMIT_PER_MINUTE` (`0` disables), and `x-forwarded-for` is trusted
when `API_TRUST_PROXY=true`. `OPTIONS` is handled for CORS (`*`).

Wire format (JSON, **PII-free** — reads go through `findPublicChecks` /
`getPublicCheck`, which project only `id, created_at, command, source, request,
from_cache, duration_ms, answer`):
- `GET /health` → `{ status, completed_checks, uptime_seconds }`
- `GET /checks?limit&offset&source=url|file&cache=true|false&q=` →
  `{ total, limit, offset, count, checks[] }` (limit clamped to 100)
- `GET /checks/:id` → one completed check, or `404`

Never widen that projection without a deliberate decision — user, avatar, guild
and channel must not leave the box.

### Admin dashboard — `src/dashboard.js` (`Dashboard`)
HTML + JSON server over the **full** audit log (user, guild, channel, verdict,
cache, duration), off unless `DASHBOARD_ENABLED=true`. It is deliberately *not*
PII-free, so it binds `DASHBOARD_HOST:DASHBOARD_PORT` (localhost by default) and
honours an optional `DASHBOARD_TOKEN` (`?token=` or `Bearer`). Reach it over an
SSH tunnel; never publish it. Reads go through `RequestLogger.adminChecks` /
`adminCheck` / `adminSummary` (sort whitelisted in `ADMIN_SORTS`, never raw
input). The page is `src/dashboard.html`, served verbatim.

- `GET /` → the page
- `GET /api/summary` → `{ totals, byUser[], byGuild[], byDay[] }`
- `GET /api/checks?sort&dir&user_id&guild_id&status&source&q&limit&offset`
- `GET /api/checks/:id` → one row + full answer

## 6. Rendering rules (`render.js`)

- Every reply is a Components V2 container: `flags: V2` (=`MessageFlags.IsComponentsV2`),
  `components: [container]`, `allowedMentions: { parse: [] }` for user text.
- Discord limits enforced by the `Budget` class: ≤4000 chars total text
  (3900 body + 400 footer) and ≤40 components.
- **Never truncate mid-line.** Whole-block `truncate()` used to cut through
  markdown links, producing broken `[label](<https://…` output. `addLines()`
  emits only complete lines and drops the ones that don't fit, so URLs and
  markdown links stay intact. Use `addLines()` for lists (sources, matches,
  warnings, footer); use `text()` for prose.
- Escape user/model text with `mdEscape()` before embedding.
- The engine only returns `thumbnail_url` for YouTube sources, so `handlers.js`'s
  `resolveSpotifyArtwork()` fills in Spotify cover art via the public
  `open.spotify.com/oembed` endpoint before rendering. Best-effort: a failure
  just renders the result without artwork.
- `SectionBuilder` **requires an accessory**; for results with no usable
  thumbnail use a plain `TextDisplayBuilder` instead (a `SectionBuilder`
  without an accessory throws a shapeshift `CombinedError`).
- The result's accent color is the **highest-severity** usage verdict (video /
  social media / reality TV), not an average; `not_found` is neutral gray. The
  same verdict is echoed at the top of the embed as a bold, emoji-tagged status
  line (`highestVerdict()`), so the color and the text always agree. This badge
  is the one deliberate emoji exception to the no-emoji rule.
- `VERDICTS` ranks, worst first: `likely_not_permitted_without_permission` (red),
  `clearance_required` (orange), `potentially_usable_with_platform_license`
  (yellow), `permitted_with_conditions` (green, v0.3.7), `free_to_use` (green,
  v0.3.7), `unknown` (gray, lowest). A known verdict always wins over an unclear
  dimension, so `unknown` only shows when all three are unknown. Unknown verdict
  strings fall back to `unknown`.

## 7. Running & deploying

### Local
```bash
npm ci
npm run fetch-engine     # or set LOONEY_BIN to a source venv
npm start                # node src/index.js
node --check src/<file>.js   # quick syntax gate (there is no test suite)
```
There is no automated test suite in this repo — verify changes with
`node --check`, a manual run, and (for engine changes) a real `/jobs` request.

Two instances on one `DISCORD_TOKEN` both answer interactions and re-register
commands. Always stop one before starting the other.

### Remote (the live bot)

**Oracle Cloud is the live host**; the older `moonsmp@192.168.100.6` box is a
legacy copy. Both use the same `DISCORD_TOKEN`, so **never run them at the same
time** — two instances both answer interactions and re-register commands.

#### Oracle Cloud (live)

Host `opc@130.61.53.246` — Oracle Linux 9.8, x86_64, shape
`VM.Standard.E2.1.Micro` (1/8 burstable OCPU, ~1 GB RAM, 30 GB disk). SSH key
`~/.ssh/renderbot-oracle.key` (copied from
`~/Downloads/ssh-key-2026-09-16-3.key`).

| Thing | Value |
| --- | --- |
| Bot checkout | `~/renderbot` (`.env` mode `600`) |
| Node | v22.23.2, official tarball at `/usr/local/bin/node` (dnf not used) |
| Engine | v0.3.7 **from source**, in standalone CPython 3.11.16 `~/python311/python` |
| `LOONEY_BIN` | `/home/opc/python311/python/bin/music-copyright-checker-server` |
| Backend / model | `openrouter` / `openrouter/free`; fallback `openai-compatible` (Token Harbor) / `mimo-v2.5:free`; Exa search |
| Engine cache | `LOONEY_CACHE_PATH=/home/opc/.cache/renderbot-engine.sqlite3` |
| Audit DB | `~/renderbot/data/requests.sqlite3` |
| Quota JSON | `~/renderbot/data/renderbot.json` |
| Discord identity | `Renderbot | RenderDragonORG#7905` |
| Allowed guilds | `ALLOWED_GUILD_IDS=1317605088558190602 1550072373229789204` |
| Service | systemd **user** unit `renderbot.service`, linger enabled |
| Admin dashboard | `DASHBOARD_ENABLED=true`, `127.0.0.1:8890` — reach it with `ssh -L 8890:127.0.0.1:8890 -i ~/.ssh/renderbot-oracle.key opc@130.61.53.246` |

```bash
# status / logs / restart (XDG_RUNTIME_DIR is needed over plain ssh)
ssh -i ~/.ssh/renderbot-oracle.key opc@130.61.53.246
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status renderbot.service
journalctl --user -u renderbot.service -f
systemctl --user restart renderbot.service
```

**Why the engine runs from source here.** The prebuilt Linux bundle (v0.3.2) is
built against `GLIBC_2.38` but OL9 ships glibc 2.34, so it aborts on startup.
The host's system Python is 3.9, while `spotapi` (an engine dep) uses PEP 604
unions and `match` statements and so needs **Python ≥ 3.10**. The engine Python
is therefore a **standalone CPython 3.11.16** (`python-build-standalone`)
with the deps installed offline from a local wheelhouse — nothing comes from
dnf or the host's Python.

> **This host is very weak.** Any heavy local work (`dnf`, `pip`, `xz`) starves
> `sshd` — port 22 accepts TCP but no banner comes back for tens of minutes.
> Do downloads, hashing and extraction on the Mac, then `scp` the results and
> keep remote work to `scp`, `tar -xzf` and `pip install --no-index --no-deps`.

Host tuning already applied (keeps the micro from freezing under memory
pressure):
- 2.5 GB swap total (`/.swapfile` 498 MB + `/swapfile2` 2 GB, both in fstab).
- PCP disabled (`pmcd/pmie/pmlogger/*.timer`) — frees ~60 MB of monitoring
  daemons that were pure overhead here.
- Oracle Cloud Agent plugins `gomon` and `oci-wlp` set `disabled: true` in
  `/etc/oracle-cloud-agent/agent.yml` (edit that file, then
  `sudo systemctl restart oracle-cloud-agent`; a `.disabled` marker file does
  **not** work). Leave `runcommand`/`agent`/`updater` alone.
- `/var/log/journal` created so kernel/journal logs survive a reboot (they were
  volatile before, which made the freezes undiagnosable). Check for OOM with
  `sudo journalctl -k -b -1 | grep -i 'out of memory'`.

Shipping local edits (there is no git remote configured):
```bash
tar -czf /tmp/renderbot-src.tar.gz -C /Users/techspot/renderbot src package.json package-lock.json .env.example AGENTS.md node_modules
scp -i ~/.ssh/renderbot-oracle.key /tmp/renderbot-src.tar.gz opc@130.61.53.246:/home/opc/
ssh -i ~/.ssh/renderbot-oracle.key opc@130.61.53.246 'cd ~/renderbot && tar -xzf ~/renderbot-src.tar.gz && export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user restart renderbot.service'
```
`node_modules` is shipped instead of running `npm ci` on the host: the runtime
deps are pure JS (no native `.node` addons), so a copy built on the Mac runs
as-is.

To update the engine: re-ship `music_copyright_checker`, `opencode_harness`,
`pyproject.toml`, build the wheel **on the Mac** (`python3 -m pip wheel
--no-deps .`), scp it (plus any new deps, resolved for cp311) into
`~/wheels311`, then
`~/python311/python/bin/python3.11 -m pip install --no-index --no-deps
~/wheels311/*.whl`, and restart the bot.

#### moonsmp (legacy)

Host `moonsmp@192.168.100.6` — Debian 13, x86_64, Node `v24.16.0`, engine from
source in `~/looney-checks` (venv `~/looney-checks/.venv`, built with `uv`
because `ensurepip`/`python3-venv` is missing; `uv` is not on the
non-interactive `PATH`). Same layout and systemd user service as Oracle. Leave
its unrelated `music-copyright-checker.service` engine on `0.0.0.0:8090` alone.

#### Smoke-test a check without Discord

The engine's `/jobs` API is the whole check path, so you can exercise it
head-on (no Discord needed) — and it's the fastest way to confirm backend,
model, and cache behaviour:

```bash
ssh -i ~/.ssh/renderbot-oracle.key opc@130.61.53.246
curl -s -X POST http://127.0.0.1:8799/jobs \
  -H 'Content-Type: application/json' \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
# -> {"job_id":"…"}; poll until status=complete
curl -s http://127.0.0.1:8799/jobs/<job_id>
```

`POST /youtube/search` is a cheap, AI-free way to confirm the engine, backend
and `YOUTUBE_API_KEY` after a deploy.

Repeat the same `POST` a second time: it should finish in ~1.5s with
`ai_meta.cache_hit: true`. Long AI runs take 100–450s — start them detached
(`nohup … >log 2>&1 &`) and poll the log rather than holding a foreground ssh.

#### Inspecting the audit log

There is **no `sqlite3` CLI on either remote**, so read the DB with Node
(unflagged on ≥23.4; the Oracle host runs Node 22 and prints an
`ExperimentalWarning`):

```bash
node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.HOME+"/renderbot/data/requests.sqlite3");console.table(d.prepare("select id,created_at,command,status,from_cache,duration_ms from requests order by id desc limit 10").all())'
```

#### Remote quirks

- `ssh -n` reads stdin from `/dev/null` — never combine it with a piped secret.
  Pipe secrets **via stdin** (never argv/`ssh` args) and drop `-n` for that call,
  e.g. `printf '%s' "$KEY" | ssh host 'python3 /tmp/update-env.py'`.
- `pkill -f <pattern>` can match the running `ssh` command line itself and kill
  your own session. Prefer the bracket trick (`[p]attern`) or avoid `pkill`.
- `uv` (moonsmp only) is not on the non-interactive `PATH`;
  `export PATH="$HOME/.local/bin:$PATH"`.
- The Oracle micro is the weakest link: never run `dnf`/`pip`/`xz` there, and
  poll a detached `nohup` job instead of holding a foreground ssh.
- `node:sqlite` is unflagged and silent on moonsmp's Node 24; on the Oracle
  host (Node 22.23) and local Node 22.17 it works but prints an
  `ExperimentalWarning`.

## 8. Rules & gotchas

- **Never commit secrets.** `.env`, `data/`, `vendor/`, `node_modules/`, `*.log`
  are git-ignored. Keys (`DISCORD_TOKEN`, `*_API_KEY`) never belong in code,
  logs, or command lines — pipe them via stdin, never argv.
- **Do not touch services you didn't start.** Locally, port `8787` is a
  pre-existing `sync4` process. On the legacy moonsmp host,
  `music-copyright-checker.service` runs an unrelated engine on port `8090` —
  leave both alone. Use a free port (`LOONEY_PORT`) instead.
- **Quota**: reserve before doing work, refund when the result was *not*
  delivered, or when the engine served research from its cache
  (`refundIfCached`). Refresh counts as a check (and bypasses the cache).
- **Best-effort side effects**: audit writes, progress edits, and engine logs
  must degrade quietly (`console.error`), never fail a check.
- `node:sqlite` needs **Node ≥ 22.5** and prints an ExperimentalWarning on
  Node 22 (silent on ≥ 23.4). `package.json` engines is `>=22.5`.
- The engine is authoritative for copyright facts; the bot never invents or
  rewrites them, only formats them.
- Match the existing code style: ESM, small modules, JSDoc on exported
  classes/functions. No emojis in code or output.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Something else is listening on port …` | `LOONEY_PORT` taken; pick a free port |
| `Engine binary not found` | Run `npm run fetch-engine` or set `LOONEY_BIN` |
| Check fails with `OpenRouter returned an empty completion` / truncated JSON | Free router flakiness; retry or use the Refresh button, or pin a model / switch backend |
| Research is slow or times out | Free models queue; pin a model, raise `LOONEY_TIMEOUT`, or use `opencode-go` |
| Duplicate bot replies | Two instances share one `DISCORD_TOKEN`; stop one |
| Audit rows missing | Writes are best-effort; check stderr/`journalctl` for `[audit] …` |
| Engine exited early on the remote | Check `journalctl`; Oracle: reinstalled deps from `~/wheels311`; moonsmp: re-run `uv pip install` in `~/looney-checks/.venv` |
| Oracle host stops answering ssh after an install | 1/8-OCPU starvation (TCP opens, no banner); wait it out, or reboot from the OCI console |
