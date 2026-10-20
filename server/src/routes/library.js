import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { all, get, run, json } from '../db.js';
import { config } from '../config.js';
import { requireUser, requireAdmin } from '../auth.js';
import { cards, card, getItem, ITEM_SELECT, progressFor, unwatchedCounts, favoritesFor } from '../serialize.js';
import { resolveImage, sendImage, tmdbImage } from '../images.js';
import { scanAll, scanState } from '../scanner.js';
import { refreshItem } from '../metadata/tmdb.js';
import { mediaForItem, audioLabel, subtitleLabel } from '../streaming/media.js';
import { getVtt, shiftVtt } from '../streaming/subtitles.js';
import { trickplayDir } from '../streaming/trickplay.js';

const libraryOut = (l) => {
  const counts = get(
    `SELECT SUM(CASE WHEN type IN ('movie','show','video') THEN 1 ELSE 0 END) AS items,
            SUM(CASE WHEN type = 'episode' THEN 1 ELSE 0 END) AS episodes
     FROM items WHERE library_id = ?`,
    l.id
  );
  return { id: l.id, name: l.name, type: l.type, paths: json(l.paths, []), lastScan: l.last_scan, itemCount: counts.items || 0, episodeCount: counts.episodes || 0 };
};

const SORTS = {
  title: 'i.sort_title COLLATE NOCASE ASC',
  added: 'added DESC',
  year: 'i.year DESC, i.sort_title',
  rating: 'i.rating DESC NULLS LAST, i.sort_title',
  random: 'RANDOM()',
};

/** Next episode to watch for a show (first unwatched after the last watched one). */
export function nextUpForShow(userId, showId) {
  const last = get(
    `SELECT e.season_number, e.episode_number FROM items e JOIN progress p ON p.item_id = e.id AND p.user_id = ?
     WHERE e.show_id = ? AND e.type = 'episode' AND p.watched = 1 ORDER BY e.season_number DESC, e.episode_number DESC LIMIT 1`,
    userId,
    showId
  );
  const where = last
    ? `AND (e.season_number > ${Number(last.season_number)} OR (e.season_number = ${Number(last.season_number)} AND e.episode_number > ${Number(last.episode_number)}))`
    : '';
  return get(
    `SELECT e.*, s.title AS show_title FROM items e JOIN items s ON s.id = e.show_id
     LEFT JOIN progress p ON p.item_id = e.id AND p.user_id = ?
     WHERE e.show_id = ? AND e.type = 'episode' AND e.season_number > 0 AND COALESCE(p.watched, 0) = 0 ${where}
     ORDER BY e.season_number, e.episode_number LIMIT 1`,
    userId,
    showId
  );
}

export function adjacentEpisode(ep, dir) {
  const cmp = dir > 0 ? '>' : '<';
  const order = dir > 0 ? 'ASC' : 'DESC';
  return get(
    `${ITEM_SELECT} WHERE i.show_id = ? AND i.type = 'episode' AND (i.season_number ${cmp} ? OR (i.season_number = ? AND i.episode_number ${cmp} ?))
     ORDER BY i.season_number ${order}, i.episode_number ${order} LIMIT 1`,
    ep.show_id,
    ep.season_number,
    ep.season_number,
    ep.episode_number
  );
}

function mediaInfo(media) {
  if (!media) return null;
  const v = media.video;
  return {
    container: media.container,
    duration: media.duration,
    bitrate: media.bitrate,
    size: media.size,
    file: path.basename(media.path),
    video: v && {
      codec: v.codec,
      profile: v.profile,
      width: v.width,
      height: v.height,
      fps: v.fps,
      bitDepth: v.bitDepth,
      hdr: v.hdr,
    },
    audio: media.audio.map((a) => ({ index: a.index, label: audioLabel(a), codec: a.codec, channels: a.channels, language: a.language, default: a.default })),
    subtitles: media.subtitles.map((s) => ({ index: s.index, label: subtitleLabel(s), language: s.language, forced: s.forced, text: s.text, default: s.default })),
    chapters: media.chapters,
  };
}

