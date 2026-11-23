import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-appart-'));
let proc;
let cookie = '';

const H = { 'content-type': 'application/json', 'x-requested-with': 'plan-appart' };
async function api(method, url, body, extra = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...H, ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* vide */ }
  return { status: res.status, json };
}

before(async () => {
  proc = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
    proc.on('exit', (c) => reject(new Error('serveur arrêté ' + c)));
    setTimeout(() => reject(new Error('timeout démarrage')), 8000);
  });
});

after(() => {
  proc?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

const plan = { v: 1, nodes: {}, walls: [], openings: [], rooms: [], furniture: [], settings: {} };

test('non connecté : accès refusé', async () => {
  assert.equal((await api('GET', '/api/plans')).status, 401);
  const s = await api('GET', '/api/session');
  assert.equal(s.json.user, null);
  assert.equal(s.json.setup, true);
});

test('CSRF : écriture sans en-tête refusée', async () => {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 403);
});

test('premier compte, mot de passe trop court puis ok', async () => {
  assert.equal((await api('POST', '/api/register', { username: 'laury', password: 'court' })).status, 400);
  const r = await api('POST', '/api/register', { username: 'laury', password: 'motdepasse-long' });
  assert.equal(r.status, 200);
  assert.ok(cookie.startsWith('sid='));
  // inscriptions fermées ensuite
  const r2 = await api('POST', '/api/register', { username: 'autre', password: 'motdepasse-long' });
  assert.equal(r2.status, 403);
});

test('CRUD plans, version et conflit', async () => {
  const c = await api('POST', '/api/plans', { name: 'Appart', data: plan, summary: { rooms: 2, area: 620000 } });
  assert.equal(c.status, 201);
  const id = c.json.id;

  const l = await api('GET', '/api/plans');
  assert.equal(l.json.length, 1);
  assert.equal(l.json[0].summary.rooms, 2);

  const u = await api('PUT', `/api/plans/${id}`, { data: plan, baseVersion: 1 });
  assert.equal(u.status, 200);
  assert.equal(u.json.version, 2);

  const conflict = await api('PUT', `/api/plans/${id}`, { data: plan, baseVersion: 1 });
  assert.equal(conflict.status, 409);
  const forced = await api('PUT', `/api/plans/${id}`, { data: plan, baseVersion: 1, force: true });
  assert.equal(forced.status, 200);

  const bad = await api('PUT', `/api/plans/${id}`, { data: { nope: 1 } });
  assert.equal(bad.status, 400);

  const dup = await api('POST', `/api/plans/${id}/duplicate`);
  assert.equal(dup.status, 201);
  assert.equal((await api('GET', '/api/plans')).json.length, 2);

  const g = await api('GET', `/api/plans/${id}`);
  assert.equal(g.json.name, 'Appart');
  assert.equal((await api('DELETE', `/api/plans/${id}`)).status, 200);
  assert.equal((await api('GET', `/api/plans/${id}`)).status, 404);
});

test('déconnexion puis reconnexion, mauvais mot de passe refusé', async () => {
  await api('POST', '/api/logout');
  cookie = '';
  assert.equal((await api('GET', '/api/plans')).status, 401);
  assert.equal((await api('POST', '/api/login', { username: 'laury', password: 'faux-mot-de-passe' })).status, 401);
  const ok = await api('POST', '/api/login', { username: 'LAURY', password: 'motdepasse-long' });
  assert.equal(ok.status, 200);
  assert.equal((await api('GET', '/api/plans')).status, 200);
});
