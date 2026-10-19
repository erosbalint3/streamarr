import Hls from 'hls.js';
import { api } from '../api.js';
import { detectCaps, measureBandwidth } from './caps.js';

export { detectCaps, measureBandwidth };

// ------------------------------------------------------------ subtitles

const vttTime = (s) => {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000 : 0;
};

export function parseVtt(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push({ start: vttTime(a), end: vttTime(b.trim().split(/\s+/)[0]), text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

export function cueHtml(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/&lt;(\/?)(i|b|u)&gt;/g, '<$1$2>')
    .replace(/&lt;[^&]*?&gt;/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\n/g, '<br>');
}

// ------------------------------------------------------------ playback controller

// Remux via MSE: how far ahead we pull the stream, and how much played data we keep for quick back-seeks.
const MSE_MAX_AHEAD = 150; // seconds, upper bound
// Browsers cap a SourceBuffer at roughly 150 MB of video (Chrome) – at 40 Mbps that is only ~30 s.
// Start from a byte budget below that, then learn the real limit from QuotaExceededError.
const MSE_BYTE_BUDGET = 110 * 1000 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Codec string for the fragmented MP4 the server remuxes, or null if MSE can't take it. */
export function remuxMime(source) {
  const v = source?.video;
  const a = source?.audio;
  if (!v) return null;
  let vc;
  if (v.codec === 'h264') {
    const prof = { baseline: '42', 'constrained baseline': '42', main: '4d', high: '64', 'high 10': '6e', 'high 4:2:2': '7a' }[(v.profile || 'high').toLowerCase()] || '64';
    vc = `avc1.${prof}00${Math.max(10, Number(v.level) || 40).toString(16).padStart(2, '0')}`;
  } else if (v.codec === 'hevc') {
    const main10 = /10/.test(v.profile || '') || v.bitDepth > 8;
    vc = `hvc1.${main10 ? 2 : 1}.${main10 ? 4 : 6}.L${Number(v.level) > 0 ? v.level : 120}.B0`;
  } else if (v.codec === 'av1') vc = `av01.0.08M.${v.bitDepth > 8 ? '10' : '08'}`;
  else if (v.codec === 'vp9') vc = v.bitDepth > 8 ? 'vp09.02.40.10' : 'vp09.00.40.08';
  else return null;
  let ac = null;
  if (a) {
    ac = { aac: 'mp4a.40.2', mp3: 'mp4a.6B', ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'flac', alac: 'alac' }[a.copy ? a.codec : 'aac'];
    if (!ac) return null;
  }
  const mime = `video/mp4; codecs="${[vc, ac].filter(Boolean).join(',')}"`;
  const MS = window.ManagedMediaSource || window.MediaSource;
  return MS?.isTypeSupported?.(mime) ? mime : null;
}

/**
 * hls.js assumes segments already exist on a CDN. Ours are encoded on demand, so the first byte
 * of a segment can take a few seconds after a seek or a quality change. The stock controller reads
 * that as a slow network, aborts the download and switches down – which starts a second encoder
 * and makes everything slower. Keep the normal bandwidth-based choice, drop the emergency abort.
 */
const BaseAbr = Hls.DefaultConfig.abrController;
class TranscodeAbrController extends BaseAbr {
  constructor(hls) {
    super(hls);
    this._abandonRulesCheck = () => {};
  }
}

const HLS_CONFIG = {
  abrController: TranscodeAbrController,
  // A deep forward buffer rides out Wi-Fi dips, but it has to fit the browser's SourceBuffer
  // memory (~150 MB in Chrome); overshooting causes "buffer full" errors and stalls.
  maxBufferLength: 60,
  maxMaxBufferLength: 300,
  maxBufferSize: 120 * 1000 * 1000,
  backBufferLength: 30,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 10,
  startFragPrefetch: true,
  enableWorker: true,
  lowLatencyMode: false,
  capLevelToPlayerSize: false,
  // Be conservative when stepping up, quick to step down.
  abrBandWidthFactor: 0.85,
  abrBandWidthUpFactor: 0.65,
  // After a seek the server may need a moment to start encoding at the new position.
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 50000,
      maxLoadTimeMs: 120000,
      timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
    },
  },
};

