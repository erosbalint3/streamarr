import fs from 'node:fs';
import os from 'node:os';
import { all, get, run, getSettings, setSettings } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, hashPassword } from '../auth.js';
import { sessions, sessionSummary, stopSession } from '../streaming/sessions.js';
import { scanState, scheduleScans } from '../scanner.js';
import { taskState } from '../tasks.js';
import { exec } from '../util/proc.js';
import { queueBackgroundWork } from '../streaming/background.js';
import { enrichPending } from '../metadata/tmdb.js';

const EDITABLE = {
  serverName: 'string',
  tmdbApiKey: 'string',
  metadataLanguage: 'string',
  hwaccel: ['none', 'vaapi', 'nvenc'],
  vaapiDevice: 'string',
  transcodePreset: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'],
  maxTranscodes: 'number',
  transcodeAheadSeconds: 'number',
  maxSoftwareHeight: [720, 1080, 1440, 2160],
  stereoDownmix: 'boolean',
  trickplay: 'boolean',
  extractSubtitles: 'boolean',
  scanIntervalMinutes: 'number',
};

let ffmpegVersion = null;
async function ffmpegInfo() {
  if (ffmpegVersion) return ffmpegVersion;
  try {
    const out = (await exec(config.ffmpeg, ['-hide_banner', '-version'], { timeout: 5000 })).toString();
    ffmpegVersion = out.split('\n')[0];
  } catch (e) {
    ffmpegVersion = `ffmpeg not found (${e.message})`;
  }
  return ffmpegVersion;
}

function detectHardware() {
  let dri = [];
  try {
    dri = fs.readdirSync('/dev/dri').filter((d) => d.startsWith('renderD')).map((d) => `/dev/dri/${d}`);
  } catch {
    /* none */
  }
  const nvidia = fs.existsSync('/dev/nvidia0') || fs.existsSync('/dev/nvidiactl');
  return { vaapiDevices: dri, nvidia, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model || 'unknown' };
}

