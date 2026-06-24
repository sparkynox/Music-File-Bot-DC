/**
 * welcome_store.js
 *
 * Persists per-guild welcome message config to a JSON file on disk,
 * so settings survive bot restarts. One entry per guild:
 *   { channelId, imageUrl, messageTemplate }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, 'welcome_config.json');

function loadAll() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read welcome_config.json, starting fresh:', err.message);
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/** Returns { channelId, imageUrl, messageTemplate } or null if not configured. */
export function getWelcomeConfig(guildId) {
  const all = loadAll();
  return all[guildId] || null;
}

/** Saves/overwrites the welcome config for a guild. */
export function setWelcomeConfig(guildId, config) {
  const all = loadAll();
  all[guildId] = config;
  saveAll(all);
}

/** Removes welcome config for a guild (e.g. if an admin wants to disable it). */
export function clearWelcomeConfig(guildId) {
  const all = loadAll();
  delete all[guildId];
  saveAll(all);
}
