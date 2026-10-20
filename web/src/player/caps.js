// ------------------------------------------------------------ device capabilities

const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

function mseHls() {
  const MS = window.ManagedMediaSource || window.MediaSource;
  return !!MS?.isTypeSupported?.('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
}

let capsCache = null;
export function detectCaps() {
  if (capsCache) return capsCache;
  const v = document.createElement('video');
  const MS = window.ManagedMediaSource || window.MediaSource;
  const mse = (t) => !!MS?.isTypeSupported?.(t);
  const native = (t) => v.canPlayType(t) === 'probably' || v.canPlayType(t) === 'maybe';
  const can = (t) => mse(t) || native(t);

  const video = {
    h264: can('video/mp4; codecs="avc1.640028"'),
    hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"'),
    av1: can('video/mp4; codecs="av01.0.08M.08"'),
    vp9: can('video/mp4; codecs="vp09.00.40.08"') || can('video/webm; codecs="vp9"'),
    vp8: can('video/webm; codecs="vp8"'),
  };
  const audio = {
    aac: can('audio/mp4; codecs="mp4a.40.2"'),
    mp3: can('audio/mpeg') || can('audio/mp4; codecs="mp4a.40.34"'),
    ac3: can('audio/mp4; codecs="ac-3"'),
    eac3: can('audio/mp4; codecs="ec-3"'),
    opus: can('audio/mp4; codecs="opus"') || can('audio/webm; codecs="opus"'),
    flac: can('audio/mp4; codecs="flac"') || can('audio/flac'),
    vorbis: can('audio/webm; codecs="vorbis"'),
    alac: can('audio/mp4; codecs="alac"'),
  };
  const hdrDisplay = window.matchMedia?.('(dynamic-range: high)').matches;
  capsCache = {
    video,
    audio,
    containers: { mp4: native('video/mp4'), webm: native('video/webm') },
    hdr: !!hdrDisplay && (video.hevc || video.av1 || video.vp9),
    dolbyVision: false,
    // Remux needs MSE (fed by the player) or a browser that streams progressive MP4 (not Safari).
    progressiveRemux: !!(window.ManagedMediaSource || window.MediaSource) || !isSafari(),
    hls: mseHls() ? 'mse' : native('application/vnd.apple.mpegurl') ? 'native' : null,
  };
  return capsCache;
}

// ------------------------------------------------------------ bandwidth probe

// Background measurements share one controller so playback can cancel them instantly.
let backgroundCtrl = null;
export function cancelBackgroundProbe() {
  backgroundCtrl?.abort();
  backgroundCtrl = null;
}

async function probe(bytes, timeoutMs, outer = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  outer?.addEventListener('abort', () => ctrl.abort(), { once: true });
  const t0 = performance.now();
  try {
    const res = await fetch(`/api/speedtest?bytes=${bytes}&r=${Math.random()}`, { cache: 'no-store', signal: ctrl.signal, credentials: 'same-origin' });
    const reader = res.body.getReader();
    let got = 0;
    let first = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first == null) first = performance.now();
      got += value.length;
    }
    const end = performance.now();
    // Measure from first byte so request latency doesn't distort throughput.
    return { bytes: got, ms: Math.max(1, end - (first ?? t0)), total: end - t0 };
  } catch {
    return { bytes: 0, ms: performance.now() - t0, total: performance.now() - t0, aborted: true };
  } finally {
    clearTimeout(timer);
  }
}

const BW_KEY = 'sa_bw2';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEstimate() {
  try {
    return JSON.parse(localStorage.getItem(BW_KEY) || 'null');
  } catch {
    return null;
  }
}

/** Remember a throughput measurement (from a probe or from a real stream). */
export function saveBandwidth(bps, source = 'probe') {
  if (!(bps > 0)) return;
  try {
    localStorage.setItem(BW_KEY, JSON.stringify({ bps: Math.round(bps), at: Date.now(), source }));
  } catch {
    /* private mode */
  }
}

/** Thorough measurement (up to ~20 MB). For the settings page and idle-time refreshes – never on the play path. */
export async function measureBandwidth({ force = false, signal = null } = {}) {
  const cached = loadEstimate();
  if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.bps;
  await probe(64 * 1024, 3000, signal); // warm the connection
  let r = await probe(512 * 1024, 4000, signal);
  if (!r.aborted && r.total < 700) {
    r = await probe(4 * 1024 * 1024, 5000, signal);
    if (!r.aborted && r.total < 500) r = await probe(16 * 1024 * 1024, 5000, signal);
  }
  if (signal?.aborted) return cached?.bps || 0;
  const bps = r.bytes ? Math.round((r.bytes * 8) / (r.ms / 1000)) : 0;
  saveBandwidth(bps, 'probe');
  return bps;
}

/**
 * Bandwidth for starting playback, without making the viewer wait (like Netflix: start now,
 * learn from the stream). Uses the remembered estimate; on a first visit a small probe capped at
 * ~1 s. Returns 0 when unknown – the server then assumes the original fits and the stall
 * watchdog corrects it if not.
 */
export async function quickBandwidth() {
  const c = loadEstimate();
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.bps;
  // Small first, bigger only if the link is fast (a short sample underestimates fast links while
  // TCP is still ramping up). Never more than ~1.2 s in total.
  let best = null;
  const take = (r) => {
    if (r && r.bytes && !r.aborted && (!best || r.bytes * 8 / r.ms > best.bytes * 8 / best.ms)) best = r;
    return r;
  };
  await Promise.race([
    (async () => {
      await probe(32 * 1024, 800);
      const first = take(await probe(384 * 1024, 900));
      if (first && !first.aborted && first.total < 300) take(await probe(2 * 1024 * 1024, 900));
    })(),
    sleepMs(1200),
  ]);
  const r = best;
  const bps = r && r.bytes && !r.aborted ? Math.round((r.bytes * 8) / (r.ms / 1000)) : 0;
  if (bps) saveBandwidth(bps, 'quick');
  return bps;
}

/** Called while the app is idle (not playing): keep the estimate fresh for the next play. */
export function refreshBandwidthWhenIdle() {
  const c = loadEstimate();
  if (c && Date.now() - c.at < 60 * 60 * 1000) return;
  const run = () => {
    if (location.pathname.startsWith('/play/')) return;
    cancelBackgroundProbe();
    backgroundCtrl = new AbortController();
    measureBandwidth({ force: true, signal: backgroundCtrl.signal }).catch(() => {});
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 10000 });
  else setTimeout(run, 3000);
}
