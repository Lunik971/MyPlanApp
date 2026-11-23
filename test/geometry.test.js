import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyPlan, insertWall, computeRooms, setWallLength, parseLen, addOpening, removeWall,
  mergeCollinear, setRoomMeta, fmtArea, fmtLen, pointInFurniture, wallInfo, openingGeom, mergeNodes,
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
