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

async function probe(bytes, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

/** Estimate download bandwidth in bits/s. Adapts the probe size so slow links aren't punished. */
export async function measureBandwidth({ force = false } = {}) {
  try {
    const cached = JSON.parse(sessionStorage.getItem('sa_bw') || 'null');
    if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.bps;
  } catch {
    /* ignore */
  }
  await probe(64 * 1024, 3000); // warm the connection
  let r = await probe(512 * 1024, 4000);
  if (!r.aborted && r.total < 700) {
    r = await probe(4 * 1024 * 1024, 5000);
    if (!r.aborted && r.total < 500) r = await probe(16 * 1024 * 1024, 5000);
  }
  const bps = r.bytes ? Math.round((r.bytes * 8) / (r.ms / 1000)) : 0;
  try {
    sessionStorage.setItem('sa_bw', JSON.stringify({ bps, at: Date.now() }));
  } catch {
    /* ignore */
  }
  return bps;
}

