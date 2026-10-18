import crypto from 'node:crypto';
import { get, getSecret } from './db.js';

const TOKEN_TTL = 1000 * 60 * 60 * 24 * 90; // 90 days
export const COOKIE = 'sa_token';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [, saltB64, hashB64] = String(stored).split('$');
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

function sign(data) {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
}

export function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + TOKEN_TTL })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function tokenFromRequest(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE]) return cookies[COOKIE];
  if (req.query?.token) return req.query.token;
  return null;
}

export function userFromRequest(req) {
  const data = verifyToken(tokenFromRequest(req));
  if (!data) return null;
  return get('SELECT id, username, is_admin, prefs FROM users WHERE id = ?', data.uid) || null;
}

export function cookieHeader(token, req) {
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  const maxAge = token ? Math.floor(TOKEN_TTL / 1000) : 0;
  return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// Fastify preHandlers
export async function requireUser(req, reply) {
  const user = userFromRequest(req);
  if (!user) return reply.code(401).send({ error: 'Sign in to continue.' });
  req.user = user;
}

export async function requireAdmin(req, reply) {
  const user = userFromRequest(req);
  if (!user) return reply.code(401).send({ error: 'Sign in to continue.' });
  if (!user.is_admin) return reply.code(403).send({ error: 'Only admins can do this.' });
  req.user = user;
}
