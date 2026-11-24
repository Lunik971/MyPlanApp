import * as G from './geometry.js';
import { VERSION } from './version.js';
import { Editor } from './editor.js';
import { ROOM_COLORS } from './render.js';

const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};

// ───────────────────────── réseau ─────────────────────────

async function api(method, url, body, opts = {}) {
  const res = await fetch(url, {
    method, credentials: 'same-origin', keepalive: !!opts.keepalive,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'plan-appart' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Erreur ${res.status}`);
    err.status = res.status; err.data = data;
    if (res.status === 401 && state.user && !url.includes('/login')) { state.user = null; showLogin(); }
    throw err;
  }
  return data;
}

const state = { user: null, session: null, plan: null, plans: [] };
let editor = null;
let deferredInstall = null;

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// ───────────────────────── feuilles (menus modaux) ─────────────────────────

function openSheet(title, body, { onClose } = {}) {
  const root = $('#sheet-root');
  const close = () => { backdrop.remove(); onClose?.(); };
  const backdrop = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'x', 'aria-label': 'Fermer', onclick: close }, '✕')),
      h('div', { class: 'sheet-body' }, body)));
  root.append(backdrop);
  return { close, el: backdrop };
}
const closeSheets = () => { $('#sheet-root').innerHTML = ''; };

// ───────────────────────── connexion ─────────────────────────

let registerMode = false;

function showLogin() {
  show('login');
  const setup = state.session?.setup;
  const canRegister = setup || state.session?.registration;
  const reg = setup || registerMode;
  $('#login-sub').textContent = setup ? 'Premier lancement : créez votre compte.' : reg ? 'Créer un compte.' : 'Connectez-vous pour retrouver vos plans.';
  $('#login-submit').textContent = reg ? 'Créer le compte' : 'Se connecter';
  $('#login-pass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#login-form').dataset.mode = reg ? 'register' : 'login';
  let alt = $('#login-alt');
  if (!alt) { alt = h('button', { type: 'button', class: 'btn sm', id: 'login-alt', onclick: () => { registerMode = !registerMode; showLogin(); } }); $('#login-form').append(alt); }
  alt.hidden = !canRegister || setup;
  alt.textContent = registerMode ? 'J’ai déjà un compte' : 'Créer un compte';
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reg = e.currentTarget.dataset.mode === 'register';
  $('#login-error').textContent = '';
  $('#login-submit').disabled = true;
  try {
    const r = await api('POST', reg ? '/api/register' : '/api/login', { username: $('#login-user').value, password: $('#login-pass').value });
    state.user = r.user;
    $('#login-pass').value = '';
    state.session = { ...state.session, setup: false };
    route();
  } catch (err) {
    $('#login-error').textContent = err.status ? err.message : 'Serveur injoignable';
  } finally { $('#login-submit').disabled = false; }
});

async function logout() {
  await flushSave();
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }
  state.user = null; state.plan = null;
  location.hash = '';
  state.session = await api('GET', '/api/session').catch(() => state.session);
  showLogin();
}

// ───────────────────────── liste des plans ─────────────────────────

const fmtDate = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

async function showPlans() {
  closeSheets();
  show('plans');
  try { state.plans = await api('GET', '/api/plans'); } catch (e) { if (e.status === 401) return; toast('Impossible de charger les plans'); }
  const ul = $('#plan-list');
  ul.innerHTML = '';
  $('#plans-empty').hidden = state.plans.length > 0;
  for (const p of state.plans) {
    const sum = p.summary?.rooms ? `${p.summary.rooms} pièce${p.summary.rooms > 1 ? 's' : ''} · ${G.fmtArea(p.summary.area)}` : 'Plan vide';
    ul.append(h('li', { class: 'plan-item' },
      h('button', { class: 'main', onclick: () => { location.hash = `#/plan/${p.id}`; } },
        h('span', { class: 't' }, p.name), h('span', { class: 's' }, `${sum} · modifié le ${fmtDate(p.updated_at)}`)),
      h('button', { class: 'more', 'aria-label': 'Options', onclick: () => planMenu(p) }, '⋮')));
  }
}

function planMenu(p) {
  const sh = openSheet(p.name, h('div', { class: 'menu-list' },
    h('button', { onclick: async () => { sh.close(); await api('POST', `/api/plans/${p.id}/duplicate`); toast('Plan dupliqué'); showPlans(); } }, h('span', { class: 'ico' }, '⎘'), 'Dupliquer (pour tester un autre aménagement)'),
    h('button', { class: 'danger', onclick: async () => { if (!confirm(`Supprimer « ${p.name} » définitivement ?`)) return; sh.close(); await api('DELETE', `/api/plans/${p.id}`); showPlans(); } }, h('span', { class: 'ico' }, '🗑'), 'Supprimer')));
}

$('#new-plan').addEventListener('click', async () => {
  const data = G.emptyPlan();
  const r = await api('POST', '/api/plans', { name: 'Mon appartement', data, summary: { rooms: 0, area: 0 } });
  location.hash = `#/plan/${r.id}`;
});

$('#plans-menu').addEventListener('click', () => {
  openSheet(state.user?.username || 'Compte', h('div', { class: 'menu-list' }, installItem(), h('button', { class: 'danger', onclick: () => { closeSheets(); logout(); } }, h('span', { class: 'ico' }, '⏻'), 'Se déconnecter')));
});

// ───────────────────────── enregistrement automatique ─────────────────────────

let saveTimer = 0, saving = false, dirty = false;
const draftKey = () => `pa:${state.plan?.id}`;

