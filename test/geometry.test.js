import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyPlan, insertWall, computeRooms, setWallLength, parseLen, addOpening, removeWall,
  mergeCollinear, setRoomMeta, wallChain, setChainLength, computeLayout, resolveSide, dimLabels, chainMeasure, setWallFaceLength, setChainFaceLength, sideEntry, addMeasure, measureEnds, measureDim, adjustMeasure, gapSpec, upsertLock, findLock, brokenLocks, normalizePlan, fmtArea, fmtLen, pointInFurniture, wallInfo, openingGeom, mergeNodes,
} from '../public/js/geometry.js';

function rect(plan, x, y, w, h, t = 10) {
  insertWall(plan, x, y, x + w, y, t);
  insertWall(plan, x + w, y, x + w, y + h, t);
  insertWall(plan, x + w, y + h, x, y + h, t);
  insertWall(plan, x, y + h, x, y, t);
}

test('parseLen accepte plusieurs écritures', () => {
  assert.equal(parseLen('345'), 345);
  assert.equal(parseLen('345cm'), 345);
  assert.equal(parseLen('3,45'), 345);
  assert.equal(parseLen('3.45 m'), 345);
  assert.equal(parseLen('3m45'), 345);
  assert.equal(parseLen('3450mm'), 345);
  assert.ok(Number.isNaN(parseLen('abc')));
});

test('une pièce rectangulaire : surface intérieure = (L - e) × (l - e)', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 400, 300, 20);
  const rooms = computeRooms(p);
  assert.equal(rooms.length, 1);
  assert.ok(Math.abs(rooms[0].area - 380 * 280) < 1, `aire ${rooms[0].area}`);
  assert.ok(Math.abs(rooms[0].axisArea - 400 * 300) < 1);
  assert.equal(fmtArea(rooms[0].area), '10,64 m²');
});

test('une cloison qui traverse coupe la pièce en deux, surfaces cohérentes', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 10);
  insertWall(p, 200, -50, 200, 350, 10); // dépasse des deux côtés : doit être coupée aux murs
  const rooms = computeRooms(p);
  const inner = rooms.filter((r) => r.area > 10000);
  assert.equal(inner.length, 2);
  const areas = inner.map((r) => Math.round(r.area)).sort((a, b) => a - b);
  // (200-10)×(300-10)=55100 ; (400-10)×(300-10)=113100
  assert.deepEqual(areas, [55100, 113100]);
});

test('un mur qui se termine en T sur un autre le coupe (T-junction)', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 10);
  insertWall(p, 300, 0, 300, 300, 10);
  assert.equal(p.walls.length, 7); // 4 + haut et bas coupés (+2) + la cloison (+1)
  assert.equal(computeRooms(p).length, 2);
});

test('mur isolé (antenne) ne crée pas de pièce et ne casse pas les surfaces', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 400, 300, 10);
  insertWall(p, 0, 150, 120, 150, 10); // antenne vers l'intérieur
  const rooms = computeRooms(p);
  assert.equal(rooms.length, 1);
  assert.ok(Math.abs(rooms[0].axisArea - 120000) < 1);
});

test('forme en L', () => {
  const p = emptyPlan();
  const pts = [[0, 0], [400, 0], [400, 200], [200, 200], [200, 400], [0, 400]];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    insertWall(p, a[0], a[1], b[0], b[1], 10);
  }
  const r = computeRooms(p);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0].axisArea - (400 * 200 + 200 * 200)) < 1);
  assert.ok(Math.abs(r[0].area - (390 * 190 + 190 * 200 - 0)) < 2000); // ordre de grandeur
});

test('corriger une mesure en mode étirer garde les angles droits', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 400, 300, 10);
  const top = p.walls.find((w) => Math.abs(p.nodes[w.a].y) < 1 && Math.abs(p.nodes[w.b].y) < 1);
  assert.ok(setWallLength(p, top.id, 450, { fixed: 'a', mode: 'stretch' }));
  const xs = Object.values(p.nodes).map((n) => n.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 0, 450, 450]);
  const r = computeRooms(p)[0];
  assert.ok(Math.abs(r.axisArea - 450 * 300) < 1);
});

