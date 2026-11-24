// Géométrie pure du plan (aucune dépendance au DOM) — utilisée par l'éditeur et testée sous Node.
// Unités : centimètres. Repère : x vers la droite, y vers le bas (comme le canvas).
//
// Modèle :
//   nodes      { id: {x, y} }                 points partagés entre murs
//   walls      [{id, a, b, t}]                mur entre deux nœuds, épaisseur t (cm), tracé à l'axe
//   openings   [{id, wall, pos, w, h, sill, kind, flip, side}]
//                pos = distance (cm) du centre de l'ouverture depuis le nœud a du mur
//   rooms      [{id, name, color, x, y}]      étiquettes ; la pièce détectée qui contient (x,y) les porte
//   furniture  [{id, kind, name, x, y, w, d, rot, shape}]  x,y = centre
//   settings   {wallT, grid, dims}

export const EPS = 0.5;
let _seq = 0;
export const uid = (p = 'i') => p + Math.random().toString(36).slice(2, 7) + (++_seq).toString(36);
export const round1 = (v) => Math.round(v * 10) / 10;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function emptyPlan() {
  return {
    v: 1,
    nodes: {},
    walls: [],
    openings: [],
    rooms: [],
    furniture: [],
    locks: [],
    measures: [],
    settings: { wallT: 10, grid: 10, dims: true, dimRef: 'inner' },
  };
}

export function normalizePlan(p) {
  const b = emptyPlan();
  const q = { ...b, ...(p || {}) };
  q.nodes = q.nodes || {};
  for (const k of ['walls', 'openings', 'rooms', 'furniture', 'locks', 'measures']) if (!Array.isArray(q[k])) q[k] = [];
  q.settings = { ...b.settings, ...(q.settings || {}) };
  return q;
}

// ───────────────────────── formats ─────────────────────────

const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtLen(cm) {
  if (cm < 100) return `${Math.round(cm)} cm`;
  return `${nf2.format(cm / 100)} m`;
}
export function fmtArea(cm2) {
  return `${nf2.format(cm2 / 10000)} m²`;
}
export function fmtCm(cm) {
  return String(Math.round(cm * 10) / 10).replace('.', ',');
}

// Accepte : 345 · 345cm · 3,45 · 3.45m · 3m45 · 3450mm
export function parseLen(s) {
  if (s == null) return NaN;
  s = String(s).trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
  let m = s.match(/^(\d+)m(\d+)$/);
  if (m) return parseInt(m[1], 10) * 100 + parseFloat('0.' + m[2]) * 100;
  m = s.match(/^(\d+(?:\.\d+)?)(mm|cm|m)?$/);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  if (m[2] === 'm') return v * 100;
  if (m[2] === 'cm') return v;
  if (m[2] === 'mm') return v / 10;
  if (m[1].includes('.') && v < 50) return v * 100; // « 3.45 » = mètres
  return v;
}

// ───────────────────────── segments ─────────────────────────

export function projectToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const x = a.x + t * dx, y = a.y + t * dy;
  return { x, y, t, d: Math.hypot(p.x - x, p.y - y) };
}

export function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y), t, u };
}

export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2; // signé
}

export function wallInfo(plan, w) {
  const a = plan.nodes[w.a], b = plan.nodes[w.b];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  return { a, b, len, ux, uy, nx: -uy, ny: ux };
}

// ───────────────────────── nœuds & murs ─────────────────────────

export function nodeAt(plan, x, y, tol = EPS) {
  for (const [id, n] of Object.entries(plan.nodes)) if (Math.hypot(n.x - x, n.y - y) <= tol) return id;
  return null;
}

export function addNode(plan, x, y) {
  const id = uid('n');
  plan.nodes[id] = { x: round1(x), y: round1(y) };
  return id;
}

export function splitWall(plan, wallId, nodeId) {
  const w = plan.walls.find((q) => q.id === wallId);
  if (!w) return null;
  const s = dist(plan.nodes[w.a], plan.nodes[nodeId]);
  const w2 = { id: uid('w'), a: nodeId, b: w.b, t: w.t };
  w.b = nodeId;
  plan.walls.push(w2);
  for (const o of plan.openings) {
    if (o.wall === wallId && o.pos > s) {
      o.wall = w2.id;
      o.pos = round1(o.pos - s);
    }
  }
  return w2.id;
}

// Retourne le nœud existant sous (x,y), ou coupe le mur touché, ou crée un nœud libre.
export function ensureNode(plan, x, y, tol = EPS) {
  let id = nodeAt(plan, x, y, tol);
  if (id) return id;
  for (const w of plan.walls) {
    const pr = projectToSegment({ x, y }, plan.nodes[w.a], plan.nodes[w.b]);
    if (pr.d <= tol && pr.t > 0 && pr.t < 1) {
      id = addNode(plan, pr.x, pr.y);
      splitWall(plan, w.id, id);
      return id;
    }
  }
  return addNode(plan, x, y);
}

const wallBetween = (plan, n1, n2) =>
  plan.walls.find((w) => (w.a === n1 && w.b === n2) || (w.a === n2 && w.b === n1));

// Ajoute un mur A→B ; le découpe aux croisements et aux nœuds rencontrés. Retourne les murs créés.
export function insertWall(plan, ax, ay, bx, by, t) {
  const A = ensureNode(plan, ax, ay);
  const B = ensureNode(plan, bx, by);
  if (A === B) return [];
  const pa = plan.nodes[A], pb = plan.nodes[B];
  const L = dist(pa, pb);
  if (L < 1) return [];
  const stops = new Map([[A, 0], [B, L]]);

  for (const [id, n] of Object.entries(plan.nodes)) {
    if (id === A || id === B) continue;
    const pr = projectToSegment(n, pa, pb);
    if (pr.d <= EPS && pr.t > 0 && pr.t < 1) stops.set(id, pr.t * L);
  }
  for (const w of plan.walls.slice()) {
    if (w.a === A || w.b === A || w.a === B || w.b === B) continue;
    const wa = plan.nodes[w.a], wb = plan.nodes[w.b];
    const x = segIntersect(pa, pb, wa, wb);
    if (!x) continue;
    const lw = dist(wa, wb);
    if (x.t * L <= EPS || (1 - x.t) * L <= EPS || x.u * lw <= EPS || (1 - x.u) * lw <= EPS) continue;
    const id = addNode(plan, x.x, x.y);
    splitWall(plan, w.id, id);
    stops.set(id, x.t * L);
  }

  const ordered = [...stops.entries()].sort((p, q) => p[1] - q[1]).map((e) => e[0]);
  const created = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    if (wallBetween(plan, ordered[i], ordered[i + 1])) continue;
    const w = { id: uid('w'), a: ordered[i], b: ordered[i + 1], t };
    plan.walls.push(w);
    created.push(w.id);
  }
  return created;
}

