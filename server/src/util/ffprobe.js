import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { exec } from './proc.js';

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1', 'mpl2', 'vplayer', 'jacosub', 'realtext', 'sami', 'stl', 'ttml']);

function rate(r) {
  if (!r || r === '0/0') return null;
  const [a, b] = r.split('/').map(Number);
  return b ? Math.round((a / b) * 1000) / 1000 : a;
}

function streamBitrate(s) {
  const tag = s.tags?.BPS || s.tags?.['BPS-eng'];
  return Number(s.bit_rate || tag || 0) || null;
}

function containerFrom(formatName, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const f = formatName || '';
  if (f.includes('matroska')) return ext === 'webm' ? 'webm' : 'mkv';
  if (f.includes('mp4') || f.includes('mov')) return ['mov'].includes(ext) ? 'mov' : 'mp4';
  if (f.includes('mpegts')) return 'ts';
  if (f.includes('avi')) return 'avi';
  if (f.includes('asf')) return 'wmv';
  if (f.includes('flv')) return 'flv';
  if (f.includes('mpeg')) return 'mpeg';
  return ext || f.split(',')[0];
}

function bitDepth(s) {
  const raw = Number(s.bits_per_raw_sample);
  if (raw) return raw;
  const m = /p(\d{2})(le|be)$/.exec(s.pix_fmt || '');
  return m ? Number(m[1]) : 8;
}

function hdrType(s) {
  const dovi = (s.side_data_list || []).some((d) => /dovi|dolby vision/i.test(d.side_data_type || ''));
  if (dovi) return 'dv';
  if (s.color_transfer === 'smpte2084') return 'hdr10';
  if (s.color_transfer === 'arib-std-b67') return 'hlg';
  return null;
}

export async function probe(file) {
  const out = await exec(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { timeout: 90000 });
  const data = JSON.parse(out.toString());
  const streams = data.streams || [];
  const format = data.format || {};

  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const video = v
    ? {
        index: v.index,
        codec: v.codec_name,
        profile: v.profile || null,
        level: v.level ?? null,
        width: v.width,
        height: v.height,
        fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate),
        pixFmt: v.pix_fmt,
        bitDepth: bitDepth(v),
        hdr: hdrType(v),
        colorPrimaries: v.color_primaries || null,
        bitrate: streamBitrate(v),
        interlaced: v.field_order && !['progressive', 'unknown'].includes(v.field_order),
      }
    : null;

  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      profile: s.profile || null,
      channels: s.channels || 2,
      layout: s.channel_layout || null,
      language: s.tags?.language || null,
      title: s.tags?.title || null,
      default: !!s.disposition?.default,
      bitrate: streamBitrate(s),
    }));

  const subtitles = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      language: s.tags?.language || null,
      title: s.tags?.title || null,
      default: !!s.disposition?.default,
      forced: !!s.disposition?.forced,
      text: TEXT_SUB_CODECS.has(s.codec_name),
    }));

  const chapters = (data.chapters || []).map((c) => ({
    start: Number(c.start_time),
    end: Number(c.end_time),
    title: c.tags?.title || null,
  }));

  const duration = Number(format.duration) || 0;
  let bitrate = Number(format.bit_rate) || 0;
  if (!bitrate && duration) {
    const st = await fs.stat(file);
    bitrate = Math.round((st.size * 8) / duration);
  }

  return {
    container: containerFrom(format.format_name, file),
    startTime: Number(format.start_time) || 0,
    duration,
    bitrate,
    video,
    audio,
    subtitles: subtitles.concat(await findExternalSubtitles(file)),
    chapters,
  };
}

const SUB_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub']);
const LANG_HINT = /^[a-z]{2,3}(-[A-Za-z]{2})?$/;

export async function findExternalSubtitles(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const subs = [];
  for (const name of entries.sort()) {
    const ext = path.extname(name).toLowerCase();
    if (!SUB_EXTS.has(ext) || ext === '.sub') continue;
    if (!name.startsWith(base)) continue;
    const middle = name.slice(base.length, -ext.length).split('.').filter(Boolean);
    const forced = middle.some((p) => /^forced$/i.test(p));
    const sdh = middle.some((p) => /^(sdh|cc|hi)$/i.test(p));
    const language = middle.find((p) => LANG_HINT.test(p) && !/^(sdh|cc|hi)$/i.test(p)) || null;
    subs.push({
      index: `ext${subs.length}`,
      external: path.join(dir, name),
      codec: ext.slice(1) === 'srt' ? 'subrip' : ext.slice(1),
      language,
      title: [sdh ? 'SDH' : null, 'External'].filter(Boolean).join(' · '),
      default: false,
      forced,
      text: true,
    });
  }
  return subs;
}

