// Playback sessions and the on-demand HLS transcoder.
//
// How it avoids the classic "buffering…" problems:
//  * Segments are produced on demand and the transcoder runs far ahead of the player
//    (TRANSCODE_AHEAD_SECONDS, default 4 min) before it is paused with SIGSTOP. Resuming is instant.
//  * Seeking anywhere restarts the encoder exactly at the requested segment, so a seek
//    costs one segment's worth of encode time instead of waiting for the transcoder to catch up.
//  * Keyframes are forced on a fixed 4s grid, so segments from different encoder runs and
//    different renditions line up perfectly – ABR switches and seeks are seamless.
//  * Every rendition in the ladder is encoded lazily; only the one the player is
//    actually pulling costs CPU. Idle renditions are reaped.
//  * If the GPU path fails, the job silently retries in hybrid, then software mode.
//  * Background work (trickplay, subtitle extraction) pauses while anyone is transcoding.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { getSettings, run } from '../db.js';
import { hlsArgs, remuxArgs, levelsFor, codecString } from './encoder.js';
import { audioBitrateFor } from './decision.js';
import { recordSpeed, statKey } from './encoderStats.js';
import { setBackgroundPaused } from '../tasks.js';
import { sleep } from '../util/proc.js';

export const sessions = new Map();

const SEGMENT_WAIT_MS = 45000;
const IDLE_RENDITION_MS = 25000; // another rendition took over
const IDLE_JOB_MS = 120000; // nobody is pulling segments at all (paused player)
const SESSION_TTL_MS = 10 * 60 * 1000;

export function segmentSeconds() {
  return getSettings().segmentSeconds || 4;
}

export function createSession({ user, item, media, decision, client, startPosition }) {
  const id = crypto.randomBytes(12).toString('base64url');
  const settings = getSettings();
  const session = {
    id,
    userId: user.id,
    username: user.username,
    itemId: item.id,
    title: item.type === 'episode' && item.show_title ? `${item.show_title} · S${item.season_number}E${item.episode_number}` : item.title,
    media,
    decision,
    mode: decision.mode,
    client: client || 'Web',
    createdAt: Date.now(),
    lastSeen: Date.now(),
    position: startPosition || 0,
    paused: false,
    stats: {},
    stalls: 0,
    level: levelsFor(settings.hwaccel)[0],
    dir: path.join(config.transcodeDir, id),
    renditions: new Map(),
    remux: null,
    historyId: null,
  };
  if (decision.mode === 'transcode') {
    for (const r of decision.ladder) {
      session.renditions.set(r.id, { ...r, dir: path.join(session.dir, r.id), completed: new Set(), pruned: new Set(), job: null, lastRequested: -1, lastRequestAt: 0 });
    }
  }
  const h = run('INSERT INTO play_history (user_id, item_id, mode, started_at, client) VALUES (?, ?, ?, ?, ?)', user.id, item.id, decision.mode, Date.now(), session.client);
  session.historyId = Number(h.lastInsertRowid);
  sessions.set(id, session);
  updateBackgroundPause();
  return session;
}

export function getSession(id) {
  const s = sessions.get(id);
  if (s) s.lastSeen = Date.now();
  return s;
}

export async function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  for (const rs of s.renditions.values()) killJob(rs);
  if (s.remux) s.remux.kill('SIGKILL');
  run('UPDATE play_history SET stalls = ? WHERE id = ?', s.stalls, s.historyId);
  await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  updateBackgroundPause();
}

// ---------------------------------------------------------------- playlists

export function masterPlaylist(session) {
  const audioBr = session.decision.audio ? audioBitrateFor(getSettings().stereoDownmix !== false ? 2 : session.decision.audio.channels) : 0;
  const fps = session.media.video.fps;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of session.renditions.values()) {
    const avg = r.bitrate + audioBr;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(r.bitrate * 1.3 + audioBr)},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${r.width}x${r.height},CODECS="${codecString(r)}"${fps ? `,FRAME-RATE=${fps.toFixed(3)}` : ''}`,
      `${r.id}/index.m3u8`
    );
  }
  return lines.join('\n') + '\n';
}

export function mediaPlaylist(session) {
  const seg = segmentSeconds();
  const duration = session.media.duration;
  const count = Math.max(1, Math.ceil(duration / seg - 0.001));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${seg + 1}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (let i = 0; i < count; i++) {
    const d = i === count - 1 ? duration - i * seg : seg;
    lines.push(`#EXTINF:${Math.max(0.1, d).toFixed(6)},`, `seg_${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- segment jobs

