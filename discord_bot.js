/**
 * discord_bot.js
 *
 * /music <name or link> -> shows two buttons (MP3 / Best Quality).
 * On tap, downloads the audio and sends it as a file attachment.
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
  Events,
} from 'discord.js';

import * as engine from './music_engine.js';
import {
  ABOUT_TEXT,
  GITHUB_URL,
  INSTAGRAM_URL,
  SHOW_HOSTING_NOTICE,
  HOSTING_NOTICE_TEXT,
  SOURCE_REPO_URL,
} from './bot_info.js';

const DISCORD_MAX_MB = parseInt(process.env.DISCORD_MAX_MB || '10', 10);

const commands = [
  new SlashCommandBuilder().setName('start').setDescription('About this bot'),
  new SlashCommandBuilder()
    .setName('music')
    .setDescription('Get a song as an audio file (no voice channel)')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name or a direct link').setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands(token, clientId) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}

function formatChoiceRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fmt_mp3').setLabel('🎵 MP3').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('fmt_best').setLabel('⭐ Best Quality').setStyle(ButtonStyle.Secondary)
  );
}

// query/requester per message, keyed by the message id the buttons are attached to
const pendingQueries = new Map();

async function deliverAudio(interaction, query, fmt) {
  let result;
  try {
    result = await engine.downloadAudio(query, fmt);
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

export function buildDiscordClient() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (c) => {
    try {
      await registerCommands(process.env.DISCORD_TOKEN, c.user.id);
    } catch (err) {
      console.error('Failed to register Discord slash commands:', err);
    }
    console.log(`Discord bot logged in as ${c.user.tag}`);
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
          const query = interaction.options.getString('query', true);
          const reply = await interaction.reply({
            content: `🔎 **${query}** — pick a format:`,
            components: [formatChoiceRow()],
            fetchReply: true,
          });
          pendingQueries.set(reply.id, { query, requesterId: interaction.user.id });
          return;
        }
      }

      if (interaction.isButton()) {
        if (interaction.customId === 'fmt_mp3' || interaction.customId === 'fmt_best') {
          const entry = pendingQueries.get(interaction.message.id);
          if (!entry) {
            await interaction.reply({ content: '❌ This request expired, run /music again.', ephemeral: true });
            return;
          }
          if (interaction.user.id !== entry.requesterId) {
            await interaction.reply({
              content: '❌ Only the person who ran the command can choose the format.',
              ephemeral: true,
            });
            return;
          }

          pendingQueries.delete(interaction.message.id);
          const fmt = interaction.customId === 'fmt_mp3' ? 'mp3' : 'best';

          // disable buttons
          const disabledRow = new ActionRowBuilder().addComponents(
            ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
            ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true)
          );
          await interaction.update({ components: [disabledRow] });

          await deliverAudio(interaction, entry.query, fmt);
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
