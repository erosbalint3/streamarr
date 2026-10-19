import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { exec } from '../util/proc.js';
import { trackBackgroundProc } from '../tasks.js';

const inflight = new Map();
const exists = (p) => fsp.access(p).then(() => true, () => false);

export function vttPath(media, sub) {
  const key = String(sub.index).replace(/[^\w]/g, '');
  return path.join(config.subtitleCacheDir, `${media.id}_${media.mtime}_${key}.vtt`);
}

/** Convert one text subtitle track (embedded or external) to WebVTT, cached on disk. */
export async function getVtt(media, sub) {
  const out = vttPath(media, sub);
  if (await exists(out)) return out;
  if (inflight.has(out)) return inflight.get(out);
  const p = (async () => {
    const tmp = `${out}.tmp`;
    const args = sub.external
      ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', sub.external, '-c:s', 'webvtt', '-f', 'webvtt', tmp]
      : ['-hide_banner', '-loglevel', 'error', '-y', '-i', media.path, '-map', `0:${sub.index}`, '-c:s', 'webvtt', '-f', 'webvtt', tmp];
    await exec(config.ffmpeg, args, { timeout: 10 * 60 * 1000 });
    await fsp.rename(tmp, out);
    return out;
  })().finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

/** Extract every embedded text track in one pass over the file (much faster than one pass per track). */
export async function extractAll(media) {
  const pending = [];
  for (const sub of media.subtitles) {
    if (!sub.text || sub.external) continue;
    if (!(await exists(vttPath(media, sub)))) pending.push(sub);
  }
  if (!pending.length) return;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', media.path];
  for (const sub of pending) args.push('-map', `0:${sub.index}`, '-c:s', 'webvtt', '-f', 'webvtt', `${vttPath(media, sub)}.tmp`);
  await exec(config.ffmpeg, args, { timeout: 24 * 60 * 60 * 1000, nice: true, onSpawn: trackBackgroundProc });
  for (const sub of pending) await fsp.rename(`${vttPath(media, sub)}.tmp`, vttPath(media, sub)).catch(() => {});
}

const ts = (s) => {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
};
const fmt = (t) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
};

/** Shift all cues by -offset (used when a remux stream starts mid-file and the video clock starts at 0). */
export function shiftVtt(text, offset) {
  if (!offset) return text;
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) {
      out.push(block);
      continue;
    }
    const [a, rest] = lines[i].split('-->');
    const restParts = rest.trim().split(/\s+/);
    const start = ts(a) - offset;
    const end = ts(restParts[0]) - offset;
    if (end <= 0) continue;
    lines[i] = `${fmt(Math.max(0, start))} --> ${fmt(end)}${restParts.length > 1 ? ' ' + restParts.slice(1).join(' ') : ''}`;
    out.push(lines.join('\n'));
  }
  return out.join('\n\n') + '\n';
}
