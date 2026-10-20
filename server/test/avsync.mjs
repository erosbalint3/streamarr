// A/V sync regression test for the progressive remux ("Direct stream").
//
// Builds a short Blu-ray-like clip (H.264 with B-frames and open GOPs, 5.1 AC-3) with a white flash
// and a beep at exactly the same moment, runs the server's real remux command from the start, after
// a seek and in skip mode, and places both events on the player's timeline exactly as Media Source
// Extensions does (fragment decode times + composition offsets + SourceBuffer.timestampOffset).
//
//   node server/test/avsync.mjs            (needs ffmpeg/ffprobe in PATH; runs in the Docker image)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remuxArgs, remuxTimestampOffset } from '../src/streaming/encoder.js';
import { probe, keyframeBefore, keyframeAfter } from '../src/util/ffprobe.js';

const EVENT = 30; // flash + beep in the source
const TOLERANCE = 0.04;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsync-'));
const src = path.join(dir, 'clip.mkv');

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 28 });
  if (r.status) throw new Error(`${cmd} failed: ${r.stderr.toString().slice(-600)}`);
  return r.stdout;
};

const beepExpr = `if(between(t\\,${EVENT}\\,${EVENT + 0.1})\\,0.8*sin(2*PI*1000*t)\\,0.02*sin(2*PI*200*t))`;
run('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=40',
  '-f', 'lavfi', '-i', `aevalsrc='${beepExpr}|${beepExpr}':s=48000:d=40`,
  '-filter_complex', `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t\\,${EVENT}\\,${EVENT + 0.03})'[v];[1:a]pan=5.1|c0=c0|c1=c1|c2=c0|c3=c0|c4=c0|c5=c1[a]`,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'superfast', '-bf', '3', '-x264-params', 'open-gop=1:keyint=48:min-keyint=1',
  '-c:a', 'ac3', '-b:a', '448k',
  src,
]);

// ------------------------------------------------------------- fragmented MP4 timing (as MSE sees it)
function sampleTimes(buf, want) {
  const tracks = {};
  const trex = {};
  const out = [];
  const u32 = (o) => buf.readUInt32BE(o);
  const walk = (s, e, ctx) => {
    for (let i = s; i + 8 <= e; ) {
      let size = u32(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      let h = 8;
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(i + 8));
        h = 16;
      }
      if (size < 8 || i + size > e) break;
      const b = i + h;
      if (['moov', 'mdia', 'mvex', 'moof'].includes(type)) walk(b, i + size, ctx);
      else if (type === 'trak' || type === 'traf') walk(b, i + size, {});
      else if (type === 'tkhd') {
        ctx.id = buf[b] === 1 ? u32(b + 20) : u32(b + 12);
        tracks[ctx.id] = ctx;
      } else if (type === 'mdhd') ctx.ts = buf[b] === 1 ? u32(b + 20) : u32(b + 12);
      else if (type === 'hdlr') ctx.type = buf.toString('latin1', b + 8, b + 12);
      else if (type === 'trex') trex[u32(b + 4)] = u32(b + 12);
      else if (type === 'tfhd') {
        const fl = buf.readUIntBE(b + 1, 3);
        ctx.tid = u32(b + 4);
        let p = b + 8;
        if (fl & 1) p += 8;
        if (fl & 2) p += 4;
        ctx.ddur = fl & 8 ? u32(p) : trex[ctx.tid] || 0;
      } else if (type === 'tfdt') ctx.dt = buf[b] === 1 ? Number(buf.readBigUInt64BE(b + 4)) : u32(b + 4);
      else if (type === 'trun') {
        const tr = tracks[ctx.tid];
        const v = buf[b];
        const fl = buf.readUIntBE(b + 1, 3);
        const n = u32(b + 4);
        let p = b + 8;
        if (fl & 1) p += 4;
        if (fl & 4) p += 4;
        let dt = ctx.dt;
        for (let k = 0; k < n; k++) {
          let dur = ctx.ddur;
          let cto = 0;
          if (fl & 0x100) (dur = u32(p)), (p += 4);
          if (fl & 0x200) p += 4;
          if (fl & 0x400) p += 4;
          if (fl & 0x800) (cto = v ? buf.readInt32BE(p) : u32(p)), (p += 4);
          if (tr?.type === want) out.push((dt + cto) / tr.ts);
          dt += dur;
        }
        ctx.dt = dt;
      }
      i += size;
    }
  };
  walk(0, buf.length, {});
  return out.sort((a, b) => a - b);
}

function packetStart(file, sel) {
  const t = run('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file])
    .toString()
    .split('\n')
    .map(parseFloat)
    .filter(Number.isFinite);
  return Math.min(...t);
}

function events(file, tso) {
  const buf = fs.readFileSync(file);
  // Decoded media carries ffmpeg's view of the timestamps; anchor each track to its MSE box times.
  const shiftV = sampleTimes(buf, 'vide')[0] - packetStart(file, 'v');
  const shiftA = sampleTimes(buf, 'soun')[0] - packetStart(file, 'a');
  const frames = run('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', `movie=${file},signalstats`, '-show_entries', 'frame=pts_time:frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'])
    .toString()
    .trim()
    .split('\n')
    .map((l) => l.split(',').map(Number));
  const flash = frames.find(([t, y]) => Number.isFinite(t) && y > 200);
  const pcm = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  let beep = null;
  for (let i = 0; i < pcm.length / 2; i++) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > 8000) {
      beep = packetStart(file, 'a') + i / 48000;
      break;
    }
  }
  return {
    flash: flash ? flash[0] + shiftV + tso : null,
    beep: beep != null ? beep + shiftA + tso : null,
  };
}

// ------------------------------------------------------------------------------------- the cases
const info = await probe(src);
const media = { path: src, video: { ...info.video, startTime: info.startTime }, audio: info.audio };
const tso = remuxTimestampOffset(media);
const expected = EVENT - (info.startTime || 0); // file time of the event on the player's timeline
const cases = [
  ['from the start', 0, false],
  ['after a seek', await keyframeBefore(src, 25.3, info.startTime), false],
  ['skip mode', await keyframeAfter(src, 25.3, info.startTime), true],
];

let failed = 0;
for (const [label, offset, exact] of cases) {
  const out = path.join(dir, 'out.mp4');
  const args = remuxArgs({ media, audio: info.audio[0], audioCopy: false, offset, stereo: true, exact });
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    const ws = fs.createWriteStream(out);
    p.stdout.pipe(ws);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    ws.on('finish', () => (p.exitCode ? reject(new Error(err)) : resolve()));
  });
  const { flash, beep } = events(out, tso);
  const ok = flash != null && beep != null && Math.abs(flash - beep) <= TOLERANCE && Math.abs(flash - expected) <= TOLERANCE;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(15)} start ${offset.toFixed(3)}s: picture at ${flash?.toFixed(3)}, sound at ${beep?.toFixed(3)} ` +
      `(expected ${expected.toFixed(3)}; offset ${flash != null && beep != null ? Math.round((flash - beep) * 1000) : '?'} ms)`
  );
}
fs.rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} A/V sync case(s) failed`);
  process.exit(1);
}