function refreshCompleted(rs) {
  try {
    const txt = fs.readFileSync(path.join(rs.dir, 'ffmpeg.m3u8'), 'utf8');
    const re = /seg_(\d+)\.ts/g;
    let m;
    while ((m = re.exec(txt))) {
      const n = Number(m[1]);
      if (!rs.pruned.has(n)) rs.completed.add(n);
      if (rs.job && n > rs.job.produced) rs.job.produced = n;
    }
  } catch {
    /* playlist not written yet */
  }
}

function killJob(rs) {
  const job = rs.job;
  if (!job) return;
  rs.job = null;
  job.killed = true;
  try {
    if (job.paused) job.proc.kill('SIGCONT');
    job.proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function startJob(session, rs, startSegment) {
  killJob(rs);
  fs.mkdirSync(rs.dir, { recursive: true });
  try {
    fs.rmSync(path.join(rs.dir, 'ffmpeg.m3u8'), { force: true });
  } catch {
    /* ignore */
  }
  rs.pruned.clear(); // the new job's playlist only lists what it writes itself
  const settings = getSettings();
  const args = hlsArgs({
    media: session.media,
    rendition: rs,
    audio: session.decision.audio,
    burn: session.decision.burnSubtitle,
    level: session.level,
    settings,
    startSegment,
    segmentSeconds: segmentSeconds(),
    outDir: rs.dir,
  });
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const job = { proc, start: startSegment, produced: startSegment - 1, paused: false, killed: false, exited: false, code: null, startedAt: Date.now(), speed: null, fps: null, stderr: '', level: session.level };
  rs.job = job;

  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const val = line.slice(eq + 1).trim();
      if (k === 'speed') job.speed = parseFloat(val) || job.speed;
      else if (k === 'out_time_us') job.outUs = Number(val) || job.outUs;
      else if (k === 'fps') job.fps = parseFloat(val) || job.fps;
    }
  });
  proc.stderr.on('data', (d) => {
    job.stderr = (job.stderr + d.toString()).slice(-4000);
  });
  proc.on('close', (code) => {
    job.exited = true;
    job.code = code;
    if (job.killed) return;
    if (rs.job === job) refreshCompleted(rs);
    if (code !== 0) {
      console.warn(`[transcode] ${session.id}/${rs.id} level=${job.level} exited ${code}: ${job.stderr.trim().split('\n').slice(-2).join(' | ')}`);
      const levels = levelsFor(settings.hwaccel);
      const idx = levels.indexOf(session.level);
      // Fell over before producing anything? Drop to the next level and retry from the same spot.
      if (job.produced < job.start && idx >= 0 && idx < levels.length - 1) {
        session.level = levels[idx + 1];
        console.warn(`[transcode] falling back to ${session.level} encoding`);
        if (rs.job === job) startJob(session, rs, job.start);
      }
    }
    updateBackgroundPause();
  });
  updateBackgroundPause();
  return job;
}

/** Make sure segment n exists, starting/redirecting the encoder as needed. Returns the file path. */
export async function getSegment(session, renditionId, n) {
  const rs = session.renditions.get(renditionId);
  if (!rs) throw Object.assign(new Error('unknown rendition'), { statusCode: 404 });
  const total = Math.ceil(session.media.duration / segmentSeconds() - 0.001);
  if (n < 0 || n >= total) throw Object.assign(new Error('segment out of range'), { statusCode: 404 });

  rs.lastRequested = n;
  rs.lastRequestAt = Date.now();
  session.activeRendition = renditionId;
  const file = path.join(rs.dir, `seg_${n}.ts`);

  refreshCompleted(rs);
  if (rs.completed.has(n) && !fs.existsSync(file)) {
    rs.completed.delete(n);
    rs.pruned.add(n);
  }
  if (!rs.completed.has(n)) {
    const job = rs.job;
    const lookahead = 3;
    if (!job || job.exited || n < job.start || n > job.produced + lookahead || rs.pruned.has(n)) {
      startJob(session, rs, n);
    } else if (job.paused) {
      resume(job);
    }
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    while (!rs.completed.has(n)) {
      if (Date.now() > deadline) throw Object.assign(new Error('transcoder is too slow'), { statusCode: 503 });
      await sleep(80);
      refreshCompleted(rs);
      const j = rs.job;
      if (!j) throw Object.assign(new Error('transcode stopped'), { statusCode: 503 });
      if (j.exited && j.code !== 0 && !rs.completed.has(n) && rs.job === j) {
        throw Object.assign(new Error(`transcode failed: ${j.stderr.trim().split('\n').pop() || 'unknown error'}`), { statusCode: 500 });
      }
      if (j.exited && j.code === 0 && !rs.completed.has(n)) {
        if (j.start <= n) throw Object.assign(new Error('past end of stream'), { statusCode: 404 });
        startJob(session, rs, n);
      }
    }
  }
  prefetch(session, rs, n);
  return file;
}

