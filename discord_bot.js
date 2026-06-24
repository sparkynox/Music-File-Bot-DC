/**
 * discord_bot.js
 *
 * /music <name or link> -> shows a thumbnail + two buttons (MP3 / Video).
 *   MP3 -> downloads audio directly.
 *   Video -> shows a resolution menu (144p/240p/360p free,
 *            480p/720p/1080p Premium-gated), still with the thumbnail.
 * /search <name> -> paginated list of results (5 per page); picking one
 *   opens the same MP3/Video flow as /music.
 * /start -> About text with GitHub/Instagram link buttons.
 * No voice channel connection at any point.
 */

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  Events,
} from 'discord.js';

import * as engine from './music_engine.js';
import { checkCooldown, startCooldown } from './cooldown.js';
import { getWelcomeConfig, setWelcomeConfig } from './welcome_store.js';
import {
  ABOUT_TEXT,
  GITHUB_URL,
  INSTAGRAM_URL,
  SHOW_HOSTING_NOTICE,
  HOSTING_NOTICE_TEXT,
  SOURCE_REPO_URL,
  PREMIUM_FEATURE_TEXT,
} from './bot_info.js';

const DISCORD_MAX_MB = parseInt(process.env.DISCORD_MAX_MB || '10', 10);
const SEARCH_PAGE_SIZE = 5;

const commands = [
  new SlashCommandBuilder().setName('start').setDescription('About this bot'),
  new SlashCommandBuilder()
    .setName('music')
    .setDescription('Get a song as an audio file (no voice channel)')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name or a direct link').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search YouTube and pick a result')
    .addStringOption((o) => o.setName('query').setDescription('Search term').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setwelcome')
    .setDescription('Set up a welcome message for new members (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

async function registerCommands(token, clientId) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}

function formatChoiceRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fmt_mp3').setLabel('🎵 MP3').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('fmt_video').setLabel('🎬 Video').setStyle(ButtonStyle.Secondary)
  );
}

function resolutionMenuRows() {
  const freeRow = new ActionRowBuilder().addComponents(
    ...engine.FREE_VIDEO_RESOLUTIONS.map((res) =>
      new ButtonBuilder().setCustomId(`res_${res}`).setLabel(res).setStyle(ButtonStyle.Success)
    )
  );
  const premiumRow = new ActionRowBuilder().addComponents(
    ...engine.PREMIUM_VIDEO_RESOLUTIONS.map((res) =>
      new ButtonBuilder().setCustomId(`res_${res}`).setLabel(`💎 ${res}`).setStyle(ButtonStyle.Secondary)
    )
  );
  return [freeRow, premiumRow];
}

function premiumLinkRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('📸 Contact on Instagram').setStyle(ButtonStyle.Link).setURL(INSTAGRAM_URL)
  );
}

function thumbnailEmbed(title, thumbnailUrl) {
  const embed = new EmbedBuilder().setTitle(title).setColor(0x5865f2);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  return embed;
}

// query/requester per message, keyed by the message id the buttons are attached to
const pendingQueries = new Map();

// search session per message id: { results, page, requesterId }
const pendingSearches = new Map();

// /setwelcome conversation state per (guildId:userId): { step, channelId, imageUrl, messageTemplate }
const welcomeSetupSessions = new Map();
const WELCOME_SETUP_TIMEOUT_MS = 5 * 60 * 1000;

function welcomeSessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function fillWelcomeTemplate(template, member) {
  return template
    .replaceAll('{user}', member.toString())
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{membercount}', String(member.guild.memberCount));
}

async function deliverAudio(interaction, query) {
  let result;
  try {
    result = await engine.downloadAudio(query, 'mp3');
  } catch (err) {
    if (err instanceof engine.DownloadError) {
      await interaction.followUp(`❌ ${err.message}`);
    } else {
      console.error(err);
      await interaction.followUp('❌ Something went wrong downloading that. Try again.');
    }
    return;
  }

  try {
    if (engine.tooLarge(result, DISCORD_MAX_MB)) {
      await interaction.followUp(
        `❌ **${result.title}** is ${engine.humanSize(result.sizeBytes)}, which is over this server's ${DISCORD_MAX_MB}MB limit. Try a shorter track.`
      );
      return;
    }

    const safeName = `${result.title.slice(0, 80)}.${result.ext}`;
    const attachment = new AttachmentBuilder(result.path, { name: safeName });
    await interaction.followUp({ content: `🎶 **${result.title}**`, files: [attachment] });
  } finally {
    engine.safeDelete(result.path);
  }
}

