import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import {
  requireAuth, loadUser, startSession, endSession, verifyPassword, createUser, userCount,
  purgeSessions, tooManyFails, noteFail, clearFails,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PLANS_SHARED = process.env.PLANS_SHARED !== 'false'; // tous les comptes voient tous les plans
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === 'true';

// Compte initial par variables d'environnement (optionnel)
if (userCount() === 0 && process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
  createUser(process.env.ADMIN_USER.trim(), process.env.ADMIN_PASSWORD);
  console.log(`Compte « ${process.env.ADMIN_USER} » créé.`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY ?? 1);
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Protection CSRF : les écritures de l'API exigent un en-tête que seul notre JS ajoute.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-requested-with') !== 'plan-appart') {
    return res.status(403).json({ error: 'Requête refusée' });
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ───────────── auth ─────────────
app.get('/api/session', (req, res) => {
  const user = loadUser(req, res);
  res.json({
    user,
    setup: userCount() === 0, // premier lancement : création du premier compte
    registration: ALLOW_REGISTRATION,
  });
});

function credentials(body) {
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  return { username, password };
}

app.post('/api/register', (req, res) => {
  const first = userCount() === 0;
  if (!first && !ALLOW_REGISTRATION) return res.status(403).json({ error: 'Les inscriptions sont fermées' });
  const { username, password } = credentials(req.body);
  if (!/^[\w.@-]{2,40}$/.test(username)) return res.status(400).json({ error: 'Identifiant invalide (2 à 40 caractères)' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  try {
    const id = createUser(username, password);
    startSession(req, res, id);
    res.json({ user: { id, username } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Identifiant déjà utilisé' });
    throw e;
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = credentials(req.body);
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (tooManyFails(key)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes' });
  const row = db.prepare('SELECT id, username, pass_hash FROM users WHERE username = ?').get(username);
  // on vérifie toujours un hash pour ne pas révéler si l'identifiant existe
  const ok = row ? verifyPassword(password, row.pass_hash) : (verifyPassword(password, 'scrypt$00$00'), false);
  if (!ok) {
    noteFail(key);
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  }
  clearFails(key);
  startSession(req, res, row.id);
  res.json({ user: { id: row.id, username: row.username } });
});

app.post('/api/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

// ───────────── plans ─────────────
const scope = (req) => (PLANS_SHARED ? { sql: '1=1', args: [] } : { sql: 'user_id = ?', args: [req.user.id] });

function cleanName(n) {
  return String(n ?? '').trim().slice(0, 120) || 'Sans titre';
}
function cleanSummary(s) {
  const rooms = Number(s?.rooms) || 0;
  const area = Number(s?.area) || 0;
  return JSON.stringify({ rooms: Math.max(0, Math.min(999, rooms | 0)), area: Math.max(0, Math.min(1e9, Math.round(area))) });
}
function validPlanData(d) {
  return d && typeof d === 'object' && !Array.isArray(d) && typeof d.nodes === 'object' && Array.isArray(d.walls);
}

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

app.get('/api/plans', requireAuth, (req, res) => {
  const s = scope(req);
  const rows = db.prepare(
    `SELECT id, name, summary, version, created_at, updated_at FROM plans WHERE ${s.sql} ORDER BY updated_at DESC`,
  ).all(...s.args);
  res.json(rows.map((r) => ({ ...r, summary: JSON.parse(r.summary || '{}') })));
});

app.post('/api/plans', requireAuth, (req, res) => {
  const { name, data, summary } = req.body || {};
  if (!validPlanData(data)) return res.status(400).json({ error: 'Plan invalide' });
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO plans (id, user_id, name, data, summary, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, cleanName(name), JSON.stringify(data), cleanSummary(summary), 1, now, now);
  res.status(201).json({ id, version: 1, updated_at: now });
});

function getPlan(req, id) {
  const s = scope(req);
  return db.prepare(`SELECT * FROM plans WHERE id = ? AND ${s.sql}`).get(id, ...s.args);
}

app.get('/api/plans/:id', requireAuth, (req, res) => {
  const p = getPlan(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Plan introuvable' });
  res.json({ id: p.id, name: p.name, version: p.version, updated_at: p.updated_at, data: JSON.parse(p.data) });
});

app.put('/api/plans/:id', requireAuth, (req, res) => {
  const p = getPlan(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Plan introuvable' });
  const { name, data, summary, baseVersion, force } = req.body || {};
  if (data !== undefined && !validPlanData(data)) return res.status(400).json({ error: 'Plan invalide' });
  if (!force && baseVersion !== undefined && baseVersion !== p.version) {
    return res.status(409).json({ error: 'Le plan a été modifié ailleurs', version: p.version, updated_at: p.updated_at });
  }
  const now = Date.now();
  const version = p.version + 1;
  db.prepare('UPDATE plans SET name = ?, data = ?, summary = ?, version = ?, updated_at = ? WHERE id = ?').run(
    name !== undefined ? cleanName(name) : p.name,
    data !== undefined ? JSON.stringify(data) : p.data,
    summary !== undefined ? cleanSummary(summary) : p.summary,
    version, now, p.id,
  );
  res.json({ version, updated_at: now });
});

app.post('/api/plans/:id/duplicate', requireAuth, (req, res) => {
  const p = getPlan(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Plan introuvable' });
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO plans (id, user_id, name, data, summary, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, cleanName(`${p.name} (copie)`), p.data, p.summary, 1, now, now);
  res.status(201).json({ id });
});

app.delete('/api/plans/:id', requireAuth, (req, res) => {
  const p = getPlan(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Plan introuvable' });
  db.prepare('DELETE FROM plans WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable' }));

// ───────────── fichiers statiques (PWA) ─────────────
// three.js servi localement (pas de CDN) : vue 3D
const THREE_DIR = path.join(__dirname, '..', 'node_modules', 'three');
app.use('/vendor/three', express.static(path.join(THREE_DIR, 'build'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/vendor/three-addons', express.static(path.join(THREE_DIR, 'examples', 'jsm'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  extensions: ['html'],
  setHeaders(res, file) {
    // toujours revalider (ETag) : une mise à jour du serveur est vue au prochain chargement
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.status === 413 ? 'Plan trop volumineux' : 'Erreur serveur' });
});

purgeSessions();
setInterval(purgeSessions, 6 * 3600 * 1000).unref();

app.listen(PORT, () => console.log(`Plan appart prêt sur http://localhost:${PORT}`));
