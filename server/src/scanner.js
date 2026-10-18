import fsp from 'node:fs/promises';
import path from 'node:path';
import { all, get, run, tx, json, getSettings } from './db.js';
import { probe } from './util/ffprobe.js';
import { limiter } from './util/proc.js';
import { VIDEO_EXTS, parseMovieName, parseEpisode, sortTitle, isSample } from './util/naming.js';
import { localArtForMovie, localArtForShow, localArtForSeason, localThumbForEpisode } from './images.js';
import { enrichPending, tmdbEnabled } from './metadata/tmdb.js';
import { queueBackgroundWork } from './streaming/background.js';

export const scanState = {
  running: false,
  library: null,
  phase: 'idle',
  processed: 0,
  total: 0,
  added: 0,
  removed: 0,
  errors: [],
  finishedAt: null,
};

const log = (msg) => console.log(`[scan] ${msg}`);

async function walk(root, out = [], base = root) {
  let dir;
  try {
    dir = await fsp.opendir(root);
  } catch (e) {
    scanState.errors.push(`Can't read ${root}: ${e.code || e.message}`);
    return out;
  }
  for await (const ent of dir) {
    const name = ent.name;
    if (name.startsWith('.') || name === '@eaDir' || name === '#recycle' || name === 'lost+found') continue;
    const full = path.join(root, name);
    if (ent.isDirectory()) {
      if (/^(extras|featurettes|behind the scenes|deleted scenes|trailers|samples?)$/i.test(name)) continue;
      await walk(full, out, base);
    } else if ((ent.isFile() || ent.isSymbolicLink()) && VIDEO_EXTS.has(path.extname(name).toLowerCase()) && !isSample(full)) {
      try {
        const st = await fsp.stat(full);
        if (st.size > 200 * 1024) out.push({ path: full, size: st.size, mtime: Math.floor(st.mtimeMs), root: base });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

function upsertMedia(itemId, file, info) {
  run(
    `INSERT INTO media_files (item_id, path, size, mtime, container, duration, bitrate, video, audio, subtitles, chapters, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET path = excluded.path, size = excluded.size, mtime = excluded.mtime, container = excluded.container,
       duration = excluded.duration, bitrate = excluded.bitrate, video = excluded.video, audio = excluded.audio,
       subtitles = excluded.subtitles, chapters = excluded.chapters, probed_at = excluded.probed_at, trickplay = NULL`,
    itemId,
    file.path,
    file.size,
    file.mtime,
    info.container,
    info.duration,
    info.bitrate,
    JSON.stringify({ ...info.video, startTime: info.startTime }),
    JSON.stringify(info.audio),
    JSON.stringify(info.subtitles),
    JSON.stringify(info.chapters),
    Date.now()
  );
}

function insertItem(fields) {
  const now = Date.now();
  const cols = { metadata_state: tmdbEnabled() ? 'pending' : 'none', added_at: now, updated_at: now, ...fields };
  const keys = Object.keys(cols);
  const r = run(`INSERT INTO items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => cols[k] ?? null));
  return Number(r.lastInsertRowid);
}

async function addMovie(lib, file, info, roots) {
  const parsed = parseMovieName(path.basename(file.path, path.extname(file.path)));
  // Generic filenames ("movie.mkv", "BDMV") – use the folder name instead.
  let { title, year } = parsed;
  if (!year || title.length < 2) {
    const folder = parseMovieName(path.basename(path.dirname(file.path)));
    if (!roots.includes(path.dirname(file.path)) && (folder.year || title.length < 2)) ({ title, year } = folder);
  }
  const art = await localArtForMovie(file.path, roots);
  const id = insertItem({
    library_id: lib.id,
    type: 'movie',
    path_key: file.path,
    title,
    sort_title: sortTitle(title),
    year,
    runtime: Math.round(info.duration / 60),
    poster: art.poster,
    backdrop: art.backdrop,
    logo: art.logo,
  });
  upsertMedia(id, file, info);
  return id;
}

async function addVideo(lib, file, info) {
  const { title, year } = parseMovieName(path.basename(file.path, path.extname(file.path)));
  const id = insertItem({
    library_id: lib.id,
    type: 'video',
    path_key: file.path,
    title,
    sort_title: sortTitle(title),
    year,
    runtime: Math.round(info.duration / 60),
    metadata_state: 'none',
  });
  upsertMedia(id, file, info);
  return id;
}

async function addEpisode(lib, file, info) {
  const ep = parseEpisode(file.path, file.root);
  let show = get("SELECT * FROM items WHERE library_id = ? AND type = 'show' AND path_key = ?", lib.id, ep.showKey);
  if (!show) {
    const art = await localArtForShow(ep.showKey);
    const id = insertItem({
      library_id: lib.id,
      type: 'show',
      path_key: ep.showKey,
      title: ep.showTitle,
      sort_title: sortTitle(ep.showTitle),
      year: ep.showYear,
      poster: art.poster,
      backdrop: art.backdrop,
      logo: art.logo,
    });
    run('UPDATE items SET show_id = ? WHERE id = ?', id, id);
    show = get('SELECT * FROM items WHERE id = ?', id);
  }
  const seasonKey = `${ep.showKey}#S${ep.season}`;
  let season = get("SELECT * FROM items WHERE library_id = ? AND type = 'season' AND path_key = ?", lib.id, seasonKey);
  if (!season) {
    const seasonDir = path.dirname(file.path);
    const id = insertItem({
      library_id: lib.id,
      type: 'season',
      parent_id: show.id,
      show_id: show.id,
      path_key: seasonKey,
      title: ep.season === 0 ? 'Specials' : `Season ${ep.season}`,
      sort_title: String(ep.season).padStart(4, '0'),
      season_number: ep.season,
      poster: await localArtForSeason(ep.showKey, seasonDir, ep.season),
    });
    season = { id };
  }
  const title = ep.episodeTitle || `Episode ${ep.episode}`;
  const id = insertItem({
    library_id: lib.id,
    type: 'episode',
    parent_id: season.id,
    show_id: show.id,
    path_key: file.path,
    title,
    sort_title: String(ep.episode).padStart(5, '0'),
    season_number: ep.season,
    episode_number: ep.episode,
    runtime: Math.round(info.duration / 60),
    thumb: await localThumbForEpisode(file.path),
  });
  upsertMedia(id, file, info);
  // Bump the show so "recently added" surfaces shows with new episodes.
  run('UPDATE items SET updated_at = ? WHERE id = ?', Date.now(), show.id);
  return id;
}

function cleanupEmpty(libId) {
  run(`DELETE FROM items WHERE library_id = ? AND type = 'season' AND NOT EXISTS (SELECT 1 FROM items e WHERE e.parent_id = items.id)`, libId);
  run(`DELETE FROM items WHERE library_id = ? AND type = 'show' AND NOT EXISTS (SELECT 1 FROM items s WHERE s.parent_id = items.id)`, libId);
}

export async function scanLibrary(lib, { full = false } = {}) {
  const roots = json(lib.paths, []).map((p) => path.resolve(p));
  scanState.library = lib.name;
  scanState.phase = 'Finding files';
  let files = [];
  for (const root of roots) files = files.concat(await walk(root));

  const existing = new Map(
    all('SELECT mf.path, mf.size, mf.mtime, mf.item_id FROM media_files mf JOIN items i ON i.id = mf.item_id WHERE i.library_id = ?', lib.id).map((r) => [r.path, r])
  );
  const seen = new Set(files.map((f) => f.path));

  // Removed files
  const gone = [...existing.values()].filter((r) => !seen.has(r.path));
  if (gone.length) {
    tx(() => gone.forEach((r) => run('DELETE FROM items WHERE id = ?', r.item_id)));
    scanState.removed += gone.length;
    log(`${lib.name}: removed ${gone.length} missing files`);
  }

  const todo = files.filter((f) => {
    const e = existing.get(f.path);
    return full || !e || e.size !== f.size || e.mtime !== f.mtime;
  });
  scanState.phase = 'Reading media info';
  scanState.total += todo.length;

  const limit = limiter(3);
  const newIds = [];
  await Promise.all(
    todo.map((file) =>
      limit(async () => {
        try {
          const info = await probe(file.path);
          if (!info.video) throw new Error('no video stream');
          const e = existing.get(file.path);
          if (e) {
            upsertMedia(e.item_id, file, info);
            newIds.push(e.item_id);
          } else {
            const taken = get('SELECT item_id FROM media_files WHERE path = ?', file.path);
            if (taken) return;
            const id = await serial(() =>
              lib.type === 'movies' ? addMovie(lib, file, info, roots) : lib.type === 'shows' ? addEpisode(lib, file, info) : addVideo(lib, file, info)
            );
            newIds.push(id);
            scanState.added++;
          }
        } catch (err) {
          scanState.errors.push(`${path.basename(file.path)}: ${err.message}`);
        } finally {
          scanState.processed++;
        }
      })
    )
  );

  cleanupEmpty(lib.id);
  run('UPDATE libraries SET last_scan = ? WHERE id = ?', Date.now(), lib.id);
  log(`${lib.name}: ${files.length} files, ${todo.length} probed, ${newIds.length} updated`);
  return newIds;
}

let pending = null;

// Serialize item creation so concurrent probes can't create the same show/season twice.
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

export async function scanAll({ libraryId = null, full = false } = {}) {
  if (scanState.running) {
    // Queue it: merge with any already-pending request (null library = everything).
    if (!pending) pending = { libraryId, full };
    else pending = { libraryId: pending.libraryId === libraryId ? libraryId : null, full: pending.full || full };
    return false;
  }
  Object.assign(scanState, { running: true, processed: 0, total: 0, added: 0, removed: 0, errors: [], phase: 'Starting' });
  try {
    const libs = libraryId ? all('SELECT * FROM libraries WHERE id = ?', libraryId) : all('SELECT * FROM libraries');
    let ids = [];
    for (const lib of libs) ids = ids.concat(await scanLibrary(lib, { full }));
    scanState.phase = 'Fetching metadata';
    await enrichPending(log).catch((e) => scanState.errors.push(`Metadata: ${e.message}`));
    queueBackgroundWork(ids);
  } catch (e) {
    scanState.errors.push(e.message);
    console.error(e);
  } finally {
    Object.assign(scanState, { running: false, phase: 'idle', library: null, finishedAt: Date.now() });
    if (scanState.errors.length > 50) scanState.errors = scanState.errors.slice(-50);
  }
  if (pending) {
    const next = pending;
    pending = null;
    setImmediate(() => scanAll(next));
  }
  return true;
}

let timer = null;
export function scheduleScans() {
  clearInterval(timer);
  const minutes = Number(getSettings().scanIntervalMinutes) || 0;
  if (minutes > 0) timer = setInterval(() => scanAll().catch(() => {}), minutes * 60 * 1000);
}