/** After serving n, make sure an encoder is running for what comes next (e.g. after a long pause). */
function prefetch(session, rs, n) {
  const total = Math.ceil(session.media.duration / segmentSeconds() - 0.001);
  if (rs.job && !rs.job.exited) {
    if (rs.job.paused) maybeResume(rs);
    return;
  }
  for (let m = n + 1; m < Math.min(total, n + 6); m++) {
    if (!rs.completed.has(m)) {
      startJob(session, rs, m);
      return;
    }
  }
}

function pause(job) {
  if (job.paused || job.exited) return;
  job.proc.kill('SIGSTOP');
  job.paused = true;
  job.sample = null;
}
function resume(job) {
  if (!job.paused || job.exited) return;
  job.proc.kill('SIGCONT');
  job.paused = false;
  job.sample = null;
}

/**
 * Real-time factor measured over the last few seconds of actual encoding (ffmpeg's own "speed" is
 * an average since start that includes time spent paused). Feeds the learned speed table.
 */
function sampleSpeed(session, rs, job, now) {
  if (job.paused || job.exited || !job.outUs) return;
  if (!job.sample) {
    job.sample = { t: now, us: job.outUs };
    return;
  }
  if (now - job.sample.t < 4000) return;
  const speed = (job.outUs - job.sample.us) / 1e6 / ((now - job.sample.t) / 1000);
  job.sample = { t: now, us: job.outUs };
  if (!(speed > 0)) return;
  job.liveSpeed = speed;
  // Skip the warm-up (probing, first keyframe, lookahead) so it doesn't skew the table.
  if (now - job.startedAt > 8000) recordSpeed(statKey(session.media, rs.height, `${getSettings().hwaccel}/${job.level}`), speed);
}

function aheadSegments() {
  return Math.max(10, Math.round((getSettings().transcodeAheadSeconds || 240) / segmentSeconds()));
}

function maybeResume(rs) {
  const job = rs.job;
  if (job?.paused && job.produced - rs.lastRequested < aheadSegments() * 0.75) resume(job);
}

/**
 * Any open player – direct play and direct stream read the same disks as background jobs.
 * Players report every 10 s (also while paused), so a session silent for 45 s is a closed
 * tab or a sleeping phone and no longer holds background work back.
 */
function updateBackgroundPause() {
  const now = Date.now();
  let watching = false;
  for (const s of sessions.values()) if (now - s.lastSeen < 45000) watching = true;
  setBackgroundPaused(watching);
}

/** Delete segments well behind the playhead (and stale ones far ahead of it) to bound scratch space. */
function pruneSegments(rs) {
  if (rs.completed.size < 90) return;
  const keepBehind = 45; // ~3 minutes for instant short back-seeks
  const keepAhead = aheadSegments() * 1.5;
  for (const n of rs.completed) {
    if (n < rs.lastRequested - keepBehind || n > rs.lastRequested + keepAhead) {
      if (rs.job && !rs.job.exited && n >= rs.job.start && n <= rs.job.produced + 2 && n > rs.lastRequested) continue;
      rs.completed.delete(n);
      rs.pruned.add(n);
      fs.rm(path.join(rs.dir, `seg_${n}.ts`), { force: true }, () => {});
    }
  }
}

