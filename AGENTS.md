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

## 3. Configuration

All config comes from `.env` (see `.env.example`); `config.js` loads it via
dotenv and resolves relative paths from the project root. Real env always wins.

| Var | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DISCORD_CLIENT_ID` | — | Application id (required) |
| `DISCORD_GUILD_ID` | — | Guild for instant slash-command registration; blank = global |
| `BOT_PREFIX` | `!` | Prefix for legacy text commands |
| `LOONEY_BIN` | macOS vendor path | Engine executable; relative = from project root |
| `LOONEY_URL` | — | Point at an already-running engine instead of spawning one |
| `LOONEY_PORT` | `8799` | Port for the managed engine |
| `LOONEY_AI_BACKEND` | `openrouter` | `openrouter` \| `opencode-go` \| `opencode` |
| `LOONEY_MODEL` | `openrouter/free` | Model passed to the engine |
| `LOONEY_TIMEOUT` | `300` | Engine `--timeout` (AI research timeout, seconds) |
| `LOONEY_JOBS` | `true` | Use the engine `/jobs` queue (recommended) |
| `LOONEY_REQUEST_TIMEOUT_MS` | `780000` | How long the bot waits for a job (13 min) |
| `LOONEY_STARTUP_TIMEOUT_MS` | `240000` | Engine boot deadline |
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
      --model <model> --timeout <sec> [--cache-path ...|--no-cache] [--no-ai] [--jobs]
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
- `opencode` — local `opencode` CLI agent; needs the binary + provider auth.

The bot forwards `OPENROUTER_API_KEY`, `OPENCODE_GO_API_KEY`, and
`YOUTUBE_API_KEY` into the child process environment (`engine.js`).

### Endpoints used
- `GET /health` → `{ status, ai_model }`
- `POST /jobs` → `202 { job_id, status_url }`; `GET /jobs/{id}` → status +
  `progress.stage/message`, and `result` when complete. Preferred path.
- `POST /check` → synchronous; used as a fallback if `/jobs` 404s.
- `POST /youtube/search` (`{ query, limit }`, limit capped at 5) →
  `{ query, results[] }` where each result has `video_id`, `url`, `title`,
  `channel`, `channel_id`, `description`, `published_at`, `thumbnail_url`.
  Added in engine **v0.3.2**; used by the search-then-pick flow below.

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
`LOONEY_CACHE_PATH`) keyed by model + prompt version + request payload, TTL 7
days. A repeat check returns in ~1.5s with `ai_meta.cache_hit: true`; the
Refresh button passes `refresh: true` to bypass it.

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
`{ version, updatedAt, users{}, daily{} }`. Atomic writes (temp + rename),
corrupt files are quarantined and recreated, daily rows older than
`DB_RETENTION_DAYS` pruned on load. `reserveQuota` increments **before** the
work; `refundQuota` decrements when the result isn't delivered. Bypass users
never decrement and get `remaining: Infinity`. Reset is 00:00 UTC.

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

Host `moonsmp@192.168.100.6` — Debian 13, x86_64, Node `v24.16.0`
(`/usr/local/bin/node`), npm 11. SSH key auth works non-interactively (no
password). The bot lives at `~/renderbot` and runs under the systemd **user**
service `renderbot.service` (linger is enabled, so it survives logout/reboot).

Remote facts:

| Thing | Value |
| --- | --- |
| Bot checkout | `~/renderbot` (`.env` mode `600`) |
| Engine (from source) | `~/looney-checks`, venv `~/looney-checks/.venv` |
| `LOONEY_BIN` | `/home/moonsmp/looney-checks/.venv/bin/music-copyright-checker-server` |
| Backend / model | `openrouter` / `openrouter/free` |
| Engine cache | `LOONEY_CACHE_PATH=/home/moonsmp/.cache/renderbot-engine.sqlite3` |
| Audit DB | `~/renderbot/data/requests.sqlite3` |
| Quota JSON | `~/renderbot/data/renderbot.json` |
| Discord identity | `Renderbot | RenderDragonORG#7905`, guild `1317605088558190602` |
| Leave alone | `music-copyright-checker.service` (user) — unrelated engine on `0.0.0.0:8090` from `~/music_copyright_checker` |

