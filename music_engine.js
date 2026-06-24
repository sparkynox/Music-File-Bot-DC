/**
 * music_engine.js
 *
 * Shared download logic used by both the Discord and Telegram bots.
 * No voice-channel streaming — this only ever downloads a single audio
 * file to disk and hands the path back to the caller, which sends it
 * as a normal file attachment.
 *
 * Requires the `yt-dlp` and `ffmpeg` binaries to be installed on the
 * host (same as the Python version). This calls the yt-dlp CLI
 * directly rather than depending on an npm wrapper, since most free
 * Node hosts only guarantee system binaries, not npm-level bindings.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { ensureYtDlp, ensureFfmpeg } from './ensure_binaries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const STALE_FILE_MAX_AGE_MS = 10 * 60 * 1000;
const URL_RE = /^https?:\/\//i;

export class DownloadError extends Error {}

export function isUrl(query) {
  return URL_RE.test(query.trim());
}

export function cleanupStaleFiles() {
  const now = Date.now();
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    const full = path.join(DOWNLOAD_DIR, f);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && now - stat.mtimeMs > STALE_FILE_MAX_AGE_MS) {
        fs.unlinkSync(full);
      }
    } catch {
      // ignore
    }
  }
}

export function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort, never throw
  }
}

/**
 * Run the yt-dlp CLI with the given args. Rejects with a DownloadError
 * carrying a clean, user-facing message on failure.
 */