test('corriger une mesure en fixant la fin', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 400, 300, 10);
  const top = p.walls.find((w) => Math.abs(p.nodes[w.a].y) < 1 && Math.abs(p.nodes[w.b].y) < 1);
  const fixed = p.nodes[top.b].x > p.nodes[top.a].x ? 'b' : 'a';
  setWallLength(p, top.id, 350, { fixed });
  const r = computeRooms(p)[0];
  assert.ok(Math.abs(r.axisArea - 350 * 300) < 1);
});

test('étirer une cloison intérieure élargit les deux pièces voisines', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 10);
  insertWall(p, 300, 0, 300, 300, 10);
  // la pièce de gauche passe de 300 à 350 de large : on corrige le mur du haut côté gauche
  const topLeft = p.walls.find((w) => {
    const a = p.nodes[w.a], b = p.nodes[w.b];
    return a.y === 0 && b.y === 0 && Math.min(a.x, b.x) === 0 && Math.max(a.x, b.x) === 300;
  });
  const fixedEnd = p.nodes[topLeft.a].x === 0 ? 'a' : 'b';
  setWallLength(p, topLeft.id, 350, { fixed: fixedEnd });
  const rooms = computeRooms(p).map((r) => Math.round(r.axisArea)).sort((a, b) => a - b);
  assert.deepEqual(rooms, [90000, 105000]);
});

test('ouvertures : suivent leur mur lorsqu’il est coupé et sont bornées', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 10);
  const top = p.walls.find((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0);
  const o = addOpening(p, top.id, 450, 'window');
  assert.equal(o.w, 100);
  insertWall(p, 300, 0, 300, 300, 10); // coupe le mur du haut en 300
  const g = openingGeom(p, p.openings[0]);
  assert.ok(g, 'ouverture rattachée à un mur');
  // son centre reste à x=450 (ou 150 selon l'orientation du mur d'origine)
  assert.ok(Math.abs(g.c.x - 450) < 1 || Math.abs(g.c.x - 150) < 1, `c.x=${g.c.x}`);
  const big = addOpening(p, top.id, 0, 'bay', { w: 5000 });
  assert.ok(big.w <= wallInfo(p, p.walls.find((w) => w.id === big.wall)).len);
});

test('supprimer une cloison re-fusionne le mur extérieur', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 10);
  insertWall(p, 300, 0, 300, 300, 10);
  assert.equal(p.walls.length, 7);
  const part = p.walls.find((w) => p.nodes[w.a].x === 300 && p.nodes[w.b].x === 300);
  removeWall(p, part.id);
  assert.equal(p.walls.length, 4);
  assert.equal(Object.keys(p.nodes).length, 4);
  assert.equal(computeRooms(p).length, 1);
});

test('nommer une pièce conserve le nom après modification de la géométrie', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 400, 300, 10);
  const r = computeRooms(p)[0];
  setRoomMeta(p, r, { name: 'Salon', color: '#cde' });
  const top = p.walls.find((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0);
  setWallLength(p, top.id, 420, { fixed: p.nodes[top.a].x === 0 ? 'a' : 'b' });
  const r2 = computeRooms(p)[0];
  assert.equal(r2.name, 'Salon');
  assert.equal(r2.color, '#cde');
});

test('fusion de deux nœuds supprime les murs dégénérés', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 400, 300, 10);
  const ids = Object.keys(p.nodes);
  mergeNodes(p, ids[0], ids[1]);
  assert.ok(p.walls.every((w) => w.a !== w.b));
});