export function pruneNodes(plan) {
  const used = new Set();
  for (const w of plan.walls) { used.add(w.a); used.add(w.b); }
  for (const id of Object.keys(plan.nodes)) if (!used.has(id)) delete plan.nodes[id];
}

function orientOpening(o, wasReversed) {
  if (wasReversed) { o.flip = !o.flip; o.side = -(o.side || 1); }
}

// Fusionne les nœuds de degré 2 alignés (suite à une suppression) pour retrouver des murs entiers.
// tolCm : un point intermédiaire à moins de tolCm de la droite (et ≤ 5° d'écart) est supprimé :
// plusieurs petits segments alignés ne forment plus qu'un seul grand mur.
export function mergeCollinear(plan, tolCm = 2.5) {
  let changed = true;
  while (changed) {
    changed = false;
    const deg = {};
    for (const w of plan.walls) { (deg[w.a] ||= []).push(w); (deg[w.b] ||= []).push(w); }
    for (const [nid, ws] of Object.entries(deg)) {
      if (ws.length !== 2 || ws[0] === ws[1]) continue;
      const [w1, w2] = ws;
      if (w1.t !== w2.t) continue;
      const p = w1.a === nid ? w1.b : w1.a;
      const q = w2.a === nid ? w2.b : w2.a;
      if (p === q) continue;
      const n = plan.nodes[nid], pp = plan.nodes[p], qq = plan.nodes[q];
      const l1 = dist(pp, n), l2 = dist(n, qq);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const cross = (n.x - pp.x) * (qq.y - n.y) - (n.y - pp.y) * (qq.x - n.x);
      const dot = (n.x - pp.x) * (qq.x - n.x) + (n.y - pp.y) * (qq.y - n.y);
      const lpq = dist(pp, qq) || 1;
      const off = Math.abs((qq.x - pp.x) * (n.y - pp.y) - (qq.y - pp.y) * (n.x - pp.x)) / lpq;
      if (dot <= 0 || Math.abs(cross) / (l1 * l2) > 0.09 || (off > tolCm && Math.abs(cross) / (l1 * l2) > 0.003)) continue;
      if (wallBetween(plan, p, q)) continue;
      // w1 : p→n, w2 : n→q
      const rev1 = w1.a !== p, rev2 = w2.a !== nid;
      for (const o of plan.openings) {
        if (o.wall === w1.id) { if (rev1) { o.pos = round1(l1 - o.pos); orientOpening(o, true); } }
        else if (o.wall === w2.id) {
          o.pos = round1(l1 + (rev2 ? l2 - o.pos : o.pos));
          if (rev2) orientOpening(o, true);
          o.wall = w1.id;
        }
      }
      w1.a = p; w1.b = q;
      plan.walls = plan.walls.filter((w) => w !== w2);
      delete plan.nodes[nid];
      changed = true;
      break;
    }
  }
}

export function removeWall(plan, wallId) {
  plan.walls = plan.walls.filter((w) => w.id !== wallId);
  plan.openings = plan.openings.filter((o) => o.wall !== wallId);
  pruneNodes(plan);
  mergeCollinear(plan);
}

// Déplace le nœud « remove » sur « keep » (fusion) ; nettoie les murs dégénérés / doublons.
export function mergeNodes(plan, keep, remove) {
  if (keep === remove) return;
  for (const w of plan.walls) {
    if (w.a === remove) w.a = keep;
    if (w.b === remove) w.b = keep;
  }
  const seen = new Map();
  const dead = new Set();
  for (const w of plan.walls) {
    if (w.a === w.b) { dead.add(w.id); continue; }
    const k = [w.a, w.b].sort().join('|');
    if (seen.has(k)) dead.add(w.id); else seen.set(k, w.id);
  }
  plan.walls = plan.walls.filter((w) => !dead.has(w.id));
  plan.openings = plan.openings.filter((o) => !dead.has(o.wall));
  delete plan.nodes[remove];
  pruneNodes(plan);
}

// Nettoyage : supprime les décrochés et fusionne les points quasi confondus, puis redresse les murs presque
// horizontaux / verticaux (écart d'angle ≤ angleDeg) en alignant leurs points.
export function cleanPlan(plan, { angleDeg = 5, shortCm = 8, snapCm = 3 } = {}) {
  const stats = { merged: 0, straightened: 0 };
  const hasOpening = (id) => plan.openings.some((o) => o.wall === id);
  // 1) murs minuscules (décrochés) et points quasi confondus
  for (let guard = 0; guard < 200; guard++) {
    let target = null;
    for (const w of plan.walls) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      if (a && b && dist(a, b) < shortCm && !hasOpening(w.id)) { target = [w.a, w.b]; break; }
    }
    if (!target) {
      const ids = Object.keys(plan.nodes);
      outer: for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (dist(plan.nodes[ids[i]], plan.nodes[ids[j]]) < snapCm) { target = [ids[i], ids[j]]; break outer; }
        }
      }
    }
    if (!target) break;
    const [k, r] = target, A = plan.nodes[k], B = plan.nodes[r];
    plan.nodes[k] = { x: round1((A.x + B.x) / 2), y: round1((A.y + B.y) / 2) };
    mergeNodes(plan, k, r);
    stats.merged++;
  }
  // 2) murs presque droits : aligner les points reliés
  const tan = Math.tan((angleDeg * Math.PI) / 180);
  for (const axis of ['x', 'y']) {
    const other = axis === 'x' ? 'y' : 'x';
    const parent = {};
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const id of Object.keys(plan.nodes)) parent[id] = id;
    for (const w of plan.walls) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      const along = Math.abs(b[other] - a[other]), across = Math.abs(b[axis] - a[axis]);
      // presque vertical (axis = x) : variation de x faible par rapport à celle de y
      if (across > 0.05 && across <= along * tan) parent[find(w.a)] = find(w.b);
    }
    const groups = {};
    for (const id of Object.keys(plan.nodes)) (groups[find(id)] ||= []).push(id);
    for (const ids of Object.values(groups)) {
      if (ids.length < 2) continue;
      const m = round1(ids.reduce((s, id) => s + plan.nodes[id][axis], 0) / ids.length);
      for (const id of ids) if (Math.abs(plan.nodes[id][axis] - m) > 0.05) { plan.nodes[id][axis] = m; stats.straightened++; }
    }
  }
  mergeCollinear(plan);
  for (const o of plan.openings) clampOpening(plan, o);
  return stats;
}

export function moveNode(plan, id, x, y) {
  const n = plan.nodes[id];
  if (n) { n.x = round1(x); n.y = round1(y); }
}

