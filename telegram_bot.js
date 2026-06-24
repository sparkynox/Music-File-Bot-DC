/**
 * telegram_bot.js
 *
 * /music <name or link> -> shows a thumbnail + inline keyboard (MP3 / Video).
 *   MP3 -> downloads audio directly.
 *   Video -> shows a resolution menu (144p/240p/360p free,
 *            480p/720p/1080p Premium-gated).
 * /search <name> -> paginated list of results (5 per page); picking one
 *   opens the same MP3/Video flow as /music.
 * /start -> About text with GitHub/Instagram link buttons.
 */

import TelegramBot from 'node-telegram-bot-api';
import { randomUUID } from 'crypto';
import fs from 'fs';

import * as engine from './music_engine.js';
import { checkCooldown, startCooldown } from './cooldown.js';
import {
  ABOUT_TEXT,
  GITHUB_URL,
  INSTAGRAM_URL,
  SHOW_HOSTING_NOTICE,
  HOSTING_NOTICE_TEXT,
  SOURCE_REPO_URL,
  PREMIUM_FEATURE_TEXT,
} from './bot_info.js';

const TELEGRAM_MAX_MB = parseInt(process.env.TELEGRAM_MAX_MB || '50', 10);
const SEARCH_PAGE_SIZE = 5;

// callback_data short id -> { query, requesterId, title }
const pendingQueries = new Map();
// callback_data short id -> { results, page, requesterId, query }
const pendingSearches = new Map();

function shortKey() {
  return randomUUID().slice(0, 10);
}

function formatKeyboard(key) {
  return {
    inline_keyboard: [
      [
        { text: '🎵 MP3', callback_data: `mp3:${key}` },
        { text: '🎬 Video', callback_data: `video:${key}` },
      ],
    ],
  };
}

function resolutionKeyboard(key) {
  return {
    inline_keyboard: [
      engine.FREE_VIDEO_RESOLUTIONS.map((res) => ({ text: res, callback_data: `res:${res}:${key}` })),
      engine.PREMIUM_VIDEO_RESOLUTIONS.map((res) => ({
        text: `💎 ${res}`,
        callback_data: `res:${res}:${key}`,
      })),
    ],
  };
}

function searchResultKeyboard(key, page, results) {
  const start = page * SEARCH_PAGE_SIZE;
  const pageResults = results.slice(start, start + SEARCH_PAGE_SIZE);
  const totalPages = Math.ceil(results.length / SEARCH_PAGE_SIZE);

  const resultButtons = pageResults.map((r, i) => [
    { text: `${start + i + 1}. ${r.title.slice(0, 60)}`, callback_data: `pick:${key}:${start + i}` },
  ]);

  const navRow = [
    { text: '◀ Prev', callback_data: page > 0 ? `pg:${key}:${page - 1}` : 'noop' },
    { text: `${page + 1}/${totalPages}`, callback_data: 'noop' },
    { text: 'Next ▶', callback_data: page + 1 < totalPages ? `pg:${key}:${page + 1}` : 'noop' },
  ];

  return { inline_keyboard: [...resultButtons, navRow] };
}

async function sendPreview(bot, chatId, title, thumbnailUrl, caption, keyboard) {
  if (thumbnailUrl) {
    try {
      return await bot.sendPhoto(chatId, thumbnailUrl, { caption, parse_mode: 'Markdown', reply_markup: keyboard });
    } catch {
      // fall through to text-only if the thumbnail URL fails to send
    }
  }
  return await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: keyboard });
}