test('formats & mobilier', () => {
  assert.equal(fmtLen(85), '85 cm');
  assert.equal(fmtLen(345), '3,45 m');
  const f = { x: 0, y: 0, w: 100, d: 50, rot: 90, shape: 'rect' };
  assert.ok(pointInFurniture({ x: 0, y: 40 }, f)); // pivoté de 90° : 50 de large en x, 100 en y
  assert.ok(!pointInFurniture({ x: 40, y: 0 }, f));
});

// ── mur entier (segments coupés par des cloisons) ──
function triplex() {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 10);
  insertWall(p, 200, 0, 200, 300, 10);
  insertWall(p, 400, 0, 400, 300, 10);
  const top = p.walls.filter((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0);
  return { p, top };
}
const topLens = (p) => p.walls.filter((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0)
  .map((w) => ({ x: Math.min(p.nodes[w.a].x, p.nodes[w.b].x), l: Math.abs(p.nodes[w.a].x - p.nodes[w.b].x) }))
  .sort((a, b) => a.x - b.x).map((q) => Math.round(q.l));

test('wallChain retrouve les 3 segments du mur du haut, ordonnés', () => {
  const { p, top } = triplex();
  assert.equal(top.length, 3);
  for (const w of top) {
    const ch = wallChain(p, w.id);
    assert.equal(ch.segments.length, 3);
    assert.equal(Math.round(ch.total), 600);
    assert.deepEqual(ch.segments.map((q) => Math.round(q.len)), [200, 200, 200]);
    assert.equal(ch.segments[ch.index].id, w.id);
  }
  // un mur vertical n'est pas relié au mur du haut (angle droit)
  const side = p.walls.find((w) => p.nodes[w.a].x === 0 && p.nodes[w.b].x === 0);
  assert.equal(wallChain(p, side.id).segments.length, 1);
});

test('longueur totale : le segment touché absorbe la différence', () => {
  const { p, top } = triplex();
  const mid = top.find((w) => Math.min(p.nodes[w.a].x, p.nodes[w.b].x) === 200);
  assert.ok(setChainLength(p, mid.id, 700, { fixed: 'first', distribute: 'selected' }));
  assert.deepEqual(topLens(p), [200, 300, 200]);
  const xs = Object.values(p.nodes).map((n) => n.x);
  assert.equal(Math.max(...xs), 700);
  assert.equal(computeRooms(p).length, 3);
});

test('longueur totale : répartition proportionnelle', () => {
  const { p, top } = triplex();
  assert.ok(setChainLength(p, top[0].id, 900, { fixed: 'first', distribute: 'prop' }));
  assert.deepEqual(topLens(p), [300, 300, 300]);
  const areas = computeRooms(p).map((r) => Math.round(r.axisArea));
  assert.deepEqual(areas, [90000, 90000, 90000]);
});

test('longueur totale : dernier segment, côté fixe à droite', () => {
  const { p, top } = triplex();
  assert.ok(setChainLength(p, top[0].id, 500, { fixed: 'second', distribute: 'last' }));
  assert.deepEqual(topLens(p), [100, 200, 200]);
  const xs = Object.values(p.nodes).map((n) => n.x);
  assert.equal(Math.max(...xs), 600); // le côté droit n'a pas bougé
  assert.equal(Math.min(...xs), 100);
});

test('chaque segment reste modifiable séparément', () => {
  const { p, top } = triplex();
  const first = top.find((w) => Math.min(p.nodes[w.a].x, p.nodes[w.b].x) === 0);
  setWallLength(p, first.id, 250, { fixed: p.nodes[first.a].x === 0 ? 'a' : 'b' });
  assert.deepEqual(topLens(p), [250, 200, 200]);
  assert.equal(Math.round(wallChain(p, first.id).total), 650);
});

// ── cotes intérieures / extérieures ──
test('longueurs de face : intérieur = axe − e, extérieur = axe + e (angles droits)', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 20);
  const lay = computeLayout(p);
  const top = p.walls.find((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0);
  const inner = resolveSide(p, lay, top.id, 1, 'inner');
  const outer = resolveSide(p, lay, top.id, 1, 'outer');
  assert.equal(Math.round(inner.entry.len), 580);
  assert.equal(Math.round(outer.entry.len), 620);
  assert.equal(inner.entry.kind, 'room');
  assert.equal(outer.entry.kind, 'outer');
  assert.notEqual(inner.side, outer.side);
});

