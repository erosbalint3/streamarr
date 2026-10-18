import { all, get, json } from './db.js';

const PLAYABLE = new Set(['movie', 'episode', 'video']);

function img(item, kind) {
  return `/api/images/${item.id}/${kind}?v=${item.updated_at}`;
}

export function progressFor(userId, ids) {
  if (!ids.length) return new Map();
  const rows = all(`SELECT * FROM progress WHERE user_id = ? AND item_id IN (${ids.map(() => '?').join(',')})`, userId, ...ids);
  return new Map(rows.map((r) => [r.item_id, r]));
}

/** Unwatched episode counts for shows/seasons, in one query. */
export function unwatchedCounts(userId, items) {
  const showIds = items.filter((i) => i.type === 'show').map((i) => i.id);
  const seasonIds = items.filter((i) => i.type === 'season').map((i) => i.id);
  const out = new Map();
  const q = (col, ids) => {
    if (!ids.length) return;
    const rows = all(
      `SELECT e.${col} AS k, COUNT(*) AS total, SUM(CASE WHEN COALESCE(p.watched, 0) = 0 THEN 1 ELSE 0 END) AS unwatched
       FROM items e LEFT JOIN progress p ON p.item_id = e.id AND p.user_id = ?
       WHERE e.type = 'episode' AND e.${col} IN (${ids.map(() => '?').join(',')}) GROUP BY e.${col}`,
      userId,
      ...ids
    );
    for (const r of rows) out.set(r.k, { total: r.total, unwatched: r.unwatched });
  };
  q('show_id', showIds);
  q('parent_id', seasonIds);
  return out;
}

export function favoritesFor(userId, ids) {
  if (!ids.length) return new Set();
  return new Set(all(`SELECT item_id FROM favorites WHERE user_id = ? AND item_id IN (${ids.map(() => '?').join(',')})`, userId, ...ids).map((r) => r.item_id));
}

export function card(item, ctx = {}) {
  const p = ctx.progress?.get(item.id);
  const counts = ctx.counts?.get(item.id);
  const c = {
    id: item.id,
    type: item.type,
    title: item.title,
    year: item.year,
    rating: item.rating,
    runtime: item.runtime,
    genres: json(item.genres, []),
    overview: ctx.full ? item.overview : undefined,
    poster: item.poster || item.type === 'season' ? img(item, 'poster') : null,
    backdrop: img(item, 'backdrop'),
    logo: item.logo ? img(item, 'logo') : null,
    thumb: item.type === 'episode' || item.type === 'video' ? img(item, 'thumb') : null,
    addedAt: item.added_at,
    seasonNumber: item.season_number ?? undefined,
    episodeNumber: item.episode_number ?? undefined,
    showId: item.type !== 'show' ? item.show_id ?? undefined : undefined,
    showTitle: item.show_title ?? undefined,
    favorite: ctx.favorites ? ctx.favorites.has(item.id) : undefined,
  };
  if (PLAYABLE.has(item.type)) {
    c.watched = !!p?.watched;
    if (p && !p.watched && p.position > 0 && p.duration) c.progress = Math.min(1, p.position / p.duration);
    c.position = p && !p.watched ? p.position : 0;
  } else if (counts) {
    c.episodeCount = counts.total;
    c.unwatched = counts.unwatched;
    c.watched = counts.total > 0 && counts.unwatched === 0;
  }
  return c;
}

/** Serialize a list of item rows for a user with progress, counts, favorites. */
export function cards(userId, items, opts = {}) {
  const ids = items.map((i) => i.id);
  const ctx = {
    progress: progressFor(userId, ids),
    counts: unwatchedCounts(userId, items),
    favorites: favoritesFor(userId, ids),
    ...opts,
  };
  return items.map((i) => card(i, ctx));
}

export const ITEM_SELECT = `SELECT i.*, s.title AS show_title FROM items i LEFT JOIN items s ON s.id = i.show_id AND i.type != 'show'`;

export function getItem(id) {
  return get(`${ITEM_SELECT} WHERE i.id = ?`, id);
}
