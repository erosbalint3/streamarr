import { all, get, run, getSettings } from '../db.js';
import { limiter, sleep } from '../util/proc.js';
import { sortTitle } from '../util/naming.js';

const BASE = 'https://api.themoviedb.org/3';
const limit = limiter(4);

export function tmdbEnabled() {
  return !!getSettings().tmdbApiKey;
}

async function tmdb(pathname, params = {}) {
  const { tmdbApiKey, metadataLanguage } = getSettings();
  const url = new URL(BASE + pathname);
  const headers = { accept: 'application/json' };
  // v4 "read access tokens" are JWTs; v3 keys are 32 hex chars.
  if (tmdbApiKey.length > 40) headers.authorization = `Bearer ${tmdbApiKey}`;
  else url.searchParams.set('api_key', tmdbApiKey);
  url.searchParams.set('language', metadataLanguage || 'en-US');
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);

  return limit(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`TMDB ${res.status} for ${pathname}`);
      return res.json();
    }
    throw new Error('TMDB rate limited');
  });
}

const img = (size, p) => (p ? `tmdb:${size}${p}` : null);

function castFrom(credits) {
  return (credits?.cast || []).slice(0, 15).map((c) => ({
    name: c.name,
    character: c.character,
    image: img('w185', c.profile_path),
  }));
}

function pickLogo(images) {
  const logos = images?.logos || [];
  const lang = (getSettings().metadataLanguage || 'en').slice(0, 2);
  const l = logos.find((x) => x.iso_639_1 === lang) || logos.find((x) => x.iso_639_1 === 'en') || logos[0];
  return l ? img('w500', l.file_path) : null;
}

async function searchBest(kind, title, year) {
  const yearKey = kind === 'movie' ? 'year' : 'first_air_date_year';
  let res = await tmdb(`/search/${kind}`, { query: title, [yearKey]: year || undefined, include_adult: 'false' });
  if (!res?.results?.length && year) res = await tmdb(`/search/${kind}`, { query: title, include_adult: 'false' });
  const results = res?.results || [];
  if (!results.length) return null;
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const exact = results.find((r) => norm(r.title || r.name) === norm(title) || norm(r.original_title || r.original_name) === norm(title));
  return exact || results[0];
}

function preferLocal(current, remote) {
  // Local artwork (file:) wins over remote art; generated frames lose to remote art.
  if (current && current.startsWith('file:')) return current;
  return remote || current;
}

export async function enrichMovie(item) {
  const hit = item.tmdb_id ? { id: item.tmdb_id } : await searchBest('movie', item.title, item.year);
  if (!hit) {
    run("UPDATE items SET metadata_state = 'none' WHERE id = ?", item.id);
    return false;
  }
  const m = await tmdb(`/movie/${hit.id}`, { append_to_response: 'credits,images', include_image_language: 'en,null' });
  if (!m) return false;
  run(
    `UPDATE items SET title = ?, sort_title = ?, original_title = ?, year = ?, overview = ?, tagline = ?, genres = ?, rating = ?,
       runtime = ?, premiere_date = ?, poster = ?, backdrop = ?, logo = ?, cast_json = ?, tmdb_id = ?, metadata_state = 'done', updated_at = ?
     WHERE id = ?`,
    m.title,
    sortTitle(m.title),
    m.original_title,
    m.release_date ? Number(m.release_date.slice(0, 4)) : item.year,
    m.overview || null,
    m.tagline || null,
    JSON.stringify((m.genres || []).map((g) => g.name)),
    m.vote_average || null,
    m.runtime || null,
    m.release_date || null,
    preferLocal(item.poster, img('w500', m.poster_path)),
    preferLocal(item.backdrop, img('w1280', m.backdrop_path)),
    pickLogo(m.images),
    JSON.stringify(castFrom(m.credits)),
    m.id,
    Date.now(),
    item.id
  );
  return true;
}