test('cotes par pièce : chaque segment a sa longueur intérieure, et le mur entier sa longueur hors-tout', () => {
  const { p, top } = triplex();
  const lay = computeLayout(p);
  const seg = top.find((w) => Math.min(p.nodes[w.a].x, p.nodes[w.b].x) === 200);
  const innerLens = dimLabels(p, lay, 'inner').filter((l) => top.some((t) => t.id === l.wall)).map((l) => Math.round(l.len)).sort((a, b) => a - b);
  assert.deepEqual(innerLens, [190, 190, 190]);
  const outer = resolveSide(p, lay, seg.id, 1, 'outer');
  const mOut = chainMeasure(p, lay, seg.id, outer.side);
  assert.deepEqual(mOut.lens.map(Math.round), [205, 200, 205]);
  assert.equal(Math.round(mOut.total), 610);
  const inn = resolveSide(p, lay, seg.id, 1, 'inner');
  const mIn = chainMeasure(p, lay, seg.id, inn.side);
  assert.equal(Math.round(mIn.total), 590); // de l'angle intérieur à l'angle intérieur
});

test('corriger une cote intérieure règle bien la longueur de la face', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 20);
  const top = p.walls.find((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0);
  const side = resolveSide(p, computeLayout(p), top.id, 1, 'inner').side;
  const fixed = p.nodes[top.a].x === 0 ? 'a' : 'b';
  assert.ok(setWallFaceLength(p, top.id, side, 400, { fixed }));
  const e = sideEntry(p, computeLayout(p), top.id, side);
  assert.ok(Math.abs(e.len - 400) < 0.1, `face ${e.len}`);
  const room = computeLayout(p).rooms[0];
  assert.ok(Math.abs(room.area - 400 * 280) < 5, `aire ${room.area}`);
});

test('mur entier : cote extérieure hors-tout de 7 m répartie sur le segment touché', () => {
  const { p, top } = triplex();
  const lay = computeLayout(p);
  const mid = top.find((w) => Math.min(p.nodes[w.a].x, p.nodes[w.b].x) === 200);
  const side = resolveSide(p, lay, mid.id, 1, 'outer').side;
  const fixed = 'first';
  assert.ok(setChainFaceLength(p, mid.id, side, 700, { fixed, distribute: 'selected' }));
  const m = chainMeasure(p, computeLayout(p), mid.id, side);
  assert.ok(Math.abs(m.total - 700) < 0.1, `total ${m.total}`);
  assert.deepEqual(m.lens.map(Math.round), [205, 290, 205]);
});

test('mode axe : une seule étiquette par mur, au milieu', () => {
  const { p } = triplex();
  const labels = dimLabels(p, computeLayout(p), 'axis');
  assert.equal(labels.length, p.walls.length);
  assert.ok(labels.every((l) => l.side === 0));
});

// ── outil Mesure & cotes verrouillées ──
test('mesure entre deux faces intérieures : la cote saisie décale le mur du bout', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 20);
  const A = { x: 10, y: 150 }, B = { x: 590, y: 150 };
  assert.ok(adjustMeasure(p, A, B, 500, { move: 'b' }));
  const xs = Object.values(p.nodes).map((n) => n.x);
  assert.equal(Math.max(...xs), 520);
  assert.equal(Math.min(...xs), 0);
  assert.ok(Math.abs(computeLayout(p).rooms[0].area - 500 * 280) < 5);
});

