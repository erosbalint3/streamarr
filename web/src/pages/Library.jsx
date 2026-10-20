import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useScrollRestore } from '../hooks.js';
import { PosterCard, LandscapeCard } from '../components/Cards.jsx';

// Pages already loaded per library view, so Back restores the grid (and its scroll) instantly.
const memo = new Map();

const SORTS = [
  ['title', 'A–Z'],
  ['added', 'Recently added'],
  ['year', 'Release year'],
  ['rating', 'Rating'],
  ['random', 'Shuffle'],
];

function countLine(lib, total, kind) {
  const n = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  if (lib.type === 'mixed') {
    if (kind === 'movies') return n(total, 'movie');
    if (kind === 'shows') return `${n(total, 'show')} · ${n(lib.episodeCount, 'episode')}`;
    return `${n(lib.movieCount, 'movie')} · ${n(lib.showCount, 'show')} · ${n(lib.episodeCount, 'episode')}`;
  }
  if (lib.type === 'shows') return `${n(total, 'show')}${lib.episodeCount ? ` · ${n(lib.episodeCount, 'episode')}` : ''}`;
  return n(total, lib.type === 'movies' ? 'movie' : 'video');
}

export default function Library() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') || 'title';
  const genre = params.get('genre') || '';
  const filter = params.get('filter') || '';
  const kind = params.get('kind') || '';
  const key = `${id}|${sort}|${genre}|${filter}|${kind}`;
  const [state, setStateRaw] = useState(() => memo.get(key) || { items: [], total: 0, genres: [], library: null, loading: true });
  const setState = useCallback(
    (fn) =>
      setStateRaw((prev) => {
        const next = typeof fn === 'function' ? fn(prev) : fn;
        memo.set(key, next);
        return next;
      }),
    [key]
  );
  const sentinel = useRef(null);
  const loadingMore = useRef(false);

  const load = useCallback(
    async (offset = 0) => {
      const q = new URLSearchParams({ sort, offset, limit: 60 });
      if (genre) q.set('genre', genre);
      if (filter) q.set('filter', filter);
      if (kind) q.set('kind', kind);
      const r = await api.get(`/api/libraries/${id}/items?${q}`);
      setState((p) => ({ ...r, items: offset ? [...p.items, ...r.items] : r.items.length >= p.items.length || !p.items.length ? r.items : [...r.items, ...p.items.slice(r.items.length)], loading: false }));
    },
    [id, sort, genre, filter, kind, setState]
  );

  useEffect(() => {
    const cached = memo.get(key);
    setStateRaw(cached || { items: [], total: 0, genres: [], library: null, loading: true });
    // Refresh the first page in the background (not for Shuffle: coming back must not reorder it).
    if (!cached || sort !== 'random') load(0);
  }, [load, key, sort]);
  useScrollRestore(state.items.length > 0 || !state.loading);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(async ([e]) => {
      if (e.isIntersecting && !loadingMore.current && state.items.length < state.total) {
        loadingMore.current = true;
        await load(state.items.length);
        loadingMore.current = false;
      }
    }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [state.items.length, state.total, load]);

  const set = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const lib = state.library;
  const landscape = lib?.type === 'other';

  return (
    <div className="library">
      <header className="library-head">
        <div>
          <h1>{lib?.name || ' '}</h1>
          {lib && <p className="muted">{countLine(lib, state.total, kind)}</p>}
        </div>
        <div className="library-tools">
          {lib?.type === 'mixed' && (
            <div className="segmented" role="group" aria-label="Show">
              <button className={!kind ? 'on' : ''} onClick={() => set('kind', '')}>Everything</button>
              <button className={kind === 'movies' ? 'on' : ''} onClick={() => set('kind', 'movies')}>Movies</button>
              <button className={kind === 'shows' ? 'on' : ''} onClick={() => set('kind', 'shows')}>Shows</button>
            </div>
          )}
          <div className="segmented" role="group" aria-label="Filter">
            <button className={!filter ? 'on' : ''} onClick={() => set('filter', '')}>All</button>
            <button className={filter === 'unwatched' ? 'on' : ''} onClick={() => set('filter', 'unwatched')}>Unwatched</button>
          </div>
          {state.genres.length > 0 && (
            <select value={genre} onChange={(e) => set('genre', e.target.value)} aria-label="Genre">
              <option value="">All genres</option>
              {state.genres.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          )}
          <select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort by">
            {SORTS.map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </div>
      </header>
      {!state.loading && !state.items.length ? (
        <div className="empty"><p>No titles match these filters.</p></div>
      ) : (
        <div className={`grid ${landscape ? 'grid-landscape' : ''}`}>
          {state.items.map((it) => (landscape ? <LandscapeCard key={it.id} item={it} /> : <PosterCard key={it.id} item={it} />))}
        </div>
      )}
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}
