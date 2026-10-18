import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const configDir = path.resolve(process.env.CONFIG_DIR || path.join(here, '../../data'));
const cacheDir = path.join(configDir, 'cache');

export const config = {
  port: Number(process.env.PORT || 8420),
  host: process.env.HOST || '0.0.0.0',
  configDir,
  cacheDir,
  imageCacheDir: path.join(cacheDir, 'images'),
  subtitleCacheDir: path.join(cacheDir, 'subtitles'),
  trickplayDir: path.join(cacheDir, 'trickplay'),
  // Transcode scratch space. Point this at a tmpfs or SSD for best results.
  transcodeDir: path.resolve(process.env.TRANSCODE_DIR || path.join(configDir, 'transcodes')),
  webDir: path.resolve(process.env.WEB_DIR || path.join(here, '../../web/dist')),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  // Directory roots the admin folder picker is allowed to browse.
  browseRoots: (process.env.MEDIA_ROOTS || '/media').split(',').map((s) => s.trim()).filter(Boolean),
};

// Defaults for runtime-editable settings (stored in the DB, editable in Admin → Settings).
// Environment variables seed the initial values.
export const settingDefaults = {
  serverName: process.env.SERVER_NAME || 'Streamarr',
  tmdbApiKey: process.env.TMDB_API_KEY || '',
  metadataLanguage: process.env.METADATA_LANGUAGE || 'en-US',
  hwaccel: process.env.HWACCEL || 'none', // none | vaapi | nvenc
  vaapiDevice: process.env.VAAPI_DEVICE || '/dev/dri/renderD128',
  transcodePreset: process.env.TRANSCODE_PRESET || 'veryfast',
  maxTranscodes: Number(process.env.MAX_TRANSCODES || 4),
  // How far (seconds) the transcoder runs ahead of the furthest segment the player asked for
  // before it is paused. Big = resilient to network hiccups; Plex uses ~60s.
  transcodeAheadSeconds: Number(process.env.TRANSCODE_AHEAD_SECONDS || 240),
  segmentSeconds: 4,
  maxSoftwareHeight: Number(process.env.MAX_SOFTWARE_HEIGHT || 1080),
  stereoDownmix: true,
  trickplay: process.env.TRICKPLAY !== 'false',
  extractSubtitles: true,
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 30),
};

for (const dir of [configDir, cacheDir, config.imageCacheDir, config.subtitleCacheDir, config.trickplayDir, config.transcodeDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