test('mesure : côté du 1er point', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 20);
  assert.ok(adjustMeasure(p, { x: 10, y: 150 }, { x: 590, y: 150 }, 500, { move: 'a' }));
  const xs = Object.values(p.nodes).map((n) => n.x);
  assert.equal(Math.min(...xs), 80);
  assert.equal(Math.max(...xs), 600);
});

test('cote verrouillée : une autre correction qui la change est détectée', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 20);
  const wa = p.walls.find((w) => p.nodes[w.a].x === 0 && p.nodes[w.b].x === 0).id;
  const wb = p.walls.find((w) => p.nodes[w.a].x === 600 && p.nodes[w.b].x === 600).id;
  const spec = gapSpec(p, { x: 10, y: 150, walls: [wa] }, { x: 590, y: 150, walls: [wb] });
  assert.ok(spec);
  assert.ok(Math.abs(spec.len - 580) < 0.01);
  upsertLock(p, spec);
  assert.ok(findLock(p, spec));
  const prev = normalizePlan(JSON.parse(JSON.stringify(p)));
  const top = p.walls.find((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0);
  setWallLength(p, top.id, 700, { fixed: p.nodes[top.a].x === 0 ? 'a' : 'b' });
  assert.ok(brokenLocks(prev, p), 'élargir la pièce doit casser la cote verrouillée');
  const prev2 = normalizePlan(JSON.parse(JSON.stringify(prev)));
  const side = prev2.walls.find((w) => prev2.nodes[w.a].x === 0 && prev2.nodes[w.b].x === 0);
  setWallLength(prev2, side.id, 400, { fixed: prev2.nodes[side.a].y === 0 ? 'a' : 'b' });
  assert.equal(brokenLocks(prev, prev2), null, 'allonger dans l’autre sens ne touche pas la cote');
});

test('mesure du bord d’une arche à la fin du mur : l’arche ne bouge pas', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 20);
  const top = p.walls.find((w) => p.nodes[w.a].y === 0 && p.nodes[w.b].y === 0);
  const left = p.nodes[top.a].x === 0;
  const pos = left ? 200 : 400; // centre de l'arche, 100 de large
  const op = addOpening(p, top.id, pos, 'arch', { w: 100 });
  const before = openingGeom(p, op).c.x;
  // du bord droit de l'arche (x=250 ou 350) au bout droit du mur (x=600) : +50 cm
  const edge = before + 50;
  assert.ok(adjustMeasure(p, { x: edge, y: 0 }, { x: 600, y: 0 }, 600 - edge + 50, { move: 'b' }));
  assert.equal(Math.round(openingGeom(p, op).c.x), Math.round(before));
  assert.equal(Math.max(...Object.values(p.nodes).map((n) => n.x)), 650);
});

test('mesure conservée : suit les murs et se place hors du plan', () => {
  const p = emptyPlan();
  rect(p, 0, 0, 600, 300, 20);
  const wa = p.walls.find((w) => p.nodes[w.a].x === 0 && p.nodes[w.b].x === 0).id;
  const wb = p.walls.find((w) => p.nodes[w.a].x === 600 && p.nodes[w.b].x === 600).id;
  const m = addMeasure(p, { x: 10, y: 150, walls: [wa] }, { x: 590, y: 150, walls: [wb] });
  assert.ok(m);
  assert.equal(addMeasure(p, { x: 10, y: 150, walls: [wa] }, { x: 590, y: 150, walls: [wb] }).id, m.id, 'pas de doublon');
  adjustMeasure(p, { x: 10, y: 150 }, { x: 590, y: 150 }, 500, { move: 'b' });
  const d = measureDim(p, m, 1);
  assert.ok(Math.abs(d.len - 500) < 0.5, `longueur suivie ${d.len}`);
  assert.ok(Math.abs(d.A2.y) > 300 || d.A2.y < -10 || d.A2.y > 310, 'ligne de cote hors du plan');
});
