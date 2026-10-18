// Seek-bar preview thumbnails ("trickplay"): sprite sheets of 10x10 frames, one frame every 10s.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { run } from '../db.js';
import { exec } from '../util/proc.js';
import { tonemapFilter } from './encoder.js';

export const TRICKPLAY = { interval: 10, cols: 10, rows: 10, width: 240 };

export function trickplayDir(media) {
  return path.join(config.trickplayDir, String(media.id));
}

export async function generateTrickplay(media) {
  const v = media.video;
  if (!v || !media.duration) return;
  const dir = trickplayDir(media);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const { interval, cols, rows, width } = TRICKPLAY;
  const height = Math.max(2, Math.round((width * v.height) / v.width / 2) * 2);
  const tonemap = v.hdr ? `${tonemapFilter(v.hdr)},` : '';
  // Decoding only keyframes keeps this ~50x faster than real time even for 4K HEVC.
  await exec(
    config.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-threads', '2',
      '-skip_frame', 'nokey',
      '-i', media.path,
      '-an', '-sn', '-dn',
      '-vf', `fps=1/${interval},scale=${width}:${height}:flags=fast_bilinear,${tonemap}format=yuvj420p,tile=${cols}x${rows}`,
      '-q:v', '6', '-start_number', '0',
      path.join(dir, '%d.jpg'),
    ],
    { timeout: 60 * 60 * 1000, nice: true }
  );
  const count = Math.ceil(media.duration / interval);
  const info = { interval, cols, rows, width, height, count, sheets: Math.ceil(count / (cols * rows)) };
  run('UPDATE media_files SET trickplay = ? WHERE id = ?', JSON.stringify(info), media.id);
  return info;
}
