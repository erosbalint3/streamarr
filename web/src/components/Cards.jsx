import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { episodeCode, formatDuration } from '../api.js';
import { IconCheck, IconPlay } from './Icons.jsx';

const TINTS = [
  ['#2b2350', '#7b66f0'],
  ['#1d2a4a', '#4f8cf0'],
  ['#36203f', '#c56bd8'],
  ['#1b3238', '#3fb7a8'],
  ['#3a2430', '#e07a8f'],
  ['#2a2a40', '#a6a0d8'],
];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Artwork-free poster: the title set as type, tinted per title. */
export function TypePoster({ title, year, small }) {
  const [a, b] = TINTS[hash(title || '') % TINTS.length];
  return (
    <div className={`typeposter ${small ? 'typeposter-sm' : ''}`} style={{ '--tp-a': a, '--tp-b': b }}>
      <span className="typeposter-title">{title}</span>
      {year && <span className="typeposter-year">{year}</span>}
    </div>
  );
}

export function Img({ src, alt = '', className, fallback = null, eager }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!src || failed) return fallback;
  return (
    <img
      src={src}
      alt={alt}
      className={`${className || ''} ${loaded ? 'is-loaded' : ''}`}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}

export function ProgressBar({ value }) {
  if (!value) return null;
  return (
    <div className="progress" aria-label={`${Math.round(value * 100)}% watched`}>
      <span style={{ width: `${Math.max(3, value * 100)}%` }} />
    </div>
  );
}

function Badge({ item }) {
  if (item.watched) {
    return (
      <span className="badge badge-watched" title="Watched">
        <IconCheck size={14} />
      </span>
    );
  }
  if (item.unwatched) return <span className="badge">{item.unwatched}</span>;
  return null;
}

export function PosterCard({ item }) {
  const sub = item.type === 'season' ? (item.episodeCount ? `${item.episodeCount} episodes` : null) : item.year;
  return (
    <Link to={`/item/${item.id}`} className="card card-poster">
      <div className="card-art">
        <Img src={item.poster} alt="" fallback={<TypePoster title={item.title} year={item.year} />} />
        {item.posterIsFrame && (
          <div className="frameposter" aria-hidden="true">
            <span className="typeposter-title">{item.title}</span>
            {item.year && <span className="typeposter-year">{item.year}</span>}
          </div>
        )}
        <Badge item={item} />
        <ProgressBar value={item.progress} />
      </div>
      <div className="card-meta">
        <span className="card-title">{item.title}</span>
        {sub && <span className="card-sub">{sub}</span>}
      </div>
    </Link>
  );
}

/** 16:9 card used for episodes and Continue Watching. Click plays directly. */
export function LandscapeCard({ item, playable = true }) {
  const navigate = useNavigate();
  const isEpisode = item.type === 'episode';
  const art = item.thumb || item.backdrop;
  const title = isEpisode ? item.showTitle || item.title : item.title;
  const sub = isEpisode ? `${episodeCode(item)} · ${item.title}` : item.year;
  const remaining = item.progress && item.runtime ? Math.max(1, Math.round(item.runtime * (1 - item.progress))) : null;
  const go = () => navigate(playable ? `/play/${item.id}` : `/item/${item.id}`);
  return (
    <div className="card card-landscape">
      <button className="card-art" onClick={go} aria-label={`Play ${title} ${sub || ''}`}>
        <Img src={art} alt="" fallback={<TypePoster title={title} small />} />
        <span className="card-play" aria-hidden="true">
          <IconPlay size={22} />
        </span>
        <Badge item={item} />
        <ProgressBar value={item.progress} />
      </button>
      <Link to={`/item/${isEpisode && item.showId ? item.showId : item.id}`} className="card-meta">
        <span className="card-title">{title}</span>
        <span className="card-sub">
          {sub}
          {remaining ? ` · ${remaining} min left` : ''}
        </span>
      </Link>
    </div>
  );
}

export function EpisodeRow({ ep, onToggleWatched }) {
  const navigate = useNavigate();
  return (
    <div className={`episode ${ep.watched ? 'is-watched' : ''}`}>
      <button className="episode-art" onClick={() => navigate(`/play/${ep.id}`)} aria-label={`Play episode ${ep.episodeNumber}`}>
        <Img src={ep.thumb} alt="" fallback={<TypePoster title={ep.title} small />} />
        <span className="card-play" aria-hidden="true">
          <IconPlay size={20} />
        </span>
        <ProgressBar value={ep.progress} />
      </button>
      <div className="episode-body">
        <div className="episode-head">
          <span className="episode-num">{ep.episodeNumber}</span>
          <Link to={`/item/${ep.id}`} className="episode-title">
            {ep.title}
          </Link>
          {ep.runtime ? <span className="episode-runtime">{formatDuration(ep.runtime * 60, { long: true })}</span> : null}
          <button className={`episode-check ${ep.watched ? 'on' : ''}`} onClick={() => onToggleWatched?.(ep)} aria-label={ep.watched ? 'Mark as unwatched' : 'Mark as watched'} title={ep.watched ? 'Mark as unwatched' : 'Mark as watched'}>
            <IconCheck size={16} />
          </button>
        </div>
        {ep.overview && <p className="episode-overview">{ep.overview}</p>}
      </div>
    </div>
  );
}