// Corrige la longueur d'un mur.
//   fixed : 'a' ou 'b' — extrémité qui ne bouge pas
//   mode  : 'stretch' (défaut) étire la pièce : tout ce qui est au-delà de l'extrémité mobile suit,
//                      ce qui conserve les angles droits ;
//           'point'   ne déplace que l'extrémité mobile.
// Étend l'ensemble de nœuds `moving` le long des murs quasi perpendiculaires à (ux,uy) (±15°).
function growPerpendicular(plan, moving, ux, uy, stopNode) {
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of plan.walls) {
      const ina = moving.has(w.a), inb = moving.has(w.b);
      if (ina === inb) continue;
      const a = plan.nodes[w.a], b = plan.nodes[w.b], l = dist(a, b) || 1;
      if (Math.abs(((b.x - a.x) * ux + (b.y - a.y) * uy) / l) > 0.26) continue;
      const other = ina ? w.b : w.a;
      if (other === stopNode) continue;
      moving.add(other);
      grew = true;
    }
  }
}

// Quelle extrémité garder fixe pour que la modification parte vers l'EXTÉRIEUR du plan : celle
// qui est la plus proche du centre du bâtiment (l'autre bout, côté façade, est celui qui avance).
export function nearerToCenter(plan, P, Q) {
  const bb = planBounds(plan);
  if (!bb) return 'P';
  const c = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 };
  const L = dist(P, Q) || 1, ux = (Q.x - P.x) / L, uy = (Q.y - P.y) / L;
  const tc = (c.x - P.x) * ux + (c.y - P.y) * uy;
  return Math.abs(L - tc) < Math.abs(tc) ? 'Q' : 'P';
}

// Côté qui avance pour une mesure entre A et B : celui qui est le plus loin du centre ('a' ou 'b')
export function measureOuterMove(plan, A, B) {
  return nearerToCenter(plan, A, B) === 'Q' ? 'a' : 'b';
}

export function setWallLength(plan, wallId, newLen, { fixed = 'a', mode = 'stretch' } = {}) {
  const w = plan.walls.find((q) => q.id === wallId);
  if (!w || !(newLen >= 1)) return false;
  if (fixed === 'outer') fixed = nearerToCenter(plan, plan.nodes[w.a], plan.nodes[w.b]) === 'Q' ? 'b' : 'a';
  if (fixed === 'center') { // par défaut : la différence est répartie des deux côtés du mur
    const L0 = dist(plan.nodes[w.a], plan.nodes[w.b]);
    const half = (newLen - L0) / 2;
    if (!(L0 + half >= 1)) return false;
    return setWallLength(plan, wallId, L0 + half, { fixed: 'a', mode }) && setWallLength(plan, wallId, newLen, { fixed: 'b', mode });
  }
  const [fa, mb] = fixed === 'b' ? [w.b, w.a] : [w.a, w.b];
  const pa = plan.nodes[fa], pb = plan.nodes[mb];
  const L = dist(pa, pb);
  if (L < 1e-6) return false;
  const ux = (pb.x - pa.x) / L, uy = (pb.y - pa.y) / L;
  const delta = newLen - L;
  if (mode === 'point') {
    plan.nodes[mb] = { x: round1(pa.x + ux * newLen), y: round1(pa.y + uy * newLen) };
    return true;
  }
  const limit = pb.x * ux + pb.y * uy - EPS;
  // nœuds qui suivent : tout ce qui est au-delà, plus les murs (quasi) perpendiculaires qui s'y accrochent,
  // pour qu'ils se déplacent parallèlement à eux-mêmes au lieu de pencher
  const moving = new Set(Object.keys(plan.nodes).filter((id) => plan.nodes[id].x * ux + plan.nodes[id].y * uy >= limit));
  growPerpendicular(plan, moving, ux, uy, fa);
  for (const id of moving) {
    const n = plan.nodes[id];
    n.x = round1(n.x + ux * delta); n.y = round1(n.y + uy * delta);
  }
  for (const f of plan.furniture) {
    if (f.x * ux + f.y * uy >= limit) { f.x = round1(f.x + ux * delta); f.y = round1(f.y + uy * delta); }
  }
  for (const r of plan.rooms) {
    if (r.x * ux + r.y * uy >= limit) { r.x = round1(r.x + ux * delta); r.y = round1(r.y + uy * delta); }
  }
  return true;
}

// ───────────────────────── mur « entier » ─────────────────────────

// Un mur coupé par des cloisons en T apparaît en plusieurs segments (un par pièce mesurée).
// wallChain retrouve la suite de segments alignés, ordonnée de gauche à droite (ou de haut en bas).
export function wallChain(plan, wallId) {
  const start = plan.walls.find((w) => w.id === wallId);
  if (!start) return null;
  const N = plan.nodes;
  const dirTo = (w, from) => {
    const to = w.a === from ? w.b : w.a;
    const l = dist(N[from], N[to]) || 1e-9;
    return { x: (N[to].x - N[from].x) / l, y: (N[to].y - N[from].y) / l, to };
  };
  const extend = (fromNode, d0, used) => {
    const out = [];
    let cur = fromNode, d = d0;
    for (;;) {
      let next = null;
      for (const w of plan.walls) {
        if (used.has(w.id) || (w.a !== cur && w.b !== cur)) continue;
        const dd = dirTo(w, cur);
        // ±3° : un mur légèrement désaligné reste « un seul mur » à travers ses cloisons
        if (Math.abs(d.x * dd.y - d.y * dd.x) < 0.05 && d.x * dd.x + d.y * dd.y > 0) { next = { w, dd }; break; }
      }
      if (!next) break;
      used.add(next.w.id);
      out.push({ wall: next.w, from: cur, to: next.dd.to });
      cur = next.dd.to; d = next.dd;
    }
    return out;
  };
  const d0 = dirTo(start, start.a);
  const used = new Set([start.id]);
  const fwd = extend(start.b, d0, used);
  const bwd = extend(start.a, { x: -d0.x, y: -d0.y }, used);
  let segs = [
    ...bwd.reverse().map((q) => ({ wall: q.wall, from: q.to, to: q.from })),
    { wall: start, from: start.a, to: start.b },
    ...fwd,
  ];
  const first = N[segs[0].from], last = N[segs.at(-1).to];
  const horiz = Math.abs(last.x - first.x) >= Math.abs(last.y - first.y);
  if (horiz ? first.x > last.x : first.y > last.y) segs = segs.reverse().map((q) => ({ wall: q.wall, from: q.to, to: q.from }));
  const segments = segs.map((q) => ({ id: q.wall.id, from: q.from, to: q.to, len: dist(N[q.from], N[q.to]) }));
  return {
    segments,
    horiz,
    index: segments.findIndex((q) => q.id === wallId),
    total: segments.reduce((a, q) => a + q.len, 0),
  };
}

