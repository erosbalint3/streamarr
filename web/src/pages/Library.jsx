import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { PosterCard, LandscapeCard } from '../components/Cards.jsx';

const SORTS = [
  ['title', 'A–Z'],
  ['added', 'Recently added'],
  ['year', 'Release year'],
  ['rating', 'Rating'],
  ['random', 'Shuffle'],
];

export default function Library() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') || 'title';
  const genre = params.get('genre') || '';
  const filter = params.get('filter') || '';
  const [state, setState] = useState({ items: [], total: 0, genres: [], library: null, loading: true });
  const sentinel = useRef(null);
  const loadingMore = useRef(false);

  const load = useCallback(
    async (offset = 0) => {
      const q = new URLSearchParams({ sort, offset, limit: 60 });
      if (genre) q.set('genre', genre);
      if (filter) q.set('filter', filter);
      const r = await api.get(`/api/libraries/${id}/items?${q}`);
      setState((p) => ({ ...r, items: offset ? [...p.items, ...r.items] : r.items, loading: false }));
    },
    [id, sort, genre, filter]
  );

  useEffect(() => {
    setState((p) => ({ ...p, loading: true }));
    load(0);
    window.scrollTo(0, 0);
  }, [load]);

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
          {lib && <p className="muted">{state.total} {lib.type === 'shows' ? 'shows' : lib.type === 'movies' ? 'movies' : 'videos'}{lib.type === 'shows' && lib.episodeCount ? ` · ${lib.episodeCount} episodes` : ''}</p>}
        </div>
        <div className="library-tools">
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
