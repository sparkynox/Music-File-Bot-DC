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

  let title = path.basename(finalPath, path.extname(finalPath));
  try {
    const titleArgs = [target, '--no-playlist', '--quiet', '--no-warnings', '--print', 'title'];
    if (cookiesFile && fs.existsSync(cookiesFile)) titleArgs.push('--cookies', cookiesFile);
    const out = await runYtDlp(ytDlpPath, titleArgs, { captureStdout: true });
    const firstLine = out.trim().split('\n')[0];
    if (firstLine) title = firstLine;
  } catch {
    // fall back to filename-derived title, already set above
  }

  return { path: finalPath, title, sizeBytes: stat.size, ext };
}

export function tooLarge(result, maxMb) {
  return result.sizeBytes > maxMb * 1024 * 1024;
}

export function humanSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