// Donne une longueur totale à un mur composé de plusieurs segments.
//   fixed      : 'first' (gauche/haut) ou 'second' (droite/bas) — côté qui ne bouge pas
//   distribute : 'selected' le segment touché absorbe la différence (les autres cotes ne changent pas)
//                'last'     le segment du bout opposé au côté fixe l'absorbe
//                'prop'     la différence est répartie proportionnellement sur tous les segments
//   mode       : 'stretch' (défaut) ou 'point', comme setWallLength (ignoré en 'prop')
export function setChainLength(plan, wallId, newTotal, { fixed = 'first', distribute = 'selected', mode = 'stretch' } = {}) {
  const ch = wallChain(plan, wallId);
  if (!ch || !(newTotal >= 1)) return false;
  if (fixed === 'outer') {
    const s0 = ch.segments[0], s1 = ch.segments[ch.segments.length - 1];
    fixed = nearerToCenter(plan, plan.nodes[s0.from], plan.nodes[s1.to]) === 'Q' ? 'second' : 'first';
  }
  if (fixed === 'center') {
    const half = (newTotal - ch.total) / 2;
    if (!(ch.total + half >= 1)) return false;
    return setChainLength(plan, wallId, ch.total + half, { fixed: 'first', distribute, mode })
      && setChainLength(plan, wallId, newTotal, { fixed: 'second', distribute, mode });
  }
  const apply = (seg, newLen, m) => {
    const w = plan.walls.find((q) => q.id === seg.id);
    const fixedNode = fixed === 'first' ? seg.from : seg.to;
    return setWallLength(plan, seg.id, newLen, { fixed: w.a === fixedNode ? 'a' : 'b', mode: m });
  };
  const segs = ch.segments;
  if (segs.length === 1) return apply(segs[0], newTotal, mode);
  const delta = newTotal - ch.total;
  if (distribute === 'prop') {
    const f = newTotal / ch.total;
    const order = fixed === 'first' ? segs : [...segs].reverse();
    const lens = new Map(segs.map((q) => [q.id, q.len]));
    for (const seg of order) apply(seg, lens.get(seg.id) * f, 'stretch');
    return true;
  }
  const seg = distribute === 'last' ? (fixed === 'first' ? segs.at(-1) : segs[0]) : segs[ch.index];
  const newLen = seg.len + delta;
  if (newLen < 1) return false;
  return apply(seg, newLen, mode);
}

// ───────────────────────── ouvertures ─────────────────────────

export const OPENING_KINDS = {
  door: { label: 'Porte', w: 83, h: 204, sill: 0 },
  double: { label: 'Porte double', w: 140, h: 204, sill: 0 },
  window: { label: 'Fenêtre', w: 100, h: 120, sill: 90 },
  bay: { label: 'Baie vitrée', w: 180, h: 215, sill: 0 },
  opening: { label: 'Ouverture', w: 90, h: 204, sill: 0 },
  arch: { label: 'Arche', w: 100, h: 230, sill: 0 },
  frame: { label: 'Cadre sans porte', w: 83, h: 204, sill: 0 },
  frenchwin: { label: 'Porte-fenêtre 4 vantaux', w: 240, h: 215, sill: 0 },
};

// Distance, le long du mur w, entre un de ses nœuds et la face des autres murs qui s'y rejoignent :
// une ouverture ne doit pas entamer ces murs (sa limite est le mur, pas l'intérieur du mur voisin).
export function endInset(plan, w, nodeId) {
  const here = plan.nodes[nodeId];
  const far = plan.nodes[w.a === nodeId ? w.b : w.a];
  const L = dist(here, far) || 1;
  const ux = (far.x - here.x) / L, uy = (far.y - here.y) / L;
  let inset = 0;
  for (const q of plan.walls) {
    if (q === w || (q.a !== nodeId && q.b !== nodeId)) continue;
    const o = plan.nodes[q.a === nodeId ? q.b : q.a];
    const l = dist(here, o) || 1;
    const sin = Math.abs(ux * ((o.y - here.y) / l) - uy * ((o.x - here.x) / l));
    if (sin < 0.1) continue; // prolongement du même mur
    inset = Math.max(inset, q.t / 2 / Math.max(sin, 0.3));
  }
  return inset;
}

export function clampOpening(plan, o) {
  const w = plan.walls.find((q) => q.id === o.wall);
  if (!w) return;
  const { len } = wallInfo(plan, w);
  const lo = endInset(plan, w, w.a), hi = len - endInset(plan, w, w.b);
  o.w = Math.max(10, Math.min(o.w, Math.max(10, hi - lo)));
  o.pos = round1(clamp(o.pos, lo + o.w / 2, hi - o.w / 2));
}

export function addOpening(plan, wallId, pos, kind = 'door', overrides = {}) {
  const d = OPENING_KINDS[kind];
  const o = { id: uid('o'), wall: wallId, pos, w: d.w, h: d.h, sill: d.sill, kind, flip: false, side: 1, ...overrides };
  clampOpening(plan, o);
  plan.openings.push(o);
  return o;
}

export function openingGeom(plan, o) {
  const w = plan.walls.find((q) => q.id === o.wall);
  if (!w) return null;
  const wi = wallInfo(plan, w);
  const c = { x: wi.a.x + wi.ux * o.pos, y: wi.a.y + wi.uy * o.pos };
  return { wall: w, ...wi, c, t: w.t };
}

// ───────────────────────── pièces (faces du graphe de murs) ─────────────────────────

// Décale un polygone (orienté « intérieur à gauche ») vers l'intérieur de thick[i]/2 par arête.
export function insetPolygon(points, thick) {
  const n = points.length;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy);
    if (l < 1e-6) { lines.push(null); continue; }
    const h = thick[i] / 2;
    lines.push({ px: p.x - (dy / l) * h, py: p.y + (dx / l) * h, dx: dx / l, dy: dy / l });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
    if (!L1 || !L2) { out.push({ ...points[i] }); continue; }
    const cr = L1.dx * L2.dy - L1.dy * L2.dx;
    if (Math.abs(cr) < 1e-6) { out.push({ x: L2.px, y: L2.py }); continue; }
    const s = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / cr;
    out.push({ x: L1.px + s * L1.dx, y: L1.py + s * L1.dy });
  }
  return out;
}

// Point bien à l'intérieur du polygone (approximation du « pôle d'inaccessibilité »).
export function labelPoint(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const N = 28;
  let best = null, bestD = -1;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = { x: x0 + ((x1 - x0) * i) / N, y: y0 + ((y1 - y0) * j) / N };
      if (!pointInPoly(p, poly)) continue;
      let d = Infinity;
      for (let k = 0; k < poly.length; k++) d = Math.min(d, projectToSegment(p, poly[k], poly[(k + 1) % poly.length]).d);
      if (d > bestD) { bestD = d; best = p; }
    }
  }
  if (!best) best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  return { x: round1(best.x), y: round1(best.y) };
}

