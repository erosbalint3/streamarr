import fs from 'node:fs';
import crypto from 'node:crypto';
import { get, run, json, getSettings } from '../db.js';
import { requireUser } from '../auth.js';
import { getItem, card } from '../serialize.js';
import { mediaForItem, audioLabel, subtitleLabel } from '../streaming/media.js';
import { decide, pickDefaultTracks } from '../streaming/decision.js';
import { keyframeBefore } from '../util/ffprobe.js';
import { createSession, getSession, stopSession, masterPlaylist, mediaPlaylist, getSegment, startRemux, sessionSummary, segmentSeconds } from '../streaming/sessions.js';
import { adjacentEpisode } from './library.js';

// Incompressible bytes for the bandwidth probe.
const SPEEDTEST = crypto.randomBytes(16 * 1024 * 1024);

const MIME = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };

function serveFileRange(req, reply, file, size, type) {
  const range = req.headers.range;
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', type).header('Cache-Control', 'private, no-transform');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) {
      start = size - Number(m[2]);
      end = size - 1;
    }
    if (start >= size || start > end) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    end = Math.min(end, size - 1);
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
    // Large read buffers keep high-bitrate remuxes (80+ Mbps) flowing without syscall overhead.
    return reply.send(fs.createReadStream(file, { start, end, highWaterMark: 1024 * 1024 }));
  }
  reply.header('Content-Length', size);
  return reply.send(fs.createReadStream(file, { highWaterMark: 1024 * 1024 }));
}

function trackLists(itemId, media, decision) {
  return {
    audioTracks: media.audio.map((a) => ({ index: a.index, label: audioLabel(a), language: a.language, selected: decision.audio?.index === a.index })),
    subtitleTracks: media.subtitles.map((s) => ({
      index: s.index,
      label: subtitleLabel(s),
      language: s.language,
      forced: s.forced,
      text: s.text,
      url: s.text ? `/api/media/${itemId}/subtitles/${s.index}.vtt` : null,
      selected: String(decision.subtitle?.index) === String(s.index),
    })),
  };
}

