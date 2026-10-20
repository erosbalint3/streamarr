import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, episodeCode, formatBitrate, formatDuration, prefetch, sized } from '../api.js';
import { Img } from '../components/Cards.jsx';
import { useAuth } from '../auth.jsx';
import { Playback, parseVtt, cueHtml } from './engine.js';
import { cancelBackgroundProbe } from './caps.js';
import Stats from './Stats.jsx';
import {
  IconPlay, IconPause, IconBack10, IconFwd10, IconVolume, IconMute, IconFullscreen, IconExitFullscreen,
  IconSubtitles, IconAudio, IconGauge, IconInfo, IconPip, IconArrowLeft, IconCheck, IconNext,
} from '../components/Icons.jsx';

const MODE_LABEL = { direct: 'Direct play', remux: 'Direct stream', transcode: 'Adaptive' };
const modeLabel = (d) => (d.mode === 'transcode' && d.renditions.length === 1 ? 'Converted' : MODE_LABEL[d.mode]);
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function Menu({ title, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('[data-menu-toggle]') && onClose();
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [onClose]);
  return (
    <div className="pmenu" ref={ref} role="menu">
      <div className="pmenu-title">{title}</div>
      {children}
    </div>
  );
}

function Option({ on, onClick, children, hint }) {
  return (
    <button role="menuitemradio" aria-checked={!!on} className={`pmenu-opt ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="pmenu-check">{on && <IconCheck size={16} />}</span>
      <span className="pmenu-label">{children}</span>
      {hint && <span className="pmenu-hint">{hint}</span>}
    </button>
  );
}

/** Primary button that fills up while an automatic countdown runs (Netflix's "Next episode" button). */
function CountdownButton({ upNext, onClick, children, big }) {
  const p = upNext.auto ? (upNext.total - upNext.left) / upNext.total : 0;
  return (
    <button className={`btn btn-primary countdown-btn ${big ? '' : 'btn-sm'}`} onClick={onClick}>
      {upNext.auto && <span className="countdown-fill" style={{ transform: `scaleX(${p})` }} aria-hidden="true" />}
      <span className="countdown-label">
        <IconNext size={big ? 20 : 16} /> {children}
        {upNext.auto && upNext.left > 0 ? <span className="countdown-secs"> · {upNext.left}s</span> : null}
      </span>
    </button>
  );
}

export default function Player() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const prefs = user?.prefs || {};

  const shell = useRef(null);
  const videoRef = useRef(null);
  const pbRef = useRef(null);
  const hideTimer = useRef(null);

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState([]);
  const [waiting, setWaiting] = useState(true);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('sa_volume') ?? 1));
  const [muted, setMuted] = useState(false);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState(null);
  const [stats, setStats] = useState(false);
  const [server, setServer] = useState(null);
  const [levels, setLevels] = useState([]);
  const [level, setLevel] = useState(-1);
  const [quality, setQuality] = useState(prefs.quality || 'auto');
  const [speed, setSpeed] = useState(1);
  const [cues, setCues] = useState(null);
  const [subIndex, setSubIndex] = useState(null);
  const [hover, setHover] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState('');
  const [upNext, setUpNext] = useState(null);
  const [blocked, setBlocked] = useState(false);
  const [dismissedNext, setDismissedNext] = useState(false);
  const [started, setStarted] = useState(false);
  const autoplayNext = prefs.autoplayNext !== false;
  const autoplayRef = useRef(autoplayNext);
  autoplayRef.current = autoplayNext;

  const say = useCallback((msg) => {
    setNotice(msg);
    clearTimeout(say.t);
    say.t = setTimeout(() => setNotice(''), 4500);
  }, []);

  // ------------------------------------------------ session lifecycle
  useEffect(() => {
    cancelBackgroundProbe(); // never let a speed test compete with the stream
    const video = videoRef.current;
    const pb = new Playback(video);
    pbRef.current = pb;
    setData(null);
    setError('');
    setUpNext(null);
    setDismissedNext(false);
    setWaiting(true);
    setStarted(false);

    pb.addEventListener('session', (e) => {
      const d = e.detail;
      setData(d);
      const selected = d.subtitleTracks.find((s) => s.selected);
      setSubIndex(selected ? selected.index : null);
      if (!d.renditions.length) setLevels([]);
    });
    pb.addEventListener('levels', (e) => setLevels(e.detail.levels));
    pb.addEventListener('level', (e) => setLevel(e.detail.level));
    pb.addEventListener('server', (e) => setServer(e.detail));
    pb.addEventListener('fallback', (e) => say(e.detail.reason));
    pb.addEventListener('autoplay-blocked', () => setBlocked(true));
    pb.addEventListener('error', (e) => setError(e.detail.message));
    pb.addEventListener('expired', () => pb.reload({}));

    const t = params.get('t');
    const audio = params.get('audio');
    const sub = params.get('sub');
    pb.load({
      itemId: id,
      startPosition: t != null ? Number(t) : undefined,
      audioIndex: audio != null ? Number(audio) : undefined,
      subtitleIndex: sub != null ? (sub === 'off' ? 'off' : /^\d+$/.test(sub) ? Number(sub) : sub) : undefined,
      quality: prefs.quality || 'auto',
      maxBitrate: prefs.maxBitrate || 0,
    }).catch((e) => setError(e.message));

    const onHide = () => pb.report();
    const onLeave = () => pb.stop();
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onLeave);
      pb.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ------------------------------------------------ video element events
  useEffect(() => {
    const v = videoRef.current;
    v.volume = volume;
    const handlers = {
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      waiting: () => setWaiting(true),
      playing: () => {
        setWaiting(false);
        setBlocked(false);
        setStarted(true);
      },
      canplay: () => setWaiting(false),
      seeking: () => setWaiting(true),
      seeked: () => setWaiting(false),
      ended: () => {
        const d = pbRef.current?.data;
        // Episodes get an end screen (next episode, or "that was the last one"); movies just close.
        if (d?.next || d?.item?.type === 'episode') {
          setUpNext({ phase: 'end', left: d.next ? 8 : 12, total: d.next ? 8 : 12, auto: d.next ? autoplayRef.current : true });
          setControls(true);
        } else goNext(true);
      },
      volumechange: () => {
        setMuted(v.muted);
        setVolume(v.volume);
        localStorage.setItem('sa_volume', String(v.volume));
      },
    };
    for (const [k, fn] of Object.entries(handlers)) v.addEventListener(k, fn);
    const tick = setInterval(() => {
      const pb = pbRef.current;
      if (!pb) return;
      setTime(pb.currentTime);
      setBuffered(pb.bufferedRanges());
    }, 250);
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      for (const [k, fn] of Object.entries(handlers)) v.removeEventListener(k, fn);
      clearInterval(tick);
      document.removeEventListener('fullscreenchange', onFs);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------ subtitles (rendered by us: works the same in every mode)
  useEffect(() => {
    if (!data || subIndex == null) return setCues(null);
    const track = data.subtitleTracks.find((s) => String(s.index) === String(subIndex));
    if (!track?.url) return setCues(null);
    let cancelled = false;
    fetch(track.url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('subtitle'))))
      .then((txt) => !cancelled && setCues(parseVtt(txt)))
      .catch(() => !cancelled && say('Couldn\'t load those subtitles.'));
    return () => {
      cancelled = true;
    };
  }, [data, subIndex, say]);

  const activeCue = useMemo(() => {
    if (!cues) return null;
    const hits = cues.filter((c) => time >= c.start && time <= c.end);
    return hits.length ? hits.map((c) => cueHtml(c.text)).join('<br>') : null;
  }, [cues, time]);

  // ------------------------------------------------ controls visibility
  const poke = useCallback(() => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!videoRef.current?.paused) setControls(false);
    }, 3200);
  }, []);
  useEffect(() => {
    if (!playing) setControls(true);
    else poke();
  }, [playing, poke]);

  // ------------------------------------------------ actions
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (v.paused) v.play().catch(() => setBlocked(true));
    else v.pause();
  }, []);
  const seekTo = useCallback((t) => pbRef.current?.seek(t), []);
  const skip = useCallback((d) => seekTo((pbRef.current?.currentTime || 0) + d), [seekTo]);
  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else shell.current?.requestFullscreen?.().catch(() => {});
  }, []);
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoRef.current.requestPictureInPicture();
    } catch {
      say('Picture-in-picture isn\'t available here.');
    }
  };

  const exit = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(data?.item?.showId ? `/item/${data.item.showId}` : `/item/${id}`);
  }, [navigate, data, id]);

  const goNext = useCallback(
    (auto = false) => {
      const next = pbRef.current?.data?.next;
      if (next) navigate(`/play/${next.id}`, { replace: true });
      else if (auto) exit();
    },
    [navigate, exit]
  );

  const chooseSubtitle = async (track) => {
    setMenu(null);
    const pb = pbRef.current;
    const burning = data.subtitleTracks.find((s) => s.selected && !s.text);
    if (!track) {
      setSubIndex(null);
      if (burning) await pb.reload({ subtitleIndex: 'off' });
      return;
    }
    if (track.text) {
      setSubIndex(track.index);
      if (burning) await pb.reload({ subtitleIndex: track.index });
    } else {
      say('Burning in picture-based subtitles…');
      await pb.reload({ subtitleIndex: track.index });
    }
  };

  const chooseAudio = async (track) => {
    setMenu(null);
    if (track.selected) return;
    say(`Switching to ${track.label}`);
    await pbRef.current.reload({ audioIndex: track.index });
  };

  const chooseQuality = async (q) => {
    setMenu(null);
    setQuality(q);
    await pbRef.current.setQuality(q);
  };

  // ------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, select, textarea')) return;
      const v = videoRef.current;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') togglePlay();
      else if (k === 'arrowleft' || k === 'j') skip(-10);
      else if (k === 'arrowright' || k === 'l') skip(k === 'l' ? 10 : 10);
      else if (k === 'arrowup') v.volume = Math.min(1, v.volume + 0.1);
      else if (k === 'arrowdown') v.volume = Math.max(0, v.volume - 0.1);
      else if (k === 'f') toggleFs();
      else if (k === 'm') v.muted = !v.muted;
      else if (k === 'i') setStats((s) => !s);
      else if (k === 'c') {
        const first = data?.subtitleTracks.find((s) => s.text);
        if (subIndex != null) setSubIndex(null);
        else if (first) setSubIndex(first.index);
      } else if (k === 'n' && data?.next) goNext();
      else if (k === 'escape' && !document.fullscreenElement) {
        if (menu) setMenu(null);
        else exit();
      } else return;
      e.preventDefault();
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, skip, toggleFs, data, subIndex, goNext, exit, menu, poke]);

  // ------------------------------------------------ up next (Netflix-style)
  // During the credits: a "Next episode" panel. With a credits chapter in the file the panel counts
  // down and moves on by itself; without one it only offers the button (a guess could cut off the
  // last scene) and the end screen takes over when the episode finishes.
  const duration = data?.duration || 0;
  const remaining = duration - time;
  const credits = useMemo(
    () => data?.chapters?.find((c) => /credit|outro|end ?card|^end$/i.test(c.title || '') && c.start > duration * 0.6),
    [data, duration]
  );
  useEffect(() => {
    if (upNext?.phase === 'end') {
      if (remaining > 3) setUpNext(null); // seeked back after the end
      return;
    }
    if (!data?.next || dismissedNext) return;
    const trigger = credits ? time >= credits.start : remaining <= 40 && duration > 300;
    if (trigger && !upNext) {
      setUpNext({ phase: 'credits', left: 10, total: 10, auto: autoplayNext && !!credits });
      prefetch(`/api/items/${data.next.id}`);
    }
    if (!trigger && upNext?.phase === 'credits') setUpNext(null);
  }, [time, remaining, data, duration, upNext, dismissedNext, credits, autoplayNext]);
  useEffect(() => {
    if (!upNext?.auto) return;
    if (upNext.phase === 'credits' && !playing) return; // paused: hold the countdown
    if (upNext.left <= 0) return upNext.phase === 'end' && !data?.next ? exit() : goNext();
    const t = setTimeout(() => setUpNext((u) => (u?.auto ? { ...u, left: u.left - 1 } : u)), 1000);
    return () => clearTimeout(t);
  }, [upNext, playing, goNext, exit, data]);
  const watchCredits = () => {
    setUpNext(null);
    setDismissedNext(true);
  };

  // ------------------------------------------------ OS integration: media keys, lock screen, keep screen awake
  useEffect(() => {
    if (!data || !('mediaSession' in navigator)) return;
    const it = data.item;
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: it.type === 'episode' ? `${episodeCode(it)} · ${it.title}` : it.title,
      artist: it.showTitle || '',
      artwork: [{ src: it.backdrop, sizes: '1280x720', type: 'image/jpeg' }],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => videoRef.current.play());
    ms.setActionHandler('pause', () => videoRef.current.pause());
    ms.setActionHandler('seekbackward', () => skip(-10));
    ms.setActionHandler('seekforward', () => skip(10));
    ms.setActionHandler('seekto', (d) => seekTo(d.seekTime));
    if (data.next) ms.setActionHandler('nexttrack', () => goNext());
  }, [data, skip, seekTo, goNext]);

  useEffect(() => {
    if (!playing || !navigator.wakeLock) return;
    let lock;
    navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {});
    return () => lock?.release?.().catch(() => {});
  }, [playing]);

  // ------------------------------------------------ seek bar
  const barRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const posFromEvent = (e) => {
    const r = barRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const onBarMove = (e) => {
    const f = posFromEvent(e);
    setHover({ f, t: f * duration });
    if (dragging != null) setDragging(f);
  };
  const onBarDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(posFromEvent(e));
  };
  const onBarUp = (e) => {
    if (dragging == null) return;
    const f = posFromEvent(e);
    setDragging(null);
    seekTo(f * duration);
  };

  const trick = data?.trickplay;
  const preview = useMemo(() => {
    if (!hover || !trick) return null;
    const idx = Math.min(trick.count - 1, Math.floor(hover.t / trick.interval));
    const per = trick.cols * trick.rows;
    const sheet = Math.floor(idx / per);
    const within = idx % per;
    return {
      url: trick.url.replace('{n}', sheet),
      x: (within % trick.cols) * trick.width,
      y: Math.floor(within / trick.cols) * trick.height,
      w: trick.width,
      h: trick.height,
      sw: trick.width * trick.cols,
      sh: trick.height * trick.rows,
    };
  }, [hover, trick]);

  const shown = dragging != null ? dragging * duration : time;
  const pct = duration ? (shown / duration) * 100 : 0;
  const it = data?.item;
  const currentLevel = levels[level];
  const textSub = data?.subtitleTracks.find((s) => String(s.index) === String(subIndex));

  return (
    <div
      ref={shell}
      className={`player ${controls || menu ? 'show-ui' : 'hide-ui'}`}
      onPointerMove={poke}
      onPointerDown={poke}
      style={{ '--sub-scale': prefs.subtitleSize || 1 }}
    >
      <video ref={videoRef} className="player-video" playsInline preload="auto" onClick={togglePlay} onDoubleClick={toggleFs} />

      {/* Artwork while the stream starts, instead of a black screen. */}
      {!started && <div className="player-poster" style={{ backgroundImage: `url(/api/images/${id}/backdrop)` }} aria-hidden="true" />}

      {activeCue && <div className={`player-subs ${controls ? 'lifted' : ''}`} dangerouslySetInnerHTML={{ __html: activeCue }} />}

      {(waiting || !data) && !error && !blocked && (
        <div className="player-spinner" aria-label="Loading">
          <span />
        </div>
      )}

      {blocked && (
        <button className="player-bigplay" onClick={togglePlay} aria-label="Play">
          <IconPlay size={44} />
        </button>
      )}

      {error && (
        <div className="player-error" role="alert">
          <p>{error}</p>
          <div className="row-gap">
            <button className="btn btn-primary" onClick={() => { setError(''); pbRef.current.reload({ forceMode: 'transcode' }); }}>Try adaptive streaming</button>
            <button className="btn btn-glass" onClick={exit}>Go back</button>
          </div>
        </div>
      )}

      {notice && <div className="player-notice">{notice}</div>}

      <div className="player-top">
        <button className="icon-btn" onClick={exit} aria-label="Back">
          <IconArrowLeft size={26} />
        </button>
        {it && (
          <div className="player-heading">
            <span className="player-title">{it.showTitle || it.title}</span>
            {it.type === 'episode' && <span className="player-subtitle">{episodeCode(it)} · {it.title}</span>}
          </div>
        )}
        {data && (
          <button className={`mode-pill mode-${data.mode}`} onClick={() => setStats((s) => !s)} title="Playback info (i)">
            {modeLabel(data)}
            {data.mode === 'transcode' ? (data.renditions.length === 1 ? ` · ${data.renditions[0].id}` : currentLevel ? ` · ${currentLevel.height}p` : '') : ''}
          </button>
        )}
      </div>

      {stats && data && <Stats data={data} pb={pbRef.current} server={server} level={currentLevel} onClose={() => setStats(false)} />}

      {upNext?.phase === 'credits' && data?.next && (
        <div className="upnext" role="dialog" aria-label="Next episode">
          <button className="upnext-art" onClick={() => goNext()} aria-label={`Play ${episodeCode(data.next)} ${data.next.title}`}>
            <Img src={sized(data.next.thumb, 220)} alt="" eager />
            <span className="card-play" aria-hidden="true"><IconPlay size={18} /></span>
          </button>
          <div className="upnext-body">
            <span className="upnext-label">Next episode</span>
            <strong className="upnext-title">{episodeCode(data.next)} · {data.next.title}</strong>
            <div className="row-gap">
              <CountdownButton upNext={upNext} onClick={() => goNext()}>Next episode</CountdownButton>
              <button className="btn btn-glass btn-sm" onClick={watchCredits}>Watch credits</button>
            </div>
          </div>
        </div>
      )}

      {upNext?.phase === 'end' && data && (
        <div className="endcard" role="dialog" aria-label={data.next ? 'Up next' : 'Finished'}>
          {data.next?.thumb && <Img className="endcard-bg" src={sized(data.next.thumb, 960)} alt="" eager />}
          <div className="endcard-inner">
            {data.next ? (
              <>
                <span className="upnext-label">Up next{data.item.showTitle ? ` in ${data.item.showTitle}` : ''}</span>
                <button className="endcard-art" onClick={() => goNext()} aria-label={`Play ${data.next.title}`}>
                  <Img src={sized(data.next.thumb, 480)} alt="" eager />
                  <span className="card-play" aria-hidden="true"><IconPlay size={26} /></span>
                </button>
                <h2 className="endcard-title">{episodeCode(data.next)} · {data.next.title}</h2>
                {data.next.overview && <p className="endcard-overview">{data.next.overview}</p>}
                <div className="row-gap">
                  <CountdownButton upNext={upNext} onClick={() => goNext()} big>Play next episode</CountdownButton>
                  <button className="btn btn-glass" onClick={exit}>Back to {data.item.showTitle ? 'the series' : 'browse'}</button>
                </div>
              </>
            ) : (
              <>
                <span className="upnext-label">{data.item.showTitle || 'Series'}</span>
                <h2 className="endcard-title">That was the last episode</h2>
                <p className="endcard-overview">You're all caught up. New episodes show up here as soon as they land in your library.</p>
                <div className="row-gap">
                  <button className="btn btn-primary" onClick={exit}>Back to the series</button>
                  <button className="btn btn-glass" onClick={() => { setUpNext(null); seekTo(0); videoRef.current.play().catch(() => {}); }}>Watch again</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="player-bottom">
        <div
          className="seekbar"
          ref={barRef}
          onPointerMove={onBarMove}
          onPointerLeave={() => dragging == null && setHover(null)}
          onPointerDown={onBarDown}
          onPointerUp={onBarUp}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={formatDuration(time)}
          tabIndex={0}
        >
          <div className="seekbar-rail">
            {buffered.map(([a, b], i) => (
              <span key={i} className="seekbar-buffer" style={{ left: `${(a / duration) * 100}%`, width: `${((b - a) / duration) * 100}%` }} />
            ))}
            <span className="seekbar-fill" style={{ width: `${pct}%` }} />
            {data?.chapters?.map((c, i) => (i > 0 ? <span key={i} className="seekbar-chapter" style={{ left: `${(c.start / duration) * 100}%` }} /> : null))}
          </div>
          <span className="seekbar-knob" style={{ left: `${pct}%` }} />
          {hover && (
            <div className="seekbar-preview" style={{ left: `clamp(${(preview?.w || 60) / 2}px, ${hover.f * 100}%, calc(100% - ${(preview?.w || 60) / 2}px))` }}>
              {preview && (
                <div
                  className="seekbar-thumb"
                  style={{ width: preview.w, height: preview.h, backgroundImage: `url(${preview.url})`, backgroundPosition: `-${preview.x}px -${preview.y}px`, backgroundSize: `${preview.sw}px ${preview.sh}px` }}
                />
              )}
              <span>{formatDuration(hover.t)}</span>
              {data?.chapters?.length > 1 && (() => {
                const ch = [...data.chapters].reverse().find((c) => c.start <= hover.t);
                return ch?.title ? <em>{ch.title}</em> : null;
              })()}
            </div>
          )}
        </div>

        <div className="player-controls">
          <button className="icon-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <IconPause size={28} /> : <IconPlay size={28} />}
          </button>
          <button className="icon-btn" onClick={() => skip(-10)} aria-label="Back 10 seconds">
            <IconBack10 size={26} />
          </button>
          <button className="icon-btn" onClick={() => skip(10)} aria-label="Forward 10 seconds">
            <IconFwd10 size={26} />
          </button>
          <div className="volume">
            <button className="icon-btn" onClick={() => (videoRef.current.muted = !muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? <IconMute /> : <IconVolume />}
            </button>
            <input type="range" min="0" max="1" step="0.02" value={muted ? 0 : volume} onChange={(e) => { videoRef.current.muted = false; videoRef.current.volume = Number(e.target.value); }} aria-label="Volume" />
          </div>
          <span className="player-time">
            {formatDuration(shown)} <span className="muted">/ {formatDuration(duration)}</span>
          </span>
          <span className="spacer" />

          {data?.next && (
            <button className="icon-btn" onClick={() => goNext()} aria-label="Next episode" title="Next episode (n)">
              <IconNext />
            </button>
          )}

          <div className="pmenu-anchor">
            <button data-menu-toggle className={`icon-btn ${subIndex != null ? 'on' : ''}`} onClick={() => setMenu(menu === 'subs' ? null : 'subs')} aria-label="Subtitles" disabled={!data}>
              <IconSubtitles />
            </button>
            {menu === 'subs' && data && (
              <Menu title="Subtitles" onClose={() => setMenu(null)}>
                <Option on={subIndex == null} onClick={() => chooseSubtitle(null)}>Off</Option>
                {data.subtitleTracks.map((s) => (
                  <Option key={s.index} on={String(subIndex) === String(s.index)} onClick={() => chooseSubtitle(s)}>
                    {s.label}
                  </Option>
                ))}
                {!data.subtitleTracks.length && <p className="pmenu-empty">No subtitles in this file.</p>}
              </Menu>
            )}
          </div>

          {data?.audioTracks.length > 1 && (
            <div className="pmenu-anchor">
              <button data-menu-toggle className="icon-btn" onClick={() => setMenu(menu === 'audio' ? null : 'audio')} aria-label="Audio track">
                <IconAudio />
              </button>
              {menu === 'audio' && (
                <Menu title="Audio" onClose={() => setMenu(null)}>
                  {data.audioTracks.map((a) => (
                    <Option key={a.index} on={a.selected} onClick={() => chooseAudio(a)}>
                      {a.label}
                    </Option>
                  ))}
                </Menu>
              )}
            </div>
          )}

          <div className="pmenu-anchor">
            <button data-menu-toggle className="icon-btn" onClick={() => setMenu(menu === 'quality' ? null : 'quality')} aria-label="Quality and speed" disabled={!data}>
              <IconGauge />
            </button>
            {menu === 'quality' && data && (
              <Menu title="Quality" onClose={() => setMenu(null)}>
                <Option on={quality === 'auto'} onClick={() => chooseQuality('auto')} hint={data.mode === 'transcode' && !data.fixedQuality && quality === 'auto' && currentLevel ? `${currentLevel.height}p now` : null}>
                  Automatic
                </Option>
                <Option on={quality === 'original'} onClick={() => chooseQuality('original')} hint={formatBitrate(data.source.bitrate)}>
                  Original
                </Option>
                {data.qualities.map((r) => (
                  <Option key={r.id} on={quality === r.id} onClick={() => chooseQuality(r.id)} hint={r.bitrate ? formatBitrate(r.bitrate) : null}>
                    {r.id}
                  </Option>
                ))}
                <div className="pmenu-title">Speed</div>
                <div className="pmenu-speeds">
                  {SPEEDS.map((s) => (
                    <button key={s} className={speed === s ? 'on' : ''} onClick={() => { setSpeed(s); videoRef.current.playbackRate = s; }}>
                      {s}×
                    </button>
                  ))}
                </div>
              </Menu>
            )}
          </div>

          <button className={`icon-btn ${stats ? 'on' : ''}`} onClick={() => setStats((s) => !s)} aria-label="Playback info">
            <IconInfo />
          </button>
          {document.pictureInPictureEnabled && (
            <button className="icon-btn" onClick={togglePip} aria-label="Picture in picture">
              <IconPip />
            </button>
          )}
          <button className="icon-btn" onClick={toggleFs} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
            {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
          </button>
        </div>
        {textSub && !textSub.text && <span className="sr-only">Subtitles are burned into the picture.</span>}
      </div>
    </div>
  );
}
