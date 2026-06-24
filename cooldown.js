/**
 * cooldown.js
 *
 * Simple in-memory per-user cooldown tracker, shared between both bots.
 * Used to rate-limit /music to one request every COOLDOWN_SECONDS per user.
 */

const COOLDOWN_SECONDS = parseInt(process.env.MUSIC_COOLDOWN_SECONDS || '10', 10);

// userId -> timestamp (ms) of when their cooldown ends
const lastUsed = new Map();

/**
 * Checks if `userId` is currently on cooldown.
 * Returns 0 if they're free to proceed, or the number of seconds
 * remaining (rounded up) if they need to wait.
 */
export function checkCooldown(userId) {
  const now = Date.now();
  const readyAt = lastUsed.get(userId) || 0;
  if (now >= readyAt) {
    return 0;
  }
  return Math.ceil((readyAt - now) / 1000);
}

/** Starts the cooldown window for `userId`, beginning now. */
export function startCooldown(userId) {
  lastUsed.set(userId, Date.now() + COOLDOWN_SECONDS * 1000);
}

export { COOLDOWN_SECONDS };
