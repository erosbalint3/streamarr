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

/** Find the last video keyframe at or before `t` (seconds). Used for exact remux seeking. */
export async function keyframeBefore(file, t, startTime = 0) {
  if (t <= 0.5) return 0;
  const abs = t + startTime;
  const from = Math.max(0, abs - 30);
  try {
    const out = await exec(
      config.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${from}%${abs + 0.05}`, '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file],
      { timeout: 15000 }
    );
    let best = null;
    for (const line of out.toString().split('\n')) {
      const [pts, flags] = line.split(',');
      const p = Number(pts);
      if (flags?.includes('K') && Number.isFinite(p) && p <= abs + 0.001) best = best == null ? p : Math.max(best, p);
    }
    return best == null ? t : Math.max(0, best - startTime);
  } catch {
    return t;
  }
}
