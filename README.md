# renderbot

A Discord bot that answers "can I use this track?" It takes a Spotify or YouTube
link, a YouTube search, or an uploaded audio file, runs it through the
[looney-checks](https://github.com/Renderdragonorg/looney-checks) copyright
engine, and renders the result as a Components V2 message: who owns the track,
what clearance it needs, and where the claims come from.

Research assistance, not legal advice.

## Commands

| Slash | Prefix | What it does |
| --- | --- | --- |
| `/check query:<...>` | `!check <...>` | Spotify URL, YouTube URL or 11-char video id, or a free-text search |
| `/file audio:<attachment>` | `!file` (with attachment) | Uploaded audio (mp3, flac, m4a, wav, ogg, opus, aac, wma) |
| `/help` | `!help` | Usage summary |

A free-text query returns up to five YouTube candidates with pick buttons;
the picked video is what gets checked. Searching is free, the check is not.

Every result carries a **Refresh research** button that re-runs the exact
request with the engine's research cache bypassed. `/check` and `/file` accept
a `private` flag to send the result as an ephemeral reply.

## Requirements

- Node.js >= 22.5 (the audit log uses the built-in `node:sqlite`)
- The looney-checks engine, either downloaded prebuilt or run from source
- An API key for the selected AI backend (OpenRouter by default)

## Quick start

```bash
npm ci
cp .env.example .env          # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, OPENROUTER_API_KEY
npm run fetch-engine          # downloads the prebuilt engine for this OS/arch
npm start
```

`npm run dev` runs the bot under `node --watch`. There is no test suite; verify
changes with `node --check src/<file>.js` and a manual run.

### Engine

`src/engine.js` spawns one warm looney-checks server and keeps it running, since
cold starts are slow. It waits for `/health`, restarts the child up to three
times if it exits unexpectedly, and re-spawns after a broken pipe. Checks go
through the async `/jobs` queue, which lets the bot show live progress; `/check`
is used as a synchronous fallback.

Set `LOONEY_URL` to point at an already-running engine instead of spawning one.
Setting `LOONEY_BIN` to a source checkout's venv binary
(`.../music-copyright-checker-server`) is faster to iterate on than the prebuilt
bundle:

```bash
LOONEY_BIN=/path/to/looney-checks/.venv/bin/music-copyright-checker-server
```

The engine caches research in SQLite for seven days (keyed by model, prompt
version, and payload), so a repeated check returns in about a second with a
cache hit. The Refresh button skips it.

## Configuration

Everything comes from `.env`; `.env.example` documents each variable inline.
The ones you are most likely to touch:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` | — | Required bot credentials |
| `DISCORD_GUILD_ID` | — | Register slash commands instantly in one guild; blank registers globally |
| `BOT_PREFIX` | `!` | Prefix for the legacy text commands |
| `ALLOWED_GUILD_IDS` | — (all) | Comma/space-separated guild ids the bot may serve; blank allows every server and DMs |
| `LOONEY_BIN` | macOS vendor path | Engine executable; relative paths resolve from the project root |
| `LOONEY_URL` | — | Use an external engine instead of spawning one |
| `LOONEY_PORT` | `8799` | Port for the managed engine |
| `LOONEY_AI_BACKEND` | `openrouter` | `openrouter`, `opencode-go`, or `opencode` |
| `LOONEY_MODEL` | `openrouter/free` | Model passed to the engine |
| `LOONEY_TIMEOUT` | `300` | AI research timeout in seconds |
| `QUOTA_DAILY_LIMIT` | `5` | Checks per user per UTC day |
| `QUOTA_BYPASS_USER_IDS` | — | Comma/space-separated user ids that skip the limit |
| `API_ENABLED` | `false` | Serve the read-only public checks API |

`validateConfig()` fails fast on a missing token, client id, or the API key
required by the selected backend (skipped when `LOONEY_URL` is set).

## State

- **Daily quota** — `data/renderbot.json`, one counter per user, reset at
  00:00 UTC. Reserved before the work starts and refunded if the result is not
  delivered. Bypass users get `remaining: Infinity`.
- **Audit log** — `data/requests.sqlite3`, an append-only SQLite table of every
  check: user, guild, channel, request, status, duration, cache flag, and the
  answer JSON. Writes are best-effort and never fail a check.
- **Refresh contexts** — in-memory, keyed by a random id in the button custom
  id, expiring after `REQUEST_CONTEXT_TTL_MS` (6 hours). Nothing is persisted.

## Public API

With `API_ENABLED=true`, `src/api.js` serves a read-only HTTP API over
completed checks, bound to `127.0.0.1:8800` by default. Put a tunnel or reverse
proxy in front to publish it.

```
GET /health                                    -> status, completed_checks, uptime
GET /checks?limit&offset&source=url|file&cache=true|false&q=
GET /checks/:id
```

Responses are PII-free by construction: only `id`, `created_at`, `command`,
`source`, `request`, `from_cache`, `duration_ms`, and `answer` are projected.
There is no auth, so a fixed-window per-IP rate limiter is the only guard.

## Deployment

Runs anywhere Node runs. On a server, a systemd user service with linger keeps
it alive across logouts:

```bash
systemctl --user status renderbot.service
journalctl --user -u renderbot.service -f
systemctl --user restart renderbot.service
```

Only one instance per `DISCORD_TOKEN`; two will both answer interactions and
re-register commands.

## Notes

- Never commit `.env`, `data/`, or `vendor/`; they are git-ignored.
- The engine is authoritative for copyright facts. The bot formats them and
  never invents or rewrites an answer.
- Logging, progress edits, and engine output are best-effort side effects that
  degrade to `console.error` rather than failing a check.
