/**
 * bot_info.js
 *
 * Shared "About" content for the /start command, used by both the
 * Discord and Telegram bots so the text and links stay in sync.
 */

export const GITHUB_URL = 'https://github.com/sparkynox';
export const INSTAGRAM_URL = 'https://instagram.com/sparkynox01';
export const SOURCE_REPO_URL = 'https://github.com/sparkynox/Music-File-Bot-DC';

export const ABOUT_TEXT =
  "🎶 **Music File Bot**\n\n" +
  "Send me a song name or a direct link with `/music`, pick a format, " +
  "and I'll send you the audio file directly — no voice channel needed.\n\n" +
  '**Formats:** MP3 or original best quality\n' +
  '**Made by:** SparkyNox\n\n' +
  'Built with Node.js, yt-dlp, and a healthy dislike of voice-channel bots 🎧';

// Toggle via SHOW_HOSTING_NOTICE=true/false in .env
export const SHOW_HOSTING_NOTICE = process.env.SHOW_HOSTING_NOTICE === 'true';

export const HOSTING_NOTICE_TEXT =
  '⚠️ **Heads up:** this bot runs on a small 700MB hosting plan, so it ' +
  "may occasionally go offline. If that happens, or if you'd like to run " +
  'your own copy, you can clone it from the source code below.';
