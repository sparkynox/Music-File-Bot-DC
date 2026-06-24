# Music File Bot (Discord + Telegram, single codebase) — Node.js version

Same bot as the Python version, ported to Node.js 20+ for free JS hosts.
No voice channel join. `/music <name or link>` → bot downloads the audio
and replies with the file itself (MP3 or best-quality original).

## Files
- `music_engine.js` — shared download logic (shells out to the `yt-dlp` CLI + ffmpeg)
- `ensure_binaries.js` — auto-downloads yt-dlp/ffmpeg if not found on PATH
- `cooldown.js` — per-user cooldown tracker for /music and /search
- `welcome_store.js` — JSON file persistence for /setwelcome config (survives restarts)
- `bot_info.js` — shared About text + GitHub/Instagram links for /start
- `discord_bot.js` — Discord slash commands `/start`, `/music`, `/search`, `/setwelcome`
- `telegram_bot.js` — Telegram commands `/start`, `/music`, `/search`
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

**`/music <name or link>`**
1. Bot looks up the song and shows a thumbnail with two buttons: **🎵 MP3** and **🎬 Video**.
2. **MP3** → downloads and sends the audio file directly.
3. **Video** → shows a resolution menu (still with the thumbnail):
   - **144p / 240p / 360p** — free, downloads and sends the video (max 50MB by default, configurable via `DISCORD_MAX_MB` / `TELEGRAM_MAX_MB`)
   - **480p / 720p / 1080p** — marked 💎 Premium. Tapping these doesn't download anything; the bot replies with a message saying it's a Premium feature, with a button to contact on Instagram.

**`/search <name>`**
1. Bot searches YouTube and shows up to 15 results, 5 per page, with **◀ Prev** / **Next ▶** buttons.
2. Tapping a result opens the same thumbnail + MP3/Video flow as `/music`.

Downloaded files are deleted from disk immediately after sending (and
anything older than 10 minutes is auto-cleaned on startup, in case a
previous run crashed mid-send).

## Cooldown

Each user can run `/music` or `/search` once every `MUSIC_COOLDOWN_SECONDS`
(default 10s, set in `.env`). This only limits how often a new search/lookup
can be started — it doesn't affect button taps (MP3/Video/resolution/page)
on an already-open request.

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

## /setwelcome (admin only)

Lets a server admin (anyone with **Manage Server** permission) set up a
welcome message for new members:

1. Run `/setwelcome` in the channel you want welcome messages to appear in.
2. Bot asks for an image — upload a PNG, GIF, JPG, or MP4 attachment.
3. Bot asks for the message text. You can use:
   - `{user}` — mentions the new member
   - `{server}` — the server's name
   - `{membercount}` — current member count
4. Bot shows a preview with **✅ Confirm** / **❌ Cancel** buttons.
5. On confirm, the config is saved to `welcome_config.json` next to the
   bot's files — it survives restarts. Running `/setwelcome` again
   overwrites the previous config for that server.

   ⚠️ Some free hosts wipe the filesystem on every redeploy (not just
   restarts). If that's the case for your host, `welcome_config.json`
   will reset on the next deploy and you'll need to run `/setwelcome`
   again. Restarts alone (the process crashing and coming back up) are
   fine — it's a fresh deploy/rebuild that can wipe it depending on the host.

**Discord Developer Portal setup required:** this feature needs the
**Server Members Intent** and **Message Content Intent** turned on for
your bot. Go to your application at https://discord.com/developers/applications
→ your bot → **Bot** tab → enable both under "Privileged Gateway Intents",
then save. Without this, `/setwelcome` and new-member detection won't work.

## Optional hosting notice

Set `SHOW_HOSTING_NOTICE=true` in `.env` to make `/start` send a second
message after the normal About message, warning that the bot runs on a
small free hosting plan and may go offline, with **Clone** and **Source
Code** buttons linking to the repo. Set to `false` (default) to skip it.
