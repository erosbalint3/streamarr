// Thin fetch wrapper. Auth rides on an HttpOnly cookie, so media URLs (images, HLS, video) just work.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event('streamarr:unauthorized'));
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data;
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

// ---------------------------------------------------------------- stale-while-revalidate cache
// Pages render from memory instantly (Back, revisits, hovered cards) and refresh in the background.
const cache = new Map(); // url -> { data, at, promise }
const listeners = new Map(); // url -> Set<fn>

function fetchInto(url) {
  const entry = cache.get(url) || {};
  if (entry.promise) return entry.promise;
  const promise = request('GET', url)
    .then((data) => {
      cache.set(url, { data, at: Date.now() });
      listeners.get(url)?.forEach((fn) => fn(data));
      return data;
    })
    .catch((e) => {
      const cur = cache.get(url);
      if (cur) delete cur.promise;
      throw e;
    });
  cache.set(url, { ...entry, promise });
  return promise;
}

/** Cached data for a URL (or undefined) – synchronous, for the first render. */
export function peek(url) {
  return cache.get(url)?.data;
}

/** Warm the cache (e.g. on hover); does nothing if the data is fresh. */
export function prefetch(url, maxAge = 30000) {
  const e = cache.get(url);
  if (e?.promise || (e?.data !== undefined && Date.now() - e.at < maxAge)) return;
  fetchInto(url).catch(() => {});
}

export function subscribe(url, fn) {
  if (!listeners.has(url)) listeners.set(url, new Set());
  listeners.get(url).add(fn);
  return () => listeners.get(url)?.delete(fn);
}

/** Drop cached responses whose URL starts with a prefix (after a change on the server). */
export function invalidate(prefix = '/api/') {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

export const api = {
  get: (url) => request('GET', url),
  /** Cached GET: resolves from memory when fresh, refetches otherwise. */
  cached: (url, maxAge = 15000) => {
    const e = cache.get(url);
    if (e?.data !== undefined && Date.now() - e.at < maxAge) return Promise.resolve(e.data);
    return fetchInto(url);
  },
  revalidate: (url) => fetchInto(url),
  post: (url, body = {}) => request('POST', url, body).finally(() => invalidate('/api/home')),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

/** Size an artwork URL for how large it is shown (the server picks or makes that size). */
export function sized(url, cssWidth) {
  if (!url) return url;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return `${url}${url.includes('?') ? '&' : '?'}w=${Math.round(cssWidth * dpr)}`;
}

export function formatDuration(seconds, { long = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (long) return h ? `${h} h ${m} min` : `${m} min`;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i > 2 ? 1 : 0)} ${u[i]}`;
}

export function formatBitrate(bps) {
  if (!bps) return '—';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

export function resolutionLabel(video) {
  if (!video) return null;
  const h = Math.max(video.height, Math.round((video.width * 9) / 16));
  if (h >= 2000) return '4K';
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 560) return '576p';
  return 'SD';
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function episodeCode(item) {
  if (item.seasonNumber == null) return '';
  return `S${item.seasonNumber} E${item.episodeNumber}`;
}