export function computeLayout(plan) {
  const nodes = plan.nodes;
  const adj = {};
  for (const w of plan.walls) {
    const a = nodes[w.a], b = nodes[w.b];
    if (!a || !b || (a.x === b.x && a.y === b.y)) continue;
    (adj[w.a] ||= []).push({ to: w.b, w, ang: Math.atan2(b.y - a.y, b.x - a.x) });
    (adj[w.b] ||= []).push({ to: w.a, w, ang: Math.atan2(a.y - b.y, a.x - b.x) });
  }
  for (const k in adj) adj[k].sort((p, q) => p.ang - q.ang);

  const visited = new Set();
  const rooms = [];
  const usedLabels = new Set();
  const faces = [];

  for (const [u, list] of Object.entries(adj)) {
    for (const e of list) {
      if (visited.has(u + '>' + e.w.id)) continue;
      const edges = [];
      let cu = u, ce = e, guard = 0;
      while (!visited.has(cu + '>' + ce.w.id) && guard++ < 5000) {
        visited.add(cu + '>' + ce.w.id);
        edges.push({ from: cu, wall: ce.w });
        const v = ce.to, lv = adj[v];
        const idx = lv.findIndex((x) => x.w === ce.w);
        ce = lv[(idx - 1 + lv.length) % lv.length];
        cu = v;
      }
      // supprime les « antennes » (mur parcouru aller-retour)
      let found = true;
      while (found && edges.length >= 3) {
        found = false;
        for (let i = 0; i < edges.length; i++) {
          const j = (i + 1) % edges.length;
          if (edges[i].wall === edges[j].wall) {
            const drop = new Set([i, j]);
            const rest = edges.filter((_, k) => !drop.has(k));
            edges.length = 0; edges.push(...rest);
            found = true;
            break;
          }
        }
      }
      if (edges.length < 3) continue;
      const pts = edges.map((ed) => nodes[ed.from]);
      const A = polyArea(pts);
      if (Math.abs(A) < 100) continue; // < 0,01 m²
      faces.push({ edges, pts, outer: A < 0 }); // A < 0 : face extérieure (contour du bâtiment)
    }
  }

  const sideMap = new Map();
  for (const f of faces) {
    const thick = f.edges.map((ed) => ed.wall.t);
    let inner = insetPolygon(f.pts, thick);
    const ia = polyArea(inner), aa = polyArea(f.pts);
    const valid = f.outer ? ia < 0 && ia <= aa + 1 : ia > 0 && ia <= aa + 1;
    if (!valid) inner = f.pts.map((p) => ({ x: p.x, y: p.y }));
    const sides = inner.map((p, i) => ({ len: dist(p, inner[(i + 1) % inner.length]), wall: f.edges[i].wall.id }));
    const key = [...new Set(f.edges.map((e) => e.from))].sort().join('-');
    // longueur de chaque face de mur (utile pour les cotes intérieures / extérieures)
    inner.forEach((p, i) => {
      const ed = f.edges[i];
      sideMap.set(ed.from + '>' + ed.wall.id, {
        wall: ed.wall.id, from: ed.from, len: sides[i].len, p0: p, p1: inner[(i + 1) % inner.length],
        kind: f.outer ? 'outer' : 'room', room: f.outer ? null : key,
      });
    });
    if (f.outer) continue;
    const area = polyArea(inner);
    let label = null;
    for (const l of plan.rooms) {
      if (usedLabels.has(l.id)) continue;
      if (pointInPoly(l, f.pts)) { label = l; usedLabels.add(l.id); break; }
    }
    rooms.push({
      id: key,
      axis: f.pts.map((p) => ({ x: p.x, y: p.y })),
      inner,
      area,
      axisArea: polyArea(f.pts),
      perimeter: sides.reduce((s, q) => s + q.len, 0),
      sides,
      center: labelPoint(inner),
      labelId: label ? label.id : null,
      name: label ? label.name : '',
      color: label ? label.color : null,
    });
  }
  rooms.sort((p, q) => p.center.y - q.center.y || p.center.x - q.center.x);
  return { rooms, sides: sideMap };
}

export function computeRooms(plan) {
  return computeLayout(plan).rooms;
}

// ───────────────────────── cotes : intérieur / extérieur / axe ─────────────────────────
// side : +1 = côté gauche du mur (de a vers b), -1 = côté droit, 0 = à l'axe.
// mode : 'inner' (nu intérieur des pièces), 'outer' (nu extérieur du bâtiment), 'axis'.

export function sideEntry(plan, layout, wallId, side) {
  const w = plan.walls.find((q) => q.id === wallId);
  if (!w || !side) return null;
  return layout.sides.get((side === 1 ? w.a : w.b) + '>' + wallId) || null;
}

// Quelle face mesurer pour ce mur : celle demandée si elle convient au mode, sinon l'autre.
export function resolveSide(plan, layout, wallId, pref, mode) {
  if (mode === 'axis') return { side: 0, entry: null };
  const want = mode === 'inner' ? 'room' : 'outer';
  const ents = (pref === -1 ? [-1, 1] : [1, -1])
    .map((sd) => ({ side: sd, entry: sideEntry(plan, layout, wallId, sd) })).filter((x) => x.entry);
  const match = ents.find((x) => x.entry.kind === want);
  if (match) return match;
  const room = ents.find((x) => x.entry.kind === 'room');
  if (mode === 'outer' && room) return room; // cloison : pas de face extérieure → mesure intérieure
  return { side: 0, entry: null };
}

