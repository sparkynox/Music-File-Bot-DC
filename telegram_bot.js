/**
 * telegram_bot.js
 *
 * /music <name or link> -> inline keyboard with MP3 / Best Quality.
 * On tap, downloads the audio and sends it as an audio file.
 * /start -> About text with GitHub/Instagram link buttons.
 */

import TelegramBot from 'node-telegram-bot-api';
import { randomUUID } from 'crypto';
import fs from 'fs';

import * as engine from './music_engine.js';
import {
  ABOUT_TEXT,
  GITHUB_URL,
  INSTAGRAM_URL,
  SHOW_HOSTING_NOTICE,
  HOSTING_NOTICE_TEXT,
  SOURCE_REPO_URL,
} from './bot_info.js';

const TELEGRAM_MAX_MB = parseInt(process.env.TELEGRAM_MAX_MB || '50', 10);

// callback_data short id -> { query, requesterId }
const pendingQueries = new Map();

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
    await bot.sendMessage(msg.chat.id, ABOUT_TEXT, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });

    if (SHOW_HOSTING_NOTICE) {
      const noticeKeyboard = {
        inline_keyboard: [
          [
            { text: 'Clone', url: SOURCE_REPO_URL },
            { text: 'Source Code', url: SOURCE_REPO_URL },
          ],
        ],
      };
      await bot.sendMessage(msg.chat.id, HOSTING_NOTICE_TEXT, {
        parse_mode: 'Markdown',
        reply_markup: noticeKeyboard,
      });
    }
  });

  bot.onText(/^\/music(?:\s+(.+))?/, async (msg, match) => {
    const query = match && match[1] ? match[1].trim() : '';
    if (!query) {
      await bot.sendMessage(msg.chat.id, 'Usage: /music <song name or link>');
      return;
    }

    const key = randomUUID().slice(0, 12);
    pendingQueries.set(key, { query, requesterId: msg.from.id });

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎵 MP3', callback_data: `mp3:${key}` },
          { text: '⭐ Best Quality', callback_data: `best:${key}` },
        ],
      ],
    };
    await bot.sendMessage(msg.chat.id, `🔎 ${query} — pick a format:`, { reply_markup: keyboard });
  });

  bot.on('callback_query', async (query) => {
    const [fmt, key] = (query.data || '').split(':');
    const entry = pendingQueries.get(key);

    if (!entry) {
      await bot.answerCallbackQuery(query.id, {
        text: 'This request expired, run /music again.',
        show_alert: true,
      });
      return;
    }

    if (query.from.id !== entry.requesterId) {
      await bot.answerCallbackQuery(query.id, {
        text: 'Only the person who ran /music can pick the format.',
        show_alert: true,
      });
      return;
    }

    pendingQueries.delete(key);
    await bot.answerCallbackQuery(query.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });

    const chatId = query.message.chat.id;
    await bot.sendChatAction(chatId, 'upload_voice');

    let result;
    try {
      result = await engine.downloadAudio(entry.query, fmt);
    } catch (err) {
      if (err instanceof engine.DownloadError) {
        await bot.sendMessage(chatId, `❌ ${err.message}`);
      } else {
        console.error(err);
        await bot.sendMessage(chatId, '❌ Something went wrong downloading that. Try again.');
      }
      return;
    }

    try {
      if (engine.tooLarge(result, TELEGRAM_MAX_MB)) {
        await bot.sendMessage(
          chatId,
          `❌ **${result.title}** is ${engine.humanSize(result.sizeBytes)}, over the ${TELEGRAM_MAX_MB}MB limit. Try a shorter track.`
        );
        return;
      }

      await bot.sendAudio(chatId, fs.createReadStream(result.path), {
        title: result.title,
      });
    } finally {
      engine.safeDelete(result.path);
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
  // node-telegram-bot-api keeps the process alive via polling internally;
  // nothing further to await here.
  await new Promise(() => {}); // keep this function "running" for Promise.all in main.js
}
