// Test de bout en bout dans un vrai navigateur (Chrome) avec émulation mobile.
// Usage : node scripts/e2e.mjs   (nécessite playwright et Chrome)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');

const PORT = 4100 + Math.floor(Math.random() * 100);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-'));
const shots = process.env.SHOTS || '/tmp/shots';
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { srv.stdout.on('data', (d) => String(d).includes('prêt') && res()); setTimeout(() => rej(new Error('démarrage')), 8000); });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) failed++; };
const ev = (fn, arg) => page.evaluate(fn, arg);
const canvasBox = async () => (await page.locator('#cv').boundingBox());
// recadre la vue sur une zone fixe (au-dessus du panneau d'outils) pour des clics reproductibles
async function refit() {
  await page.waitForTimeout(250);
  await ev(() => window.__app.editor.fit({ x0: -60, y0: -60, x1: 620, y1: 480 }));
}
async function tapPlan(x, y) {
  const sp = await ev(([x, y]) => window.__app.editor.toScreen({ x, y }), [x, y]);
  const b = await canvasBox();
  await page.mouse.move(b.x + sp.x, b.y + sp.y);
  await page.mouse.down();
  await page.mouse.up();
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/?e2e`);
  console.log('Connexion / premier compte');
  await page.waitForSelector('#login-form', { state: 'visible' });
  ok((await page.textContent('#login-submit')).includes('Créer'), 'premier lancement : création du compte proposée');
  await page.fill('#login-user', 'laury');
  await page.fill('#login-pass', 'un-mot-de-passe-solide');
  await page.click('#login-submit');
  await page.waitForSelector('#plans:not([hidden])');
  ok(true, 'compte créé, liste des plans affichée');
  await page.screenshot({ path: `${shots}/1-liste.png` });

  console.log('Nouveau plan');
  await page.click('#new-plan');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForFunction(() => window.__app?.editor?.W > 100);

  console.log('Tracé des murs');
  await page.click('[data-tool=wall]');
  await refit();
  for (const [x, y] of [[0, 0], [500, 0], [500, 400], [0, 400], [0, 0]]) await tapPlan(x, y);
  let r = await ev(() => window.__app.editor.rooms.map((r) => Math.round(r.area)));
  ok(r.length === 1, `une pièce détectée après fermeture du rectangle (${r.length})`);
  ok(Math.abs(r[0] - 490 * 390) < 5, `surface intérieure = (500-10)×(400-10) cm² (${r[0]})`);
  await page.click('[data-tool=wall]'); // ré-armer l'outil
  await refit();
  await tapPlan(250, 0);
  await page.screenshot({ path: `${shots}/1b-trace.png` });
  await tapPlan(250, 400);
  await page.click('#draftbar .btn.primary'); // Terminer
  r = await ev(() => window.__app.editor.rooms.length);
  ok(r === 2, `la cloison crée une 2e pièce (${r})`);

  console.log('Saisie d’une longueur au clavier');
  await ev(() => window.__app.editor.setTool('wall'));
  await refit();
  await tapPlan(100, 100);
  await page.fill('#draftbar input', '2,5 m');
  await page.click('#draftbar [aria-label="Vers right"]');
  // la cloison à x=250 coupe le nouveau mur en deux : on additionne les morceaux situés à y=100
  const w = await ev(() => { const p = window.__app.editor.plan; return Math.round(p.walls.filter((q) => p.nodes[q.a].y === 100 && p.nodes[q.b].y === 100).reduce((s, q) => s + Math.hypot(p.nodes[q.a].x - p.nodes[q.b].x, p.nodes[q.a].y - p.nodes[q.b].y), 0)); });
  ok(w === 260, `mur de 2,5 m (cote intérieure, axe 2,6 m) créé par saisie, découpé par la cloison (${w} cm)`);
  await page.click('#draftbar .btn.primary');
  await ev(() => window.__app.editor.undo()); // retire ce mur de test
  await ev(() => window.__app.editor.setTool('select'));

  console.log('Portes et fenêtres');
  await page.click('[data-tool=opening]');
  await refit();
  await tapPlan(120, 0);
  await page.waitForSelector('#panel:not([hidden])');
  ok((await page.textContent('#panel')).includes('Porte'), 'une porte est posée et son panneau s’ouvre');
  await page.fill('#panel label:has-text("Largeur") input', '93');
  await page.press('#panel label:has-text("Largeur") input', 'Enter');
  let ow = await ev(() => window.__app.editor.plan.openings[0].w);
  ok(ow === 93, `largeur de porte personnalisée (${ow})`);
  await page.click('#kindbar .chip:has-text("Fenêtre")');
  await refit();
  await tapPlan(400, 0);
  await page.fill('#panel label:has-text("Largeur") input', '135');
  await page.press('#panel label:has-text("Largeur") input', 'Enter');
  const kinds = await ev(() => window.__app.editor.plan.openings.map((o) => o.kind + ':' + o.w));
  ok(kinds.join() === 'door:93,window:135', `porte + fenêtre (${kinds})`);

  console.log('Corriger une mesure');
  await page.click('[data-tool=select]');
  await refit();
  await tapPlan(400, 400); // mur du bas, partie droite
  await page.waitForSelector('#panel:not([hidden])');
  ok((await page.textContent('#panel')).startsWith('Mur'), 'toucher un mur ouvre son panneau');
  const before = await ev(() => window.__app.editor.rooms.map((r) => Math.round(r.axisArea)).sort((a, b) => a - b));
  await page.fill('#panel label:has-text("Ce segment") input', '300');
  await page.press('#panel label:has-text("Ce segment") input', 'Enter');
  const after = await ev(() => window.__app.editor.rooms.map((r) => Math.round(r.axisArea)).sort((a, b) => a - b));
  ok(JSON.stringify(before) !== JSON.stringify(after), `les surfaces suivent la correction (${before} → ${after})`);
  await page.screenshot({ path: `${shots}/2-mur.png` });

  console.log('Cotes verrouillées & outil Mesure');
  const locks0 = await ev(() => window.__app.editor.plan.locks.length);
  ok(locks0 >= 1, `la cote saisie est verrouillée par défaut (${locks0})`);
  await page.click('[data-tool=measure]');
  await refit();
  const bb = await ev(() => { const ns = Object.values(window.__app.editor.plan.nodes); return { x0: Math.min(...ns.map((n) => n.x)), y0: Math.min(...ns.map((n) => n.y)), y1: Math.max(...ns.map((n) => n.y)) }; });
  await tapPlan(bb.x0 + 60, bb.y0 + 5);
  await tapPlan(bb.x0 + 60, bb.y1 - 5);
  await page.waitForSelector('#measbar input');
  const mv = Number((await page.inputValue('#measbar input')).replace(',', '.'));
  ok(Math.abs(mv - (bb.y1 - bb.y0 - 10)) < 1, `mesure intérieure entre les deux murs (${mv} cm)`);
  await page.fill('#measbar input', String(mv - 50));
  await page.press('#measbar input', 'Enter');
  const bb2 = await ev(() => { const ns = Object.values(window.__app.editor.plan.nodes); return { h: Math.max(...ns.map((n) => n.y)) - Math.min(...ns.map((n) => n.y)), locks: window.__app.editor.plan.locks.filter((l) => l.kind === 'measure').length }; });
  ok(Math.abs(bb2.h - (bb.y1 - bb.y0 - 50)) < 1, `la cote saisie décale le mur du fond (${bb2.h})`);
  ok(bb2.locks === 1, 'la mesure saisie est verrouillée');
  const edited = await ev(() => {
    const e = window.__app.editor; e.setTool('select');
    const m = e.plan.measures.at(-1); e.select({ type: 'measure', id: m.id });
    const d0 = window.__app.G.measureDim(e.plan, m, 1).len;
    const r = e.applySelectedMeasure(d0 - 20, 'b');
    return { r, d0, d1: window.__app.G.measureDim(e.plan, m, 1).len };
  });
  ok(edited.r && Math.abs(edited.d1 - (edited.d0 - 20)) < 0.5, `mesure conservée modifiable (${edited.d0} → ${edited.d1})`);
  const refused = await ev(() => {
    const e = window.__app.editor; e.setTool('select');
    const mx = Math.min(...Object.values(e.plan.nodes).map((n) => n.x));
    const w = e.plan.walls.find((q) => e.plan.nodes[q.a].x === mx && e.plan.nodes[q.b].x === mx);
    e.select({ type: 'wall', id: w.id, side: 1 });
    const before = JSON.stringify(e.plan.nodes);
    const wi = Math.hypot(e.plan.nodes[w.a].x - e.plan.nodes[w.b].x, e.plan.nodes[w.a].y - e.plan.nodes[w.b].y);
    const r = e.applyWallLength(wi + 100, { fixed: e.plan.nodes[w.a].y <= e.plan.nodes[w.b].y ? 'a' : 'b', mode: 'stretch' });
    return { r, same: before === JSON.stringify(e.plan.nodes) };
  });
  ok(refused.r === false && refused.same, 'une modification qui casse une cote verrouillée est refusée');
  await page.waitForSelector('text=Déverrouiller et appliquer');
  const h0 = await ev(() => { const ns = Object.values(window.__app.editor.plan.nodes); return Math.max(...ns.map((n) => n.y)) - Math.min(...ns.map((n) => n.y)); });
  await page.click('text=Déverrouiller et appliquer');
  const h1 = await ev(() => { const ns = Object.values(window.__app.editor.plan.nodes); return Math.max(...ns.map((n) => n.y)) - Math.min(...ns.map((n) => n.y)); });
  ok(h1 - h0 >= 99.4 && h1 - h0 <= 110.6, `« Déverrouiller et appliquer » applique la modification (${h0} → ${h1})`);

  await page.click('#btn-menu');
  await page.click('text=Cotes verrouillées');
  await page.waitForSelector('.lock-item');
  await page.screenshot({ path: shots + '/locks.png' });
  const nLocks = await page.locator('.lock-item').count();
  ok(nLocks >= 2, `fenêtre des cotes verrouillées (${nLocks})`);
  await page.click('text=Verrouillées seulement');
  ok(await ev(() => window.__app.editor.plan.settings.dimsShow === 'locked'), 'affichage limité aux cotes verrouillées');
  await page.click('text=Toutes les cotes');
  page.once('dialog', (d) => d.accept());
  await page.click('text=Tout déverrouiller');
  await page.waitForFunction(() => window.__app.editor.plan.locks.length === 0);
  ok(true, 'tout déverrouiller');
  await page.click('.sheet-head .x');


  console.log('Nom de pièce & meuble');
  await refit();
  await tapPlan(120, 200);
  await page.waitForSelector('#panel b:has-text("Pièce")');
  await page.click('#panel .chip:has-text("Salon")');
  const nm = await ev(() => window.__app.editor.rooms.map((r) => r.name));
  ok(nm.includes('Salon'), `pièce nommée (${nm})`);
  await page.click('[data-tool=furniture]');
  await page.click('.catalog button:has-text("Canapé 3 pl.")');
  await page.waitForSelector('#panel b:has-text("Meuble")');
  ok((await ev(() => window.__app.editor.plan.furniture.length)) === 1, 'un meuble ajouté');
  await page.fill('#panel label:has-text("Rotation") input', '90');
  await page.press('#panel label:has-text("Rotation") input', 'Enter');
  ok((await ev(() => window.__app.editor.plan.furniture[0].rot)) === 90, 'rotation du meuble');
  await page.screenshot({ path: `${shots}/3-meuble.png` });

  console.log('Surfaces & export');
  await page.click('[data-tool=rooms]');
  await page.waitForSelector('.rooms-table');
  const txt = await page.textContent('.rooms-table');
  ok(txt.includes('Salon') && txt.includes('Total'), 'tableau des surfaces avec total');
  await page.screenshot({ path: `${shots}/4-surfaces.png` });
  await page.click('.sheet-head .x');
  const png = await ev(() => window.__app.editor.exportCanvas('Test').toDataURL('image/png').length);
  ok(png > 5000, `export PNG généré (${png} octets en base64)`);

  console.log('Sauvegarde serveur & rechargement');
  await page.waitForFunction(() => document.querySelector('#save-state').className === 'save-state', null, { timeout: 8000 });
  ok(true, 'enregistrement automatique terminé');
  const url = page.url();
  await page.reload();
  await page.waitForFunction(() => window.__app?.editor?.plan?.walls?.length > 0, null, { timeout: 8000 });
  const persisted = await ev(() => ({ walls: window.__app.editor.plan.walls.length, o: window.__app.editor.plan.openings.length, f: window.__app.editor.plan.furniture.length, rooms: window.__app.editor.rooms.map((r) => r.name) }));
  ok(persisted.o === 2 && persisted.f === 1 && persisted.rooms.includes('Salon'), `plan rechargé depuis le serveur (${JSON.stringify(persisted)})`);
  await page.click('#z-fit');
  await page.screenshot({ path: `${shots}/5-recharge.png` });

  console.log('Gestes tactiles réels (CDP) : pincement et glisser à un doigt');
  const cdp = await ctx.newCDPSession(page);
  const b0 = await canvasBox();
  const cx = b0.x + b0.width / 2, cy = b0.y + 250;
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  await page.click('#z-fit');
  await ev(() => window.__app.editor.select(null));
  const s0 = await ev(() => window.__app.editor.view.s);
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 40 - i * 10, cy], [cx + 40 + i * 10, cy]]);
  await touch('touchEnd', []);
  const s1 = await ev(() => window.__app.editor.view.s);
  ok(s1 > s0 * 1.8, `pincement à deux doigts = zoom (${s0.toFixed(3)} → ${s1.toFixed(3)})`);
  const nWalls = await ev(() => window.__app.editor.plan.walls.length);
  ok(nWalls === 7, 'le pincement ne modifie pas le plan');
  const o0 = await ev(() => ({ ...window.__app.editor.view }));
  await touch('touchStart', [[b0.x + 60, b0.y + 560]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[b0.x + 60 + i * 12, b0.y + 560 - i * 15]]);
  await touch('touchEnd', []);
  const o1 = await ev(() => ({ ...window.__app.editor.view }));
  ok(Math.abs(o1.ox - o0.ox - 72) < 2 && Math.abs(o1.oy - o0.oy + 90) < 2, `glisser à un doigt = déplacement de la vue (${Math.round(o1.ox - o0.ox)}, ${Math.round(o1.oy - o0.oy)})`);
  await page.click('#z-fit');
  // tracé au doigt : pose d'un point puis d'un autre avec des vrais événements tactiles
  await ev(() => window.__app.editor.setTool('wall'));
  await page.waitForTimeout(250);
  await ev(() => window.__app.editor.fit({ x0: -60, y0: -60, x1: 620, y1: 480 }));
  const tt = async (x, y) => { const sp = await ev(([x, y]) => window.__app.editor.toScreen({ x, y }), [x, y]); await touch('touchStart', [[b0.x + sp.x, b0.y + sp.y]]); await touch('touchEnd', []); };
  await tt(600, 100); await tt(600, 300);
  const added = await ev(() => window.__app.editor.plan.walls.length);
  ok(added === 8, `mur tracé au doigt (${added} murs)`);
  await ev(() => window.__app.editor.finishDraft());

  console.log('Clic droit = quitter le mode en cours');
  await ev(() => window.__app.editor.setTool('wall'));
  await page.waitForTimeout(250);
  await ev(() => window.__app.editor.fit({ x0: -60, y0: -60, x1: 620, y1: 480 }));
  await tapPlan(100, 450);
  const bx = await canvasBox();
  await page.mouse.click(bx.x + 150, bx.y + 150, { button: 'right' });
  const st = await ev(() => ({ tool: window.__app.editor.tool, draft: window.__app.editor.draft, walls: window.__app.editor.plan.walls.length }));
  ok(st.tool === 'select' && st.draft === null, `clic droit pendant le tracé → retour au mode sélection (${st.tool})`);
  ok(st.walls === 8, 'le clic droit n’a pas ajouté de mur');
  await ev(() => window.__app.editor.setTool('opening'));
  await page.mouse.click(bx.x + 150, bx.y + 150, { button: 'right' });
  ok((await ev(() => window.__app.editor.tool)) === 'select', 'clic droit en mode porte/fenêtre → sélection');

  console.log('Retour liste');
  await page.click('#btn-back');
  await page.waitForSelector('#plan-list .plan-item');
  const sub = await page.textContent('.plan-item .s');
  ok(/pièces/.test(sub), `résumé dans la liste (${sub.slice(0, 40)})`);
  await page.screenshot({ path: `${shots}/6-liste.png` });
  ok(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
} catch (e) {
  failed++;
  console.error('ÉCHEC :', e.message);
  await page.screenshot({ path: `${shots}/fail.png` }).catch(() => {});
  if (errors.length) console.error(errors.join('\n'));
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} échec(s)` : '\nTout est OK');
process.exit(failed ? 1 : 0);
