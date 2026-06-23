# Music File Bot (Discord + Telegram, single codebase) — Node.js version

Same bot as the Python version, ported to Node.js 20+ for free JS hosts.
No voice channel join. `/music <name or link>` → bot downloads the audio
and replies with the file itself (MP3 or best-quality original).

## Files
- `music_engine.js` — shared download logic (shells out to the `yt-dlp` CLI + ffmpeg)
- `ensure_binaries.js` — auto-downloads yt-dlp/ffmpeg if not found on PATH
- `bot_info.js` — shared About text + GitHub/Instagram links for /start
- `discord_bot.js` — Discord slash commands `/start` and `/music`
- `telegram_bot.js` — Telegram commands `/start` and `/music`
- `main.js` — runs both bots together in one process
- `.env.example` — copy to `.env` and fill in your tokens
- `package.json` — Node dependencies

## Requirements on the host

This calls the **system `yt-dlp` and `ffmpeg` binaries** directly (not an
npm wrapper). 

**You don't need to install them manually** — on startup, `main.js`
checks if `yt-dlp` / `ffmpeg` are on `PATH`. If either is missing (common
on free hosts with no package manager access), it automatically downloads
a standalone Linux build straight from GitHub releases into a local
`bin/` folder and uses that instead, for the rest of the process's life.

This needs:
- The host to be **Linux** (true for almost all free Node hosts)
- Outbound HTTPS access to github.com (most hosts allow this)
- The `tar` command available for extracting ffmpeg (present on virtually
  every Linux image)

If your host blocks outbound internet access entirely, this fallback
won't work and you'll need a host that allows either outbound requests
or pre-installed binaries.

## Setup

```bash
npm install
```

Copy `.env.example` → `.env` and fill in:
```
DISCORD_TOKEN=your_discord_bot_token
TELEGRAM_TOKEN=your_telegram_bot_token
DISCORD_MAX_MB=50
TELEGRAM_MAX_MB=50
```

> Discord's REAL upload limit depends on server boost level:
> No boost = 10MB, Level 2 = 50MB, Level 3 = 100MB.
> Telegram bot API hard limit is 50MB for bot-uploaded files.

Run:
```bash
npm start
```

## How it works

1. User: `/music believer imagine dragons` (or pastes a YouTube link)
2. Bot replies with two buttons: **🎵 MP3** and **⭐ Best Quality**
3. User taps one → bot downloads with yt-dlp, sends the file, then
   deletes it from disk immediately after sending (and also auto-cleans
   anything older than 10 minutes on startup, in case a previous run
   crashed mid-send).
4. If the file exceeds the configured size limit, the bot reports that
   instead of trying to send it (and still deletes the leftover file).

## Fixing "Sign in to confirm you're not a bot"

By default the bot requests YouTube's **Android client** instead of the
web client, which avoids most bot-detection on its own — no cookies
needed in most cases.

If it still happens occasionally on specific videos, cookies are the
reliable fallback:

1. On a device where you're logged into YouTube, export cookies as a
   `cookies.txt` file (Netscape format) — e.g. via the "Get cookies.txt
   LOCALLY" browser extension.
2. Copy that file onto the machine/host running this bot.
3. Set `YTDLP_COOKIES_FILE=/path/to/cookies.txt` in `.env`.
4. Restart the bot.

Cookies expire eventually (usually weeks/months) — if the error comes
back later, just re-export and replace the file.

## Optional hosting notice

Set `SHOW_HOSTING_NOTICE=true` in `.env` to make `/start` send a second
message after the normal About message, warning that the bot runs on a
small free hosting plan and may go offline, with **Clone** and **Source
Code** buttons linking to the repo. Set to `false` (default) to skip it.
