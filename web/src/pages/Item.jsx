import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, episodeCode, formatBitrate, formatBytes, formatDuration, resolutionLabel } from '../api.js';
import { useAuth } from '../auth.jsx';
import { EpisodeRow, Img, PosterCard, TypePoster } from '../components/Cards.jsx';
import { IconPlay, IconCheck, IconBookmark, IconBookmarkFilled, IconRefresh, IconArrowLeft } from '../components/Icons.jsx';
import { toast } from '../components/Toast.jsx';

function TechBadges({ media }) {
  if (!media?.video) return null;
  const v = media.video;
  const a = media.audio.find((x) => x.default) || media.audio[0];
  const badges = [resolutionLabel(v), v.hdr === 'dv' ? 'Dolby Vision' : v.hdr === 'hdr10' ? 'HDR10' : v.hdr === 'hlg' ? 'HLG' : null, v.codec?.toUpperCase(), a ? (a.channels > 6 ? '7.1' : a.channels > 2 ? '5.1' : 'Stereo') : null].filter(Boolean);
  return (
    <div className="tech">
      {badges.map((b) => (
        <span key={b} className="tech-badge">{b}</span>
      ))}
      <span className="tech-detail">
        {media.container?.toUpperCase()} · {formatBitrate(media.bitrate)} · {formatBytes(media.size)}
      </span>
    </div>
  );
}