// Étiquettes de cotes à afficher (et à toucher). offCm : décalage vers l'intérieur de la face.
export function dimLabels(plan, layout, mode, offCm = 10) {
  const out = [];
  for (const w of plan.walls) {
    const a = plan.nodes[w.a], b = plan.nodes[w.b];
    if (!a || !b) continue;
    let used = false;
    if (mode !== 'axis') {
      const ents = [1, -1].map((sd) => ({ side: sd, e: sideEntry(plan, layout, w.id, sd) })).filter((x) => x.e);
      let chosen = ents.filter((x) => x.e.kind === 'room');
      if (mode === 'outer') {
        const outer = ents.filter((x) => x.e.kind === 'outer');
        if (outer.length) chosen = outer;
      }
      for (const { side, e } of chosen) {
        const dx = e.p1.x - e.p0.x, dy = e.p1.y - e.p0.y, l = Math.hypot(dx, dy) || 1;
        out.push({
          wall: w.id, side, len: e.len, kind: e.kind,
          x: (e.p0.x + e.p1.x) / 2 - (dy / l) * offCm, y: (e.p0.y + e.p1.y) / 2 + (dx / l) * offCm,
        });
        used = true;
      }
    }
    if (!used) out.push({ wall: w.id, side: 0, len: dist(a, b), kind: 'axis', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return out;
}

const chainSideOfWall = (seg, wall, sideW) => (wall.a === seg.from ? 1 : -1) * sideW;
const wallSideOfChain = (seg, wall, sideC) => (wall.a === seg.from ? 1 : -1) * sideC;

// Longueurs affichées des segments d'un mur entier et longueur totale, pour une face donnée.
export function chainMeasure(plan, layout, wallId, sideW) {
  const ch = wallChain(plan, wallId);
  if (!ch) return null;
  const wall = (id) => plan.walls.find((q) => q.id === id);
  if (!sideW) return { ch, lens: ch.segments.map((q) => q.len), total: ch.total, sideC: 0 };
  const sel = ch.segments[ch.index];
  const sideC = chainSideOfWall(sel, wall(sel.id), sideW);
  const ents = ch.segments.map((seg) => sideEntry(plan, layout, seg.id, wallSideOfChain(seg, wall(seg.id), sideC)));
  const lens = ch.segments.map((seg, i) => (ents[i] ? ents[i].len : seg.len));
  let total = ch.total;
  const e0 = ents[0], e1 = ents.at(-1);
  if (e0 && e1) {
    const f = ch.segments[0], l = ch.segments.at(-1);
    const start = e0.from === f.from ? e0.p0 : e0.p1;
    const end = e1.from === l.from ? e1.p1 : e1.p0;
    const A = plan.nodes[f.from], B = plan.nodes[l.to];
    const L = dist(A, B) || 1;
    total = ((end.x - start.x) * (B.x - A.x) + (end.y - start.y) * (B.y - A.y)) / L;
  }
  return { ch, lens, total, sideC };
}

// Règle la longueur d'une face de mur (intérieure / extérieure) en agissant sur l'axe, par itérations.
export function setWallFaceLength(plan, wallId, side, target, opts = {}) {
  for (let i = 0; i < 5; i++) {
    const e = sideEntry(plan, computeLayout(plan), wallId, side);
    const w = plan.walls.find((q) => q.id === wallId);
    if (!w) return false;
    const axis = wallInfo(plan, w).len;
    const diff = target - (e ? e.len : axis);
    if (Math.abs(diff) < 0.05) return true;
    if (!setWallLength(plan, wallId, axis + diff, opts)) return false;
  }
  return true;
}

// Idem pour la longueur totale d'un mur entier (suite de segments alignés).
export function setChainFaceLength(plan, wallId, side, target, opts = {}) {
  for (let i = 0; i < 5; i++) {
    const m = chainMeasure(plan, computeLayout(plan), wallId, side);
    if (!m) return false;
    const diff = target - m.total;
    if (Math.abs(diff) < 0.05) return true;
    if (!setChainLength(plan, wallId, m.ch.total + diff, opts)) return false;
  }
  return true;
}

export function setRoomMeta(plan, room, { name, color }) {
  let lab = plan.rooms.find((l) => l.id === room.labelId);
  if (!lab) {
    lab = { id: uid('r'), name: '', color: null, x: room.center.x, y: room.center.y };
    plan.rooms.push(lab);
  }
  if (name !== undefined) lab.name = name;
  if (color !== undefined) lab.color = color;
  return lab;
}

export function planSummary(plan) {
  const rooms = computeRooms(plan);
  const total = rooms.reduce((s, r) => s + r.area, 0);
  return { rooms: rooms.length, area: Math.round(total) };
}

export function planBounds(plan) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
  for (const n of Object.values(plan.nodes)) add(n.x, n.y, 15);
  for (const f of plan.furniture) add(f.x, f.y, Math.max(f.w, f.d) / 2);
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1 };
}

// ───────────────────────── mobilier ─────────────────────────

export const FURNITURE = [
  { cat: 'Chambre', kind: 'bed140', name: 'Lit 140', w: 140, d: 190 },
  { cat: 'Chambre', kind: 'bed160', name: 'Lit 160', w: 160, d: 200 },
  { cat: 'Chambre', kind: 'bed90', name: 'Lit 90', w: 90, d: 190 },
  { cat: 'Chambre', kind: 'nightstand', name: 'Chevet', w: 40, d: 40 },
  { cat: 'Chambre', kind: 'wardrobe', name: 'Armoire', w: 120, d: 60 },
  { cat: 'Chambre', kind: 'dresser', name: 'Commode', w: 100, d: 50 },
  { cat: 'Salon', kind: 'sofa2', name: 'Canapé 2 pl.', w: 160, d: 90 },
  { cat: 'Salon', kind: 'sofa3', name: 'Canapé 3 pl.', w: 210, d: 90 },
  { cat: 'Salon', kind: 'armchair', name: 'Fauteuil', w: 80, d: 80 },
  { cat: 'Salon', kind: 'coffee', name: 'Table basse', w: 100, d: 50 },
  { cat: 'Salon', kind: 'tv', name: 'Meuble TV', w: 150, d: 40 },
  { cat: 'Salon', kind: 'shelf', name: 'Bibliothèque', w: 90, d: 30 },
  { cat: 'Repas', kind: 'table160', name: 'Table 160', w: 160, d: 90 },
  { cat: 'Repas', kind: 'tableround', name: 'Table ronde', w: 100, d: 100, shape: 'round' },
  { cat: 'Repas', kind: 'chair', name: 'Chaise', w: 45, d: 45 },
  { cat: 'Cuisine', kind: 'fridge', name: 'Frigo', w: 60, d: 65 },
  { cat: 'Cuisine', kind: 'hob', name: 'Plaque', w: 60, d: 60 },
  { cat: 'Cuisine', kind: 'sink', name: 'Évier', w: 120, d: 60 },
  { cat: 'Cuisine', kind: 'counter', name: 'Élément 60', w: 60, d: 60 },
  { cat: 'Cuisine', kind: 'washer', name: 'Lave-linge', w: 60, d: 60 },
  { cat: 'Bain', kind: 'bath', name: 'Baignoire', w: 170, d: 70 },
  { cat: 'Bain', kind: 'shower', name: 'Douche', w: 90, d: 90 },
  { cat: 'Bain', kind: 'basin', name: 'Lavabo', w: 60, d: 50 },
  { cat: 'Bain', kind: 'wc', name: 'WC', w: 40, d: 70 },
  { cat: 'Bureau', kind: 'desk', name: 'Bureau', w: 140, d: 70 },
  { cat: 'Bureau', kind: 'officechair', name: 'Fauteuil', w: 60, d: 60, shape: 'round' },
  { cat: 'Autre', kind: 'rect', name: 'Rectangle', w: 100, d: 60 },
  { cat: 'Autre', kind: 'round', name: 'Cercle', w: 80, d: 80, shape: 'round' },
];

export function addFurniture(plan, spec, x, y) {
  const f = {
    id: uid('f'), kind: spec.kind || 'rect', name: spec.name || '', x: round1(x), y: round1(y),
    w: spec.w, d: spec.d, rot: 0, shape: spec.shape || 'rect',
  };
  plan.furniture.push(f);
  return f;
}

export function furnitureCorners(f) {
  const r = (f.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const lx = (sx * f.w) / 2, ly = (sy * f.d) / 2;
    return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
  });
}

