import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, json } from './db.js';
import os from 'node:os';
import { exec, limiter } from './util/proc.js';
import { tonemapFilter } from './streaming/encoder.js';

const inflight = new Map();
const once = (key, fn) => {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
};

const exists = (p) => fsp.access(p).then(() => true, () => false);

/** Download a TMDB image ("w500/abc.jpg") into the cache and return its path. */
export function tmdbImage(ref) {
  const clean = ref.replace(/^tmdb:/, '').replace(/^\/+/, '');
  if (!/^(w\d+|original)\/[\w.-]+$/.test(clean)) throw new Error('bad image ref');
  const out = path.join(config.imageCacheDir, 'tmdb', clean.replace('/', '_'));
  return once(out, async () => {
    if (await exists(out)) return out;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const res = await fetch(`https://image.tmdb.org/t/p/${clean}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`image ${res.status}`);
    const tmp = `${out}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await fsp.rename(tmp, out);
    return out;
  });
}


// Frame grabs hit the disk hard (seek + decode); a library page can ask for dozens at once.
const frameLimit = limiter(Math.max(2, Math.min(4, os.cpus().length)));
const failed = new Map(); // out path -> time of last failure, so broken files aren't retried on every request
const FRAME = {
  poster: { at: 0.22, vf: 'crop=min(iw\\,ih*2/3):min(ih\\,iw*3/2),scale=400:600' },
  backdrop: { at: 0.18, vf: 'scale=1280:-2' },
  thumb: { at: 0.3, vf: 'scale=640:-2' },
};

/**
 * Grab a representative still from the video. Decodes only keyframes around the target time and
 * lets ffmpeg's thumbnail filter pick the most typical one, which skips black and fade frames.
 */
function generatedFrame(itemId, kind) {
  const out = path.join(config.imageCacheDir, 'gen', `${itemId}_${kind}.jpg`);
  return once(out, async () => {
    if (await exists(out)) return out;
    if (Date.now() - (failed.get(out) || 0) < 30 * 60 * 1000) throw new Error('frame grab failed recently');
    const media = get('SELECT path, duration, video FROM media_files WHERE item_id = ?', itemId);
    if (!media) throw new Error('no media');
    const video = json(media.video, {});
    const spec = FRAME[kind];
    const at = Math.max(1, (media.duration || 60) * spec.at);
    const tonemap = video?.hdr ? `${tonemapFilter(video.hdr)},` : '';
    const tmp = `${out}.tmp.jpg`;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const grab = (fast) =>
      exec(
        config.ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error',
          ...(fast ? ['-skip_frame', 'nokey'] : []),
          '-ss', String(at), '-i', media.path,
          '-an', '-sn', '-dn',
          '-vf', `${fast ? 'thumbnail=n=8,' : ''}${tonemap}${spec.vf},format=yuvj420p`,
          '-frames:v', '1', '-q:v', '3', '-y', tmp,
        ],
        { timeout: 90000, nice: true }
      );
    try {
      await frameLimit(async () => {
        try {
          await grab(true);
        } catch {
          await grab(false); // some files (e.g. short clips, odd GOPs) need a plain decode
        }
      });
      await fsp.rename(tmp, out);
      failed.delete(out);
      return out;
    } catch (e) {
      failed.set(out, Date.now());
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  });
}

/** Item id whose video should stand in for a show/season without artwork. */
function firstEpisodeOf(item) {
  const col = item.type === 'season' ? 'parent_id' : 'show_id';
  return get(`SELECT id FROM items WHERE ${col} = ? AND type = 'episode' ORDER BY season_number = 0, season_number, episode_number LIMIT 1`, item.id)?.id;
}

// Sizes the TMDB image CDN serves for any image; we pick the smallest one covering the display size.
const TMDB_WIDTHS = [92, 154, 185, 300, 342, 500, 780, 1280];
// Buckets for our own resized copies (local artwork, frames grabbed from video).
const RESIZE_WIDTHS = [200, 342, 500, 780, 1280];
const resizeLimit = limiter(2);

function tmdbSized(ref, width) {
  if (!width) return ref;
  const target = TMDB_WIDTHS.find((w) => w >= width) || 1280;
  return ref.replace(/^tmdb:(w\d+|original)\//, `tmdb:w${target}/`);
}

/** A copy of `file` at most `width` px wide (cached). Avoids sending 1280 px art to 180 px cards. */
function resized(file, width) {
  const bucket = RESIZE_WIDTHS.find((w) => w >= width) || 1280;
  const isPng = /\.png$/i.test(file);
  return once(`${file}@${bucket}`, async () => {
    const st = await fsp.stat(file);
    const key = crypto.createHash('md5').update(`${file}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 20);
    const out = path.join(config.imageCacheDir, 'resized', `${key}_${bucket}.${isPng ? 'png' : 'jpg'}`);
    if (await exists(out)) return out;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp.${isPng ? 'png' : 'jpg'}`;
    try {
      await resizeLimit(() =>
        exec(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale='min(iw,${bucket})':-2:flags=lanczos`, ...(isPng ? [] : ['-q:v', '3']), '-frames:v', '1', '-y', tmp], { timeout: 30000, nice: true })
      );
      await fsp.rename(tmp, out);
      return out;
    } catch {
      await fsp.rm(tmp, { force: true });
      return file; // serve the original rather than nothing
    }
  });
}

/**
 * Resolve the file to serve for an item's image, optionally sized for display.
 * kind: poster | backdrop | thumb | logo
 */
export async function resolveImage(itemId, kind, width = 0) {
  const file = await resolveImageFile(itemId, kind, width);
  if (!file || !width || kind === 'logo' || file.startsWith(path.join(config.imageCacheDir, 'tmdb'))) return file;
  return resized(file, width);
}

async function resolveImageFile(itemId, kind, width) {
  const item = get('SELECT id, type, poster, backdrop, thumb, logo, parent_id, show_id FROM items WHERE id = ?', itemId);
  if (!item) return null;
  let ref = item[kind];

  // Fallback chain: episodes without thumbs use a frame; seasons borrow the show's poster.
  if (!ref) {
    if (kind === 'poster' && item.type === 'season' && item.show_id) ref = get('SELECT poster FROM items WHERE id = ?', item.show_id)?.poster;
    if (kind === 'backdrop' && item.show_id) ref = get('SELECT backdrop FROM items WHERE id = ?', item.show_id)?.backdrop;
  }
  if (!ref) {
    if (kind === 'logo') return null;
    const playable = ['movie', 'episode', 'video'].includes(item.type);
    if (playable) return generatedFrame(item.id, kind);
    if (item.type === 'show' || item.type === 'season') {
      const ep = firstEpisodeOf(item.type === 'season' && kind === 'backdrop' ? { id: item.show_id, type: 'show' } : item);
      if (ep) return generatedFrame(ep, kind === 'thumb' ? 'backdrop' : kind);
    }
    return null;
  }
  if (ref.startsWith('tmdb:')) return tmdbImage(kind === 'logo' ? ref : tmdbSized(ref, width));
  if (ref.startsWith('file:')) {
    const p = ref.slice(5);
    return (await exists(p)) ? p : null;
  }
  return null;
}

export function imageEtag(file, stat) {
  return `"${crypto.createHash('md5').update(`${file}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16)}"`;
}

export async function sendImage(reply, req, file) {
  const stat = await fsp.stat(file);
  const etag = imageEtag(file, stat);
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=604800').header('ETag', etag).header('Content-Length', stat.size);
  return reply.send(fs.createReadStream(file));
}

// ---- local artwork discovery (used by the scanner) ----
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

async function firstExisting(dir, names) {
  for (const n of names) {
    for (const ext of IMG_EXT) {
      const p = path.join(dir, n + ext);
      if (await exists(p)) return `file:${p}`;
    }
  }
  return null;
}

export async function localArtForMovie(file, libraryRoots) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const dedicated = !libraryRoots.includes(dir);
  return {
    poster: await firstExisting(dir, [`${base}-poster`, base, ...(dedicated ? ['poster', 'folder', 'cover', 'movie'] : [])]),
    backdrop: await firstExisting(dir, [`${base}-fanart`, `${base}-backdrop`, ...(dedicated ? ['fanart', 'backdrop', 'background', 'art'] : [])]),
    logo: await firstExisting(dir, [`${base}-logo`, ...(dedicated ? ['logo', 'clearlogo'] : [])]),
  };
}

export async function localArtForShow(showDir) {
  return {
    poster: await firstExisting(showDir, ['poster', 'folder', 'cover', 'show']),
    backdrop: await firstExisting(showDir, ['fanart', 'backdrop', 'background', 'art']),
    logo: await firstExisting(showDir, ['logo', 'clearlogo']),
  };
}

export async function localArtForSeason(showDir, seasonDir, n) {
  const pad = String(n).padStart(2, '0');
  return (
    (await firstExisting(showDir, [`season${pad}-poster`, `Season${pad}`, n === 0 ? 'season-specials-poster' : '_'])) ||
    (seasonDir && seasonDir !== showDir ? await firstExisting(seasonDir, ['poster', 'folder', 'cover']) : null)
  );
}

export async function localThumbForEpisode(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  return firstExisting(dir, [`${base}-thumb`, base]);
}