function TrackPicker({ media, audio, setAudio, sub, setSub }) {
  if (!media) return null;
  return (
    <div className="tracks">
      {media.audio.length > 1 && (
        <label className="track">
          <span>Audio</span>
          <select value={audio ?? ''} onChange={(e) => setAudio(e.target.value === '' ? undefined : Number(e.target.value))}>
            <option value="">Automatic</option>
            {media.audio.map((a) => (
              <option key={a.index} value={a.index}>{a.label}</option>
            ))}
          </select>
        </label>
      )}
      {media.subtitles.length > 0 && (
        <label className="track">
          <span>Subtitles</span>
          <select value={sub ?? ''} onChange={(e) => setSub(e.target.value === '' ? undefined : e.target.value)}>
            <option value="">Automatic</option>
            <option value="off">Off</option>
            {media.subtitles.map((s) => (
              <option key={s.index} value={s.index}>{s.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function Seasons({ show, onChanged }) {
  const seasons = show.seasons || [];
  const initial = seasons.find((s) => s.id && show.nextUp && s.seasonNumber === show.nextUp.seasonNumber) || seasons[0];
  const [active, setActive] = useState(initial?.id);
  const [episodes, setEpisodes] = useState(null);

  const load = useCallback(() => {
    if (!active) return;
    api.get(`/api/items/${active}/children`).then(setEpisodes);
  }, [active]);
  useEffect(load, [load]);

  const toggle = async (ep) => {
    await api.post(`/api/items/${ep.id}/watched`, { watched: !ep.watched });
    load();
    onChanged?.();
  };

  if (!seasons.length) return null;
  return (
    <section className="seasons">
      <div className="season-tabs" role="tablist">
        {seasons.map((s) => (
          <button key={s.id} role="tab" aria-selected={s.id === active} className={s.id === active ? 'on' : ''} onClick={() => setActive(s.id)}>
            {s.title}
            {s.unwatched ? <span className="season-count">{s.unwatched}</span> : s.watched ? <IconCheck size={14} /> : null}
          </button>
        ))}
        {active && <Link className="season-link" to={`/item/${active}`}>Season details</Link>}
      </div>
      <div className="episodes">{episodes ? episodes.map((ep) => <EpisodeRow key={ep.id} ep={ep} onToggleWatched={toggle} />) : <div className="episodes-loading" aria-busy="true" />}</div>
    </section>
  );
}

export default function Item() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [audio, setAudio] = useState();
  const [sub, setSub] = useState();

  const load = useCallback(() => {
    api.get(`/api/items/${id}`).then(setItem).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    setItem(null);
    setAudio(undefined);
    setSub(undefined);
    load();
    window.scrollTo(0, 0);
  }, [load]);

  if (error) return <div className="empty"><p>{error}</p></div>;
  if (!item) return <div className="item-skeleton" aria-busy="true" />;

  const playable = ['movie', 'episode', 'video'].includes(item.type);
  const playTarget = playable ? item : item.type === 'show' ? item.nextUp : item.episodes?.find((e) => !e.watched) || item.episodes?.[0];
  const resumeAt = playTarget?.position > 30 ? playTarget.position : 0;

  const play = (fromStart = false) => {
    if (!playTarget) return;
    const q = new URLSearchParams();
    if (fromStart) q.set('t', '0');
    if (playable && audio !== undefined) q.set('audio', audio);
    if (playable && sub !== undefined) q.set('sub', sub);
    navigate(`/play/${playTarget.id}${q.size ? `?${q}` : ''}`);
  };

  const toggleWatched = async () => {
    await api.post(`/api/items/${item.id}/watched`, { watched: !item.watched });
    load();
  };
  const toggleFav = async () => {
    const r = await api.post(`/api/items/${item.id}/favorite`, { favorite: !item.favorite });
    setItem((p) => ({ ...p, favorite: r.favorite }));
    toast(r.favorite ? 'Added to My list' : 'Removed from My list');
  };
  const refresh = async () => {
    toast('Refreshing metadata…');
    try {
      await api.post(`/api/items/${item.id}/refresh`);
      load();
      toast('Metadata refreshed', 'ok');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const fixMatch = async () => {
    const tmdbId = window.prompt('TMDB id for this title (the number in its themoviedb.org URL):', item.tmdbId || '');
    if (!tmdbId) return;
    try {
      await api.post(`/api/items/${item.id}/match`, { tmdbId });
      load();
      toast('Match updated', 'ok');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const isEpisode = item.type === 'episode';
  const backdrop = item.type === 'season' ? item.show?.backdrop : item.backdrop;
  const heading = isEpisode ? item.showTitle : item.type === 'season' ? item.show?.title : item.title;
  const meta = [
    isEpisode ? episodeCode(item) : null,
    item.type !== 'season' ? item.year : null,
    item.media ? formatDuration(item.media.duration, { long: true }) : null,
    item.type === 'show' && item.seasons ? `${item.seasons.length} season${item.seasons.length === 1 ? '' : 's'}` : null,
    item.type === 'season' && item.episodes ? `${item.episodes.length} episodes` : null,
    item.rating ? `★ ${item.rating.toFixed(1)}` : null,
  ].filter(Boolean);

  return (
    <div className="item">
      <div className="item-backdrop" aria-hidden="true">
        <Img src={backdrop} alt="" eager />
      </div>
      <div className="item-body">
        {(isEpisode || item.type === 'season') && (
          <Link className="item-crumb" to={`/item/${item.showId}`}>
            <IconArrowLeft size={16} /> {heading}
          </Link>
        )}
        <div className="item-main">
          <div className={`item-poster ${isEpisode || item.type === 'video' ? 'item-poster-wide' : ''}`}>
            {isEpisode || item.type === 'video' ? (
              <Img src={item.thumb} alt="" eager fallback={<TypePoster title={item.title} small />} />
            ) : (
              <Img src={item.poster} alt="" eager fallback={<TypePoster title={heading} year={item.year} />} />
            )}
          </div>
          <div className="item-info">
            {item.logo && !isEpisode && item.type !== 'season' ? (
              <Img className="item-logo" src={item.logo} alt={item.title} fallback={<h1 className="item-title">{item.title}</h1>} />
            ) : (
              <h1 className="item-title">{isEpisode || item.type === 'season' ? item.title : item.title}</h1>
            )}
            <p className="item-meta">
              {meta.map((m, i) => (
                <span key={i}>{m}</span>
              ))}
            </p>
            {item.genres?.length > 0 && <p className="item-genres">{item.genres.join(', ')}</p>}
            {item.tagline && <p className="item-tagline">{item.tagline}</p>}
            {item.overview && <p className="item-overview">{item.overview}</p>}

            <div className="item-actions">
              {playTarget && (
                <button className="btn btn-primary btn-lg" onClick={() => play(false)}>
                  <IconPlay size={20} />
                  {resumeAt ? `Resume from ${formatDuration(resumeAt)}` : !playable ? `Play ${episodeCode(playTarget)}` : 'Play'}
                </button>
              )}
              {resumeAt > 0 && (
                <button className="btn btn-glass btn-lg" onClick={() => play(true)}>
                  Start over
                </button>
              )}
              <button className={`icon-btn icon-btn-lg ${item.watched ? 'on' : ''}`} onClick={toggleWatched} title={item.watched ? 'Mark as unwatched' : 'Mark as watched'} aria-label={item.watched ? 'Mark as unwatched' : 'Mark as watched'}>
                <IconCheck />
              </button>
              {item.type !== 'season' && item.type !== 'episode' && (
                <button className={`icon-btn icon-btn-lg ${item.favorite ? 'on' : ''}`} onClick={toggleFav} title={item.favorite ? 'Remove from My list' : 'Add to My list'} aria-label={item.favorite ? 'Remove from My list' : 'Add to My list'}>
                  {item.favorite ? <IconBookmarkFilled /> : <IconBookmark />}
                </button>
              )}
              {user?.isAdmin && item.type !== 'video' && (
                <button className="icon-btn icon-btn-lg" onClick={refresh} title="Refresh metadata" aria-label="Refresh metadata">
                  <IconRefresh />
                </button>
              )}
            </div>
            {playTarget && !playable && playTarget.progress ? <p className="muted small">{episodeCode(playTarget)} · {playTarget.title} — in progress</p> : null}

            {playable && <TrackPicker media={item.media} audio={audio} setAudio={setAudio} sub={sub} setSub={setSub} />}
            {playable && <TechBadges media={item.media} />}
            {user?.isAdmin && (item.type === 'movie' || item.type === 'show') && (
              <button className="link-btn small" onClick={fixMatch}>Wrong title or artwork? Fix the match</button>
            )}
          </div>
        </div>

        {isEpisode && (item.previous || item.next) && (
          <div className="ep-nav">
            {item.previous ? <Link to={`/item/${item.previous.id}`}>← {episodeCode(item.previous)} {item.previous.title}</Link> : <span />}
            {item.next && <Link to={`/item/${item.next.id}`}>{episodeCode(item.next)} {item.next.title} →</Link>}
          </div>
        )}

        {item.type === 'show' && <Seasons show={item} onChanged={load} />}

        {item.type === 'season' && (
          <section className="seasons">
            {item.siblings?.length > 1 && (
              <div className="season-tabs">
                {item.siblings.map((s) => (
                  <Link key={s.id} to={`/item/${s.id}`} className={s.id === item.id ? 'on' : ''}>{s.title}</Link>
                ))}
              </div>
            )}
            <div className="episodes">
              {item.episodes?.map((ep) => (
                <EpisodeRow key={ep.id} ep={ep} onToggleWatched={async (e) => { await api.post(`/api/items/${e.id}/watched`, { watched: !e.watched }); load(); }} />
              ))}
            </div>
          </section>
        )}

        {item.cast?.length > 0 && (
          <section className="cast">
            <h2>Cast</h2>
            <div className="cast-track">
              {item.cast.map((c, i) => (
                <div key={i} className="person">
                  <div className="person-img">
                    <Img src={c.image} alt="" fallback={<span>{c.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>} />
                  </div>
                  <span className="person-name">{c.name}</span>
                  {c.character && <span className="person-role">{c.character}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {item.media && (
          <details className="fileinfo">
            <summary>File information</summary>
            <dl>
              <dt>File</dt><dd>{item.media.file}</dd>
              <dt>Video</dt><dd>{item.media.video.codec} {item.media.video.profile ? `(${item.media.video.profile})` : ''} · {item.media.video.width}×{item.media.video.height} · {item.media.video.fps} fps · {item.media.video.bitDepth}-bit</dd>
              <dt>Audio</dt><dd>{item.media.audio.map((a) => a.label).join(' / ') || 'None'}</dd>
              <dt>Subtitles</dt><dd>{item.media.subtitles.map((s) => s.label).join(' / ') || 'None'}</dd>
              <dt>Chapters</dt><dd>{item.media.chapters.length || 'None'}</dd>
            </dl>
          </details>
        )}
      </div>
    </div>
  );
}

export { PosterCard };