function setSave(kind) {
  const el = $('#save-state');
  el.className = 'save-state' + (kind === 'saved' ? '' : kind === 'dirty' ? ' dirty' : ' err');
  el.title = { saved: 'Enregistré', dirty: 'Modifications en cours d’enregistrement…', err: 'Hors ligne — sera enregistré dès que possible' }[kind];
}

function backup() {
  try { localStorage.setItem(draftKey(), JSON.stringify({ data: editor.plan, name: state.plan.name, baseVersion: state.plan.version, ts: Date.now() })); } catch { /* quota */ }
}

function markDirty() {
  if (!state.plan) return;
  dirty = true; setSave('dirty'); backup();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 900);
}

async function save({ keepalive = false } = {}) {
  if (!state.plan || saving || !dirty) return;
  clearTimeout(saveTimer);
  saving = true; dirty = false;
  const id = state.plan.id;
  try {
    const r = await api('PUT', `/api/plans/${id}`, {
      name: state.plan.name, data: editor.plan, summary: G.planSummary(editor.plan), baseVersion: state.plan.version,
    }, { keepalive });
    if (state.plan?.id === id) state.plan.version = r.version;
    if (!dirty) { setSave('saved'); try { localStorage.removeItem(`pa:${id}`); } catch { /* ignore */ } }
  } catch (e) {
    dirty = true;
    if (e.status === 409) conflictSheet();
    else if (e.status !== 401) { setSave('err'); saveTimer = setTimeout(() => save(), 8000); }
  } finally {
    saving = false;
    if (dirty && !saveTimer) saveTimer = setTimeout(() => save(), 900);
  }
}

async function flushSave() {
  clearTimeout(saveTimer);
  for (let i = 0; i < 3 && dirty && state.plan; i++) { await save(); }
}

function conflictSheet() {
  clearTimeout(saveTimer);
  const id = state.plan.id;
  const sh = openSheet('Plan modifié ailleurs', h('div', {},
    h('p', {}, 'Ce plan a été enregistré depuis un autre appareil pendant que vous le modifiiez.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => {
        sh.close();
        try {
          const r = await api('PUT', `/api/plans/${id}`, { name: state.plan.name, data: editor.plan, summary: G.planSummary(editor.plan), force: true });
          state.plan.version = r.version; dirty = false; setSave('saved'); toast('Votre version a été enregistrée');
        } catch { toast('Échec de l’enregistrement'); }
      } }, 'Garder ma version'),
      h('button', { class: 'btn', onclick: async () => { sh.close(); dirty = false; try { localStorage.removeItem(`pa:${id}`); } catch { /* ignore */ } await openPlan(id); } }, 'Charger l’autre')),
  ));
}

window.addEventListener('online', () => { if (dirty) save(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) save({ keepalive: true }); });

// ───────────────────────── éditeur ─────────────────────────

const prefs = { wallFix: 'center', wallMode: 'stretch', chainDist: 'selected' };
let panelKey = '', panelSync = [];

function ensureEditor() {
  if (editor) return;
  editor = new Editor($('#cv'), {
    change: onChange, select: onSelect, draft: onDraft, meas: () => buildMeasBar(), tool: onTool, history: updateHistory, toast, live: onLive, blocked: onBlocked,
  });
  // la vue utile s'arrête au-dessus du panneau d'outils (barre de tracé, panneau de sélection…)
  const dock = $('#dock');
  const upd = () => {
    const boxes = [...dock.querySelectorAll('.dockbox')].filter((b) => !b.hidden);
    const hh = boxes.length ? dock.getBoundingClientRect().height - ($('#hint').hidden ? 0 : $('#hint').offsetHeight + 8) : 0;
    editor.setInset(hh);
  };
  new ResizeObserver(upd).observe(dock);
  for (const b of dock.querySelectorAll('.dockbox')) new MutationObserver(upd).observe(b, { attributes: true, attributeFilter: ['hidden'] });
}

async function openPlan(id) {
  closeSheets();
  let p;
  try { p = await api('GET', `/api/plans/${id}`); } catch (e) { if (e.status === 404) { toast('Plan introuvable'); location.hash = ''; } return; }
  show('editor');
  ensureEditor();
  state.plan = { id: p.id, name: p.name, version: p.version };
  let data = p.data;
  dirty = false;
  try {
    const raw = localStorage.getItem(`pa:${id}`);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.baseVersion === p.version) { data = d.data; dirty = true; toast('Modifications non enregistrées récupérées'); }
      else localStorage.removeItem(`pa:${id}`);
    }
  } catch { /* ignore */ }
  $('#plan-name').value = p.name;
  editor.resize();
  editor.setPlan(data);
  buildTools();
  editor.setTool('select');
  setSave(dirty ? 'dirty' : 'saved');
  if (dirty) saveTimer = setTimeout(() => save(), 900);
  $('#z-dims').classList.toggle('on', !!editor.plan.settings.dims);
  hint('Touchez un élément pour le modifier · 2 doigts pour déplacer et zoomer', 4500);
  if (!editor.plan.walls.length) hint('Plan vide : choisissez l’outil « Mur » pour commencer à tracer', 6000);
}