export class Playback extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.hls = null;
    this.data = null;
    this.offset = 0;
    this.base = 0; // added to video.currentTime to get file time (progressive remux starts at 0)
    this.mse = null;
    this.opts = {};
    this.stalls = 0;
    this.recentStalls = [];
    this.stallStart = null;
    this.seeking = false;
    this.bandwidth = 0;
    this.server = null;
    this.capped = false;
    this.destroyed = false;
    this._timers = [];
    this._bind();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _bind() {
    const v = this.video;
    const on = (ev, fn) => {
      v.addEventListener(ev, fn);
      this._timers.push(() => v.removeEventListener(ev, fn));
    };
    on('seeking', () => (this.seeking = true));
    on('seeked', () => {
      this.seeking = false;
      // A re-sync nudge is part of the ongoing stall: keep its clock running so a stall that the
      // nudge doesn't cure still escalates (restart the stream, then convert).
      if (this._nudging) {
        this._nudging = false;
        return;
      }
      this.stallStart = null;
    });
    on('waiting', () => {
      if (this.sourceLoading) return; // a new stream starting up, not a stall
      if (!this.seeking && !v.paused && this.stallStart == null) {
        this.stallStart = performance.now();
        this.stallSnap = this._snapshot();
      }
    });
    const resolved = () => {
      this.seeking = false;
      if (this.sourceLoading) {
        this.sourceLoading = false;
        this.stallStart = null;
        return;
      }
      if (this.stallStart != null) {
        const ms = performance.now() - this.stallStart;
        if (ms > 1000) {
          this.stalls++;
          this.recentStalls.push(Date.now());
          this._onStall(ms, 'stall');
        }
        this.stallStart = null;
      }
    };
    on('playing', resolved);
    on('timeupdate', () => {
      if (this.stallStart != null && v.readyState >= 3) resolved();
    });
    on('pause', () => this.report());
    on('error', () => this._onMediaError());

    const watchdog = setInterval(() => this._watchdog(), 1000);
    const reporter = setInterval(() => this.report(), 10000);
    this._timers.push(() => clearInterval(watchdog), () => clearInterval(reporter));
  }

  get mode() {
    return this.data?.mode;
  }
  get currentTime() {
    return this.base + (this.video.currentTime || 0);
  }
  get duration() {
    return this.data?.duration || 0;
  }

  bufferedAhead() {
    const v = this.video;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.3 && v.buffered.end(i) >= v.currentTime) return v.buffered.end(i) - v.currentTime;
    }
    return 0;
  }

  /** Buffered ranges in absolute (file) time, for the seek bar. */
  bufferedRanges() {
    const v = this.video;
    const off = this.base;
    const out = [];
    for (let i = 0; i < v.buffered.length; i++) out.push([v.buffered.start(i) + off, v.buffered.end(i) + off]);
    return out;
  }

  async load(opts) {
    this._loadInFlight = (this._loadInFlight || 0) + 1;
    try {
      return await this._load(opts);
    } finally {
      this._loadInFlight--;
    }
  }

  async _load(opts) {
    this.opts = { ...this.opts, ...opts };
    const caps = detectCaps();
    if (!this.bandwidth) this.bandwidth = await measureBandwidth();
    const body = {
      caps,
      bandwidth: this.bandwidth,
      quality: this.opts.quality,
      maxBitrate: this.opts.maxBitrate,
      forceMode: this.opts.forceMode,
      capHeight: this.opts.capHeight,
      startPosition: this.opts.startPosition,
      client: clientName(),
      replaceSession: this.data?.sessionId,
    };
    if (this.opts.audioIndex !== undefined) body.audioIndex = this.opts.audioIndex;
    if (this.opts.subtitleIndex !== undefined) body.subtitleIndex = this.opts.subtitleIndex === 'off' ? null : this.opts.subtitleIndex;
    const data = await api.post(`/api/playback/${this.opts.itemId}/start`, body);
    if (this.destroyed) {
      navigator.sendBeacon?.(`/api/playback/session/${data.sessionId}/stop`, JSON.stringify({}));
      return;
    }
    this.data = data;
    this.offset = data.offset || 0;
    this.capped = false;
    this._hinted = false;
    this.recentStalls = [];
    this._attach(data.url, data.startPosition);
    this.emit('session', data);
    return data;
  }

  _destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.mse) {
      this.mse.gen++;
      this.mse.ctrl?.abort();
      URL.revokeObjectURL(this.mse.objUrl);
      this.mse = null;
    }
  }

  // ---------------------------------------------------------- remux through Media Source Extensions
  // A plain <video src> on an endless progressive stream only buffers a few seconds in Chrome.
  // Feeding the fMP4 stream into a SourceBuffer ourselves lets us keep minutes buffered,
  // and the absolute timeline (timestampOffset) means the seek bar never needs offset math.

  _startMse(url, offset, start, mime, play) {
    const MS = window.ManagedMediaSource || window.MediaSource;
    const ms = new MS();
    const v = this.video;
    if (window.ManagedMediaSource && MS === window.ManagedMediaSource) v.disableRemotePlayback = true;
    const objUrl = URL.createObjectURL(ms);
    const bps = Math.max(1e6, this.data?.source?.bitrate || 8e6);
    const limit = Math.max(12, Math.min(MSE_MAX_AHEAD, (MSE_BYTE_BUDGET * 8) / bps));
    this.mse = { ms, sb: null, gen: 0, ctrl: null, objUrl, limit, mime };
    ms.addEventListener(
      'sourceopen',
      () => {
        if (this.mse?.ms !== ms) return;
        try {
          ms.duration = this.duration;
          const sb = ms.addSourceBuffer(mime);
          sb.mode = 'segments';
          this.mse.sb = sb;
        } catch (e) {
          this.emit('error', { message: `This browser rejected the stream (${e.message}).` });
          return;
        }
        this._feed(url, offset);
        v.currentTime = start || 0;
        play();
      },
      { once: true }
    );
    v.src = objUrl;
  }

  _sbIdle(sb) {
    return sb.updating ? new Promise((r) => sb.addEventListener('updateend', r, { once: true })) : Promise.resolve();
  }

  _mseAhead() {
    return this.bufferedAhead();
  }

  /** Seconds we try to keep buffered ahead (fits the browser's memory limit for this bitrate). */
  _mseLimit() {
    return this.mse?.limit || 30;
  }

  /**
   * Append one chunk. Never drops data: a lost chunk corrupts the fMP4 stream and playback
   * would freeze where the hole is. When the browser's buffer is full we free played data
   * and wait – as long as it takes (e.g. while paused) – for playback to make room.
   */
  async _append(sb, chunk, gen) {
    const m = this.mse;
    for (;;) {
      await this._sbIdle(sb);
      if (!m || gen !== m.gen || m.ms.readyState !== 'open') return;
      try {
        sb.appendBuffer(chunk);
        await this._sbIdle(sb);
        return;
      } catch (e) {
        if (e.name !== 'QuotaExceededError') throw e;
        // The browser already evicted everything it safely could (it never touches the group of
        // pictures being played). Learn the real capacity so the reader stops before it next time,
        // then wait – as long as it takes, e.g. while paused – for playback to make room.
        // Removing data ourselves is unsafe: removal extends to the next keyframe, which in real
        // films can be 10+ seconds away, i.e. past the playhead – that froze playback.
        const ahead = this._mseAhead();
        if (ahead > 4) m.limit = Math.max(8, Math.min(m.limit, ahead * 0.85));
        this.quotaHits = (this.quotaHits || 0) + 1;
        const target = Math.max(4, ahead - 3);
        while (gen === m.gen && this._mseAhead() > target) await sleep(400);
      }
    }
  }

  /** End of the buffered range that contains the playhead. */
  _bufferEnd() {
    return this.video.currentTime + this.bufferedAhead();
  }

  async _recoverFeed(gen, reason, rebuild) {
    const m = this.mse;
    if (!m || gen !== m.gen || this.destroyed) return;
    this.recoveries = (this.recoveries || 0) + 1;
    this._sendDiag(`recover (${reason})`, 0);
    m.retries = (m.retries || 0) + 1;
    if (m.retries > 6) {
      this.emit('error', { message: `The stream keeps dropping (${reason}).` });
      return;
    }
    await sleep(Math.min(5000, 400 * 2 ** (m.retries - 1)));
    // A new stream is being negotiated (quality change, fallback…): this recovery is moot.
    if (!this.mse || gen !== this.mse.gen || this.destroyed || this._loadInFlight) return;
    const sid = this.data.sessionId;
    try {
      const pos = rebuild ? this.currentTime : this._bufferEnd();
      const r = await api.post(`/api/playback/session/${sid}/seek`, { position: pos });
      if (!this.mse || gen !== this.mse.gen || this._loadInFlight || this.data?.sessionId !== sid) return;
      this.offset = r.offset;
      if (rebuild) {
        const wasPaused = this.video.paused;
        this._attach(r.url, pos);
        if (wasPaused) this.video.pause();
      } else this._feed(r.url, r.offset);
    } catch (e) {
      if (this._loadInFlight || this.data?.sessionId !== sid) return;
      if (e.status === 404) this.emit('expired');
      else this._recoverFeed(gen, e.message, rebuild);
    }
  }

  async _feed(url, offset) {
    const m = this.mse;
    if (!m?.sb) return;
    const gen = ++m.gen;
    m.ctrl?.abort();
    const ctrl = new AbortController();
    m.ctrl = ctrl;
    const sb = m.sb;
    await this._sbIdle(sb);
    if (gen !== m.gen) return;
    try {
      if (m.ms.readyState === 'open') sb.abort();
      sb.timestampOffset = offset;
    } catch {
      /* ignore */
    }
    let reader;
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`stream ${res.status}`);
      reader = res.body.getReader();
    } catch (e) {
      if (e.name !== 'AbortError') this.emit('error', { message: 'The stream could not be started.' });
      return;
    }
    let pending = [];
    let pendingBytes = 0;
    let lastFlush = performance.now();
    const flush = async () => {
      if (!pendingBytes) return;
      const buf = new Uint8Array(pendingBytes);
      let o = 0;
      for (const c of pending) {
        buf.set(c, o);
        o += c.length;
      }
      pending = [];
      pendingBytes = 0;
      lastFlush = performance.now();
      try {
        await this._append(sb, buf, gen);
      } catch (e) {
        e.fromAppend = true;
        throw e;
      }
      m.retries = 0;
    };
    try {
      for (;;) {
        // Backpressure: stop reading once we're far enough ahead; TCP then pauses the server's ffmpeg.
        while (gen === m.gen && this._mseAhead() > this._mseLimit()) await sleep(400);
        if (gen !== m.gen) break;
        const { done, value } = await reader.read();
        if (gen !== m.gen) break;
        if (done) {
          await flush();
          await this._sbIdle(sb);
          // The server stream ended before the file did (ffmpeg crashed, proxy timeout…): continue
          // from where the buffer ends instead of treating it as the end of the movie.
          const end = this._bufferEnd();
          if (gen === m.gen && end < this.duration - 2) {
            this._recoverFeed(gen, 'stream ended early', false);
            return;
          }
          if (gen === m.gen && m.ms.readyState === 'open') {
            try {
              m.ms.endOfStream();
            } catch {
              /* ignore */
            }
          }
          return;
        }
        pending.push(value);
        pendingBytes += value.length;
        // Coalesce small network chunks; append quickly at startup so playback begins fast.
        if (pendingBytes >= 1024 * 1024 || performance.now() - lastFlush > 250 || this._mseAhead() < 3) await flush();
      }
    } catch (e) {
      // A media (decode) error makes every append fail – _onMediaError decides what to do then.
      if (e.name !== 'AbortError' && gen === m.gen && !this.video.error) {
        console.warn('[remux] feed error', e);
        // Network hiccup: resume downloading after the buffered part. Broken buffer: rebuild it.
        this._recoverFeed(gen, e.message, !!e.fromAppend);
      }
    }
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
  }

  _attach(url, start) {
    this.sourceLoading = true;
    this.stallStart = null;
    this.stallSnap = null;
    const v = this.video;
    this._destroyHls();
    const mode = this.data.mode;
    const playWhenReady = () => {
      const p = v.play();
      p?.catch?.((e) => {
        if (e?.name === 'NotAllowedError') this.emit('autoplay-blocked');
      });
    };

    if (mode === 'transcode' && !detectCaps().hls) {
      this.emit('error', { message: 'This browser can\'t play H.264 video or HLS streams. Try Chrome, Edge, Firefox or Safari.' });
      return;
    }
    if (mode === 'transcode' && detectCaps().hls === 'mse') {
      const hls = new Hls({
        ...HLS_CONFIG,
        startPosition: start || 0,
        abrEwmaDefaultEstimate: this.bandwidth ? Math.round(this.bandwidth * 0.8) : 5_000_000,
        startLevel: -1,
      });
      this.hls = hls;
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => this.emit('level', { level: d.level }));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.emit('levels', { levels: hls.levels });
        playWhenReady();
      });
      let mediaRecoveries = 0;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setTimeout(() => this.hls === hls && hls.startLoad(), 1500);
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 3) {
          hls.recoverMediaError();
        } else {
          this.emit('error', { message: `Playback failed (${d.details}).` });
        }
      });
      hls.loadSource(url);
      hls.attachMedia(v);
      return;
    }

    if (mode === 'remux') {
      const mime = remuxMime(this.data.source);
      if (mime) {
        this.base = 0;
        this._startMse(url, this.offset, start, mime, playWhenReady);
        return;
      }
      this.base = this.offset; // progressive fallback: the stream's clock starts at the keyframe
    } else this.base = 0;

    v.src = url;
    const local = mode === 'remux' ? Math.max(0, (start || 0) - this.offset) : start || 0;
    const onMeta = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      if (local > 0.5) v.currentTime = local;
      playWhenReady();
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.load();
  }

  async seek(t) {
    t = Math.max(0, Math.min(t, this.duration - 0.5));
    if (this.mode !== 'remux') {
      this.video.currentTime = t;
      return;
    }
    const local = t - this.base;
    const inBuffer = this.bufferedRanges().some(([a, b]) => t >= a && t <= b - 0.5);
    if (local >= 0 && inBuffer) {
      this.video.currentTime = local;
      return;
    }
    // Outside the buffered window: restart the remux at the nearest keyframe before t.
    this.seeking = true;
    this.emit('reloading');
    if (this.mse) this.video.currentTime = t;
    const r = await api.post(`/api/playback/session/${this.data.sessionId}/seek`, { position: t });
    this.offset = r.offset;
    if (this.mse) {
      this._feed(r.url, r.offset);
      return;
    }
    this._attach(r.url, t);
  }

  /** Re-negotiate the session at the current position with changed options. */
  async reload(patch) {
    const { keepPlaying, ...opts } = patch;
    const pos = opts.startPosition ?? this.currentTime;
    // After a media error the element may report paused although the viewer never paused.
    const wasPaused = !keepPlaying && this.video.paused;
    await this.load({ ...opts, startPosition: pos });
    if (wasPaused) this.video.pause();
  }

  /**
   * auto     – adaptive: the original when it fits, otherwise hls.js picks from the ladder
   * original – always the source quality
   * 1080p…   – one fixed rendition; nothing switches it automatically
   */
  setQuality(q) {
    this.opts.quality = q;
    this._fellBack = false;
    if (q === 'auto') {
      // Already adaptive: just hand control back to hls.js, no restart needed.
      if (this.hls && !this.data.fixedQuality) {
        this.capped = false;
        this.hls.autoLevelCapping = -1;
        this.hls.nextLevel = -1;
        return;
      }
      if (this.mode !== 'transcode') return; // already playing the original
    }
    // Fixed qualities and "original" are decided by the server (it may play the file itself
    // when the original is already within the chosen quality).
    return this.reload({ quality: q, forceMode: undefined, capHeight: undefined });
  }

  /**
   * Safety net: the element is "waiting" although the data it needs is buffered (a decoder that
   * lost sync after a buffer change, a tiny gap between fragments). Re-seeking to the current
   * position re-syncs it – the same trick hls.js uses for its own streams.
   */
  _unstick() {
    const v = this.video;
    const stuck = !v.paused && !v.seeking && v.readyState < 3 && this.bufferedAhead() > 1.5;
    if (!stuck) {
      this._stuckTicks = 0;
      return;
    }
    if (++this._stuckTicks < 2) return; // ~2 s
    this._stuckTicks = -3; // give the nudge a few seconds before trying again
    let t = v.currentTime;
    // Inside a gap? Jump to the start of the next buffered range.
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) > t && v.buffered.start(i) - t < 3) {
        t = v.buffered.start(i);
        break;
      }
    }
    console.warn(`[player] decoder stuck at ${v.currentTime.toFixed(2)}s with data buffered – re-syncing`);
    if (this.stallStart == null) {
      this.stallStart = performance.now() - 2000;
      this.stallSnap = this._snapshot();
    }
    this._nudging = true;
    this.nudges = (this.nudges || 0) + 1;
    this._sendDiag('nudge', this.stallStart ? performance.now() - this.stallStart : 0);
    v.currentTime = t + 0.01;
  }

  /**
   * The browser's decoder rejected the original video (e.g. macOS VideoToolbox -12909 on some
   * Blu-ray H.264). Get past it instead of stalling:
   *   direct play   -> direct stream (the server repairs H.264 parameter sets on the way)
   *   direct stream -> one fresh restart; if it fails again at the same spot, convert from here
   *                    and switch back to the original ~45 s later, once past the bad section
   */
  _onMediaError() {
    const v = this.video;
    const err = v.error;
    if (!err || this.destroyed || !this.data || this.hls || this.sourceLoading) return;
    if (err.code !== 3 && err.code !== 4) return; // decode / unsupported data
    // Browsers can fire several error events for one failure: handle each stream's failure once.
    if (this._erroredSrc === v.currentSrc) return;
    this._erroredSrc = v.currentSrc;
    const pos = this.currentTime;
    this._sendDiag(`media error ${err.code} (${this.mode})`, 0);
    if (this.mode === 'direct') {
      this.emit('fallback', { reason: 'Your browser couldn\'t decode this file directly – repairing the stream.' });
      this.reload({ forceMode: 'remux', startPosition: pos, keepPlaying: true });
      return;
    }
    if (this.mode === 'remux') {
      const prev = this._decodeErr;
      this._decodeErr = { pos, at: Date.now() };
      if (!prev || Math.abs(pos - prev.pos) > 60 || Date.now() - prev.at > 5 * 60 * 1000) {
        this._recoverFeed(this.mse?.gen ?? 0, 'decode error', true);
        return;
      }
      this._returnToOriginalAt = pos + 45;
      this.emit('fallback', { reason: 'Your browser can\'t decode this part of the file – converting it for a moment.' });
      this.reload({ forceMode: 'transcode', startPosition: pos, keepPlaying: true });
    }
  }

  /** Automatic mode, single converted stream: restart one quality step lower. */
  stepDown(why) {
    if (this._steppingDown || this.data.fixedQuality) return;
    const cur = this.data.renditions[0];
    const lower = this.data.qualities.find((q) => q.height < cur.height);
    if (!lower) return;
    this._steppingDown = true;
    this.recentStalls = [];
    this.stallStart = null;
    this.emit('fallback', { reason: `${why} – switched to ${lower.id}.` });
    this.reload({ capHeight: lower.height }).finally(() => (this._steppingDown = false));
  }

  /** Playback state worth knowing when something goes wrong (sent to the server log). */
  _snapshot() {
    const v = this.video;
    const near = this.bufferedRanges()
      .filter(([a, b]) => b > this.currentTime - 30 && a < this.currentTime + 200)
      .map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`);
    const fr = this._frames || [];
    const first = fr[0];
    const last = fr[fr.length - 1];
    const recentTotal = first && last ? last.total - first.total : 0;
    return {
      position: +this.currentTime.toFixed(2),
      readyState: v.readyState,
      bufferAhead: +this.bufferedAhead().toFixed(1),
      ranges: near.join(' '),
      size: v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null,
      // Frames the browser could not decode in time over the last ~8 s: a struggling decoder.
      droppedRecent: first && last ? `${last.dropped - first.dropped}/${recentTotal}` : null,
      fps: first && last && last.t > first.t ? +((recentTotal * 1000) / (last.t - first.t)).toFixed(1) : null,
      mime: this.mse?.mime || (this.hls ? 'hls' : 'progressive'),
      limit: this.mse ? Math.round(this.mse.limit) : null,
      quotaHits: this.quotaHits || 0,
      nudges: this.nudges || 0,
      recoveries: this.recoveries || 0,
      level: this.hls ? this.hls.currentLevel : null,
      error: v.error ? `${v.error.code} ${v.error.message || ''}`.trim() : null,
      msState: this.mse?.ms?.readyState || null,
      networkState: v.networkState,
    };
  }

  _sendDiag(kind, ms) {
    if (!this.data) return;
    const body = { kind, ms: Math.round(ms || 0), stalls: this.stalls, client: navigator.userAgent, ...(this.stallSnap || this._snapshot()), now: this._snapshot() };
    api.post(`/api/playback/session/${this.data.sessionId}/diag`, body).catch(() => {});
  }

  _onStall(ms, kind) {
    this._sendDiag(kind, ms);
    this.emit('stall', { ms, total: this.stalls });
  }

  _watchdog() {
    if (!this.data || this.destroyed) return;
    if (this._returnToOriginalAt != null && this.mode === 'transcode' && !this.video.paused && this.currentTime > this._returnToOriginalAt) {
      this._returnToOriginalAt = null;
      this.emit('fallback', { reason: 'Past the damaged section – back to the original quality.' });
      this.reload({ forceMode: undefined });
      return;
    }
    const q = this.video.getVideoPlaybackQuality?.();
    if (q) {
      this._frames = (this._frames || []).concat({ t: performance.now(), dropped: q.droppedVideoFrames, total: q.totalVideoFrames }).slice(-9);
    }
    // A stall still going on after 6 s: report it now, before any fallback changes the picture.
    if (this.stallStart != null && !this._freezeSent && performance.now() - this.stallStart > 6000) {
      this._freezeSent = true;
      this._sendDiag('freeze', performance.now() - this.stallStart);
    }
    if (this.stallStart == null) this._freezeSent = false;
    this._unstick();
    const now = Date.now();
    this.recentStalls = this.recentStalls.filter((t) => now - t < 90000);
    const longStall = this.stallStart != null && performance.now() - this.stallStart > 7000;
    const choppy = this.recentStalls.length >= 3;
    if (!longStall && !choppy) return;

    if (this.data.fixedQuality) {
      if (!this._hinted) {
        this._hinted = true;
        this.emit('fallback', { reason: `${this.opts.quality} is buffering on this connection. Pick a lower quality or Automatic.` });
      }
      return;
    }

    if (this.mode === 'transcode' && this.data.renditions.length === 1) {
      this.stepDown('Playback kept pausing to load');
      return;
    }
    if (this.mse && (!this._rebuiltAt || Date.now() - this._rebuiltAt > 60000)) {
      // First try a fresh stream at the same spot: it resets the browser's decoder and buffer,
      // which fixes a stuck pipeline without paying for a server-side conversion.
      this._rebuiltAt = Date.now();
      this.stallStart = null;
      this.recentStalls = [];
      this.emit('fallback', { reason: 'Playback got stuck – restarting the stream.' });
      this._recoverFeed(this.mse.gen, 'stalled', true);
      return;
    }
    if (this.mode !== 'transcode' && this.opts.quality !== 'original' && !this._fellBack) {
      // The original file is too heavy for this connection: switch to adaptive streaming.
      this._fellBack = true;
      this.stallStart = null;
      this.recentStalls = [];
      this.emit('fallback', { reason: 'Switched to adaptive quality to stop buffering.' });
      this.reload({ forceMode: 'transcode' });
    } else if (this.hls && !this.capped && this.hls.currentLevel > 0) {
      this.capped = true;
      this.recentStalls = [];
      this.hls.autoLevelCapping = this.hls.currentLevel - 1;
      this.hls.nextLevel = this.hls.currentLevel - 1;
      this.emit('fallback', { reason: 'Lowered quality to keep playback smooth.' });
      setTimeout(() => {
        if (this.hls) {
          this.hls.autoLevelCapping = -1;
          this.capped = false;
        }
      }, 120000);
    }
  }

  async report() {
    if (!this.data || this.destroyed) return;
    const sid = this.data.sessionId;
    const q = this.video.getVideoPlaybackQuality?.();
    try {
      const r = await api.post(`/api/playback/session/${sid}/progress`, {
        position: this.currentTime,
        paused: this.video.paused,
        buffer: Math.round(this.bufferedAhead()),
        bandwidth: this.hls?.bandwidthEstimate ? Math.round(this.hls.bandwidthEstimate) : this.bandwidth,
        level: this.hls ? this.hls.currentLevel : null,
        droppedFrames: q?.droppedVideoFrames ?? null,
        stalls: this.stalls,
      });
      this.server = r.session;
      this.emit('server', r.session);
      // The server can't encode this rendition in real time and our buffer is draining: step down.
      const t = r.session?.transcode;
      // Single rendition and the encoder runs slower than real time with the buffer draining.
      if (!this.data.fixedQuality && this.data.renditions.length === 1 && t?.running && !t.throttled && t.speed && t.speed < 0.95 && this.bufferedAhead() < 15) {
        this.stepDown('The server can\'t convert this quality in real time');
      }
      if (this.hls && !this.data.fixedQuality && t?.running && t.speed && t.speed < 1.05 && this.bufferedAhead() < 20 && this.hls.currentLevel > 0 && !this.capped) {
        this.capped = true;
        this.hls.autoLevelCapping = this.hls.currentLevel - 1;
        this.emit('fallback', { reason: 'The server is busy – lowered quality to avoid buffering.' });
      }
    } catch (e) {
      // 404 for a session we're replacing right now (or already replaced) is expected, not expiry.
      if (e.status === 404 && this.data?.sessionId === sid && !this._loadInFlight && !this.destroyed) this.emit('expired');
    }
  }

  stop() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.data) {
      const body = JSON.stringify({ position: this.currentTime });
      if (!navigator.sendBeacon?.(`/api/playback/session/${this.data.sessionId}/stop`, body)) {
        fetch(`/api/playback/session/${this.data.sessionId}/stop`, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
      }
    }
    this._destroyHls();
    this._timers.forEach((f) => f());
    try {
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* ignore */
    }
  }
}

function clientName() {
  const ua = navigator.userAgent;
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Browser';
  const os = /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iOS' : /mac os/i.test(ua) ? 'macOS' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}
