import { get, run, json, getSettings } from '../db.js';
import { hashPassword, verifyPassword, createToken, cookieHeader, requireUser, userFromRequest } from '../auth.js';

const publicUser = (u) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin, prefs: json(u.prefs, {}) });

const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  attempts.set(ip, a);
  return a.length >= 10;
}

export default async function authRoutes(app) {
  app.get('/api/auth/status', async (req) => {
    const count = get('SELECT COUNT(*) AS n FROM users').n;
    const user = userFromRequest(req);
    return { needsSetup: count === 0, user: user ? publicUser(user) : null, serverName: getSettings().serverName };
  });

  // First-run setup: creates the admin account. Afterwards only admins can create users (see admin routes).
  app.post('/api/auth/setup', async (req, reply) => {
    const count = get('SELECT COUNT(*) AS n FROM users').n;
    if (count > 0) return reply.code(409).send({ error: 'Setup is already complete. Sign in instead.' });
    const { username, password } = req.body || {};
    if (!username?.trim() || !password || password.length < 6) return reply.code(400).send({ error: 'Choose a username and a password of at least 6 characters.' });
    const r = run('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)', username.trim(), hashPassword(password), Date.now());
    const user = get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
    const token = createToken(user);
    reply.header('Set-Cookie', cookieHeader(token, req));
    return { user: publicUser(user), token };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (rateLimited(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Wait a minute and try again.' });
    const { username, password } = req.body || {};
    const user = username ? get('SELECT * FROM users WHERE username = ?', String(username).trim()) : null;
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      attempts.get(req.ip)?.push(Date.now()) ?? attempts.set(req.ip, [Date.now()]);
      return reply.code(401).send({ error: 'That username and password don\'t match.' });
    }
    const token = createToken(user);
    reply.header('Set-Cookie', cookieHeader(token, req));
    return { user: publicUser(user), token };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.header('Set-Cookie', cookieHeader('', req));
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser }, async (req) => publicUser(req.user));

  app.put('/api/me/prefs', { preHandler: requireUser }, async (req) => {
    const prefs = { ...json(req.user.prefs, {}), ...(req.body || {}) };
    run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), req.user.id);
    return { prefs };
  });

  app.put('/api/me/password', { preHandler: requireUser }, async (req, reply) => {
    const { current, password } = req.body || {};
    const row = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(current || ''), row.password_hash)) return reply.code(400).send({ error: 'Your current password is incorrect.' });
    if (!password || password.length < 6) return reply.code(400).send({ error: 'The new password needs at least 6 characters.' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), req.user.id);
    return { ok: true };
  });
}