async function route() {
  if (!state.user) return showLogin();
  const m = location.hash.match(/^#\/plan\/([\w-]+)/);
  if (m) await openPlan(m[1]);
  else { await flushSave(); state.plan = null; editor?.setTool('select'); await showPlans(); }
}
window.addEventListener('hashchange', () => { if (state.user) route(); });

$('#btn-back').addEventListener('click', () => { location.hash = ''; });
$('#plan-name').addEventListener('change', (e) => {
  state.plan.name = e.target.value.trim() || 'Sans titre';
  e.target.value = state.plan.name;
  markDirty();
});
$('#plan-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('#btn-undo').addEventListener('click', () => editor.undo());
$('#btn-redo').addEventListener('click', () => editor.redo());
$('#z-in').addEventListener('click', () => editor.zoomAt({ x: editor.W / 2, y: editor.H / 2 }, 1.3));
$('#z-out').addEventListener('click', () => editor.zoomAt({ x: editor.W / 2, y: editor.H / 2 }, 1 / 1.3));
$('#z-fit').addEventListener('click', () => editor.fit());
$('#z-dims').addEventListener('click', (e) => {
  const on = !editor.plan.settings.dims;
  editor.setSetting('dims', on);
  e.currentTarget.classList.toggle('on', on);
});

function updateHistory() {
  $('#btn-undo').disabled = !editor?.canUndo;
  $('#btn-redo').disabled = !editor?.canRedo;
}

function onChange() {
  markDirty();
  updateHistory();
  refreshPanel();
}
function onLive() { if (panelSync.length) panelSync.forEach((f) => f()); }

let hintTimer = 0;
function hint(text, ms = 3800) {
  const el = $('#hint');
  clearTimeout(hintTimer);
  el.hidden = !text; el.textContent = text || '';
  if (text && ms) hintTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ───────────────────────── barre d'outils ─────────────────────────

const ICONS = {
  select: '<path d="M5 3l14 8-6 2-2 6z"/>',
  wall: '<path d="M4 20V5h16M4 20h6"/><path d="M4 5v0" stroke-width="4"/>',
  opening: '<path d="M5 21V4h11v17M3 21h18"/><circle cx="13" cy="13" r=".8" fill="currentColor"/>',
  furniture: '<path d="M4 11V8a2 2 0 012-2h12a2 2 0 012 2v3"/><path d="M3 13a2 2 0 014 0v2h10v-2a2 2 0 014 0v5H3z"/>',
  measure: '<path d="M3 16l13-13 5 5L8 21z"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2"/>',
  rooms: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 12h9M13 4v16"/>',
};
const svg = (n) => { const w = document.createElement('span'); w.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`; return w.firstChild; };

function buildTools() {
  const nav = $('#tools');
  nav.innerHTML = '';
  const defs = [
    ['select', 'Sélection', () => editor.setTool('select')],
    ['wall', 'Mur', () => editor.setTool('wall')],
    ['opening', 'Porte / fenêtre', () => editor.setTool('opening')],
    ['measure', 'Mesure', () => editor.setTool('measure')],
    ['furniture', 'Meuble', () => furnitureSheet()],
    ['rooms', 'Surfaces', () => roomsSheet()],
  ];
  for (const [id, label, fn] of defs) {
    nav.append(h('button', { 'data-tool': id, onclick: fn }, svg(id), label));
  }
}

function onTool(tool) {
  for (const b of $('#tools').children) b.classList.toggle('on', b.dataset.tool === tool);
  $('#draftbar').hidden = tool !== 'wall';
  $('#kindbar').hidden = tool !== 'opening';
  $('#measbar').hidden = tool !== 'measure';
  measKey = '';
  if (tool === 'measure') { buildMeasBar(); hint('Touchez le 1er point (mur, coin…), puis le 2e. Saisissez la cote pour ajuster.', 6000); }
  if (tool === 'wall') buildDraftBar();
  if (tool === 'opening') buildKindBar();
  if (tool === 'wall') hint('Touchez pour poser le 1er point · glissez pour ajuster avant de relâcher');
  else if (tool === 'opening') hint('Touchez un mur pour poser l’ouverture, puis réglez sa taille');
  else hint('');
}

// ───────────────────────── barre « mur » ─────────────────────────

let draftUi = null;
const DIRS = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

function buildDraftBar() {
  const bar = $('#draftbar');
  bar.innerHTML = '';
  const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Longueur : 345 ou 3,45 m', autocomplete: 'off', 'aria-label': 'Longueur du mur' });
  const dirBtn = (k, label) => h('button', { class: 'btn sm sq', 'aria-label': `Vers ${k}`, onclick: () => applyLen(DIRS[k]) }, label);
  const applyLen = (dir) => {
    const v = G.parseLen(input.value);
    if (!editor.draft?.last) return toast('Posez d’abord le premier point');
    if (!Number.isFinite(v) || v < 1) { if (dir) editor.draft.lastDir = dir; return toast('Saisissez d’abord une longueur'); }
    editor.drawLength(v, dir);
    input.value = ''; input.focus();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyLen(null); });
  const thick = h('select', { 'aria-label': 'Épaisseur des murs', class: 'thick' },
    [7, 10, 15, 20, 30].map((t) => h('option', { value: t, selected: editor.plan.settings.wallT === t }, `Ép. ${t} cm`)));
  thick.addEventListener('change', () => editor.setSetting('wallT', Number(thick.value)));
  const finish = h('button', { class: 'btn sm primary', onclick: () => editor.finishDraft() }, 'Terminer');
  const ok = h('button', { class: 'btn sm', onclick: () => applyLen(null) }, 'OK');
  const arrows = h('div', { class: 'row tight' }, dirBtn('left', '←'), dirBtn('up', '↑'), dirBtn('down', '↓'), dirBtn('right', '→'), thick, finish);
  bar.append(h('div', { class: 'row tight' }, input, ok), arrows);
  draftUi = { input, finish, arrows, ok };
  onDraft(editor.draft);
}

function onDraft(d) {
  if (!draftUi) return;
  const active = !!d?.last;
  draftUi.input.disabled = !active;
  draftUi.finish.disabled = !active;
  draftUi.ok.disabled = !active;
  for (const b of draftUi.arrows.querySelectorAll('.sq')) b.disabled = !active;
  if (editor.tool === 'wall') hint(active ? 'Touchez le point suivant — ou saisissez une longueur puis un sens (←↑↓→)' : 'Touchez pour poser le 1er point · glissez pour ajuster avant de relâcher');
}

// ───────────────────────── barre « ouverture » ─────────────────────────

const measPrefs = { move: 'both' };
let measKey = '';
function buildMeasBar() {
  const bar = $('#measbar');
  if (editor?.tool !== 'measure') return;
  const info = editor.measInfo();
  const key = info ? `${editor.meas.A.x},${editor.meas.A.y},${editor.meas.B.x},${editor.meas.B.y}:${info.locked}:${info.lockable}` : 'none';
  if (key === measKey) return;
  measKey = key;
  bar.innerHTML = '';
  if (!info) {
    bar.append(h('p', { class: 'note' }, editor.meas?.A ? 'Touchez le 2e point.' : 'Touchez le 1er point : face de mur, coin ou axe.'));
    return;
  }
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Cote' });
  input.value = G.fmtCm(info.len);
  input.addEventListener('focus', () => setTimeout(() => input.select(), 0));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('change', () => {
    const v = G.parseLen(input.value);
    if (Number.isFinite(v) && v >= 1) { if (!editor.applyMeasure(v, measPrefs.move)) input.value = G.fmtCm(info.len); } else input.value = G.fmtCm(info.len);
  });
  bar.append(
    h('div', { class: 'row tight' }, h('label', {}, 'Cote (cm)', input),
      h('button', { class: 'chip' + (info.locked ? ' on' : ''), onclick: () => editor.toggleMeasureLock() }, info.locked ? '🔒 Verrouillée' : info.lockable ? '🔓 Verrouiller' : '🔓 Libre'),
      h('button', { class: 'chip', onclick: () => editor.resetMeasure() }, 'Nouvelle'),
      h('button', { class: 'chip', title: 'Retirer cette mesure du plan', onclick: () => editor.removeActiveMeasure() }, '🗑')),
    h('div', { class: 'row tight' }, h('span', { class: 'lbl' }, 'Déplacer :'), seg([['both', 'Des 2 côtés'], ['b', 'Côté 2e point'], ['a', 'Côté 1er point']], () => measPrefs.move, (v) => { measPrefs.move = v; })),
    info.lockable ? null : h('p', { class: 'note' }, 'Points libres : la cote règle la distance mais ne peut pas être verrouillée.'),
  );
}

function buildKindBar() {
  const bar = $('#kindbar');
  bar.innerHTML = '';
  const chips = h('div', { class: 'chips' });
  const render = () => {
    chips.innerHTML = '';
    for (const [k, d] of Object.entries(G.OPENING_KINDS)) chips.append(h('button', { class: 'chip' + (editor.openingKind === k ? ' on' : ''), onclick: () => { editor.setOpeningKind(k); render(); } }, d.label));
  };
  render();
  bar.append(chips);
}

// ───────────────────────── panneau de sélection ─────────────────────────

function onSelect(sel) {
  refreshPanel(true);
  if (sel) requestAnimationFrame(ensureVisible);
}

function ensureVisible() {
  const s = editor.sel, o = editor.selected;
  if (!s || !o) return;
  let c;
  if (s.type === 'wall') { const a = editor.plan.nodes[o.a], b = editor.plan.nodes[o.b]; c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  else if (s.type === 'opening') { const g = G.openingGeom(editor.plan, o); c = g?.c; }
  else if (s.type === 'room') c = o.center;
  else if (s.type === 'measure') return;
  else c = { x: o.x, y: o.y };
  if (c) editor.ensureVisible(c, 70);
}

function refreshPanel(force = false) {
  const panel = $('#panel');
  const sel = editor?.sel;
  const o = editor?.selected;
  if (!sel || !o || editor.tool === 'wall') { panel.hidden = true; panel.innerHTML = ''; panelKey = ''; panelSync = []; return; }
  const key = sel.type + ':' + sel.id + (sel.type === 'opening' ? ':' + o.kind : '') + (sel.type === 'measure' ? ':' + (editor.plan.locks || []).some((l) => l.measure === sel.id) : '')
    + (sel.type === 'wall' ? ':' + (editor.measure()?.count || 1) + ':' + editor.dimRef + ':' + (editor.measure()?.canSwitch ? 1 : 0) + ':' + (editor.measure()?.locked ? 1 : 0) + (editor.measure()?.chainLocked ? 1 : 0) + (sel.chain ? ':c' : '') : '');
  if (force || key !== panelKey) {
    panelKey = key; panelSync = [];
    panel.innerHTML = '';
    panel.append(buildPanel(sel.type));
    panel.hidden = false;
  }
  panelSync.forEach((f) => f());
}

function field(label, get, apply, { unit = 'cm', min = 1, parse = G.parseLen, fmt = G.fmtCm } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': label });
  input.addEventListener('focus', () => setTimeout(() => input.select(), 0));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('change', () => {
    const v = parse(input.value);
    if (Number.isFinite(v) && v >= min) apply(v); else input.value = fmt(get());
  });
  const sync = () => { if (document.activeElement !== input) input.value = fmt(get()); };
  panelSync.push(sync); sync();
  return h('label', {}, `${label}${unit ? ` (${unit})` : ''}`, input);
}

const panelHead = (title, extra, deletable = true) => h('div', { class: 'panel-head' }, h('b', {}, title), extra || null,
  deletable ? h('button', { class: 'trash', 'aria-label': 'Supprimer', title: 'Supprimer', onclick: () => editor.deleteSelection() }, '🗑') : null,
  h('button', { class: 'x' + (deletable ? '' : ' first'), 'aria-label': 'Fermer', onclick: () => editor.select(null) }, '✕'));
const seg = (opts, get, set) => {
  const box = h('div', { class: 'seg' });
  const render = () => { box.innerHTML = ''; for (const [v, l] of opts) box.append(h('button', { class: get() === v ? 'on' : '', onclick: () => { set(v); render(); } }, l)); };
  render();
  return box;
};
const textBind = (get) => { const n = document.createTextNode(''); const sync = () => { n.nodeValue = get(); }; panelSync.push(sync); sync(); return n; };

function buildPanel(type) {
  if (type === 'wall') return wallPanel();
  if (type === 'opening') return openingPanel();
  if (type === 'furniture') return furniturePanel();
  if (type === 'measure') return measurePanel();
  return roomPanel();
}

function sideLabels(w) {
  const a = editor.plan.nodes[w.a], b = editor.plan.nodes[w.b];
  const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const firstIsA = horiz ? a.x <= b.x : a.y <= b.y;
  return { horiz, firstIsA };
}

const REFS = [['inner', 'Intérieur'], ['outer', 'Extérieur'], ['axis', 'Axe']];
function setDimRef(v) {
  editor.setSetting('dimRef', v);
  markDirty();
  refreshPanel(true);
}

const sel0 = () => editor.sel || {};
function wallPanel() {
  const cur = () => editor.selected;
  const m = () => editor.measure();
  const labels = () => (sideLabels(cur()).horiz ? ['Côté gauche', 'Côté droit'] : ['Côté haut', 'Côté bas']);
  const apply = (v) => {
    const w = cur(); const { firstIsA } = sideLabels(w);
    const keepFirst = prefs.wallFix === 'first';
    const fixed = prefs.wallFix === 'center' ? 'center' : keepFirst === firstIsA ? 'a' : 'b';
    editor.applyWallLength(v, { fixed, mode: prefs.wallMode });
  };
  const applyChain = (v) => editor.applyChainLength(v, { fixed: prefs.wallFix, distribute: prefs.chainDist, mode: prefs.wallMode });
  const fixSeg = h('span');
  const renderFix = () => { fixSeg.innerHTML = ''; const [l1, l2] = labels(); fixSeg.append(seg([['center', 'Des 2 côtés'], ['first', l1 + ' fixe'], ['second', l2 + ' fixe']], () => prefs.wallFix, (v) => { prefs.wallFix = v; })); };
  renderFix();
  panelSync.push(renderFix);
  const thick = h('div', { class: 'chips' });
  const renderThick = () => { thick.innerHTML = ''; for (const t of [7, 10, 15, 20, 30]) thick.append(h('button', { class: 'chip' + (cur().t === t ? ' on' : ''), onclick: () => editor.setWallThickness(t) }, String(t))); };
  renderThick(); panelSync.push(renderThick);
  const multi = (m()?.count || 1) > 1;
  const refSeg = seg(REFS, () => editor.dimRef, setDimRef);
  refSeg.classList.add('sm');
  const face = textBind(() => { const q = m(); return q ? (q.mode === 'axis' ? 'à l’axe' : q.entry ? `côté ${q.faceName}` : 'à l’axe') : ''; });
  const switchBtn = m()?.canSwitch
    ? h('button', { class: 'chip', title: 'Mesurer l’autre côté du mur', 'aria-label': 'Autre côté', onclick: () => { editor.switchSide(); refreshPanel(true); } }, '⇄') : null;
  const distSeg = multi ? h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Mur entier :'),
    seg([['selected', 'Ce segment'], ['last', 'Au bout'], ['prop', 'Réparti']], () => prefs.chainDist, (v) => { prefs.chainDist = v; })) : null;
  const segList = multi ? h('p', { class: 'note' }, textBind(() => {
    const q = m(); return q ? 'Segments : ' + q.segs.map((x, i) => (i === q.index ? '[' + G.fmtCm(x) + ']' : G.fmtCm(x))).join(' + ') + ' cm' : '';
  })) : null;
  const lockBtn = (on, onClick, title) => h('button', { class: 'chip icon' + (on ? ' on' : ''), title, 'aria-label': title, onclick: onClick }, on ? '🔒' : '🔓');
  const more = h('details', { class: 'more' }, h('summary', {}, 'Options'),
    distSeg,
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Ajuster :'), fixSeg),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Correction :'), seg([['stretch', 'Étirer la pièce'], ['point', 'Ce point seul']], () => prefs.wallMode, (v) => { prefs.wallMode = v; })),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Épaisseur (cm) :'), thick),
    h('p', { class: 'note' }, textBind(() => `Mesure ${face.nodeValue}. Une cote saisie est verrouillée automatiquement. Étirer garde les angles droits. Surfaces calculées à l’intérieur.`)),
  );
  return h('div', {},
    panelHead('Mur', h('span', { class: 'muted' }, textBind(() => (m() ? G.fmtLen(m().len) : ''))), true),
    h('div', { class: 'row tight' }, refSeg, switchBtn),
    h('div', { class: 'row tight end' },
      field(multi ? 'Ce segment' : 'Longueur', () => m().len, apply, { min: 5 }),
      lockBtn(m()?.locked, () => { editor.toggleLock('wall', m().len); refreshPanel(true); }, 'Verrouiller le segment'),
      multi ? field('Mur entier', () => m().total, applyChain, { min: 5 }) : null,
      multi ? lockBtn(m()?.chainLocked, () => { editor.toggleLock('chain', m().total); refreshPanel(true); }, 'Verrouiller le mur entier') : null),
    segList,
    multi ? h('div', { class: 'row' }, h('button', { class: 'chip' + (sel0().chain ? ' on' : ''), onclick: () => { editor.toggleChainSelection(); refreshPanel(true); } }, sel0().chain ? '✓ Mur entier sélectionné (glissez-le)' : '↔ Sélectionner le mur entier')) : null,
    more,
  );
}

function openingPanel() {
  const cur = () => editor.selected;
  const isDoor = () => ['door', 'double'].includes(cur().kind);
  const kinds = h('div', { class: 'chips' });
  for (const [k, d] of Object.entries(G.OPENING_KINDS)) kinds.append(h('button', { class: 'chip' + (cur().kind === k ? ' on' : ''), onclick: () => editor.updateOpening({ kind: k }) }, d.label));
  const showSill = cur().kind === 'window' || cur().kind === 'bay';
  return h('div', {},
    panelHead(G.OPENING_KINDS[cur().kind].label),
    kinds,
    h('div', { class: 'row' },
      field('Largeur', () => cur().w, (v) => editor.updateOpening({ w: v }), { min: 10 }),
      field('Hauteur', () => cur().h, (v) => editor.updateOpening({ h: v }), { min: 10 }),
      showSill ? field('Allège', () => cur().sill, (v) => editor.updateOpening({ sill: v }), { min: 0 }) : null),
    h('div', { class: 'row' },
      isDoor() && cur().kind === 'door' ? h('button', { class: 'btn sm', onclick: () => editor.updateOpening({ flip: !cur().flip }) }, '↔ Charnière') : null,
      isDoor() ? h('button', { class: 'btn sm', onclick: () => editor.updateOpening({ side: -(cur().side || 1) }) }, '⇅ Sens d’ouverture') : null,
    ),
    h('p', { class: 'note' }, 'Glissez l’ouverture le long du mur (ou vers un autre mur) pour la déplacer.'),
  );
}

function measurePanel() {
  const isLk = () => (editor.plan.locks || []).some((l) => l.kind === 'measure' && l.measure === editor.sel?.id);
  const len = () => { const d = G.measureDim(editor.plan, editor.selected, 1); return d ? d.len : 0; };
  return h('div', {},
    panelHead('Mesure', h('span', { class: 'muted' }, textBind(() => G.fmtLen(len())))),
    h('div', { class: 'row' }, field('Cote', len, (v) => editor.applySelectedMeasure(v, measPrefs.move), { min: 1 })),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Déplacer :'), seg([['both', 'Des 2 côtés'], ['b', 'Côté 2e point'], ['a', 'Côté 1er point']], () => measPrefs.move, (v) => { measPrefs.move = v; })),
    h('div', { class: 'row' }, h('button', { class: 'chip' + (isLk() ? ' on' : ''), onclick: () => { editor.toggleSelectedMeasureLock(); refreshPanel(true); } }, isLk() ? '🔒 Verrouillée' : '🔓 Verrouiller')),
    h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => { editor.resetMeasurePlacement(); } }, '↺ Position automatique')),
    h('p', { class: 'note' }, 'Glissez le chiffre ou la ligne pour déplacer la cote. Mesure conservée et verrouillée : elle suit les murs, et une modification qui la ferait changer est refusée. Tapez une nouvelle cote pour la corriger (le verrou est mis à jour) ; 🗑 la supprime.'));
}

function furniturePanel() {
  const cur = () => editor.selected;
  const name = h('input', { type: 'text', 'aria-label': 'Nom', maxlength: 40, placeholder: 'Nom du meuble' });
  name.addEventListener('change', () => editor.updateFurniture({ name: name.value.trim() }));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  panelSync.push(() => { if (document.activeElement !== name) name.value = cur().name || ''; });
  const rot = (d) => editor.updateFurniture({ rot: cur().rot + d });
  return h('div', {},
    panelHead('Meuble'),
    h('div', { class: 'row' }, name),
    h('div', { class: 'row' },
      field('Largeur', () => cur().w, (v) => editor.updateFurniture({ w: v }), { min: 5 }),
      field('Profondeur', () => cur().d, (v) => editor.updateFurniture({ d: v }), { min: 5 }),
      field('Rotation', () => cur().rot, (v) => editor.updateFurniture({ rot: v }), { unit: '°', min: -1000, parse: (s) => parseFloat(String(s).replace(',', '.')), fmt: (v) => String(Math.round(v * 10) / 10) })),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: () => rot(-90) }, '⟲ 90°'),
      h('button', { class: 'btn sm', onclick: () => rot(90) }, '⟳ 90°'),
      h('button', { class: 'btn sm', onclick: () => editor.duplicateSelection() }, 'Dupliquer')),
    h('p', { class: 'note' }, 'Glissez pour déplacer, utilisez la poignée ronde pour pivoter.'),
  );
}

const ROOM_NAMES = ['Salon', 'Séjour', 'Cuisine', 'Chambre', 'Salle de bain', 'WC', 'Entrée', 'Couloir', 'Bureau', 'Cellier', 'Balcon', 'Dressing'];

function roomPanel() {
  const cur = () => editor.selected;
  const name = h('input', { type: 'text', maxlength: 40, placeholder: 'Nom de la pièce', 'aria-label': 'Nom de la pièce' });
  name.addEventListener('change', () => editor.setRoom({ name: name.value.trim() }));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  panelSync.push(() => { if (document.activeElement !== name) name.value = cur().name || ''; });
  const chips = h('div', { class: 'chips' }, ROOM_NAMES.map((n) => h('button', { class: 'chip', onclick: () => { name.value = n; editor.setRoom({ name: n }); } }, n)));
  const sw = h('div', { class: 'swatches' });
  const renderSw = () => { sw.innerHTML = ''; for (const c of [null, ...ROOM_COLORS]) sw.append(h('button', { class: 'swatch' + ((cur().color || null) === c ? ' on' : ''), style: `background:${c || '#f4f7fb'}`, 'aria-label': 'Couleur', onclick: () => editor.setRoom({ color: c }) })); };
  renderSw(); panelSync.push(renderSw);
  const sides = h('span');
  panelSync.push(() => { sides.textContent = cur().sides.map((s) => G.fmtLen(s.len)).join(' · '); });
  return h('div', {},
    panelHead('Pièce', null, false),
    h('div', { class: 'row' }, name),
    chips,
    h('div', { class: 'kv', style: 'margin-top:10px' },
      h('span', {}, 'Surface (intérieur des murs)'), h('b', {}, textBind(() => G.fmtArea(cur().area))),
      h('span', {}, 'Surface à l’axe des murs'), h('b', {}, textBind(() => G.fmtArea(cur().axisArea))),
      h('span', {}, 'Périmètre intérieur'), h('b', {}, textBind(() => G.fmtLen(cur().perimeter)))),
    h('p', { class: 'note' }, 'Côtés intérieurs : ', sides),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Couleur :'), sw),
  );
}

// ───────────────────────── feuilles : meubles, surfaces, menu ─────────────────────────

function furnitureSheet() {
  const sh = openSheet('Ajouter un meuble', (() => {
    const nm = h('input', { type: 'text', placeholder: 'Nom (ex. Étagère)', maxlength: 40 });
    const wi = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Largeur cm' });
    const de = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Profondeur cm' });
    const add = h('button', { class: 'btn primary', onclick: () => {
      const w = G.parseLen(wi.value), d = G.parseLen(de.value);
      if (!(w >= 5 && d >= 5)) return toast('Indiquez largeur et profondeur');
      sh.close(); editor.addFurniture({ kind: 'rect', name: nm.value.trim(), w, d });
    } }, 'Ajouter');
    const wrap = h('div', {},
      h('p', { class: 'cat-title' }, 'Dimensions personnalisées'),
      h('div', { class: 'row' }, nm), h('div', { class: 'row' }, wi, de, add));
    const cats = [...new Set(G.FURNITURE.map((f) => f.cat))];
    for (const c of cats) {
      wrap.append(h('p', { class: 'cat-title' }, c), h('div', { class: 'catalog' },
        G.FURNITURE.filter((f) => f.cat === c).map((f) => h('button', { onclick: () => { sh.close(); editor.addFurniture(f); } }, h('b', {}, f.name), h('small', {}, `${f.w} × ${f.d}`)))));
    }
    return wrap;
  })());
}

function roomsSheet() {
  const rooms = editor.rooms;
  const total = rooms.reduce((s, r) => s + r.area, 0);
  const body = h('div', {});
  if (!rooms.length) body.append(h('p', { class: 'muted' }, 'Aucune pièce fermée pour l’instant. Tracez des murs qui se referment pour obtenir les surfaces.'));
  else {
    const t = h('table', { class: 'rooms-table' });
    for (const r of rooms) {
      t.append(h('tr', { 'data-id': r.id, onclick: () => { sh.close(); editor.setTool('select'); editor.select({ type: 'room', id: r.id }); const xs = r.axis.map((p) => p.x), ys = r.axis.map((p) => p.y); editor.focusOn({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }); requestAnimationFrame(ensureVisible); } },
        h('td', {}, h('span', { class: 'dot', style: `background:${r.color || '#f4f7fb'}` }), r.name || h('span', { class: 'muted' }, 'Pièce sans nom')),
        h('td', {}, G.fmtArea(r.area))));
    }
    t.append(h('tr', { class: 'total' }, h('td', {}, 'Total'), h('td', {}, G.fmtArea(total))));
    body.append(t, h('p', { class: 'note' }, 'Surfaces mesurées à l’intérieur des murs (épaisseur déduite). Touchez une ligne pour afficher la pièce.'),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async () => {
        const txt = rooms.map((r) => `${r.name || 'Pièce'} : ${G.fmtArea(r.area)}`).concat(`Total : ${G.fmtArea(total)}`).join('\n');
        try { await navigator.clipboard.writeText(txt); toast('Copié'); } catch { toast('Copie impossible'); }
      } }, 'Copier la liste')));
  }
  const sh = openSheet('Surfaces par pièce', body);
}

function installItem() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return null;
  if (deferredInstall) return h('button', { onclick: async () => { closeSheets(); deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; } }, h('span', { class: 'ico' }, '📲'), 'Installer l’application');
  if (ios) return h('div', { class: 'item muted' }, h('span', { class: 'ico' }, '📲'), 'Partager → « Sur l’écran d’accueil »');
  return null;
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

async function exportImage() {
  const c = editor.exportCanvas(state.plan.name);
  if (!c) return toast('Le plan est vide');
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const fname = `${state.plan.name.replace(/[^\w\-]+/g, '_') || 'plan'}.png`;
  const file = new File([blob], fname, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: state.plan.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = h('a', { href: URL.createObjectURL(blob), download: fname });
  document.body.append(a); a.click(); a.remove();
}

// Une modification est bloquée par une cote verrouillée : proposer de la déverrouiller
function onBlocked({ lock, label, retry }) {
  if (!retry) { toast(`🔒 ${label} verrouillée : déverrouillez-la d’abord`); return; }
  const sh = openSheet('Cote verrouillée', h('div', {},
    h('p', {}, `Cette modification changerait la cote verrouillée « ${label} ».`),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { sh.close(); editor.removeLockById(lock.id); markDirty(); retry(); refreshPanel(true); } }, '🔓 Déverrouiller et appliquer'),
      h('button', { class: 'btn', onclick: () => { sh.close(); refreshPanel(true); } }, 'Annuler'))));
}

function locksSheet() {
  const body = h('div', {});
  const sh = openSheet('Cotes verrouillées', body);
  const render = () => {
    body.innerHTML = '';
    const list = editor.lockList();
    body.append(
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Afficher :'),
        seg([['all', 'Toutes les cotes'], ['locked', 'Verrouillées seulement']], () => (editor.plan.settings.dimsShow === 'locked' ? 'locked' : 'all'), (v) => { editor.setSetting('dimsShow', v); markDirty(); })),
    );
    if (!list.length) { body.append(h('p', { class: 'note' }, 'Aucune cote verrouillée. Une cote saisie ou une mesure posée est verrouillée automatiquement.')); return; }
    const box = h('div', { class: 'lock-list' });
    for (const it of list) {
      box.append(h('div', { class: 'lock-item' },
        h('button', { class: 'lock-main', onclick: () => { sh.close(); editor.focusOn(it.target, it.at); } },
          h('b', {}, `🔒 ${G.fmtLen(it.len)}`), h('span', { class: 'muted' }, ` ${it.label}${it.ref ? ' · ' + it.ref : ''}`)),
        h('button', { class: 'chip icon', title: 'Déverrouiller', 'aria-label': 'Déverrouiller', onclick: () => { editor.removeLockById(it.id); markDirty(); render(); } }, '🔓')));
    }
    body.append(box,
      h('button', { class: 'btn danger-soft', onclick: () => { if (!confirm(`Déverrouiller les ${list.length} cotes ?`)) return; editor.unlockAll(); markDirty(); toast('Toutes les cotes sont déverrouillées'); render(); } }, `🔓 Tout déverrouiller (${list.length})`));
  };
  render();
}

function settingsSheet() {
  const s = editor.plan.settings;
  const grid = h('div', { class: 'chips' });
  const rg = () => { grid.innerHTML = ''; for (const g of [5, 10, 25, 50]) grid.append(h('button', { class: 'chip' + (s.grid === g ? ' on' : ''), onclick: () => { editor.setSetting('grid', g); markDirty(); rg(); } }, `${g} cm`)); };
  rg();
  const dims = seg([[true, 'Affichées'], [false, 'Masquées']], () => !!s.dims, (v) => { editor.setSetting('dims', v); $('#z-dims').classList.toggle('on', v); markDirty(); });
  openSheet('Réglages du plan', h('div', {},
    h('p', { class: 'cat-title' }, 'Pas d’accrochage des points'), grid,
    h('p', { class: 'cat-title' }, 'Cotes sur les murs'), dims,
    h('p', { class: 'cat-title' }, 'Cotes prises à…'), seg(REFS, () => editor.dimRef, (v) => { editor.setSetting('dimRef', v); markDirty(); }),
    h('p', { class: 'note' }, 'L’épaisseur des nouveaux murs se règle dans l’outil « Mur ».')));
}

$('#btn-menu').addEventListener('click', () => {
  const sh = openSheet('Menu', h('div', { class: 'menu-list' },
    h('button', { onclick: () => { sh.close(); roomsSheet(); } }, h('span', { class: 'ico' }, '▦'), 'Surfaces par pièce'),
    h('button', { onclick: () => { sh.close(); exportImage(); } }, h('span', { class: 'ico' }, '🖼'), 'Exporter en image (PNG)'),
    h('button', { onclick: () => { sh.close(); locksSheet(); } }, h('span', { class: 'ico' }, '🔒'), `Cotes verrouillées (${(editor.plan.locks || []).length})`),
    h('button', { onclick: () => { sh.close(); editor.cleanPlan(); markDirty(); } }, h('span', { class: 'ico' }, '✨'), 'Redresser et nettoyer le plan'),
    h('button', { onclick: () => { sh.close(); settingsSheet(); } }, h('span', { class: 'ico' }, '⚙'), 'Réglages du plan'),
    h('button', { onclick: async () => { sh.close(); await flushSave(); const r = await api('POST', `/api/plans/${state.plan.id}/duplicate`); toast('Copie créée — ouverte'); location.hash = `#/plan/${r.id}`; } }, h('span', { class: 'ico' }, '⎘'), 'Dupliquer ce plan'),
    installItem(),
    h('p', { class: 'note ver-note' }, textBind(() => `Version ${VERSION}${serverVersion && serverVersion !== VERSION ? ` — serveur ${serverVersion} : rechargez (Ctrl+F5)` : ''}`)),
    h('hr'),
    h('button', { class: 'danger', onclick: async () => { if (!confirm(`Supprimer « ${state.plan.name} » définitivement ?`)) return; sh.close(); dirty = false; const id = state.plan.id; await api('DELETE', `/api/plans/${id}`); try { localStorage.removeItem(`pa:${id}`); } catch { /* ignore */ } location.hash = ''; } }, h('span', { class: 'ico' }, '🗑'), 'Supprimer ce plan'),
    h('button', { class: 'danger', onclick: () => { sh.close(); logout(); } }, h('span', { class: 'ico' }, '⏻'), 'Se déconnecter')));
});

// ───────────────────────── version ─────────────────────────
let serverVersion = '';
$('#ver').textContent = 'v' + VERSION;
fetch('/api/version').then((r) => r.json()).then((j) => {
  serverVersion = j.version || '';
  if (serverVersion && serverVersion !== VERSION) $('#ver').textContent = `v${VERSION} → v${serverVersion} dispo`;
}).catch(() => {});

// ───────────────────────── démarrage ─────────────────────────

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async function init() {
  try {
    state.session = await api('GET', '/api/session');
    state.user = state.session.user;
  } catch {
    state.session = { user: null, setup: false, registration: false };
    toast('Serveur injoignable');
  }
  route();
})();

// pour les tests automatisés
if (location.search.includes('e2e')) window.__app = { get editor() { return editor; }, state, G };