// Housekeeping loop: throttle, reap idle jobs, expire sessions.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      stopSession(s.id);
      continue;
    }
    for (const rs of s.renditions.values()) {
      pruneSegments(rs);
      const job = rs.job;
      if (!job || job.exited) continue;
      refreshCompleted(rs);
      const idle = now - rs.lastRequestAt;
      const otherActive = s.activeRendition && s.activeRendition !== rs.id;
      if ((otherActive && idle > IDLE_RENDITION_MS) || idle > IDLE_JOB_MS) {
        killJob(rs);
        continue;
      }
      // The player switched to another quality: freeze this encoder right away so the two
      // don't split the CPU (it resumes instantly if the player switches back).
      if (otherActive) {
        pause(job);
        continue;
      }
      sampleSpeed(s, rs, job, now);
      const ahead = job.produced - rs.lastRequested;
      if (!job.paused && ahead > aheadSegments()) pause(job);
      else maybeResume(rs);
    }
  }
  updateBackgroundPause();
}, 1000).unref();

// ---------------------------------------------------------------- remux

export function startRemux(session, offset) {
  if (session.remux) session.remux.kill('SIGKILL');
  const args = remuxArgs({
    media: session.media,
    audio: session.decision.audio,
    audioCopy: session.decision.audioCopy,
    offset,
    stereo: getSettings().stereoDownmix !== false,
  });
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  proc.on('close', (code) => {
    if (code && code !== 255 && !proc.killed) console.warn(`[remux] ${session.id} exited ${code}: ${err.trim()}`);
    if (session.remux === proc) session.remux = null;
  });
  session.remux = proc;
  return proc;
}

/**
 * Start the remux while the /start response is still on its way to the player, so the process has
 * opened the file and probed it by the time the player asks for the stream (~0.1–0.2 s saved, more
 * on spinning disks). Unclaimed after 15 s, it is discarded.
 */
export function prestartRemux(session, offset) {
  const proc = startRemux(session, offset);
  session.prestart = { proc, offset };
  setTimeout(() => {
    if (session.prestart?.proc !== proc) return;
    session.prestart = null;
    if (session.remux === proc) session.remux = null;
    proc.kill('SIGKILL');
  }, 15000).unref();
}

/** The pre-started process if it matches this request, otherwise a fresh one. */
export function takeRemux(session, offset) {
  const p = session.prestart;
  session.prestart = null;
  if (p && Math.abs(p.offset - offset) < 0.002 && session.remux === p.proc && p.proc.exitCode == null && !p.proc.killed) return p.proc;
  return startRemux(session, offset);
}

// ---------------------------------------------------------------- stats for the admin dashboard

export function sessionSummary(s) {
  const rs = s.activeRendition ? s.renditions.get(s.activeRendition) : null;
  const job = rs?.job;
  return {
    id: s.id,
    user: s.username,
    itemId: s.itemId,
    title: s.title,
    mode: s.mode,
    client: s.client,
    reasons: s.decision.reasons,
    position: s.position,
    duration: s.media.duration,
    paused: s.paused,
    startedAt: s.createdAt,
    lastSeen: s.lastSeen,
    stalls: s.stalls,
    bandwidth: s.stats.bandwidth || null,
    buffer: s.stats.buffer ?? null,
    source: {
      container: s.media.container,
      video: `${s.media.video.codec} ${s.media.video.width}x${s.media.video.height}${s.media.video.hdr ? ' ' + s.media.video.hdr.toUpperCase() : ''}`,
      audio: s.decision.audio ? `${s.decision.audio.codec} ${s.decision.audio.channels}ch` : 'none',
      bitrate: s.media.bitrate,
    },
    transcode: rs
      ? {
          rendition: rs.id,
          bitrate: rs.bitrate,
          level: s.level,
          speed: job ? (job.liveSpeed ?? job.speed ?? null) : null,
          age: job ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
          fps: job?.fps ?? null,
          throttled: !!job?.paused,
          running: !!job && !job.exited,
          aheadSeconds: job ? Math.max(0, (job.produced - rs.lastRequested) * segmentSeconds()) : 0,
        }
      : null,
  };
}

// Clean leftovers from a previous run. Only the contents: the directory itself may be a
// tmpfs mount point or sit in a root-owned parent we can't write to.
fs.mkdirSync(config.transcodeDir, { recursive: true });
for (const entry of fs.readdirSync(config.transcodeDir)) {
  fs.rmSync(path.join(config.transcodeDir, entry), { recursive: true, force: true });
}