export function pointInFurniture(p, f) {
  const r = (-f.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = p.x - f.x, dy = p.y - f.y;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  if (f.shape === 'round') return (lx / (f.w / 2)) ** 2 + (ly / (f.d / 2)) ** 2 <= 1;
  return Math.abs(lx) <= f.w / 2 && Math.abs(ly) <= f.d / 2;
}


// ───────────────────────── cotes verrouillées ─────────────────────────
// Une cote saisie est verrouillée : une autre modification ne peut pas la faire changer.
//  {kind:'wall',  wall, side, ref, len}   longueur d'une face (ou de l'axe) d'un segment
//  {kind:'chain', wall, side, ref, len}   longueur totale d'un mur entier
//  {kind:'gap',   wa, wb, dx, dy, sa, sb, len}   écart entre deux murs parallèles (outil Mesure)

export function lockValue(plan, layout, lk) {
  if (lk.kind === 'measure') {
    const m = (plan.measures || []).find((q) => q.id === lk.measure);
    const e = m && measureEnds(plan, m);
    return e ? dist(e.A, e.B) : null;
  }
  if (lk.kind === 'gap') {
    const wa = plan.walls.find((q) => q.id === lk.wa), wb = plan.walls.find((q) => q.id === lk.wb);
    const A = wa && plan.nodes[wa.a], B = wb && plan.nodes[wb.a];
    if (!A || !B) return null;
    return (B.x * lk.dx + B.y * lk.dy + lk.sb) - (A.x * lk.dx + A.y * lk.dy + lk.sa);
  }
  const w = plan.walls.find((q) => q.id === lk.wall);
  if (!w) return null;
  if (lk.kind === 'chain') { const m = chainMeasure(plan, layout, lk.wall, lk.side); return m ? m.total : null; }
  if (!lk.side) return wallInfo(plan, w).len;
  const e = sideEntry(plan, layout, lk.wall, lk.side);
  return e ? e.len : wallInfo(plan, w).len;
}

export function findLock(plan, spec) {
  return (plan.locks || []).find((l) => l.kind === spec.kind && (spec.kind === 'measure' ? l.measure === spec.measure : spec.kind === 'gap'
    ? (l.wa === spec.wa && l.wb === spec.wb) || (l.wa === spec.wb && l.wb === spec.wa)
    : l.wall === spec.wall && l.side === spec.side && l.ref === spec.ref)) || null;
}

export function upsertLock(plan, spec) {
  plan.locks ||= [];
  const l = findLock(plan, spec);
  if (l) { Object.assign(l, spec, { id: l.id }); return l; }
  const n = { id: uid('k'), ...spec };
  plan.locks.push(n);
  return n;
}

export function removeMeasure(plan, id) {
  plan.measures = (plan.measures || []).filter((m) => m.id !== id);
  plan.locks = (plan.locks || []).filter((l) => !(l.kind === 'measure' && l.measure === id));
}

export function removeLock(plan, id) {
  plan.locks = (plan.locks || []).filter((l) => l.id !== id);
}

// Première cote verrouillée qui était respectée dans `prev` et ne l'est plus dans `plan`.
export function brokenLocks(prev, plan, ignore) {
  const ignoreIds = ignore instanceof Set ? ignore : new Set([].concat(ignore || []));
  if (!plan.locks?.length) return null;
  const lp = computeLayout(prev), ln = computeLayout(plan);
  for (const lk of plan.locks) {
    if (ignoreIds.has(lk.id)) continue;
    const before = lockValue(prev, lp, lk);
    if (before == null || Math.abs(before - lk.len) > 0.5) continue;
    const now = lockValue(plan, ln, lk);
    if (now == null || Math.abs(now - lk.len) > 0.5) return lk;
  }
  return null;
}

// Verrou d'une mesure entre deux points posés sur des murs parallèles (sinon null)
export function gapSpec(plan, A, B) {
  const L = dist(A, B);
  if (L < 1 || !A.walls?.length || !B.walls?.length) return null;
  const dx = (B.x - A.x) / L, dy = (B.y - A.y) / L;
  const perp = (id) => {
    const w = plan.walls.find((q) => q.id === id);
    if (!w) return false;
    const a = plan.nodes[w.a], b = plan.nodes[w.b], l = dist(a, b) || 1;
    return Math.abs(((b.x - a.x) * dx + (b.y - a.y) * dy) / l) < 0.02;
  };
  const wa = A.walls.find(perp), wb = B.walls.find((id) => perp(id) && id !== wa);
  if (!wa || !wb) return null;
  const na = plan.nodes[plan.walls.find((q) => q.id === wa).a], nb = plan.nodes[plan.walls.find((q) => q.id === wb).a];
  return {
    kind: 'gap', wa, wb, dx, dy,
    sa: (A.x - na.x) * dx + (A.y - na.y) * dy, sb: (B.x - nb.x) * dx + (B.y - nb.y) * dy, len: L,
  };
}

// Outil Mesure : règle la distance entre deux points en décalant tout ce qui se trouve
// au-delà du point B (move:'b') ou en deçà du point A (move:'a').
export function adjustMeasure(plan, A, B, newLen, { move = 'outer' } = {}) {
  const L = dist(A, B);
  if (L < 1e-6 || !(newLen >= 1)) return false;
  if (move === 'outer') move = measureOuterMove(plan, A, B);
  if (move === 'both') { // moitié de chaque côté
    const half = (newLen - L) / 2, ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
    if (!(L + half >= 1)) return false;
    const B1 = { x: B.x + ux * half, y: B.y + uy * half };
    if (!adjustMeasure(plan, A, B, L + half, { move: 'b' })) return false;
    return adjustMeasure(plan, A, B1, newLen, { move: 'a' });
  }
  const dx = (B.x - A.x) / L, dy = (B.y - A.y) / L, delta = newLen - L;
  const tol = (P) => {
    let t = 0;
    for (const w of plan.walls) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      if (a && b && projectToSegment(P, a, b).d <= w.t / 2 + 0.6) t = Math.max(t, w.t / 2);
    }
    return t;
  };
  const pr = (o) => o.x * dx + o.y * dy;
  const fwd = move !== 'a';
  const limit = fwd ? pr(B) - tol(B) - 0.5 : pr(A) + tol(A) + 0.5;
  const k = fwd ? delta : -delta;
  const hit = (o) => (fwd ? pr(o) >= limit : pr(o) <= limit);
  // les ouvertures sont repérées depuis le début de leur mur : on les replace après le décalage
  const centers = plan.openings.map((op) => {
    const g = openingGeom(plan, op);
    return g ? { op, c: { ...g.c } } : null;
  }).filter(Boolean);
  const moving = new Set(Object.keys(plan.nodes).filter((id) => hit(plan.nodes[id])));
  growPerpendicular(plan, moving, dx, dy, null);
  for (const id of moving) { const o = plan.nodes[id]; o.x = round1(o.x + dx * k); o.y = round1(o.y + dy * k); }
  for (const o of [...plan.furniture, ...plan.rooms]) {
    if (hit(o)) { o.x = round1(o.x + dx * k); o.y = round1(o.y + dy * k); }
  }
  for (const { op, c } of centers) {
    const w = plan.walls.find((q) => q.id === op.wall);
    if (!w) continue;
    const nc = hit(c) ? { x: c.x + dx * k, y: c.y + dy * k } : c;
    const wi = wallInfo(plan, w);
    op.pos = round1((nc.x - wi.a.x) * wi.ux + (nc.y - wi.a.y) * wi.uy);
    clampOpening(plan, op);
  }
  return true;
}



