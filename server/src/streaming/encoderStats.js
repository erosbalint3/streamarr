// Learned conversion speed per (source kind → output quality, encoder). Lets the server pick the
// best quality it can actually sustain on this hardware *before* playback starts – instead of
// starting too high and stepping down after the viewer has already seen it stall.
import { get, run } from '../db.js';
import { classHeight } from './decision.js';

const KEY = '_encoderStats';
let stats = null;
let saveTimer = null;

function load() {
  if (!stats) {
    try {
      stats = JSON.parse(get('SELECT value FROM settings WHERE key = ?', KEY)?.value || '{}') || {};
    } catch {
      stats = {};
    }
  }
  return stats;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(stats));
  }, 5000);
  saveTimer.unref?.();
}

export function statKey(media, height, hwaccel) {
  const v = media.video;
  return `${v.codec}${v.hdr ? '-hdr' : ''}${v.bitDepth > 8 ? '-10bit' : ''}:${classHeight(v)}>${height}:${hwaccel || 'none'}`;
}

/** Record an observed real-time factor (exponentially weighted). */
export function recordSpeed(key, speed) {
  if (!(speed > 0.05 && speed < 50)) return;
  const s = load();
  const prev = s[key];
  s[key] = prev ? { speed: +(prev.speed * 0.7 + speed * 0.3).toFixed(3), n: prev.n + 1, at: Date.now() } : { speed: +speed.toFixed(3), n: 1, at: Date.now() };
  persist();
}

/** Known real-time factor for converting this file to `height`, or null if never measured. */
export function expectedSpeed(media, height, hwaccel) {
  return load()[statKey(media, height, hwaccel)]?.speed ?? null;
}

export function allStats() {
  return load();
}
