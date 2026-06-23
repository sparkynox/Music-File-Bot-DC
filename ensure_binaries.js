/**
 * ensure_binaries.js
 *
 * Makes sure `yt-dlp` and `ffmpeg` are available without needing the
 * host's package manager. On first run, if either binary isn't found
 * on PATH, this downloads a standalone Linux build straight from
 * GitHub releases into ./bin and uses that instead for the rest of
 * the process's life.
 *
 * This is for Linux hosts only (most free Node hosts run Linux
 * containers). It does not attempt Windows/macOS binaries.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, 'bin');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
// Static, self-contained ffmpeg build (single binary, no shared libs needed).
const FFMPEG_TAR_URL =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz';

let resolvedYtDlpPath = null;
let resolvedFfmpegPath = null;

function commandExists(cmd) {
  const result = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return result.error == null;
}

function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, { headers: { 'User-Agent': 'music-file-bot' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        file.close();
        reject(err);
      });
  });
}

/**
 * Ensures yt-dlp is available, returning the command/path to invoke it with.
 * Checks PATH first; falls back to downloading a standalone binary into ./bin.
 */
export async function ensureYtDlp() {
  if (resolvedYtDlpPath) return resolvedYtDlpPath;

  if (commandExists('yt-dlp')) {
    resolvedYtDlpPath = 'yt-dlp';
    return resolvedYtDlpPath;
  }

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  const localPath = path.join(BIN_DIR, 'yt-dlp');

  if (!fs.existsSync(localPath)) {
    console.log('[ensure_binaries] yt-dlp not found on PATH, downloading standalone binary...');
    await downloadFile(YTDLP_URL, localPath);
    fs.chmodSync(localPath, 0o755);
    console.log('[ensure_binaries] yt-dlp downloaded to', localPath);
  }

  resolvedYtDlpPath = localPath;
  return resolvedYtDlpPath;
}

/**
 * Ensures ffmpeg is available, returning the path to the ffmpeg binary
 * (or 'ffmpeg' if it's already on PATH). yt-dlp is told where to find
 * it via --ffmpeg-location when a local copy is used.
 */
export async function ensureFfmpeg() {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;

  if (commandExists('ffmpeg')) {
    resolvedFfmpegPath = 'ffmpeg';
    return resolvedFfmpegPath;
  }

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  const extractDir = path.join(BIN_DIR, 'ffmpeg-extracted');
  const localFfmpegBin = findExtractedFfmpeg(extractDir);

  if (localFfmpegBin) {
    resolvedFfmpegPath = localFfmpegBin;
    return resolvedFfmpegPath;
  }

  console.log('[ensure_binaries] ffmpeg not found on PATH, downloading static build...');
  const tarPath = path.join(BIN_DIR, 'ffmpeg.tar.xz');
  await downloadFile(FFMPEG_TAR_URL, tarPath);

  fs.mkdirSync(extractDir, { recursive: true });
  const result = spawnSync('tar', ['-xJf', tarPath, '-C', extractDir, '--strip-components=1']);
  if (result.status !== 0) {
    throw new Error(
      `Failed to extract ffmpeg archive (is 'tar' with xz support available?): ${result.stderr?.toString() || ''}`
    );
  }
  fs.unlinkSync(tarPath);

  const bin = findExtractedFfmpeg(extractDir);
  if (!bin) {
    throw new Error('ffmpeg binary not found after extraction.');
  }
  fs.chmodSync(bin, 0o755);
  console.log('[ensure_binaries] ffmpeg downloaded and extracted to', bin);

  resolvedFfmpegPath = bin;
  return resolvedFfmpegPath;
}

function findExtractedFfmpeg(extractDir) {
  const candidate = path.join(extractDir, 'bin', 'ffmpeg');
  if (fs.existsSync(candidate)) return candidate;
  const flatCandidate = path.join(extractDir, 'ffmpeg');
  if (fs.existsSync(flatCandidate)) return flatCandidate;
  return null;
}