// ───────────────────────── mesures conservées ─────────────────────────
// Chaque extrémité est ancrée sur un mur (position le long du mur, décalage de l'axe) : la mesure
// suit le mur quand il bouge, et sa valeur est toujours recalculée.

export function anchorPoint(plan, P) {
  const w = plan.walls.find((q) => q.id === P.walls?.[0]);
  if (!w) return null;
  const wi = wallInfo(plan, w);
  const dx = P.x - wi.a.x, dy = P.y - wi.a.y;
  return { wall: w.id, pos: round1(dx * wi.ux + dy * wi.uy), off: round1(dx * wi.nx + dy * wi.ny) };
}

export function resolveAnchor(plan, an) {
  const w = plan.walls.find((q) => q.id === an?.wall);
  if (!w) return null;
  const wi = wallInfo(plan, w);
  return { x: wi.a.x + wi.ux * an.pos + wi.nx * an.off, y: wi.a.y + wi.uy * an.pos + wi.ny * an.off };
}

export function measureEnds(plan, m) {
  const A = resolveAnchor(plan, m.a), B = resolveAnchor(plan, m.b);
  return A && B ? { A, B } : null;
}

export function addMeasure(plan, A, B) {
  const a = anchorPoint(plan, A), b = anchorPoint(plan, B);
  if (!a || !b) return null;
  plan.measures ||= [];
  const ends = (m) => measureEnds(plan, m);
  const dup = plan.measures.find((m) => {
    const e = ends(m);
    return e && ((dist(e.A, A) < 0.6 && dist(e.B, B) < 0.6) || (dist(e.A, B) < 0.6 && dist(e.B, A) < 0.6));
  });
  if (dup) return dup;
  const m = { id: uid('m'), a, b };
  plan.measures.push(m);
  return m;
}

// Cote reportée hors du plan : ligne parallèle décalée au-delà de l'emprise, prolongée par des pointillés.
// m.d (cm, signé le long de la normale (-uy,ux)) et m.s (0..1 le long de la ligne) la déplacent à la main ;
// sinon la cote s'empile automatiquement derrière celles déjà placées (`placed`) pour ne pas se superposer.
export function measureDim(plan, m, S, placed) {
  const e = measureEnds(plan, m);
  if (!e) return null;
  const { A, B } = e;
  const len = dist(A, B);
  if (len < 1) return null;
  const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
  let nx = -uy, ny = ux, D;
  if (typeof m.d === 'number') {
    if (m.d < 0) { nx = -nx; ny = -ny; }
    D = Math.max(Math.abs(m.d), 4);
  } else {
    const bb = planBounds(plan) || { x0: A.x, y0: A.y, x1: B.x, y1: B.y };
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const cen = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 };
    if ((mid.x - cen.x) * nx + (mid.y - cen.y) * ny < 0) { nx = -nx; ny = -ny; }
    D = 0;
    for (const c of [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]]) D = Math.max(D, (c[0] - A.x) * nx + (c[1] - A.y) * ny);
    D += 26 / S;
    if (placed) {
      const a0 = A.x * ux + A.y * uy, a1 = B.x * ux + B.y * uy;
      for (let k = 0; k < 12; k++) {
        const clash = placed.some((q) => {
          if (Math.abs(q.ux * uy - q.uy * ux) > 0.02) return false;
          const off = (q.A2.x - A.x) * nx + (q.A2.y - A.y) * ny;
          if (Math.abs(off - D) > 14 / S) return false;
          const q0 = q.A2.x * ux + q.A2.y * uy, q1 = q.B2.x * ux + q.B2.y * uy;
          return Math.min(Math.max(a0, a1), Math.max(q0, q1)) - Math.max(Math.min(a0, a1), Math.min(q0, q1)) > 1;
        });
        if (!clash) break;
        D += 18 / S;
      }
    }
  }
  const A2 = { x: A.x + nx * D, y: A.y + ny * D }, B2 = { x: B.x + nx * D, y: B.y + ny * D };
  const s = typeof m.s === 'number' ? Math.min(0.95, Math.max(0.05, m.s)) : 0.5;
  const dim = { A, B, A2, B2, mid: { x: A2.x + (B2.x - A2.x) * s, y: A2.y + (B2.y - A2.y) * s }, len, nx, ny, ux, uy, D };
  placed?.push(dim);
  return dim;
}


// Déplacement d'un point sans casser les angles droits : 
//  - coin / T (mur horizontal ET vertical) : dx déplace le mur vertical en entier, dy le mur horizontal en entier ;
//  - bout d'un mur vertical (resp. horizontal) : le point coulisse le long du mur (x verrouillé, resp. y) ;
//  - sinon : déplacement libre.
export function nodeDragPlan(plan, nodeId, tolDeg = 6) {
  const n = plan.nodes[nodeId];
  const tan = Math.tan((tolDeg * Math.PI) / 180);
  const H = [], V = [];
  for (const w of plan.walls) {
    if (w.a !== nodeId && w.b !== nodeId) continue;
    const o = plan.nodes[w.a === nodeId ? w.b : w.a];
    const dx = Math.abs(o.x - n.x), dy = Math.abs(o.y - n.y);
    if (dy <= dx * tan) H.push(w.id); else if (dx <= dy * tan) V.push(w.id);
  }
  const chainNodes = (wid) => {
    const c = wallChain(plan, wid);
    return c ? [c.segments[0].from, ...c.segments.map((q) => q.to)] : [];
  };
  const out = { xNodes: [nodeId], yNodes: [nodeId], lockX: false, lockY: false, ortho: false };
  if (H.length && V.length) {
    out.ortho = true;
    out.xNodes = [...new Set([nodeId, ...V.flatMap(chainNodes)])];
    out.yNodes = [...new Set([nodeId, ...H.flatMap(chainNodes)])];
  } else if (V.length) { out.ortho = true; out.lockX = true; }
  else if (H.length) { out.ortho = true; out.lockY = true; }
  return out;
}

export function moveNodeOrtho(plan, nodeId, dp, origs, tx, ty) {
  const o = origs[nodeId];
  const dx = dp.lockX ? 0 : tx - o.x, dy = dp.lockY ? 0 : ty - o.y;
  for (const id of dp.xNodes) moveNode(plan, id, origs[id].x + dx, plan.nodes[id].y);
  for (const id of dp.yNodes) moveNode(plan, id, plan.nodes[id].x, origs[id].y + dy);
}