function runYtDlp(ytDlpPath, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args);
    let stderr = '';
    let stdout = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    if (captureStdout) {
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    proc.on('error', (err) => {
      reject(new DownloadError(`yt-dlp failed to start: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        if (stderr.includes('Sign in to confirm') || stderr.includes('not a bot')) {
          reject(
            new DownloadError(
              "YouTube is blocking this download (bot-check). The bot owner needs to set up cookies — check YTDLP_COOKIES_FILE in .env."
            )
          );
        } else if (stderr.includes('Requested format is not available')) {
          reject(
            new DownloadError(
              "That resolution isn't available for this video. Try a different resolution or a different video."
            )
          );
        } else {
          reject(new DownloadError(`Couldn't find or download that: ${stderr.trim().slice(-500)}`));
        }
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Free resolutions that are actually allowed to download.
 * Anything else (480p, 720p, 1080p) is gated behind the Premium message.
 */
export const FREE_VIDEO_RESOLUTIONS = ['144p', '240p', '360p'];
export const PREMIUM_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'];

async function resolveTitle(ytDlpPath, target, cookiesFile) {
  try {
    const titleArgs = [target, '--no-playlist', '--quiet', '--no-warnings', '--print', 'title'];
    if (cookiesFile && fs.existsSync(cookiesFile)) titleArgs.push('--cookies', cookiesFile);
    const out = await runYtDlp(ytDlpPath, titleArgs, { captureStdout: true });
    const firstLine = out.trim().split('\n')[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

async function resolveThumbnail(ytDlpPath, target, cookiesFile) {
  try {
    const args = [target, '--no-playlist', '--quiet', '--no-warnings', '--print', 'thumbnail'];
    if (cookiesFile && fs.existsSync(cookiesFile)) args.push('--cookies', cookiesFile);
    const out = await runYtDlp(ytDlpPath, args, { captureStdout: true });
    const firstLine = out.trim().split('\n')[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Looks up just the title + thumbnail for `query` without downloading
 * anything. Used to show a preview before MP3/Video buttons.
 */
export async function getPreview(query) {
  const ytDlpPath = await ensureYtDlp();
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;
  const target = isUrl(query) ? query.trim() : `ytsearch1:${query.trim()}`;

  const title = await resolveTitle(ytDlpPath, target, cookiesFile);
  const thumbnailUrl = await resolveThumbnail(ytDlpPath, target, cookiesFile);

  if (!title) {
    throw new DownloadError(`Couldn't find anything for "${query}".`);
  }

  return { title, thumbnailUrl, url: isUrl(query) ? query.trim() : null };
}

/**
 * Search YouTube for `query` and return up to `count` results, each
 * with { title, url, thumbnailUrl, durationSeconds, uploader }.
 * Used by /search for the multi-result picker.
 */
export async function searchVideos(query, count = 15) {
  const ytDlpPath = await ensureYtDlp();
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;

  const args = [
    `ytsearch${count}:${query.trim()}`,
    '--flat-playlist',
    '--quiet',
    '--no-warnings',
    '--dump-json',
    '--extractor-args',
    'youtube:player_client=android,web',
  ];
  if (cookiesFile && fs.existsSync(cookiesFile)) {
    args.push('--cookies', cookiesFile);
  }

  const out = await runYtDlp(ytDlpPath, args, { captureStdout: true });
  const lines = out.trim().split('\n').filter(Boolean);

  return lines
    .map((line) => {
      try {
        const obj = JSON.parse(line);
        return {
          title: obj.title || 'Unknown title',
          url: obj.url || (obj.id ? `https://www.youtube.com/watch?v=${obj.id}` : null),
          thumbnailUrl: obj.thumbnails?.length ? obj.thumbnails[obj.thumbnails.length - 1].url : obj.thumbnail || null,
          durationSeconds: obj.duration ?? null,
          uploader: obj.uploader || obj.channel || 'Unknown',
        };
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.url);
}

/**
 * Download `query` (a search term or a direct URL) as audio in the
 * requested format ('mp3' or 'best').
 *
 * Returns { path, title, sizeBytes, ext }. Caller must delete the
 * returned path after use (see safeDelete).
 */
export async function downloadAudio(query, fmt) {
  const ytDlpPath = await ensureYtDlp();
  const ffmpegPath = await ensureFfmpeg();

  const jobId = randomUUID();
  const outTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
  const target = isUrl(query) ? query.trim() : `ytsearch1:${query.trim()}`;
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;

  const args = [
    target,
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '-o',
    outTemplate,
    // Android client avoids most YouTube bot-detection without cookies.
    '--extractor-args',
    'youtube:player_client=android,web',
  ];

  // If we downloaded a standalone ffmpeg, tell yt-dlp exactly where it is
  // instead of relying on PATH.
  if (ffmpegPath !== 'ffmpeg') {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (cookiesFile && fs.existsSync(cookiesFile)) {
    args.push('--cookies', cookiesFile);
  }

  if (fmt === 'mp3') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '192K');
  } else {
    args.push('-f', 'bestaudio/best');
  }

  await runYtDlp(ytDlpPath, args);

  const produced = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(jobId));
  if (produced.length === 0) {
    throw new DownloadError('Download finished but the file went missing. Try again.');
  }

  const finalPath = path.join(DOWNLOAD_DIR, produced[0]);
  const stat = fs.statSync(finalPath);
  const ext = path.extname(finalPath).replace('.', '');
  const title = (await resolveTitle(ytDlpPath, target, cookiesFile)) ?? path.basename(finalPath, path.extname(finalPath));

  return { path: finalPath, title, sizeBytes: stat.size, ext };
}

/**
 * Download `query` as video at one of the FREE_VIDEO_RESOLUTIONS
 * ('144p', '240p', or '360p'). Premium resolutions are intentionally
 * not handled here — the bot layer should intercept those before
 * ever calling this function.
 *
 * Returns { path, title, sizeBytes, ext }. Caller must delete the
 * returned path after use (see safeDelete).
 */
export async function downloadVideo(query, resolution) {
  if (!FREE_VIDEO_RESOLUTIONS.includes(resolution)) {
    throw new DownloadError(`Resolution ${resolution} is not available for free download.`);
  }

  const ytDlpPath = await ensureYtDlp();
  const ffmpegPath = await ensureFfmpeg();

  const jobId = randomUUID();
  const outTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
  const target = isUrl(query) ? query.trim() : `ytsearch1:${query.trim()}`;
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;
  const heightCap = parseInt(resolution.replace('p', ''), 10);

  const args = [
    target,
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '-o',
    outTemplate,
    '--extractor-args',
    'youtube:player_client=android,web',
    '-f',
    // Try split video+audio at the cap first, then a pre-merged format
    // at the cap, then the worst available combined format — but only
    // ever the actual cap, never above it. If literally no format at
    // or below the cap exists, yt-dlp will report a clean "format not
    // available" error instead of silently exceeding the free tier.
    `bestvideo[height<=${heightCap}]+bestaudio/best[height<=${heightCap}]/worst[height<=${heightCap}]`,
    '--merge-output-format',
    'mp4',
  ];

  if (ffmpegPath !== 'ffmpeg') {
    args.push('--ffmpeg-location', ffmpegPath);
  }
  if (cookiesFile && fs.existsSync(cookiesFile)) {
    args.push('--cookies', cookiesFile);
  }

  await runYtDlp(ytDlpPath, args);

  const produced = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(jobId));
  if (produced.length === 0) {
    throw new DownloadError('Download finished but the file went missing. Try again.');
  }

  const finalPath = path.join(DOWNLOAD_DIR, produced[0]);
  const stat = fs.statSync(finalPath);
  const ext = path.extname(finalPath).replace('.', '');
  const title = (await resolveTitle(ytDlpPath, target, cookiesFile)) ?? path.basename(finalPath, path.extname(finalPath));

  return { path: finalPath, title, sizeBytes: stat.size, ext };
}

export function tooLarge(result, maxMb) {
  return result.sizeBytes > maxMb * 1024 * 1024;
}

export function humanSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
