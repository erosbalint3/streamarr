import { useState } from 'react';
import { api, formatBitrate } from '../api.js';
import { useAuth } from '../auth.jsx';
import { toast } from '../components/Toast.jsx';
import { detectCaps, measureBandwidth } from '../player/caps.js';

const QUALITIES = [
  ['auto', 'Automatic', 'Plays the original when your connection can carry it, adapts otherwise.'],
  ['original', 'Always original', 'Never reduces quality. May buffer on slow connections.'],
  ['1080p', '1080p', 'Converted to 1080p at most.'],
  ['720p', '720p', 'Good for mobile data or busy Wi-Fi.'],
  ['480p', '480p', 'Lowest data use.'],
];
const BITRATES = [
  [0, 'No limit'],
  [40_000_000, '40 Mbps'],
  [20_000_000, '20 Mbps'],
  [10_000_000, '10 Mbps'],
  [6_000_000, '6 Mbps'],
  [3_000_000, '3 Mbps'],
];
const LANGS = [
  ['', 'Any'],
  ['en', 'English'],
  ['hu', 'Hungarian'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
];

export default function Settings() {
  const { user, updatePrefs } = useAuth();
  const prefs = user?.prefs || {};
  const [speed, setSpeed] = useState(null);
  const [testing, setTesting] = useState(false);
  const [pw, setPw] = useState({ current: '', password: '' });
  const caps = detectCaps();

  const save = async (patch) => {
    await updatePrefs(patch);
    toast('Saved', 'ok');
  };

  const test = async () => {
    setTesting(true);
    setSpeed(await measureBandwidth({ force: true }));
    setTesting(false);
  };

  const changePassword = async (e) => {
    e.preventDefault();
    try {
      await api.put('/api/me/password', pw);
      setPw({ current: '', password: '' });
      toast('Password changed', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const supported = (o) => Object.entries(o).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(', ') || 'none';

  return (
    <div className="settings narrow">
      <h1>Playback & account</h1>

      <section className="panel">
        <h2>Streaming quality</h2>
        <div className="choice-list">
          {QUALITIES.map(([k, label, desc]) => (
            <label key={k} className={`choice ${(prefs.quality || 'auto') === k ? 'on' : ''}`}>
              <input type="radio" name="quality" checked={(prefs.quality || 'auto') === k} onChange={() => save({ quality: k })} />
              <span className="choice-label">{label}</span>
              <span className="choice-desc">{desc}</span>
            </label>
          ))}
        </div>
        <label className="field inline">
          <span>Bitrate limit</span>
          <select value={prefs.maxBitrate || 0} onChange={(e) => save({ maxBitrate: Number(e.target.value) })}>
            {BITRATES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <div className="speedtest">
          <button className="btn btn-glass" onClick={test} disabled={testing}>{testing ? 'Measuring…' : 'Test my connection to the server'}</button>
          {speed != null && <span><strong>{formatBitrate(speed)}</strong> — {speed > 60e6 ? 'enough for 4K originals.' : speed > 25e6 ? 'enough for most 1080p originals.' : speed > 8e6 ? 'heavy files will play in adaptive mode.' : 'expect adaptive quality for most titles.'}</span>}
        </div>
      </section>

      <section className="panel">
        <h2>Audio & subtitles</h2>
        <label className="field inline">
          <span>Preferred audio language</span>
          <select value={prefs.audioLanguage || ''} onChange={(e) => save({ audioLanguage: e.target.value })}>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l === 'Any' ? 'File default' : l}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>Show subtitles</span>
          <select value={prefs.subtitleMode || 'forced'} onChange={(e) => save({ subtitleMode: e.target.value })}>
            <option value="off">Never</option>
            <option value="forced">Only forced (foreign dialogue)</option>
            <option value="always">Always</option>
          </select>
        </label>
        <label className="field inline">
          <span>Subtitle language</span>
          <select value={prefs.subtitleLanguage || ''} onChange={(e) => save({ subtitleLanguage: e.target.value })}>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>Subtitle size</span>
          <select value={prefs.subtitleSize || 1} onChange={(e) => save({ subtitleSize: Number(e.target.value) })}>
            <option value={0.8}>Small</option>
            <option value={1}>Medium</option>
            <option value={1.25}>Large</option>
            <option value={1.5}>Extra large</option>
          </select>
        </label>
      </section>

      <section className="panel">
        <h2>This device</h2>
        <dl className="kv">
          <dt>Video codecs</dt><dd>{supported(caps.video)}</dd>
          <dt>Audio codecs</dt><dd>{supported(caps.audio)}</dd>
          <dt>HDR display</dt><dd>{caps.hdr ? 'Yes – HDR plays without tone mapping' : 'No – HDR is tone-mapped on the server'}</dd>
          <dt>Adaptive streaming</dt><dd>{caps.hls === 'mse' ? 'hls.js' : caps.hls === 'native' ? 'Native HLS' : 'Unavailable'}</dd>
        </dl>
      </section>

      <section className="panel">
        <h2>Password</h2>
        <form onSubmit={changePassword} className="stack">
          <label className="field">
            <span>Current password</span>
            <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          </label>
          <label className="field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" minLength={6} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required />
          </label>
          <button className="btn btn-primary">Change password</button>
        </form>
      </section>
    </div>
  );
}
