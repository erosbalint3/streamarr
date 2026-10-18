import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, formatBitrate, formatBytes, formatDuration, timeAgo } from '../api.js';
import { useAuth } from '../auth.jsx';
import { toast } from '../components/Toast.jsx';
import { IconFolder, IconRefresh, IconTrash, IconClose, IconPlus, IconChevronLeft } from '../components/Icons.jsx';

function usePoll(url, ms) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api.get(url).then(setData).catch(() => {}), [url]);
  useEffect(() => {
    load();
    if (!ms) return;
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [load, ms]);
  return [data, load];
}

const plural = (n, word) => `${n || 0} ${word}${n === 1 ? '' : 's'}`;
const MODE_LABEL = { direct: 'Direct play', remux: 'Direct stream', transcode: 'Transcode' };

// ------------------------------------------------------------ overview
function Overview() {
  const [status] = usePoll('/api/admin/status', 5000);
  const [sessions, reloadSessions] = usePoll('/api/admin/sessions', 2000);
  const [history] = usePoll('/api/admin/history', 15000);

  const kill = async (id) => {
    await api.del(`/api/admin/sessions/${id}`);
    reloadSessions();
  };

  const ps = status?.playStats || {};
  const directShare = ps.plays ? Math.round((((ps.direct || 0) + (ps.remux || 0)) / ps.plays) * 100) : null;

  return (
    <div className="admin-grid">
      <section className="panel span-2">
        <h2>Now playing</h2>
        {!sessions?.length && <p className="muted">Nobody is watching right now.</p>}
        <div className="sessions">
          {sessions?.map((s) => (
            <article key={s.id} className="session">
              <div className="session-head">
                <div>
                  <strong>{s.title}</strong>
                  <span className="muted small">{s.user} · {s.client}</span>
                </div>
                <span className={`mode-pill mode-${s.mode}`}>{MODE_LABEL[s.mode]}</span>
              </div>
              <div className="session-bar">
                <span style={{ width: `${(s.position / s.duration) * 100}%` }} />
              </div>
              <div className="session-facts">
                <span>{s.paused ? 'Paused' : 'Playing'} at {formatDuration(s.position)} / {formatDuration(s.duration)}</span>
                <span>Source: {s.source.video} · {s.source.audio} · {formatBitrate(s.source.bitrate)}</span>
                {s.transcode && (
                  <span>
                    {s.transcode.rendition} @ {formatBitrate(s.transcode.bitrate)} · {s.transcode.level} · {s.transcode.speed ? `${s.transcode.speed.toFixed(1)}×` : '…'} ·{' '}
                    {s.transcode.throttled ? 'throttled' : s.transcode.running ? 'encoding' : 'idle'} · {Math.round(s.transcode.aheadSeconds)} s ahead
                  </span>
                )}
                <span>Client buffer: {s.buffer ?? '—'} s · Connection: {formatBitrate(s.bandwidth)} · Stalls: {s.stalls}</span>
                {s.reasons.length > 0 && <span className="muted">Why: {s.reasons.join('; ')}</span>}
              </div>
              <button className="link-btn danger small" onClick={() => kill(s.id)}>Stop this stream</button>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Server</h2>
        {status ? (
          <dl className="kv">
            <dt>Library</dt>
            <dd>{plural(status.library.movies, 'movie')} · {plural(status.library.shows, 'show')} · {plural(status.library.episodes, 'episode')}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(status.library.bytes)} · {Math.round(status.library.seconds / 3600)} hours</dd>
            <dt>CPU</dt>
            <dd>{status.hardware.cpus} × {status.hardware.cpuModel} · load {status.load.map((l) => l.toFixed(1)).join(' / ')}</dd>
            <dt>GPU</dt>
            <dd>{[status.hardware.vaapiDevices.length ? `VAAPI (${status.hardware.vaapiDevices.join(', ')})` : null, status.hardware.nvidia ? 'NVIDIA' : null].filter(Boolean).join(', ') || 'None detected'}</dd>
            <dt>Transcode disk</dt>
            <dd>{status.transcodeDisk ? `${formatBytes(status.transcodeDisk.free)} free` : '—'}</dd>
            <dt>FFmpeg</dt>
            <dd className="small">{status.ffmpeg}</dd>
            <dt>Background</dt>
            <dd>{status.tasks.paused ? 'Paused while transcoding' : status.tasks.running || 'Idle'}{status.tasks.queued ? ` · ${status.tasks.queued} queued` : ''}</dd>
          </dl>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="panel">
        <h2>Last 30 days</h2>
        {status && (
          <dl className="kv">
            <dt>Plays</dt>
            <dd>{ps.plays || 0}</dd>
            <dt>Original quality</dt>
            <dd>{directShare != null ? `${directShare}% (direct play + direct stream)` : '—'}</dd>
            <dt>Transcodes</dt>
            <dd>{ps.transcode || 0}</dd>
            <dt>Buffering events</dt>
            <dd>{ps.stalls || 0}</dd>
          </dl>
        )}
        <h3>Recent plays</h3>
        <ul className="history">
          {history?.slice(0, 12).map((h) => (
            <li key={h.id}>
              <span>{h.show_title ? `${h.show_title} S${h.season_number}E${h.episode_number}` : h.title || 'Deleted item'}</span>
              <span className="muted small">{h.username} · {MODE_LABEL[h.mode]} · {timeAgo(h.started_at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ------------------------------------------------------------ libraries
function FolderPicker({ onPick, onClose }) {
  const [dir, setDir] = useState({ path: null, dirs: [], parent: null });
  const [error, setError] = useState('');
  const open = useCallback((p) => {
    setError('');
    api.get(`/api/fs/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`).then(setDir).catch((e) => setError(e.message));
  }, []);
  useEffect(() => open(null), [open]);
  return (
    <div className="modal" role="dialog" aria-label="Choose a folder">
      <div className="modal-card">
        <header>
          <strong>Choose a folder</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose size={18} /></button>
        </header>
        <div className="picker-path">
          {dir.path != null && (
            <button className="icon-btn" onClick={() => open(dir.parent || null)} aria-label="Up one folder"><IconChevronLeft size={18} /></button>
          )}
          <code>{dir.path || 'Media roots'}</code>
        </div>
        {error && <p className="form-error">{error}</p>}
        <ul className="picker-list">
          {dir.dirs.map((d) => (
            <li key={d.path}>
              <button onClick={() => open(d.path)}><IconFolder size={18} /> {d.name}</button>
            </li>
          ))}
          {!dir.dirs.length && <li className="muted small">No subfolders.</li>}
        </ul>
        <footer>
          <button className="btn btn-primary" disabled={!dir.path} onClick={() => onPick(dir.path)}>Use this folder</button>
        </footer>
      </div>
    </div>
  );
}

function Libraries() {
  const [libs, reload] = usePoll('/api/libraries', 0);
  const [scan, reloadScan] = usePoll('/api/scan', 2000);
  const [form, setForm] = useState(null);
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    if (scan && !scan.running) reload();
  }, [scan?.running, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    try {
      if (form.id) await api.put(`/api/libraries/${form.id}`, { name: form.name, paths: form.paths });
      else await api.post('/api/libraries', form);
      toast(form.id ? 'Library updated – rescanning' : 'Library added – scanning now', 'ok');
      setForm(null);
      reload();
      reloadScan();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const remove = async (lib) => {
    if (!window.confirm(`Remove “${lib.name}”? Your files stay untouched; watch history for it is lost.`)) return;
    await api.del(`/api/libraries/${lib.id}`);
    reload();
  };

  const rescan = async (lib, full = false) => {
    await api.post(`/api/libraries/${lib.id}/scan`, { full });
    reloadScan();
    toast(full ? 'Full rescan started' : 'Scan started');
  };

  return (
    <div className="stack-lg">
      {scan?.running && (
        <div className="scanbar">
          <strong>Scanning {scan.library}</strong> — {scan.phase} {scan.total ? `(${scan.processed}/${scan.total})` : ''}
          <div className="session-bar"><span style={{ width: scan.total ? `${(scan.processed / scan.total) * 100}%` : '10%' }} /></div>
        </div>
      )}
      <div className="lib-list">
        {libs?.map((l) => (
          <article key={l.id} className="panel lib">
            <div>
              <h3>{l.name}</h3>
              <p className="muted small">
                {l.type === 'movies' ? 'Movies' : l.type === 'shows' ? 'TV shows' : 'Other videos'} · {plural(l.itemCount, 'title')}{l.episodeCount ? ` · ${plural(l.episodeCount, 'episode')}` : ''} · scanned {timeAgo(l.lastScan)}
              </p>
              {l.paths.map((p) => <code key={p} className="path">{p}</code>)}
            </div>
            <div className="lib-actions">
              <button className="btn btn-glass btn-sm" onClick={() => rescan(l)}><IconRefresh size={16} /> Scan</button>
              <button className="btn btn-glass btn-sm" onClick={() => rescan(l, true)}>Full rescan</button>
              <button className="btn btn-glass btn-sm" onClick={() => setForm({ id: l.id, name: l.name, type: l.type, paths: l.paths })}>Edit</button>
              <button className="icon-btn" onClick={() => remove(l)} aria-label={`Remove ${l.name}`}><IconTrash size={18} /></button>
            </div>
          </article>
        ))}
        {libs && !libs.length && !form && <p className="muted">No libraries yet. Add one to start scanning your media.</p>}
      </div>

      {!form && (
        <button className="btn btn-primary" onClick={() => setForm({ name: '', type: 'movies', paths: [] })}>
          <IconPlus size={18} /> Add library
        </button>
      )}

      {form && (
        <form className="panel stack" onSubmit={save}>
          <h2>{form.id ? 'Edit library' : 'New library'}</h2>
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Movies" required />
          </label>
          {!form.id && (
            <div className="field">
              <span>Type</span>
              <div className="segmented">
                {[['movies', 'Movies'], ['shows', 'TV shows'], ['other', 'Other videos']].map(([k, l]) => (
                  <button type="button" key={k} className={form.type === k ? 'on' : ''} onClick={() => setForm({ ...form, type: k })}>{l}</button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <span>Folders</span>
            {form.paths.map((p) => (
              <div key={p} className="path-row">
                <code className="path">{p}</code>
                <button type="button" className="icon-btn" onClick={() => setForm({ ...form, paths: form.paths.filter((x) => x !== p) })} aria-label="Remove folder"><IconClose size={16} /></button>
              </div>
            ))}
            <button type="button" className="btn btn-glass btn-sm" onClick={() => setPicker(true)}><IconFolder size={16} /> Add folder</button>
            <small className="muted">
              {form.type === 'shows' ? 'One folder per show, e.g. Breaking Bad/Season 01/Breaking.Bad.S01E01.mkv' : 'Files like The Matrix (1999).mkv, optionally in their own folder.'}
            </small>
          </div>
          <div className="row-gap">
            <button className="btn btn-primary" disabled={!form.paths.length || !form.name}>{form.id ? 'Save changes' : 'Add library'}</button>
            <button type="button" className="btn btn-glass" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
      {picker && (
        <FolderPicker
          onClose={() => setPicker(false)}
          onPick={(p) => {
            setForm((f) => ({ ...f, paths: [...new Set([...f.paths, p])] }));
            setPicker(false);
          }}
        />
      )}
      {scan?.errors?.length > 0 && (
        <details className="panel">
          <summary>{scan.errors.length} files couldn't be read in the last scan</summary>
          <ul className="small muted">{scan.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------ users
function Users() {
  const { user } = useAuth();
  const [users, reload] = usePoll('/api/admin/users', 0);
  const [form, setForm] = useState({ username: '', password: '', isAdmin: false });

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/admin/users', form);
      setForm({ username: '', password: '', isAdmin: false });
      toast('User created', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const act = async (fn) => {
    try {
      await fn();
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return (
    <div className="admin-grid">
      <section className="panel span-2">
        <h2>People</h2>
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Last played</th><th /></tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id}>
                <td>{u.username}{u.id === user.id ? ' (you)' : ''}</td>
                <td>{u.isAdmin ? 'Admin' : 'Viewer'}</td>
                <td>{timeAgo(u.lastPlayed)}</td>
                <td className="right">
                  {u.id !== user.id && (
                    <>
                      <button className="link-btn small" onClick={() => act(() => api.put(`/api/admin/users/${u.id}`, { isAdmin: !u.isAdmin }))}>{u.isAdmin ? 'Make viewer' : 'Make admin'}</button>
                      <button className="link-btn small" onClick={() => { const p = window.prompt(`New password for ${u.username}:`); if (p) act(() => api.put(`/api/admin/users/${u.id}`, { password: p })); }}>Reset password</button>
                      <button className="link-btn danger small" onClick={() => window.confirm(`Delete ${u.username}?`) && act(() => api.del(`/api/admin/users/${u.id}`))}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <form className="panel stack" onSubmit={create}>
        <h2>Add a person</h2>
        <label className="field"><span>Username</span><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
        <label className="field"><span>Password</span><input type="password" minLength={6} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
        <label className="check"><input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} /> Can manage the server</label>
        <button className="btn btn-primary">Create account</button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------ server settings
function ServerSettings() {
  const [s, setS] = useState(null);
  const [test, setTest] = useState(null);
  useEffect(() => {
    api.get('/api/admin/settings').then(setS);
  }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const set = (k, v) => setS({ ...s, [k]: v });

  const save = async (e) => {
    e.preventDefault();
    try {
      setS(await api.put('/api/admin/settings', s));
      toast('Settings saved', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const runTest = async () => {
    setTest({ running: true });
    setTest(await api.post('/api/admin/hwtest', { hwaccel: s.hwaccel }));
  };

  return (
    <form className="admin-grid" onSubmit={save}>
      <section className="panel stack">
        <h2>Transcoding</h2>
        <label className="field">
          <span>Hardware acceleration</span>
          <select value={s.hwaccel} onChange={(e) => set('hwaccel', e.target.value)}>
            <option value="none">None (CPU)</option>
            <option value="vaapi">Intel / AMD (VAAPI)</option>
            <option value="nvenc">NVIDIA (NVENC)</option>
          </select>
          <small className="muted">The GPU must be passed into the container – see the README. Falls back to CPU automatically if it fails.</small>
        </label>
        {s.hwaccel === 'vaapi' && (
          <label className="field"><span>VAAPI device</span><input value={s.vaapiDevice} onChange={(e) => set('vaapiDevice', e.target.value)} /></label>
        )}
        <div className="row-gap">
          <button type="button" className="btn btn-glass btn-sm" onClick={runTest} disabled={test?.running}>{test?.running ? 'Testing…' : 'Test encoder'}</button>
          {test && !test.running && (test.ok ? <span className="ok small">Works – {test.speed}× real time for 1080p</span> : <span className="bad small">Failed: {test.error}</span>)}
        </div>
        <label className="field">
          <span>CPU encoder preset</span>
          <select value={s.transcodePreset} onChange={(e) => set('transcodePreset', e.target.value)}>
            {['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].map((p) => <option key={p}>{p}</option>)}
          </select>
          <small className="muted">Faster presets keep up on weaker CPUs; slower ones look better at the same bitrate.</small>
        </label>
        <label className="field">
          <span>Highest CPU-transcoded resolution</span>
          <select value={s.maxSoftwareHeight} onChange={(e) => set('maxSoftwareHeight', Number(e.target.value))}>
            {[720, 1080, 1440, 2160].map((h) => <option key={h} value={h}>{h}p</option>)}
          </select>
          <small className="muted">Renditions above this are only offered with a GPU, so the server never promises more than it can encode in real time.</small>
        </label>
        <label className="field">
          <span>Encode ahead of the player (seconds)</span>
          <input type="number" min="30" max="1800" value={s.transcodeAheadSeconds} onChange={(e) => set('transcodeAheadSeconds', Number(e.target.value))} />
          <small className="muted">A bigger lead rides out network hiccups. Uses more transcode disk space.</small>
        </label>
        <label className="check"><input type="checkbox" checked={s.stereoDownmix} onChange={(e) => set('stereoDownmix', e.target.checked)} /> Downmix converted audio to stereo</label>
      </section>

      <section className="panel stack">
        <h2>Metadata</h2>
        <label className="field">
          <span>Server name</span>
          <input value={s.serverName} onChange={(e) => set('serverName', e.target.value)} />
        </label>
        <label className="field">
          <span>TMDB API key</span>
          <input value={s.tmdbApiKey} onChange={(e) => set('tmdbApiKey', e.target.value)} placeholder="Paste a v3 key or v4 read token" />
          <small className="muted">Free at themoviedb.org → Settings → API. Adds posters, backdrops, cast and descriptions.</small>
        </label>
        <label className="field">
          <span>Metadata language</span>
          <input value={s.metadataLanguage} onChange={(e) => set('metadataLanguage', e.target.value)} placeholder="en-US" />
        </label>
        <label className="field">
          <span>Rescan libraries every (minutes, 0 = never)</span>
          <input type="number" min="0" value={s.scanIntervalMinutes} onChange={(e) => set('scanIntervalMinutes', Number(e.target.value))} />
        </label>
        <label className="check"><input type="checkbox" checked={s.trickplay} onChange={(e) => set('trickplay', e.target.checked)} /> Generate seek-bar preview thumbnails</label>
        <label className="check"><input type="checkbox" checked={s.extractSubtitles} onChange={(e) => set('extractSubtitles', e.target.checked)} /> Pre-extract embedded subtitles</label>
      </section>
      <div className="span-2">
        <button className="btn btn-primary">Save settings</button>
      </div>
    </form>
  );
}

export default function Admin() {
  const { user } = useAuth();
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return (
    <div className="admin">
      <header className="admin-head">
        <h1>Server dashboard</h1>
        <nav className="tabs">
          <NavLink to="/admin" end>Activity</NavLink>
          <NavLink to="/admin/libraries">Libraries</NavLink>
          <NavLink to="/admin/users">People</NavLink>
          <NavLink to="/admin/settings">Settings</NavLink>
        </nav>
      </header>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="libraries" element={<Libraries />} />
        <Route path="users" element={<Users />} />
        <Route path="settings" element={<ServerSettings />} />
      </Routes>
    </div>
  );
}
