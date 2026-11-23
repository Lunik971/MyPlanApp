import crypto from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 60);
const SESSION_MS = SESSION_DAYS * 86400 * 1000;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const e = Buffer.from(hashHex, 'hex');
  return e.length === h.length && crypto.timingSafeEqual(e, h);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, token, maxAgeMs) {
  const secure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && req.secure);
  const parts = [
    `sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha(token), userId, Date.now() + SESSION_MS);
  setCookie(req, res, token, SESSION_MS);
}

export function endSession(req, res) {
  const t = parseCookies(req).sid;
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  setCookie(req, res, '', 0);
}

// Lit la session ; la prolonge quand il en reste moins de la moitié (session « glissante »).
export function loadUser(req, res) {
  const t = parseCookies(req).sid;
  if (!t) return null;
  const row = db.prepare(
    'SELECT s.expires_at, u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  ).get(sha(t));
  if (!row || row.expires_at < Date.now()) return null;
  if (row.expires_at - Date.now() < SESSION_MS / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_MS, sha(t));
    setCookie(req, res, t, SESSION_MS);
  }
  return { id: row.id, username: row.username };
}

export function requireAuth(req, res, next) {
  const u = loadUser(req, res);
  if (!u) return res.status(401).json({ error: 'Non connecté' });
  req.user = u;
  next();
}

export function purgeSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createUser(username, password) {
  const info = db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?,?,?)')
    .run(username, hashPassword(password), Date.now());
  return Number(info.lastInsertRowid);
}

// Limiteur très simple contre le brute-force : 10 échecs / 15 min par IP + identifiant.
const fails = new Map();
export function tooManyFails(key) {
  const f = fails.get(key);
  return !!f && f.until > Date.now() && f.n >= 10;
}
export function noteFail(key) {
  const f = fails.get(key);
  if (!f || f.until < Date.now()) fails.set(key, { n: 1, until: Date.now() + 15 * 60 * 1000 });
  else f.n++;
}
export function clearFails(key) {
  fails.delete(key);
}
