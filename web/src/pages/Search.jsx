import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { PosterCard, LandscapeCard } from '../components/Cards.jsx';
import { IconSearch } from '../components/Icons.jsx';

export default function Search() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [results, setResults] = useState(null);
  const input = useRef(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const term = q.trim();
    setParams(term ? { q: term } : {}, { replace: true });
    if (term.length < 2) return setResults(null);
    const t = setTimeout(() => api.get(`/api/search?q=${encodeURIComponent(term)}`).then((r) => setResults(r.results)), 180);
    return () => clearTimeout(t);
  }, [q, setParams]);

  const titles = results?.filter((r) => r.type !== 'episode') || [];
  const episodes = results?.filter((r) => r.type === 'episode') || [];

  return (
    <div className="search">
      <label className="search-box">
        <IconSearch size={26} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titles, episodes, actors" aria-label="Search" />
      </label>
      {results && !results.length && <p className="empty">Nothing matches “{q}”.</p>}
      {titles.length > 0 && (
        <section>
          <h2 className="section-title">Titles</h2>
          <div className="grid">{titles.map((r) => <PosterCard key={r.id} item={r} />)}</div>
        </section>
      )}
      {episodes.length > 0 && (
        <section>
          <h2 className="section-title">Episodes</h2>
          <div className="grid grid-landscape">{episodes.map((r) => <LandscapeCard key={r.id} item={r} />)}</div>
        </section>
      )}
    </div>
  );
}