```bash
# status / logs / restart (XDG_RUNTIME_DIR is needed over plain ssh)
ssh moonsmp@192.168.100.6
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status renderbot.service
journalctl --user -u renderbot.service -f
systemctl --user restart renderbot.service
```

Local edits are shipped by tar + scp (there is no git remote configured):
```bash
tar -czf /tmp/renderbot-src.tar.gz -C /Users/techspot/renderbot src package.json package-lock.json .env.example AGENTS.md
scp /tmp/renderbot-src.tar.gz moonsmp@192.168.100.6:/home/moonsmp/
ssh moonsmp@192.168.100.6 'cd ~/renderbot && tar -xzf ~/renderbot-src.tar.gz && npm ci --omit=dev'
# then restart the service
```

**Engine on the remote** runs from source (the prebuilt Linux bundle predates
the `opencode-go` backend). `ensurepip`/`python3-venv` is missing on this host,
so the venv was created with `uv` (which is *not* on the non-interactive
`PATH`):

```bash
export PATH="$HOME/.local/bin:$PATH"
cd ~/looney-checks
uv venv --python /usr/bin/python3 .venv            # only if .venv is missing
uv pip install --python .venv/bin/python .          # first install
# after editing engine source:
uv pip install --python .venv/bin/python --reinstall .
```

To update the remote engine: re-ship `music_copyright_checker`,
`opencode_harness`, `pyproject.toml`, reinstall as above, then restart the bot.

#### Smoke-test a check without Discord

The engine's `/jobs` API is the whole check path, so you can exercise it
head-on (no Discord needed) — and it's the fastest way to confirm backend,
model, and cache behaviour:

```bash
ssh moonsmp@192.168.100.6
curl -s -X POST http://127.0.0.1:8799/jobs \
  -H 'Content-Type: application/json' \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
# -> {"job_id":"…"}; poll until status=complete
curl -s http://127.0.0.1:8799/jobs/<job_id>
```

Repeat the same `POST` a second time: it should finish in ~1.5s with
`ai_meta.cache_hit: true`. Long AI runs take 100–450s — start them detached
(`nohup … >log 2>&1 &`) and poll the log rather than holding a foreground ssh.

#### Inspecting the audit log

There is **no `sqlite3` CLI on the remote**, so read the DB with Node (which
needs no flag on Node 24):

```bash
node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.HOME+"/renderbot/data/requests.sqlite3");console.table(d.prepare("select id,created_at,command,status,from_cache,duration_ms from requests order by id desc limit 10").all())'
```

#### Remote quirks

- `ssh -n` reads stdin from `/dev/null` — never combine it with a piped secret.
  Pipe secrets **via stdin** (never argv/`ssh` args) and drop `-n` for that call,
  e.g. `printf '%s' "$KEY" | ssh host 'python3 /tmp/update-env.py'`.
- `pkill -f <pattern>` can match the running `ssh` command line itself and kill
  your own session. Prefer the bracket trick (`[p]attern`) or avoid `pkill`.
- `uv` is not on the non-interactive `PATH`; `export PATH="$HOME/.local/bin:$PATH"`.
- `node:sqlite` is unflagged and silent on the remote's Node 24; on local Node
  22.17 it works but prints an `ExperimentalWarning`.

## 8. Rules & gotchas

- **Never commit secrets.** `.env`, `data/`, `vendor/`, `node_modules/`, `*.log`
  are git-ignored. Keys (`DISCORD_TOKEN`, `*_API_KEY`) never belong in code,
  logs, or command lines — pipe them via stdin, never argv.
- **Do not touch services you didn't start.** Locally, port `8787` is a
  pre-existing `sync4` process. On the remote, `music-copyright-checker.service`
  runs an unrelated engine on port `8090` — leave both alone. Use a free port
  (`LOONEY_PORT`) instead.
- **Quota**: reserve before doing work, refund only when the result was *not*
  delivered. Refresh counts as a check.
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
| Engine exited early on the remote | Check `journalctl`; re-run `uv pip install` in `~/looney-checks/.venv` |
