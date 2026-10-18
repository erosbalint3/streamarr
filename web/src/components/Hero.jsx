import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatDuration } from '../api.js';
import { Img } from './Cards.jsx';
import { IconPlay, IconInfo } from './Icons.jsx';

const ROTATE_MS = 9000;

export default function Hero({ items }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const navigate = useNavigate();
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (items.length < 2 || paused || reduced) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % items.length), ROTATE_MS);
    return () => clearTimeout(t);
  }, [index, items.length, paused, reduced]);

  if (!items.length) return null;
  const item = items[index];
  const playId = item.type === 'show' ? item.playTarget?.id : item.id;
  const resume = item.type === 'show' ? item.playTarget?.position : item.position;
  const meta = [item.year, item.type === 'show' ? 'Series' : item.runtime ? formatDuration(item.runtime * 60, { long: true }) : null, item.genres?.slice(0, 2).join(', '), item.rating ? `★ ${item.rating.toFixed(1)}` : null].filter(Boolean);

  return (
    <section className="hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-roledescription="carousel">
      {items.map((it, i) => (
        <div key={it.id} className={`hero-bg ${i === index ? 'is-active' : ''}`} aria-hidden={i !== index}>
          <Img src={it.backdrop} alt="" eager={i === 0} />
        </div>
      ))}
      <div className="hero-scrim" />
      <div className="hero-content" key={item.id}>
        {item.logo ? <Img className="hero-logo" src={item.logo} alt={item.title} fallback={<h1 className="hero-title">{item.title}</h1>} /> : <h1 className="hero-title">{item.title}</h1>}
        <p className="hero-meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </p>
        {item.overview && <p className="hero-overview">{item.overview}</p>}
        <div className="hero-actions">
          {playId && (
            <button className="btn btn-primary btn-lg" onClick={() => navigate(`/play/${playId}`)}>
              <IconPlay size={20} />
              {resume > 30 ? 'Resume' : item.type === 'show' && item.playTarget ? `Play ${item.playTarget.label}` : 'Play'}
            </button>
          )}
          <Link className="btn btn-glass btn-lg" to={`/item/${item.id}`}>
            <IconInfo size={20} /> Details
          </Link>
        </div>
      </div>
      {items.length > 1 && (
        <div className="hero-dots" role="tablist">
          {items.map((it, i) => (
            <button key={it.id} role="tab" aria-selected={i === index} aria-label={it.title} className={i === index ? 'is-active' : ''} onClick={() => setIndex(i)}>
              <span style={{ animationDuration: `${ROTATE_MS}ms`, animationPlayState: paused || reduced ? 'paused' : 'running' }} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