async function keyframesIn(file, from, to) {
  const out = await exec(
    config.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${from}%${to}`, '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file],
    { timeout: 15000 }
  );
  const keys = [];
  for (const line of out.toString().split('\n')) {
    const [pts, flags] = line.split(',');
    const p = Number(pts);
    if (flags?.includes('K') && Number.isFinite(p)) keys.push(p);
  }
  return keys.sort((a, b) => a - b);
}

/**
 * Last video keyframe at or before `t` (seconds, file time). Used for exact remux seeking.
 * Reads a short window first: keyframes are rarely > 8 s apart, and on a hard drive every
 * second of a 40 Mbps file read here is ~5 MB of extra seek latency.
 */
export async function keyframeBefore(file, t, startTime = 0) {
  if (t <= 0.5) return 0;
  const abs = t + startTime;
  try {
    for (const span of [8, 30]) {
      const keys = (await keyframesIn(file, Math.max(0, abs - span), abs + 0.05)).filter((p) => p <= abs + 0.001);
      if (keys.length) return Math.max(0, keys[keys.length - 1] - startTime);
      if (abs - span <= 0) return 0;
    }
    return Math.max(0, t - 30);
  } catch {
    return t;
  }
}

/** First video keyframe strictly after `t` – used to step over a section a decoder rejects. */
export async function keyframeAfter(file, t, startTime = 0) {
  const abs = t + startTime;
  try {
    for (const span of [10, 40]) {
      const keys = (await keyframesIn(file, abs, abs + span)).filter((p) => p > abs + 0.04);
      if (keys.length) return keys[0] - startTime;
    }
  } catch {
    /* fall through */
  }
  return t + 2;
}

/**
 * Look at the source file's packets around `t` (seconds, file time) for things that make browsers
 * stall: long keyframe intervals, timestamp gaps in video or audio, and timestamps going backwards.
 * Returns a one-line human summary.
 */
export async function inspectAround(file, t, { startTime = 0, videoIndex = 0, audioIndex = null } = {}) {
  const abs = t + startTime;
  const from = Math.max(0, abs - 12);
  const out = await exec(
    config.ffprobe,
    ['-v', 'error', '-read_intervals', `${from}%${abs + 12}`, '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,flags', '-of', 'csv=p=0', file],
    { timeout: 30000 }
  );
  const v = [];
  const a = [];
  let noPts = 0;
  for (const line of out.toString().split('\n')) {
    const [idx, pts, dts, dur, flags] = line.split(',');
    const i = Number(idx);
    const p = Number(pts);
    if (i !== videoIndex && i !== audioIndex) continue;
    if (!Number.isFinite(p)) {
      noPts++;
      continue;
    }
    const pkt = { pts: p - startTime, dts: Number(dts) - startTime, dur: Number(dur) || 0, key: (flags || '').includes('K') };
    (i === videoIndex ? v : a).push(pkt);
  }
  const fmt = (x) => x.toFixed(2);
  const parts = [`source ${fmt(from - startTime)}-${fmt(abs + 12 - startTime)}s`];

  if (v.length) {
    const keys = v.filter((p) => p.key).map((p) => p.pts).sort((x, y) => x - y);
    let maxGop = 0;
    for (let i = 1; i < keys.length; i++) maxGop = Math.max(maxGop, keys[i] - keys[i - 1]);
    const byPts = [...v].sort((x, y) => x.pts - y.pts);
    const frameDur = byPts.length > 2 ? (byPts[byPts.length - 1].pts - byPts[0].pts) / (byPts.length - 1) : 0.04;
    const gaps = [];
    for (let i = 1; i < byPts.length; i++) {
      const g = byPts[i].pts - byPts[i - 1].pts;
      if (g > Math.max(0.25, frameDur * 4)) gaps.push(`${fmt(g)}s at ${fmt(byPts[i - 1].pts)}`);
    }
    let backwards = 0;
    for (let i = 1; i < v.length; i++) if (v[i].dts < v[i - 1].dts) backwards++;
    parts.push(
      `video: ${v.length} frames (~${(1 / frameDur).toFixed(2)} fps), keyframes at [${keys.map(fmt).join(', ')}]${keys.length > 1 ? ` (longest GOP ${fmt(maxGop)}s)` : ' (≤1 keyframe in 24 s!)'}` +
        `${gaps.length ? `, TIMESTAMP GAPS ${gaps.slice(0, 4).join('; ')}` : ', no gaps'}${backwards ? `, DTS goes backwards ${backwards}x` : ''}`
    );
  } else parts.push('video: no packets found');

  if (audioIndex != null) {
    if (a.length) {
      const byPts = [...a].sort((x, y) => x.pts - y.pts);
      const gaps = [];
      let overlaps = 0;
      for (let i = 1; i < byPts.length; i++) {
        const end = byPts[i - 1].pts + byPts[i - 1].dur;
        const g = byPts[i].pts - end;
        if (g > 0.1) gaps.push(`${fmt(g)}s at ${fmt(end)}`);
        if (g < -0.1) overlaps++;
      }
      parts.push(`audio: ${a.length} packets${gaps.length ? `, AUDIO GAPS ${gaps.slice(0, 4).join('; ')}` : ', no gaps'}${overlaps ? `, ${overlaps} overlaps` : ''}`);
    } else parts.push('audio: NO PACKETS in this window');
  }
  if (noPts) parts.push(`${noPts} packets without timestamps`);
  return parts.join(' | ');
}