export function buildTelegramBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/^\/start/, async (msg) => {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🐙 GitHub', url: GITHUB_URL },
          { text: '📸 Instagram', url: INSTAGRAM_URL },
        ],
      ],
    };
    await bot.sendMessage(msg.chat.id, ABOUT_TEXT, { parse_mode: 'Markdown', reply_markup: keyboard });

    if (SHOW_HOSTING_NOTICE) {
      const noticeKeyboard = {
        inline_keyboard: [
          [
            { text: 'Clone', url: SOURCE_REPO_URL },
            { text: 'Source Code', url: SOURCE_REPO_URL },
          ],
        ],
      };
      await bot.sendMessage(msg.chat.id, HOSTING_NOTICE_TEXT, { parse_mode: 'Markdown', reply_markup: noticeKeyboard });
    }
  });

  bot.onText(/^\/music(?:\s+(.+))?/, async (msg, match) => {
    const query = match && match[1] ? match[1].trim() : '';
    if (!query) {
      await bot.sendMessage(msg.chat.id, 'Usage: /music <song name or link>');
      return;
    }

    const remaining = checkCooldown(msg.from.id);
    if (remaining > 0) {
      await bot.sendMessage(msg.chat.id, `⏳ Slow down a bit — try again in ${remaining}s.`);
      return;
    }
    startCooldown(msg.from.id);

    let preview;
    try {
      preview = await engine.getPreview(query);
    } catch (err) {
      await bot.sendMessage(msg.chat.id, err instanceof engine.DownloadError ? `❌ ${err.message}` : '❌ Something went wrong looking that up.');
      return;
    }

    const key = shortKey();
    pendingQueries.set(key, { query: preview.url || query, requesterId: msg.from.id, title: preview.title });

    await sendPreview(bot, msg.chat.id, preview.title, preview.thumbnailUrl, `🔎 *${preview.title}* — pick a format:`, formatKeyboard(key));
  });

  bot.onText(/^\/search(?:\s+(.+))?/, async (msg, match) => {
    const query = match && match[1] ? match[1].trim() : '';
    if (!query) {
      await bot.sendMessage(msg.chat.id, 'Usage: /search <search term>');
      return;
    }

    const remaining = checkCooldown(msg.from.id);
    if (remaining > 0) {
      await bot.sendMessage(msg.chat.id, `⏳ Slow down a bit — try again in ${remaining}s.`);
      return;
    }
    startCooldown(msg.from.id);

    await bot.sendChatAction(msg.chat.id, 'typing');

    let results;
    try {
      results = await engine.searchVideos(query, 15);
    } catch (err) {
      await bot.sendMessage(msg.chat.id, err instanceof engine.DownloadError ? `❌ ${err.message}` : '❌ Search failed. Try again.');
      return;
    }

    if (results.length === 0) {
      await bot.sendMessage(msg.chat.id, `❌ No results found for "${query}".`);
      return;
    }

    const key = shortKey();
    pendingSearches.set(key, { results, page: 0, requesterId: msg.from.id, query });

    await bot.sendMessage(msg.chat.id, `🔎 Results for *${query}*:`, {
      parse_mode: 'Markdown',
      reply_markup: searchResultKeyboard(key, 0, results),
    });
  });

  bot.on('callback_query', async (query) => {
    const parts = (query.data || '').split(':');
    const action = parts[0];
    const chatId = query.message.chat.id;

    if (action === 'noop') {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // --- Search pagination ---
    if (action === 'pg') {
      const key = parts[1];
      const page = parseInt(parts[2], 10);
      const session = pendingSearches.get(key);
      if (!session) {
        await bot.answerCallbackQuery(query.id, { text: 'This search expired, run /search again.', show_alert: true });
        return;
      }
      if (query.from.id !== session.requesterId) {
        await bot.answerCallbackQuery(query.id, { text: 'Only the person who searched can change pages.', show_alert: true });
        return;
      }
      session.page = page;
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageReplyMarkup(searchResultKeyboard(key, page, session.results), {
        chat_id: chatId,
        message_id: query.message.message_id,
      });
      return;
    }

    // --- Search result picked ---
    if (action === 'pick') {
      const key = parts[1];
      const index = parseInt(parts[2], 10);
      const session = pendingSearches.get(key);
      if (!session) {
        await bot.answerCallbackQuery(query.id, { text: 'This search expired, run /search again.', show_alert: true });
        return;
      }
      if (query.from.id !== session.requesterId) {
        await bot.answerCallbackQuery(query.id, { text: 'Only the person who searched can pick a result.', show_alert: true });
        return;
      }

      const picked = session.results[index];
      pendingSearches.delete(key);

      if (!picked) {
        await bot.answerCallbackQuery(query.id, { text: 'That result is no longer available.', show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });

      const newKey = shortKey();
      pendingQueries.set(newKey, { query: picked.url, requesterId: query.from.id, title: picked.title });

      await sendPreview(bot, chatId, picked.title, picked.thumbnailUrl, `🔎 *${picked.title}* — pick a format:`, formatKeyboard(newKey));
      return;
    }

    // --- MP3 ---
    if (action === 'mp3') {
      const key = parts[1];
      const entry = pendingQueries.get(key);
      if (!entry) {
        await bot.answerCallbackQuery(query.id, { text: 'This request expired, run /music again.', show_alert: true });
        return;
      }
      if (query.from.id !== entry.requesterId) {
        await bot.answerCallbackQuery(query.id, { text: 'Only the person who ran /music can pick the format.', show_alert: true });
        return;
      }

      pendingQueries.delete(key);
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
      await bot.sendChatAction(chatId, 'upload_voice');

      let result;
      try {
        result = await engine.downloadAudio(entry.query, 'mp3');
      } catch (err) {
        await bot.sendMessage(chatId, err instanceof engine.DownloadError ? `❌ ${err.message}` : '❌ Something went wrong downloading that. Try again.');
        if (!(err instanceof engine.DownloadError)) console.error(err);
        return;
      }

      try {
        if (engine.tooLarge(result, TELEGRAM_MAX_MB)) {
          await bot.sendMessage(chatId, `❌ **${result.title}** is ${engine.humanSize(result.sizeBytes)}, over the ${TELEGRAM_MAX_MB}MB limit. Try a shorter track.`);
          return;
        }
        await bot.sendAudio(chatId, fs.createReadStream(result.path), { title: result.title });
      } finally {
        engine.safeDelete(result.path);
      }
      return;
    }

    // --- Video: show resolution menu ---
    if (action === 'video') {
      const key = parts[1];
      const entry = pendingQueries.get(key);
      if (!entry) {
        await bot.answerCallbackQuery(query.id, { text: 'This request expired, run /music again.', show_alert: true });
        return;
      }
      if (query.from.id !== entry.requesterId) {
        await bot.answerCallbackQuery(query.id, { text: 'Only the person who ran /music can pick the format.', show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      await bot.editMessageReplyMarkup(resolutionKeyboard(key), {
        chat_id: chatId,
        message_id: query.message.message_id,
      });
      return;
    }

    // --- Resolution choice ---
    if (action === 'res') {
      const resolution = parts[1];
      const key = parts[2];
      const entry = pendingQueries.get(key);

      if (!entry) {
        await bot.answerCallbackQuery(query.id, { text: 'This request expired, run /music again.', show_alert: true });
        return;
      }
      if (query.from.id !== entry.requesterId) {
        await bot.answerCallbackQuery(query.id, { text: 'Only the person who ran /music can pick the resolution.', show_alert: true });
        return;
      }

      if (engine.PREMIUM_VIDEO_RESOLUTIONS.includes(resolution)) {
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, PREMIUM_FEATURE_TEXT, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '📸 Contact on Instagram', url: INSTAGRAM_URL }]] },
        });
        return;
      }

      pendingQueries.delete(key);
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
      await bot.sendChatAction(chatId, 'upload_video');

      let result;
      try {
        result = await engine.downloadVideo(entry.query, resolution);
      } catch (err) {
        await bot.sendMessage(chatId, err instanceof engine.DownloadError ? `❌ ${err.message}` : '❌ Something went wrong downloading that. Try again.');
        if (!(err instanceof engine.DownloadError)) console.error(err);
        return;
      }

      try {
        if (engine.tooLarge(result, TELEGRAM_MAX_MB)) {
          await bot.sendMessage(chatId, `❌ **${result.title}** (${resolution}) is ${engine.humanSize(result.sizeBytes)}, over the ${TELEGRAM_MAX_MB}MB limit. Try a lower resolution.`);
          return;
        }
        await bot.sendVideo(chatId, fs.createReadStream(result.path), { caption: `${result.title} (${resolution})` });
      } finally {
        engine.safeDelete(result.path);
      }
    }
  });

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
  });

  return bot;
}

export async function runTelegramBot(token) {
  buildTelegramBot(token);
  console.log('Telegram bot started');
  await new Promise(() => {});
}