export async function enrichShow(show) {
  const hit = show.tmdb_id ? { id: show.tmdb_id } : await searchBest('tv', show.title, show.year);
  if (!hit) {
    run("UPDATE items SET metadata_state = 'none' WHERE id = ? OR show_id = ?", show.id, show.id);
    return false;
  }
  const t = await tmdb(`/tv/${hit.id}`, { append_to_response: 'credits,images', include_image_language: 'en,null' });
  if (!t) return false;
  const now = Date.now();
  run(
    `UPDATE items SET title = ?, sort_title = ?, original_title = ?, year = ?, overview = ?, tagline = ?, genres = ?, rating = ?,
       premiere_date = ?, poster = ?, backdrop = ?, logo = ?, cast_json = ?, tmdb_id = ?, metadata_state = 'done', updated_at = ?
     WHERE id = ?`,
    t.name,
    sortTitle(t.name),
    t.original_name,
    t.first_air_date ? Number(t.first_air_date.slice(0, 4)) : show.year,
    t.overview || null,
    t.tagline || null,
    JSON.stringify((t.genres || []).map((g) => g.name)),
    t.vote_average || null,
    t.first_air_date || null,
    preferLocal(show.poster, img('w500', t.poster_path)),
    preferLocal(show.backdrop, img('w1280', t.backdrop_path)),
    pickLogo(t.images),
    JSON.stringify(castFrom(t.credits)),
    t.id,
    now,
    show.id
  );

  const seasons = all("SELECT * FROM items WHERE parent_id = ? AND type = 'season'", show.id);
  for (const season of seasons) {
    const s = await tmdb(`/tv/${t.id}/season/${season.season_number}`);
    if (!s) {
      run("UPDATE items SET metadata_state = 'none' WHERE id = ?", season.id);
      continue;
    }
    run(
      `UPDATE items SET title = ?, overview = ?, poster = ?, premiere_date = ?, metadata_state = 'done', updated_at = ? WHERE id = ?`,
      s.name || season.title,
      s.overview || null,
      preferLocal(season.poster, img('w500', s.poster_path)),
      s.air_date || null,
      now,
      season.id
    );
    const byNumber = new Map((s.episodes || []).map((e) => [e.episode_number, e]));
    for (const ep of all("SELECT * FROM items WHERE parent_id = ? AND type = 'episode'", season.id)) {
      const e = byNumber.get(ep.episode_number);
      if (!e) {
        run("UPDATE items SET metadata_state = 'none' WHERE id = ?", ep.id);
        continue;
      }
      run(
        `UPDATE items SET title = ?, overview = ?, thumb = ?, rating = ?, runtime = ?, premiere_date = ?, metadata_state = 'done', updated_at = ? WHERE id = ?`,
        e.name || ep.title,
        e.overview || null,
        preferLocal(ep.thumb, img('w780', e.still_path)),
        e.vote_average || null,
        e.runtime || null,
        e.air_date || null,
        now,
        ep.id
      );
    }
  }
  return true;
}

/** Fetch metadata for everything still pending. */
export async function enrichPending(log = () => {}) {
  if (!tmdbEnabled()) return;
  const movies = all("SELECT * FROM items WHERE type = 'movie' AND metadata_state = 'pending'");
  const shows = all(
    `SELECT DISTINCT s.* FROM items s WHERE s.type = 'show' AND (s.metadata_state = 'pending'
       OR EXISTS (SELECT 1 FROM items e WHERE e.show_id = s.id AND e.metadata_state = 'pending'))`
  );
  log(`Fetching metadata for ${movies.length} movies and ${shows.length} shows`);
  await Promise.all([
    ...movies.map((m) => enrichMovie(m).catch((e) => log(`TMDB movie "${m.title}": ${e.message}`))),
    ...shows.map((s) => enrichShow(s).catch((e) => log(`TMDB show "${s.title}": ${e.message}`))),
  ]);
}

export async function refreshItem(id) {
  const item = get('SELECT * FROM items WHERE id = ?', id);
  if (!item) return;
  const root = item.show_id ? get('SELECT * FROM items WHERE id = ?', item.show_id) : item;
  if (root.type === 'movie') return enrichMovie(root);
  if (root.type === 'show') return enrichShow(root);
}