export default async function playbackRoutes(app) {
  // sendBeacon() posts JSON as text/plain.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body, done) => {
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch {
      done(null, {});
    }
  });

  app.get('/api/speedtest', { preHandler: requireUser }, async (req, reply) => {
    const bytes = Math.min(Math.max(Number(req.query.bytes) || 2 * 1024 * 1024, 64 * 1024), SPEEDTEST.length);
    return reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-store, no-transform').header('Content-Length', bytes).send(SPEEDTEST.subarray(0, bytes));
  });

  app.post('/api/playback/:itemId/start', { preHandler: requireUser }, async (req, reply) => {
    const item = getItem(req.params.itemId);
    const media = item && mediaForItem(item.id);
    if (!media) return reply.code(404).send({ error: 'This title has no playable file.' });
    if (!media.video) return reply.code(415).send({ error: 'This file has no video stream.' });
    try {
      fs.accessSync(media.path, fs.constants.R_OK);
    } catch {
      return reply.code(410).send({ error: 'The media file is missing or unreadable. Check that the drive is mounted.' });
    }

    const body = req.body || {};
    if (body.replaceSession) await stopSession(body.replaceSession);
    const settings = getSettings();
    const prefs = json(req.user.prefs, {});
    const defaults = pickDefaultTracks(media, prefs);
    const audioIndex = body.audioIndex !== undefined ? body.audioIndex : defaults.audioIndex;
    const subtitleIndex = body.subtitleIndex !== undefined ? body.subtitleIndex : defaults.subtitleIndex;

    const progress = get('SELECT position, watched FROM progress WHERE user_id = ? AND item_id = ?', req.user.id, item.id);
    let startPosition = body.startPosition != null ? Number(body.startPosition) : progress && !progress.watched ? progress.position : 0;
    if (startPosition > media.duration - 5) startPosition = 0;

    const decision = decide(media, {
      caps: body.caps,
      audioIndex,
      subtitleIndex,
      quality: body.quality || prefs.quality || 'auto',
      maxBitrate: Number(body.maxBitrate ?? prefs.maxBitrate ?? 0),
      bandwidth: Number(body.bandwidth || 0),
      forceMode: body.forceMode,
      settings,
    });

    const session = createSession({ user: req.user, item, media, decision, client: body.client, startPosition });
    let url;
    let offset = 0;
    if (decision.mode === 'direct') url = `/api/stream/${session.id}/direct`;
    else if (decision.mode === 'remux') {
      offset = await keyframeBefore(media.path, startPosition, media.video.startTime || 0);
      url = `/api/stream/${session.id}/remux?offset=${offset.toFixed(3)}`;
    } else url = `/api/stream/${session.id}/master.m3u8`;

    let next = null;
    if (item.type === 'episode') {
      const n = adjacentEpisode(item, 1);
      if (n) next = card(n);
    }

    return {
      sessionId: session.id,
      mode: decision.mode,
      reasons: decision.reasons,
      url,
      offset,
      startPosition,
      duration: media.duration,
      segmentSeconds: segmentSeconds(),
      renditions: decision.ladder || [],
      fixedQuality: decision.fixed,
      qualities: decision.qualities.map((r) => ({ id: r.id, bitrate: r.bitrate, height: r.height })),
      ...trackLists(item.id, media, decision),
      trickplay: media.trickplay ? { ...media.trickplay, url: `/api/media/${item.id}/trickplay/{n}.jpg` } : null,
      chapters: media.chapters,
      source: {
        container: media.container,
        bitrate: media.bitrate,
        video: media.video,
        audio: decision.audio ? { codec: decision.audio.codec, channels: decision.audio.channels, copy: decision.audioCopy } : null,
      },
      item: {
        id: item.id,
        type: item.type,
        title: item.title,
        showTitle: item.show_title || null,
        showId: item.show_id,
        seasonNumber: item.season_number,
        episodeNumber: item.episode_number,
        backdrop: `/api/images/${item.id}/backdrop?v=${item.updated_at}`,
      },
      next,
    };
  });

  // Remux seek outside the buffered range: find the exact keyframe and hand back a new stream URL.
  app.post('/api/playback/session/:sid/seek', async (req, reply) => {
    const s = getSession(req.params.sid);
    if (!s) return reply.code(404).send({ error: 'Playback session expired.' });
    const t = Math.max(0, Math.min(Number(req.body?.position) || 0, s.media.duration - 1));
    const offset = await keyframeBefore(s.media.path, t, s.media.video.startTime || 0);
    return { url: `/api/stream/${s.id}/remux?offset=${offset.toFixed(3)}`, offset };
  });

  app.post('/api/playback/session/:sid/progress', async (req, reply) => {
    const s = getSession(req.params.sid);
    if (!s) return reply.code(404).send({ error: 'Playback session expired.' });
    const b = req.body || {};
    const position = Number(b.position) || 0;
    s.position = position;
    s.paused = !!b.paused;
    s.stats = { buffer: b.buffer, bandwidth: b.bandwidth, level: b.level, dropped: b.droppedFrames };
    if (b.stalls != null) s.stalls = Number(b.stalls);

    const duration = s.media.duration;
    const watched = duration > 0 && position / duration >= 0.92;
    const prev = get('SELECT watched FROM progress WHERE user_id = ? AND item_id = ?', s.userId, s.itemId);
    run(
      `INSERT INTO progress (user_id, item_id, position, duration, watched, play_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
         watched = CASE WHEN excluded.watched = 1 THEN 1 WHEN excluded.position > 60 AND progress.watched = 1 AND ? THEN 0 ELSE progress.watched END,
         play_count = progress.play_count + excluded.play_count, updated_at = excluded.updated_at`,
      s.userId,
      s.itemId,
      position,
      duration,
      watched ? 1 : 0,
      watched && !prev?.watched ? 1 : 0,
      Date.now(),
      // Re-watching something already watched: once well past the start and before the end, it's in progress again.
      position > 60 && !watched ? 1 : 0
    );
    return { ok: true, watched, session: sessionSummary(s) };
  });

  app.post('/api/playback/session/:sid/stop', async (req) => {
    const s = getSession(req.params.sid);
    if (s && req.body?.position != null) {
      const position = Number(req.body.position);
      const watched = position / s.media.duration >= 0.92;
      run(
        `INSERT INTO progress (user_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET position = excluded.position, watched = MAX(progress.watched, excluded.watched), updated_at = excluded.updated_at`,
        s.userId,
        s.itemId,
        position,
        s.media.duration,
        watched ? 1 : 0,
        Date.now()
      );
    }
    await stopSession(req.params.sid);
    return { ok: true };
  });

  // ---------------- stream delivery (the session id is the capability token)
  app.get('/api/stream/:sid/direct', async (req, reply) => {
    const s = getSession(req.params.sid);
    if (!s || s.mode !== 'direct') return reply.code(404).send();
    return serveFileRange(req, reply, s.media.path, s.media.size, MIME[s.media.container] || 'video/mp4');
  });

  app.get('/api/stream/:sid/remux', async (req, reply) => {
    const s = getSession(req.params.sid);
    if (!s) return reply.code(404).send();
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const proc = startRemux(s, offset);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store, no-transform',
      'Accept-Ranges': 'none',
      'X-Accel-Buffering': 'no',
    });
    proc.stdout.pipe(reply.raw);
    const cleanup = () => {
      if (s.remux === proc) s.remux = null;
      proc.kill('SIGKILL');
    };
    req.raw.on('close', cleanup);
    proc.on('close', () => reply.raw.end());
  });

  app.get('/api/stream/:sid/master.m3u8', async (req, reply) => {
    const s = getSession(req.params.sid);
    if (!s || s.mode !== 'transcode') return reply.code(404).send();
    return reply.header('Content-Type', 'application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(masterPlaylist(s));
  });

  app.get('/api/stream/:sid/:rid/index.m3u8', async (req, reply) => {
    const s = getSession(req.params.sid);
    if (!s || !s.renditions.has(req.params.rid)) return reply.code(404).send();
    return reply.header('Content-Type', 'application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(mediaPlaylist(s));
  });

  app.get('/api/stream/:sid/:rid/:seg', async (req, reply) => {
    const s = getSession(req.params.sid);
    const m = /^seg_(\d+)\.ts$/.exec(req.params.seg);
    if (!s || !m) return reply.code(404).send();
    try {
      const file = await getSegment(s, req.params.rid, Number(m[1]));
      const stat = fs.statSync(file);
      return reply.header('Content-Type', 'video/mp2t').header('Content-Length', stat.size).header('Cache-Control', 'private, max-age=3600').send(fs.createReadStream(file));
    } catch (e) {
      return reply.code(e.statusCode || 500).send({ error: e.message });
    }
  });
}
