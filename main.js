/**
 * main.js
 *
 * Runs the Discord bot and Telegram bot together in a single process.
 * Both share music_engine.js for downloading.
 *
 * Usage:
 *   node main.js
 */

import 'dotenv/config';
import * as engine from './music_engine.js';
import { ensureYtDlp, ensureFfmpeg } from './ensure_binaries.js';
import { runDiscordBot } from './discord_bot.js';
import { runTelegramBot } from './telegram_bot.js';

async function main() {
  engine.cleanupStaleFiles();

  console.log('Checking yt-dlp / ffmpeg availability...');
  try {
    await ensureYtDlp();
    await ensureFfmpeg();
    console.log('yt-dlp and ffmpeg ready.');
  } catch (err) {
    console.error('Failed to prepare yt-dlp/ffmpeg:', err.message);
    console.error('The bots will still start, but downloads will fail until this is fixed.');
  }

  const discordToken = process.env.DISCORD_TOKEN;
  const telegramToken = process.env.TELEGRAM_TOKEN;

  const tasks = [];

  if (discordToken && discordToken !== 'your_discord_bot_token_here') {
    tasks.push(runDiscordBot(discordToken).catch((err) => console.error('Discord bot crashed:', err)));
  } else {
    console.warn('DISCORD_TOKEN not set — Discord bot will not start.');
  }

  if (telegramToken && telegramToken !== 'your_telegram_bot_token_here') {
    tasks.push(runTelegramBot(telegramToken).catch((err) => console.error('Telegram bot crashed:', err)));
  } else {
    console.warn('TELEGRAM_TOKEN not set — Telegram bot will not start.');
  }

  if (tasks.length === 0) {
    console.error('Neither token is set. Fill in .env and try again.');
    process.exit(1);
  }

  await Promise.all(tasks);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('Shutting down.');
  process.exit(0);
});