export default async function adminRoutes(app) {
  app.get('/api/admin/status', { preHandler: requireAdmin }, async () => {
    let disk = null;
    try {
      const st = fs.statfsSync(config.transcodeDir);
      disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    } catch {
      /* not supported */
    }
    const counts = get(
      `SELECT SUM(type = 'movie') AS movies, SUM(type = 'show') AS shows, SUM(type = 'episode') AS episodes, SUM(type = 'video') AS videos FROM items`
    );
    const playStats = get(`SELECT COUNT(*) AS plays, SUM(stalls) AS stalls, SUM(mode = 'direct') AS direct, SUM(mode = 'remux') AS remux, SUM(mode = 'transcode') AS transcode FROM play_history WHERE started_at > ?`, Date.now() - 30 * 86400000);
    const size = get('SELECT SUM(size) AS bytes, SUM(duration) AS seconds FROM media_files');
    return {
      version: '1.0.0',
      ffmpeg: await ffmpegInfo(),
      hardware: detectHardware(),
      load: os.loadavg(),
      memory: { free: os.freemem(), total: os.totalmem() },
      uptime: process.uptime(),
      transcodeDisk: disk,
      transcodeDir: config.transcodeDir,
      library: { ...counts, bytes: size.bytes || 0, seconds: size.seconds || 0 },
      playStats,
      scan: scanState,
      tasks: taskState(),
    };
  });

  app.get('/api/admin/sessions', { preHandler: requireAdmin }, async () => [...sessions.values()].map(sessionSummary));

  app.delete('/api/admin/sessions/:id', { preHandler: requireAdmin }, async (req) => {
    await stopSession(req.params.id);
    return { ok: true };
  });

  app.get('/api/admin/history', { preHandler: requireAdmin }, async () =>
    all(
      `SELECT h.*, u.username, i.title, s.title AS show_title, i.season_number, i.episode_number FROM play_history h
       LEFT JOIN users u ON u.id = h.user_id LEFT JOIN items i ON i.id = h.item_id LEFT JOIN items s ON s.id = i.show_id AND i.type = 'episode'
       ORDER BY h.started_at DESC LIMIT 50`
    )
  );

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    const s = { ...getSettings() };
    delete s._secret;
    return s;
  });

  app.put('/api/admin/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const patch = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      const rule = EDITABLE[k];
      if (!rule) continue;
      if (Array.isArray(rule)) {
        const val = typeof rule[0] === 'number' ? Number(v) : v;
        if (!rule.includes(val)) return reply.code(400).send({ error: `${k} must be one of ${rule.join(', ')}` });
        patch[k] = val;
      } else if (rule === 'number') patch[k] = Math.max(0, Number(v) || 0);
      else if (rule === 'boolean') patch[k] = !!v;
      else patch[k] = String(v ?? '').trim();
    }
    const before = getSettings();
    const after = setSettings(patch);
    if (patch.scanIntervalMinutes != null) scheduleScans();
    if (patch.tmdbApiKey && patch.tmdbApiKey !== before.tmdbApiKey) {
      run("UPDATE items SET metadata_state = 'pending' WHERE metadata_state = 'none' AND type IN ('movie','show','season','episode')");
      enrichPending((m) => console.log(`[metadata] ${m}`)).catch(() => {});
    }
    if ((patch.trickplay && !before.trickplay) || (patch.extractSubtitles && !before.extractSubtitles)) queueBackgroundWork();
    const out = { ...after };
    delete out._secret;
    return out;
  });

  // Quick 2-second encode to confirm the selected hardware acceleration works inside the container.
  app.post('/api/admin/hwtest', { preHandler: requireAdmin }, async (req) => {
    const settings = getSettings();
    const hw = req.body?.hwaccel || settings.hwaccel;
    const src = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '3'];
    let args;
    if (hw === 'vaapi') args = [...src.slice(0, 2), '-init_hw_device', `vaapi=va:${settings.vaapiDevice}`, '-filter_hw_device', 'va', ...src.slice(2), '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-b:v', '6M', '-f', 'null', '-'];
    else if (hw === 'nvenc') args = [...src, '-c:v', 'h264_nvenc', '-b:v', '6M', '-f', 'null', '-'];
    else args = [...src, '-c:v', 'libx264', '-preset', settings.transcodePreset, '-b:v', '6M', '-f', 'null', '-'];
    const t0 = Date.now();
    try {
      await exec(config.ffmpeg, args, { timeout: 60000 });
      const secs = (Date.now() - t0) / 1000;
      return { ok: true, hwaccel: hw, seconds: secs, speed: Math.round((3 / secs) * 10) / 10 };
    } catch (e) {
      return { ok: false, hwaccel: hw, error: e.message };
    }
  });

  app.post('/api/admin/background', { preHandler: requireAdmin }, async () => {
    queueBackgroundWork();
    return { ok: true, tasks: taskState() };
  });

  // ---------------- users
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () =>
    all(`SELECT u.id, u.username, u.is_admin, u.created_at, (SELECT MAX(started_at) FROM play_history h WHERE h.user_id = u.id) AS last_played FROM users u ORDER BY u.id`).map((u) => ({
      id: u.id,
      username: u.username,
      isAdmin: !!u.is_admin,
      createdAt: u.created_at,
      lastPlayed: u.last_played,
    }))
  );

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const { username, password, isAdmin } = req.body || {};
    if (!username?.trim() || !password || password.length < 6) return reply.code(400).send({ error: 'Enter a username and a password of at least 6 characters.' });
    if (get('SELECT id FROM users WHERE username = ?', username.trim())) return reply.code(409).send({ error: 'That username is taken.' });
    run('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)', username.trim(), hashPassword(password), isAdmin ? 1 : 0, Date.now());
    return { ok: true };
  });

  app.put('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { password, isAdmin } = req.body || {};
    const id = Number(req.params.id);
    if (password) {
      if (password.length < 6) return reply.code(400).send({ error: 'Passwords need at least 6 characters.' });
      run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    }
    if (isAdmin != null) {
      if (id === req.user.id && !isAdmin) return reply.code(400).send({ error: 'You can\'t remove your own admin rights.' });
      run('UPDATE users SET is_admin = ? WHERE id = ?', isAdmin ? 1 : 0, id);
    }
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    if (Number(req.params.id) === req.user.id) return reply.code(400).send({ error: 'You can\'t delete your own account.' });
    run('DELETE FROM users WHERE id = ?', req.params.id);
    return { ok: true };
  });
}