async function deliverVideo(interaction, query, resolution) {
  let result;
  try {
    result = await engine.downloadVideo(query, resolution);
  } catch (err) {
    if (err instanceof engine.DownloadError) {
      await interaction.followUp(`❌ ${err.message}`);
    } else {
      console.error(err);
      await interaction.followUp('❌ Something went wrong downloading that. Try again.');
    }
    return;
  }

  try {
    if (engine.tooLarge(result, DISCORD_MAX_MB)) {
      await interaction.followUp(
        `❌ **${result.title}** (${resolution}) is ${engine.humanSize(result.sizeBytes)}, which is over this server's ${DISCORD_MAX_MB}MB limit. Try a lower resolution.`
      );
      return;
    }

    const safeName = `${result.title.slice(0, 80)}.${result.ext}`;
    const attachment = new AttachmentBuilder(result.path, { name: safeName });
    await interaction.followUp({ content: `🎬 **${result.title}** (${resolution})`, files: [attachment] });
  } finally {
    engine.safeDelete(result.path);
  }
}

function searchResultRows(sessionKey, page, results) {
  const start = page * SEARCH_PAGE_SIZE;
  const pageResults = results.slice(start, start + SEARCH_PAGE_SIZE);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`pick_${sessionKey}`)
    .setPlaceholder('Pick a result...')
    .addOptions(
      pageResults.map((r, i) => ({
        label: `${start + i + 1}. ${r.title.slice(0, 90)}`,
        value: String(start + i),
      }))
    );
  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

  const totalPages = Math.ceil(results.length / SEARCH_PAGE_SIZE);
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`page_${sessionKey}_${page - 1}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId('page_noop')
      .setLabel(`${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`page_${sessionKey}_${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page + 1 >= totalPages)
  );

  return [selectRow, navRow];
}

export function buildDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    try {
      await registerCommands(process.env.DISCORD_TOKEN, c.user.id);
    } catch (err) {
      console.error('Failed to register Discord slash commands:', err);
    }
    console.log(`Discord bot logged in as ${c.user.tag}`);
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const config = getWelcomeConfig(member.guild.id);
      if (!config) return;

      const channel = await member.guild.channels.fetch(config.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const text = fillWelcomeTemplate(config.messageTemplate, member);
      await channel.send({ content: text, files: config.imageUrl ? [config.imageUrl] : [] });
    } catch (err) {
      console.error('Failed to send welcome message:', err);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;

    const key = welcomeSessionKey(message.guild.id, message.author.id);
    const session = welcomeSetupSessions.get(key);
    if (!session) return;

    if (Date.now() - session.startedAt > WELCOME_SETUP_TIMEOUT_MS) {
      welcomeSetupSessions.delete(key);
      await message.reply('⌛ Welcome setup timed out. Run /setwelcome again.');
      return;
    }

    if (message.channelId !== session.channelId) return;

    if (session.step === 'awaiting_image') {
      const attachment = message.attachments.find((a) =>
        /\.(png|gif|mp4|jpg|jpeg|webp)$/i.test(a.name || a.url)
      );
      if (!attachment) {
        await message.reply('❌ Please upload a PNG, GIF, JPG, or MP4 attachment.');
        return;
      }

      session.imageUrl = attachment.url;
      session.step = 'awaiting_message';
      session.startedAt = Date.now();
      await message.reply(
        '✅ Got the image. Now send the welcome message text.\n' +
          'You can use `{user}`, `{server}`, and `{membercount}` as placeholders.'
      );
      return;
    }

    if (session.step === 'awaiting_message') {
      session.messageTemplate = message.content;
      session.step = 'awaiting_confirm';

      const previewText = session.messageTemplate
        .replaceAll('{user}', message.author.toString())
        .replaceAll('{server}', message.guild.name)
        .replaceAll('{membercount}', String(message.guild.memberCount));

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`welcome_confirm_${message.author.id}`).setLabel('✅ Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`welcome_cancel_${message.author.id}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
      );

      await message.reply({
        content: `**Preview:**\n${previewText}`,
        files: [session.imageUrl],
        components: [confirmRow],
      });
      return;
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'start') {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🐙 GitHub').setStyle(ButtonStyle.Link).setURL(GITHUB_URL),
            new ButtonBuilder().setLabel('📸 Instagram').setStyle(ButtonStyle.Link).setURL(INSTAGRAM_URL)
          );
          await interaction.reply({ content: ABOUT_TEXT, components: [row] });

          if (SHOW_HOSTING_NOTICE) {
            const noticeRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setLabel('Clone').setStyle(ButtonStyle.Link).setURL(SOURCE_REPO_URL),
              new ButtonBuilder().setLabel('Source Code').setStyle(ButtonStyle.Link).setURL(SOURCE_REPO_URL)
            );
            await interaction.followUp({ content: HOSTING_NOTICE_TEXT, components: [noticeRow] });
          }
          return;
        }

        if (interaction.commandName === 'music') {
          const remaining = checkCooldown(interaction.user.id);
          if (remaining > 0) {
            await interaction.reply({ content: `⏳ Slow down a bit — try again in ${remaining}s.`, ephemeral: true });
            return;
          }
          startCooldown(interaction.user.id);

          const query = interaction.options.getString('query', true);
          await interaction.reply({ content: `🔎 Looking up **${query}**...` });

          let preview;
          try {
            preview = await engine.getPreview(query);
          } catch (err) {
            const msg = err instanceof engine.DownloadError ? err.message : 'Something went wrong looking that up.';
            await interaction.editReply({ content: `❌ ${msg}` });
            return;
          }

          const embed = thumbnailEmbed(preview.title, preview.thumbnailUrl);
          const reply = await interaction.editReply({
            content: `🔎 **${preview.title}** — pick a format:`,
            embeds: [embed],
            components: [formatChoiceRow()],
          });
          pendingQueries.set(reply.id, { query: preview.url || query, requesterId: interaction.user.id, title: preview.title });
          return;
        }

        if (interaction.commandName === 'search') {
          const remaining = checkCooldown(interaction.user.id);
          if (remaining > 0) {
            await interaction.reply({ content: `⏳ Slow down a bit — try again in ${remaining}s.`, ephemeral: true });
            return;
          }
          startCooldown(interaction.user.id);

          const query = interaction.options.getString('query', true);
          await interaction.reply({ content: `🔎 Searching for **${query}**...` });
          const reply = await interaction.fetchReply();

          let results;
          try {
            results = await engine.searchVideos(query, 15);
          } catch (err) {
            const msg = err instanceof engine.DownloadError ? err.message : 'Search failed. Try again.';
            await interaction.editReply({ content: `❌ ${msg}` });
            return;
          }

          if (results.length === 0) {
            await interaction.editReply({ content: `❌ No results found for "${query}".` });
            return;
          }

          const sessionKey = reply.id;
          pendingSearches.set(sessionKey, { results, page: 0, requesterId: interaction.user.id });
          await interaction.editReply({
            content: `🔎 Results for **${query}**:`,
            components: searchResultRows(sessionKey, 0, results),
          });
          return;
        }

        if (interaction.commandName === 'setwelcome') {
          if (!interaction.guild) {
            await interaction.reply({ content: '❌ This command only works in a server.', ephemeral: true });
            return;
          }

          const key = welcomeSessionKey(interaction.guild.id, interaction.user.id);
          welcomeSetupSessions.set(key, {
            step: 'awaiting_image',
            channelId: interaction.channelId,
            startedAt: Date.now(),
          });

          await interaction.reply({
            content:
              '🖼️ Send the welcome image/GIF now (upload a PNG, GIF, or MP4 as an attachment in this channel).\n' +
              'You have 5 minutes.',
          });
          return;
        }
      }

      // --- /setwelcome conversational steps (plain messages, not slash commands) ---
      // handled via the messageCreate listener below, not here.

      if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId;

        if (customId.startsWith('pick_')) {
          const sessionKey = customId.slice('pick_'.length);
          const index = parseInt(interaction.values[0], 10);

          const session = pendingSearches.get(sessionKey);
          if (!session) {
            await interaction.reply({ content: '❌ This search expired, run /search again.', ephemeral: true });
            return;
          }
          if (interaction.user.id !== session.requesterId) {
            await interaction.reply({ content: '❌ Only the person who searched can pick a result.', ephemeral: true });
            return;
          }

          const picked = session.results[index];
          pendingSearches.delete(sessionKey);

          if (!picked) {
            await interaction.update({ content: '❌ That result is no longer available.', components: [] });
            return;
          }

          const embed = thumbnailEmbed(picked.title, picked.thumbnailUrl);
          await interaction.update({
            content: `🔎 **${picked.title}** — pick a format:`,
            embeds: [embed],
            components: [formatChoiceRow()],
          });
          pendingQueries.set(interaction.message.id, { query: picked.url, requesterId: interaction.user.id, title: picked.title });
          return;
        }
      }

      if (interaction.isButton()) {
        const customId = interaction.customId;

        // --- /setwelcome confirm/cancel ---
        if (customId.startsWith('welcome_confirm_') || customId.startsWith('welcome_cancel_')) {
          const ownerId = customId.split('_').pop();
          if (interaction.user.id !== ownerId) {
            await interaction.reply({ content: '❌ Only the person setting this up can confirm or cancel.', ephemeral: true });
            return;
          }
          if (!interaction.guild) return;

          const key = welcomeSessionKey(interaction.guild.id, interaction.user.id);
          const session = welcomeSetupSessions.get(key);
          if (!session || session.step !== 'awaiting_confirm') {
            await interaction.reply({ content: '❌ This setup session expired. Run /setwelcome again.', ephemeral: true });
            return;
          }

          welcomeSetupSessions.delete(key);

          if (customId.startsWith('welcome_cancel_')) {
            await interaction.update({ content: '❌ Welcome setup cancelled.', components: [] });
            return;
          }

          setWelcomeConfig(interaction.guild.id, {
            channelId: session.channelId,
            imageUrl: session.imageUrl,
            messageTemplate: session.messageTemplate,
          });

          await interaction.update({ content: '✅ Welcome message saved! New members will see this from now on.', components: [] });
          return;
        }

        // --- Search pagination ---
        if (customId.startsWith('page_') && customId !== 'page_noop') {
          const [, sessionKey, pageStr] = customId.split('_');
          const session = pendingSearches.get(sessionKey);
          if (!session) {
            await interaction.reply({ content: '❌ This search expired, run /search again.', ephemeral: true });
            return;
          }
          if (interaction.user.id !== session.requesterId) {
            await interaction.reply({ content: '❌ Only the person who searched can change pages.', ephemeral: true });
            return;
          }
          session.page = parseInt(pageStr, 10);
          await interaction.update({ components: searchResultRows(sessionKey, session.page, session.results) });
          return;
        }

        const messageId = interaction.message.id;
        const entry = pendingQueries.get(messageId);

        // MP3 / Video top-level choice
        if (customId === 'fmt_mp3' || customId === 'fmt_video') {
          if (!entry) {
            await interaction.reply({ content: '❌ This request expired, run /music again.', ephemeral: true });
            return;
          }
          if (interaction.user.id !== entry.requesterId) {
            await interaction.reply({ content: '❌ Only the person who ran the command can choose the format.', ephemeral: true });
            return;
          }

          if (customId === 'fmt_mp3') {
            pendingQueries.delete(messageId);
            await interaction.update({ components: [] });
            await deliverAudio(interaction, entry.query);
            return;
          }

          // Video -> show resolution menu, keep the entry alive for the next click
          await interaction.update({
            content: `🔎 **${entry.title || entry.query}** — pick a resolution:`,
            components: resolutionMenuRows(),
          });
          return;
        }

        // Resolution choice
        if (customId.startsWith('res_')) {
          if (!entry) {
            await interaction.reply({ content: '❌ This request expired, run /music again.', ephemeral: true });
            return;
          }
          if (interaction.user.id !== entry.requesterId) {
            await interaction.reply({ content: '❌ Only the person who ran the command can choose the resolution.', ephemeral: true });
            return;
          }

          const resolution = customId.replace('res_', '');

          if (engine.PREMIUM_VIDEO_RESOLUTIONS.includes(resolution)) {
            await interaction.reply({ content: PREMIUM_FEATURE_TEXT, components: [premiumLinkRow()], ephemeral: true });
            return;
          }

          pendingQueries.delete(messageId);
          await interaction.update({ components: [] });
          await deliverVideo(interaction, entry.query, resolution);
        }
      }
    } catch (err) {
      console.error('Interaction handler error:', err);
    }
  });

  return client;
}

export async function runDiscordBot(token) {
  const client = buildDiscordClient();
  await client.login(token);
}