export default async function libraryRoutes(app) {
  // ---------------- libraries
  app.get('/api/libraries', { preHandler: requireUser }, async () => all('SELECT * FROM libraries ORDER BY name').map(libraryOut));

  app.post('/api/libraries', { preHandler: requireAdmin }, async (req, reply) => {
    const { name, type, paths } = req.body || {};
    if (!name?.trim() || !['movies', 'shows', 'other'].includes(type) || !Array.isArray(paths) || !paths.length) {
      return reply.code(400).send({ error: 'A library needs a name, a type and at least one folder.' });
    }
    for (const p of paths) {
      if (!fs.existsSync(p)) return reply.code(400).send({ error: `The folder ${p} doesn't exist inside the container. Check your volume mounts.` });
    }
    const r = run('INSERT INTO libraries (name, type, paths, created_at) VALUES (?, ?, ?, ?)', name.trim(), type, JSON.stringify(paths), Date.now());
    const lib = get('SELECT * FROM libraries WHERE id = ?', Number(r.lastInsertRowid));
    scanAll({ libraryId: lib.id });
    return libraryOut(lib);
  });

  app.put('/api/libraries/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const lib = get('SELECT * FROM libraries WHERE id = ?', req.params.id);
    if (!lib) return reply.code(404).send({ error: 'Library not found.' });
    const { name, paths } = req.body || {};
    run('UPDATE libraries SET name = ?, paths = ? WHERE id = ?', name?.trim() || lib.name, JSON.stringify(paths || json(lib.paths, [])), lib.id);
    if (paths) scanAll({ libraryId: lib.id });
    return libraryOut(get('SELECT * FROM libraries WHERE id = ?', lib.id));
  });

  app.delete('/api/libraries/:id', { preHandler: requireAdmin }, async (req) => {
    run('DELETE FROM libraries WHERE id = ?', req.params.id);
    return { ok: true };
  });

  app.post('/api/libraries/:id/scan', { preHandler: requireAdmin }, async (req) => {
    const started = await Promise.race([scanAll({ libraryId: Number(req.params.id), full: !!req.body?.full }), new Promise((r) => setTimeout(() => r(true), 50))]);
    return { started, state: scanState };
  });

  app.post('/api/scan', { preHandler: requireAdmin }, async () => {
    scanAll();
    return { state: scanState };
  });

  app.get('/api/scan', { preHandler: requireUser }, async () => scanState);

  // Folder picker for the library editor.
  app.get('/api/fs/browse', { preHandler: requireAdmin }, async (req, reply) => {
    const requested = req.query.path ? path.resolve(req.query.path) : null;
    if (!requested) {
      return { path: null, parent: null, dirs: config.browseRoots.filter((r) => fs.existsSync(r)).map((r) => ({ name: r, path: r })) };
    }
    const allowed = config.browseRoots.some((r) => requested === r || requested.startsWith(r + path.sep));
    if (!allowed) return reply.code(403).send({ error: `Only folders under ${config.browseRoots.join(', ')} can be browsed.` });
    let entries = [];
    try {
      entries = await fsp.readdir(requested, { withFileTypes: true });
    } catch (e) {
      return reply.code(400).send({ error: `Can't open this folder (${e.code}).` });
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(requested, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const isRoot = config.browseRoots.includes(requested);
    return { path: requested, parent: isRoot ? '' : path.dirname(requested), dirs };
  });

  // ---------------- browsing
  app.get('/api/libraries/:id/items', { preHandler: requireUser }, async (req, reply) => {
    const lib = get('SELECT * FROM libraries WHERE id = ?', req.params.id);
    if (!lib) return reply.code(404).send({ error: 'Library not found.' });
    const type = lib.type === 'movies' ? 'movie' : lib.type === 'shows' ? 'show' : 'video';
    const sort = SORTS[req.query.sort] || SORTS.title;
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const offset = Number(req.query.offset) || 0;
    const where = ['i.library_id = ?', 'i.type = ?'];
    const params = [lib.id, type];
    if (req.query.genre) {
      where.push('EXISTS (SELECT 1 FROM json_each(i.genres) g WHERE g.value = ?)');
      params.push(req.query.genre);
    }
    if (req.query.q) {
      where.push('i.title LIKE ?');
      params.push(`%${req.query.q}%`);
    }
    if (req.query.filter === 'unwatched') {
      if (type === 'show') {
        where.push(`EXISTS (SELECT 1 FROM items e LEFT JOIN progress p ON p.item_id = e.id AND p.user_id = ? WHERE e.show_id = i.id AND e.type = 'episode' AND COALESCE(p.watched,0) = 0)`);
      } else where.push('NOT EXISTS (SELECT 1 FROM progress p WHERE p.item_id = i.id AND p.user_id = ? AND p.watched = 1)');
      params.push(req.user.id);
    }
    const addedExpr = type === 'show' ? `(SELECT MAX(e.added_at) FROM items e WHERE e.show_id = i.id)` : 'i.added_at';
    const rows = all(`SELECT i.*, ${addedExpr} AS added FROM items i WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = get(`SELECT COUNT(*) AS n FROM items i WHERE ${where.join(' AND ')}`, ...params).n;
    const genres = all(`SELECT g.value AS name, COUNT(*) AS n FROM items i, json_each(i.genres) g WHERE i.library_id = ? AND i.type = ? GROUP BY g.value ORDER BY n DESC`, lib.id, type);
    return { library: libraryOut(lib), items: cards(req.user.id, rows), total, genres: genres.map((g) => g.name) };
  });

  app.get('/api/home', { preHandler: requireUser }, async (req) => {
    const uid = req.user.id;
    const rows = [];

    const continueRows = all(
      `${ITEM_SELECT} JOIN progress p ON p.item_id = i.id AND p.user_id = ?
       WHERE p.watched = 0 AND p.position > 30 AND (p.duration IS NULL OR p.position < p.duration * 0.95)
       ORDER BY p.updated_at DESC LIMIT 20`,
      uid
    );
    const continueShowIds = new Set(continueRows.filter((r) => r.show_id).map((r) => r.show_id));

    const recentShows = all(
      `SELECT e.show_id, MAX(p.updated_at) AS t FROM progress p JOIN items e ON e.id = p.item_id
       WHERE p.user_id = ? AND e.type = 'episode' AND p.updated_at > ? GROUP BY e.show_id ORDER BY t DESC LIMIT 20`,
      uid,
      Date.now() - 1000 * 60 * 60 * 24 * 90
    );
    const nextUp = recentShows.filter((r) => !continueShowIds.has(r.show_id)).map((r) => nextUpForShow(uid, r.show_id)).filter(Boolean);

    if (continueRows.length) rows.push({ id: 'continue', title: 'Continue watching', style: 'landscape', items: cards(uid, continueRows) });
    if (nextUp.length) rows.push({ id: 'nextup', title: 'Up next', style: 'landscape', items: cards(uid, nextUp) });

    const favs = all(`${ITEM_SELECT} JOIN favorites f ON f.item_id = i.id AND f.user_id = ? ORDER BY f.added_at DESC LIMIT 30`, uid);
    if (favs.length) rows.push({ id: 'mylist', title: 'My list', style: 'poster', items: cards(uid, favs) });

    for (const lib of all('SELECT * FROM libraries ORDER BY id')) {
      let items;
      if (lib.type === 'shows') {
        items = all(
          `SELECT s.*, MAX(e.added_at) AS last_ep FROM items s JOIN items e ON e.show_id = s.id AND e.type = 'episode'
           WHERE s.library_id = ? AND s.type = 'show' GROUP BY s.id ORDER BY last_ep DESC LIMIT 24`,
          lib.id
        );
      } else {
        items = all(`SELECT * FROM items WHERE library_id = ? AND type IN ('movie','video') ORDER BY added_at DESC LIMIT 24`, lib.id);
      }
      if (items.length) rows.push({ id: `recent-${lib.id}`, title: `Recently added to ${lib.name}`, style: lib.type === 'other' ? 'landscape' : 'poster', libraryId: lib.id, items: cards(uid, items) });
    }

    const topRated = all(`SELECT * FROM items WHERE type IN ('movie','show') AND rating >= 7 ORDER BY RANDOM() LIMIT 20`);
    if (topRated.length >= 6) rows.push({ id: 'toprated', title: 'Highly rated', style: 'poster', items: cards(uid, topRated) });

    const genres = all(`SELECT g.value AS name, COUNT(*) AS n FROM items i, json_each(i.genres) g WHERE i.type IN ('movie','show') GROUP BY g.value HAVING n >= 6 ORDER BY RANDOM() LIMIT 3`);
    for (const g of genres) {
      const items = all(`SELECT i.* FROM items i WHERE i.type IN ('movie','show') AND EXISTS (SELECT 1 FROM json_each(i.genres) x WHERE x.value = ?) ORDER BY RANDOM() LIMIT 20`, g.name);
      rows.push({ id: `genre-${g.name}`, title: g.name, style: 'poster', items: cards(uid, items) });
    }

    // Hero: prefer items with real artwork and an overview.
    let hero = all(`SELECT * FROM items WHERE type IN ('movie','show') AND backdrop IS NOT NULL AND overview IS NOT NULL ORDER BY added_at DESC LIMIT 40`);
    if (hero.length < 3) hero = hero.concat(all(`SELECT * FROM items WHERE type IN ('movie','show','video') ORDER BY added_at DESC LIMIT 12`));
    const seen = new Set();
    hero = hero.filter((h) => !seen.has(h.id) && seen.add(h.id)).sort(() => Math.random() - 0.5).slice(0, 6);
    const heroCards = cards(uid, hero, { full: true });
    for (const h of heroCards) {
      if (h.type === 'show') {
        const n = nextUpForShow(uid, h.id);
        h.playTarget = n ? { id: n.id, label: `S${n.season_number} E${n.episode_number}`, position: progressFor(uid, [n.id]).get(n.id)?.position || 0 } : null;
      }
    }
    return { hero: heroCards, rows };
  });

  app.get('/api/items/:id', { preHandler: requireUser }, async (req, reply) => {
    const uid = req.user.id;
    const item = getItem(req.params.id);
    if (!item) return reply.code(404).send({ error: 'This title no longer exists.' });
    const out = card(item, {
      progress: progressFor(uid, [item.id]),
      counts: unwatchedCounts(uid, [item]),
      favorites: favoritesFor(uid, [item.id]),
      full: true,
    });
    out.tagline = item.tagline;
    out.originalTitle = item.original_title;
    out.premiereDate = item.premiere_date;
    out.cast = json(item.cast_json, []).map((c) => ({ ...c, image: c.image ? `/api/tmdb-image/${c.image.replace(/^tmdb:/, '')}` : null }));
    out.libraryId = item.library_id;
    out.tmdbId = item.tmdb_id;

    if (['movie', 'episode', 'video'].includes(item.type)) {
      out.media = mediaInfo(mediaForItem(item.id));
    }
    if (item.type === 'show') {
      const seasons = all(`SELECT * FROM items WHERE parent_id = ? AND type = 'season' ORDER BY season_number = 0, season_number`, item.id);
      out.seasons = cards(uid, seasons);
      const next = nextUpForShow(uid, item.id) || get(`${ITEM_SELECT} WHERE i.show_id = ? AND i.type = 'episode' ORDER BY i.season_number = 0, i.season_number, i.episode_number LIMIT 1`, item.id);
      out.nextUp = next ? cards(uid, [next])[0] : null;
    }
    if (item.type === 'season') {
      const eps = all(`${ITEM_SELECT} WHERE i.parent_id = ? AND i.type = 'episode' ORDER BY i.episode_number`, item.id);
      out.episodes = cards(uid, eps, { full: true });
      out.siblings = cards(uid, all(`SELECT * FROM items WHERE parent_id = ? AND type = 'season' ORDER BY season_number = 0, season_number`, item.parent_id));
      const show = getItem(item.show_id);
      out.show = { id: show.id, title: show.title, backdrop: `/api/images/${show.id}/backdrop?v=${show.updated_at}`, logo: show.logo ? `/api/images/${show.id}/logo?v=${show.updated_at}` : null };
    }
    if (item.type === 'episode') {
      const prev = adjacentEpisode(item, -1);
      const next = adjacentEpisode(item, 1);
      out.previous = prev ? card(prev) : null;
      out.next = next ? card(next) : null;
      out.seasonId = item.parent_id;
    }
    return out;
  });

  app.get('/api/items/:id/children', { preHandler: requireUser }, async (req) => {
    const rows = all(`${ITEM_SELECT} WHERE i.parent_id = ? ORDER BY i.season_number, i.episode_number, i.sort_title`, req.params.id);
    return cards(req.user.id, rows, { full: true });
  });

  app.get('/api/search', { preHandler: requireUser }, async (req) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return { results: [] };
    const like = `%${q}%`;
    const rows = all(
      `${ITEM_SELECT} WHERE i.type IN ('movie','show','video','episode') AND (i.title LIKE ? OR i.original_title LIKE ?)
       ORDER BY CASE WHEN i.title LIKE ? THEN 0 ELSE 1 END, CASE i.type WHEN 'episode' THEN 1 ELSE 0 END, i.sort_title LIMIT 48`,
      like,
      like,
      `${q}%`
    );
    // Also match cast members.
    const people = all(`SELECT * FROM items i WHERE i.type IN ('movie','show') AND i.cast_json LIKE ? LIMIT 24`, like);
    const seen = new Set(rows.map((r) => r.id));
    return { results: cards(req.user.id, rows.concat(people.filter((p) => !seen.has(p.id)))) };
  });

  // ---------------- user state
  app.post('/api/items/:id/watched', { preHandler: requireUser }, async (req) => {
    const watched = req.body?.watched !== false;
    const item = get('SELECT id, type FROM items WHERE id = ?', req.params.id);
    if (!item) return { ok: false };
    const targets =
      item.type === 'show'
        ? all("SELECT id FROM items WHERE show_id = ? AND type = 'episode'", item.id)
        : item.type === 'season'
          ? all("SELECT id FROM items WHERE parent_id = ? AND type = 'episode'", item.id)
          : [item];
    const now = Date.now();
    for (const t of targets) {
      run(
        `INSERT INTO progress (user_id, item_id, position, watched, play_count, updated_at) VALUES (?, ?, 0, ?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET watched = excluded.watched, position = 0, updated_at = excluded.updated_at,
           play_count = progress.play_count + excluded.play_count`,
        req.user.id,
        t.id,
        watched ? 1 : 0,
        watched ? 1 : 0,
        now
      );
    }
    return { ok: true, watched };
  });

  app.post('/api/items/:id/favorite', { preHandler: requireUser }, async (req) => {
    const fav = req.body?.favorite !== false;
    if (fav) run('INSERT OR IGNORE INTO favorites (user_id, item_id, added_at) VALUES (?, ?, ?)', req.user.id, req.params.id, Date.now());
    else run('DELETE FROM favorites WHERE user_id = ? AND item_id = ?', req.user.id, req.params.id);
    return { favorite: fav };
  });

  app.post('/api/items/:id/refresh', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const ok = await refreshItem(Number(req.params.id));
      return { ok: !!ok };
    } catch (e) {
      return reply.code(502).send({ error: `Metadata refresh failed: ${e.message}` });
    }
  });

  // Fix a wrong match by pointing an item at a specific TMDB id.
  app.post('/api/items/:id/match', { preHandler: requireAdmin }, async (req, reply) => {
    const tmdbId = Number(req.body?.tmdbId);
    if (!tmdbId) return reply.code(400).send({ error: 'Enter a TMDB id.' });
    const item = get('SELECT id, type, show_id FROM items WHERE id = ?', req.params.id);
    const target = item.type === 'movie' || item.type === 'show' ? item.id : item.show_id;
    run("UPDATE items SET tmdb_id = ?, metadata_state = 'pending' WHERE id = ?", tmdbId, target);
    await refreshItem(target);
    return { ok: true };
  });

  // ---------------- images & assets
  app.get('/api/images/:id/:kind', { preHandler: requireUser, compress: false }, async (req, reply) => {
    if (!['poster', 'backdrop', 'thumb', 'logo'].includes(req.params.kind)) return reply.code(404).send();
    try {
      const w = Math.max(0, Math.min(Number(req.query.w) || 0, 1920));
      const file = await resolveImage(Number(req.params.id), req.params.kind, w);
      if (!file) return reply.code(404).send();
      return sendImage(reply, req, file);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/api/tmdb-image/:size/:file', { preHandler: requireUser, compress: false }, async (req, reply) => {
    try {
      const file = await tmdbImage(`${req.params.size}/${req.params.file}`);
      return sendImage(reply, req, file);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/api/media/:itemId/trickplay/:n', { preHandler: requireUser, compress: false }, async (req, reply) => {
    const media = mediaForItem(Number(req.params.itemId));
    const n = parseInt(req.params.n, 10);
    if (!media?.trickplay || !Number.isFinite(n)) return reply.code(404).send();
    const file = path.join(trickplayDir(media), `${n}.jpg`);
    if (!fs.existsSync(file)) return reply.code(404).send();
    return sendImage(reply, req, file);
  });

  app.get('/api/media/:itemId/subtitles/:index', { preHandler: requireUser }, async (req, reply) => {
    const media = mediaForItem(Number(req.params.itemId));
    const key = String(req.params.index).replace(/\.vtt$/, '');
    const sub = media?.subtitles.find((s) => String(s.index) === key);
    if (!sub || !sub.text) return reply.code(404).send({ error: 'Subtitle track not found.' });
    try {
      const file = await getVtt(media, sub);
      let text = await fsp.readFile(file, 'utf8');
      const offset = Number(req.query.offset) || 0;
      if (offset) text = shiftVtt(text, offset);
      return reply.header('Content-Type', 'text/vtt; charset=utf-8').header('Cache-Control', 'private, max-age=3600').send(text);
    } catch (e) {
      return reply.code(500).send({ error: `Couldn't convert subtitles: ${e.message}` });
    }
  });
}
