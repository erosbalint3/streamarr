import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, json } from './db.js';
import { exec } from './util/proc.js';
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


/** Grab a still frame from the video file. */
function generatedFrame(itemId, kind) {
  const out = path.join(config.imageCacheDir, 'gen', `${itemId}_${kind}.jpg`);
  return once(out, async () => {
    if (await exists(out)) return out;
    const media = get('SELECT path, duration, video FROM media_files WHERE item_id = ?', itemId);
    if (!media) throw new Error('no media');
    const video = json(media.video, {});
    const at = Math.max(1, (media.duration || 60) * (kind === 'thumb' ? 0.3 : 0.18));
    const width = kind === 'backdrop' ? 1280 : 640;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tonemap = video?.hdr ? `${tonemapFilter(video.hdr)},` : '';
    await exec(
      config.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', media.path, '-frames:v', '1', '-vf', `${tonemap}scale=${width}:-2,format=yuvj420p`, '-q:v', '4', '-y', out],
      { timeout: 60000, nice: true }
    );
    return out;
  });
}

/**
 * Resolve the file to serve for an item's image.
 * kind: poster | backdrop | thumb | logo
 */
export async function resolveImage(itemId, kind) {
  const item = get('SELECT id, type, poster, backdrop, thumb, logo, parent_id, show_id FROM items WHERE id = ?', itemId);
  if (!item) return null;
  let ref = item[kind];

  // Fallback chain: episodes without thumbs use a frame; seasons borrow the show's poster.
  if (!ref) {
    if (kind === 'poster' && item.type === 'season' && item.show_id) ref = get('SELECT poster FROM items WHERE id = ?', item.show_id)?.poster;
    if (kind === 'backdrop' && item.show_id) ref = get('SELECT backdrop FROM items WHERE id = ?', item.show_id)?.backdrop;
  }
  if (!ref) {
    const playable = ['movie', 'episode', 'video'].includes(item.type);
    if (playable && (kind === 'thumb' || kind === 'backdrop')) return generatedFrame(item.id, kind);
    if (kind === 'backdrop' && (item.type === 'show' || item.type === 'season')) {
      const ep = get("SELECT id FROM items WHERE show_id = ? AND type = 'episode' ORDER BY season_number, episode_number LIMIT 1", item.show_id || item.id);
      if (ep) return generatedFrame(ep.id, 'backdrop');
    }
    return null;
  }
  if (ref.startsWith('tmdb:')) return tmdbImage(ref);
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
