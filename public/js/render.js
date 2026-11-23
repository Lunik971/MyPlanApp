// Rendu 2D du plan sur un canvas. Aucune mutation du plan ici.
import { openingGeom, furnitureCorners, fmtLen, fmtArea, wallInfo, dimLabels, resolveSide, wallChain } from './geometry.js';

export const ROOM_COLORS = ['#e8f0fb', '#e4f4e8', '#fdf0dc', '#fbe6ec', '#ece6fa', '#dff3f5', '#f5f0d2', '#eceff1'];
const DEFAULT_ROOM = '#f6f8fb';
const WALL_FILL = '#d9dee5';   // intérieur des murs
const WALL_LINE = '#303843';   // contour des murs
const BLUE = '#2563eb';

const niceUp = (v, list = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]) => list.find((n) => n >= v) || list.at(-1);

function pill(ctx, text, x, y, { fg = '#334155', bg = 'rgba(255,255,255,.92)', border = '#cbd5e1', font = '600 11px system-ui, sans-serif' } = {}) {
  ctx.font = font;
  const w = ctx.measureText(text).width + 10, h = 18;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, 6); else ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fillStyle = bg; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = border; ctx.stroke();
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}

function haloText(ctx, text, x, y, { fg = '#52607a', font = '600 11px system-ui, sans-serif', halo = 'rgba(255,255,255,.92)', w = 3.5 } = {}) {
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = w; ctx.strokeStyle = halo; ctx.strokeText(text, x, y + 0.5);
  ctx.fillStyle = fg; ctx.fillText(text, x, y + 0.5);
}

function polyPath(ctx, pts, X, Y) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
  ctx.closePath();
}

function drawGrid(ctx, W, H, view) {
  const S = view.s;
  const step = niceUp(14 / S);
  const x0 = -view.ox / S, y0 = -view.oy / S, x1 = (W - view.ox) / S, y1 = (H - view.oy) / S;
  ctx.lineWidth = 1;
  const line = (a, b, c, d) => { ctx.moveTo(a, b); ctx.lineTo(c, d); };
  ctx.beginPath(); ctx.strokeStyle = '#f1f3f6';
  for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const sx = Math.round(x * S + view.ox) + 0.5; line(sx, 0, sx, H); }
  for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const sy = Math.round(y * S + view.oy) + 0.5; line(0, sy, W, sy); }
  ctx.stroke();
  if (step < 100 && 100 * S >= 18) {
    ctx.beginPath(); ctx.strokeStyle = '#e4e8ed';
    for (let x = Math.floor(x0 / 100) * 100; x <= x1; x += 100) { const sx = Math.round(x * S + view.ox) + 0.5; line(sx, 0, sx, H); }
    for (let y = Math.floor(y0 / 100) * 100; y <= y1; y += 100) { const sy = Math.round(y * S + view.oy) + 0.5; line(0, sy, W, sy); }
    ctx.stroke();
  }
}

function drawDoorSymbol(ctx, g, o, S, X, Y) {
  const { ux, uy, nx, ny, c } = g;
  const side = o.side || 1;
  const half = o.w / 2;
  const leaf = (hx, hy, dirx, diry, r) => {
    // charnière (hx,hy), le vantail ouvert est perpendiculaire au mur, côté « side »
    const ex = hx + nx * side * r, ey = hy + ny * side * r;
    const a0 = Math.atan2(diry, dirx), a1 = Math.atan2(ny * side, nx * side);
    let diff = a1 - a0;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    // zone de débattement teintée, puis arc, puis vantail bien marqué
    ctx.beginPath(); ctx.moveTo(X(hx), Y(hy)); ctx.arc(X(hx), Y(hy), r * S, a0, a1, diff < 0); ctx.closePath();
    ctx.fillStyle = 'rgba(37,99,235,.09)'; ctx.fill();
    ctx.beginPath(); ctx.arc(X(hx), Y(hy), r * S, a0, a1, diff < 0);
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#5b6b82'; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(X(hx), Y(hy)); ctx.lineTo(X(ex), Y(ey));
    ctx.lineWidth = 2.4; ctx.strokeStyle = BLUE; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(X(hx), Y(hy), 2.6, 0, Math.PI * 2); ctx.fillStyle = BLUE; ctx.fill();
  };
  if (o.kind === 'double') {
    leaf(c.x - ux * half, c.y - uy * half, ux, uy, half);
    leaf(c.x + ux * half, c.y + uy * half, -ux, -uy, half);
  } else {
    const hd = o.flip ? 1 : -1;
    leaf(c.x + ux * half * hd, c.y + uy * half * hd, -ux * hd, -uy * hd, o.w);
  }
}

function drawPassage(ctx, g, o, S, X, Y, P, seg) {
  const { t } = g;
  const half = o.w / 2;
  ctx.lineWidth = 1.8; ctx.strokeStyle = WALL_LINE;
  if (o.kind === 'arch') {
    // arche : montants à bouts arrondis + trait pointillé de linteau
    ctx.lineWidth = 1.6;
    const r = Math.min(t / 2, 14);
    ctx.beginPath();
    for (const sd of [-1, 1]) {
      const ex = half * sd;
      for (const fy of [-1, 1]) {
        const a = P(ex, fy * (t / 2 - r)), b = P(ex - sd * r, fy * t / 2);
        const cc = P(ex - sd * r, fy * (t / 2 - r));
        ctx.moveTo(a[0], a[1]);
        ctx.quadraticCurveTo(P(ex, fy * t / 2)[0], P(ex, fy * t / 2)[1], b[0], b[1]);
        void cc;
      }
      seg(ex, t / 2 - r, ex, -(t / 2 - r));
    }
    ctx.stroke();
    ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#5b6b82'; ctx.lineWidth = 1; seg(-half, 0, half, 0); ctx.stroke(); ctx.setLineDash([]);
  } else if (o.kind === 'frame') {
    // cadre de porte sans vantail : deux montants pleins + seuil
    const fw = Math.min(6, o.w / 4);
    ctx.fillStyle = WALL_LINE;
    for (const sd of [-1, 1]) {
      ctx.beginPath();
      [[sd * half, t / 2], [sd * (half - fw), t / 2], [sd * (half - fw), -t / 2], [sd * half, -t / 2]].forEach(([a, b], i) => { const p = P(a, b); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#5b6b82'; ctx.lineWidth = 1; seg(-half + fw, 0, half - fw, 0); ctx.stroke(); ctx.setLineDash([]);
  } else {
    ctx.beginPath(); seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2); ctx.stroke();
  }
}

function drawOpeningSymbol(ctx, g, o, S, X, Y) {
  const { ux, uy, nx, ny, c, t } = g;
  const half = o.w / 2;
  const P = (a, b) => [X(c.x + ux * a + nx * b), Y(c.y + uy * a + ny * b)];
  const seg = (a1, b1, a2, b2) => { const p = P(a1, b1), q = P(a2, b2); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
  ctx.lineWidth = 1.2; ctx.strokeStyle = WALL_LINE; ctx.lineJoin = 'round';
  if (o.kind === 'door' || o.kind === 'double') {
    // seuil
    ctx.lineWidth = 1.8;
    ctx.beginPath(); seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2); ctx.stroke();
    drawDoorSymbol(ctx, g, o, S, X, Y);
  } else if (o.kind === 'arch' || o.kind === 'frame' || o.kind === 'opening') {
    // bande teintée : le passage reste visible même sans vantail
    ctx.beginPath();
    [[-half, t / 2], [half, t / 2], [half, -t / 2], [-half, -t / 2]].forEach(([a, b], i) => { const q = P(a, b); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
    ctx.closePath(); ctx.fillStyle = 'rgba(37,99,235,.10)'; ctx.fill();
    drawPassage(ctx, g, o, S, X, Y, P, seg);
  } else if (o.kind === 'window') {
    ctx.beginPath();
    seg(-half, t / 2, half, t / 2); seg(-half, -t / 2, half, -t / 2);
    seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2);
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = '#7fb0ee'; ctx.lineWidth = 1.5; seg(-half, 0, half, 0); ctx.stroke();
  } else if (o.kind === 'bay') {
    ctx.beginPath();
    seg(-half, t / 2, half, t / 2); seg(-half, -t / 2, half, -t / 2);
    seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2);
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = '#7fb0ee'; ctx.lineWidth = 1.5;
    seg(-half, t / 6, half * 0.1, t / 6); seg(-half * 0.1, -t / 6, half, -t / 6);
    ctx.stroke();
  } else {
    ctx.beginPath(); seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2); ctx.stroke();
  }
}

function drawFurniture(ctx, f, S, X, Y, selected) {
  ctx.save();
  ctx.translate(X(f.x), Y(f.y));
  ctx.rotate((f.rot * Math.PI) / 180);
  ctx.scale(S, S);
  const w = f.w, d = f.d;
  ctx.lineWidth = 1.4 / S;
  ctx.fillStyle = '#fffaf0'; ctx.strokeStyle = '#a07f43';
  ctx.beginPath();
  if (f.shape === 'round') ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); else ctx.rect(-w / 2, -d / 2, w, d);
  ctx.fill(); ctx.stroke();
  ctx.lineWidth = 1 / S; ctx.strokeStyle = '#c4a46a';
  const k = f.kind || '';
  const r = (x, y, ww, hh, rad = 0) => { ctx.beginPath(); if (rad && ctx.roundRect) ctx.roundRect(x, y, ww, hh, rad); else ctx.rect(x, y, ww, hh); ctx.stroke(); };
  if (k.startsWith('bed')) {
    const pw = w / 2 - 8;
    r(-w / 2 + 5, -d / 2 + 5, pw, Math.min(35, d / 5), 6); r(3, -d / 2 + 5, pw, Math.min(35, d / 5), 6);
    ctx.beginPath(); ctx.moveTo(-w / 2, -d / 2 + d * 0.35); ctx.lineTo(w / 2, -d / 2 + d * 0.35); ctx.stroke();
  } else if (k.startsWith('sofa') || k === 'armchair') {
    r(-w / 2 + 3, -d / 2 + 3, w - 6, d * 0.28, 6);
    r(-w / 2 + 3, -d / 2 + 3, 12, d - 6, 6); r(w / 2 - 15, -d / 2 + 3, 12, d - 6, 6);
  } else if (k === 'hob') {
    for (const [cx, cy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) { ctx.beginPath(); ctx.arc(cx * w, cy * d, Math.min(w, d) * 0.15, 0, Math.PI * 2); ctx.stroke(); }
  } else if (k === 'sink') {
    r(-w / 2 + 6, -d / 2 + 6, w / 2 - 9, d - 12, 5); r(3, -d / 2 + 6, w / 2 - 9, d - 12, 5);
  } else if (k === 'bath') {
    r(-w / 2 + 6, -d / 2 + 6, w - 12, d - 12, Math.min(d, 30));
  } else if (k === 'shower') {
    ctx.beginPath(); ctx.moveTo(-w / 2, -d / 2); ctx.lineTo(w / 2, d / 2); ctx.moveTo(w / 2, -d / 2); ctx.lineTo(-w / 2, d / 2); ctx.stroke();
  } else if (k === 'wc') {
    r(-w / 2 + 4, -d / 2 + 3, w - 8, 16, 3);
    ctx.beginPath(); ctx.ellipse(0, d / 2 - d * 0.32, w / 2 - 6, d * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
  } else if (k === 'basin') {
    ctx.beginPath(); ctx.ellipse(0, 3, w / 2 - 8, d / 2 - 8, 0, 0, Math.PI * 2); ctx.stroke();
  } else if (k === 'washer') {
    ctx.beginPath(); ctx.arc(0, 4, Math.min(w, d) * 0.3, 0, Math.PI * 2); ctx.stroke();
  } else if (k === 'wardrobe' || k === 'dresser' || k === 'shelf') {
    ctx.beginPath(); ctx.moveTo(0, -d / 2); ctx.lineTo(0, d / 2); ctx.stroke();
  } else if (k === 'tv') {
    r(-w / 2 + 10, -d / 2 + 8, w - 20, 6);
  }
  ctx.restore();
  // libellé (toujours droit)
  if (Math.min(f.w, f.d) * S >= 22 || f.w * S >= 60) {
    const fs = Math.max(9, Math.min(12, Math.min(f.w, f.d) * S * 0.28));
    ctx.font = `500 ${fs}px system-ui, sans-serif`;
    ctx.fillStyle = '#6b5428'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (f.name) ctx.fillText(f.name, X(f.x), Y(f.y));
  }
  if (selected) {
    const cs = furnitureCorners(f);
    ctx.beginPath();
    cs.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.closePath();
    ctx.lineWidth = 2; ctx.strokeStyle = BLUE; ctx.stroke();
  }
}

export function rotateHandle(f, S) {
  const r = (f.rot * Math.PI) / 180;
  const off = f.d / 2 + 30 / S;
  return { x: f.x + Math.sin(r) * off, y: f.y - Math.cos(r) * off };
}

/**
 * @param ctx   contexte 2D déjà mis à l'échelle (CSS px)
 * @param W,H   taille CSS du canvas
 * @param view  {s, ox, oy}   écran = plan * s + o
 * @param o     {layer, sel, grid, dims, draft, ghost, showNodes, handles, bg, mergeMark, exporting}
 */
export function renderPlan(ctx, W, H, plan, rooms, view, o = {}) {
  const S = view.s;
  const X = (x) => x * S + view.ox, Y = (y) => y * S + view.oy;
  const sel = o.sel || null;

  ctx.save();
  ctx.fillStyle = o.bg || '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (o.grid) drawGrid(ctx, W, H, view);

  // pièces
  for (const r of rooms) {
    polyPath(ctx, r.inner, X, Y);
    ctx.fillStyle = r.color || DEFAULT_ROOM; ctx.fill();
  }

  // murs sur un calque, puis découpe des ouvertures
  const layer = o.layer;
  const lctx = layer.getContext('2d');
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, layer.width, layer.height);
  lctx.setTransform(ctx.getTransform());
  lctx.lineCap = 'square'; lctx.lineJoin = 'miter';
  const ow = Math.max(1.1, Math.min(1.8, S * 4)); // épaisseur du trait de contour (px)
  for (const pass of [0, 1]) {
    lctx.strokeStyle = pass === 0 ? WALL_LINE : WALL_FILL;
    for (const w of plan.walls) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      if (!a || !b) continue;
      const base = Math.max(w.t * S, 2.2);
      lctx.lineWidth = pass === 0 ? base + ow * 2 : base;
      lctx.beginPath(); lctx.moveTo(X(a.x), Y(a.y)); lctx.lineTo(X(b.x), Y(b.y)); lctx.stroke();
    }
  }
  lctx.globalCompositeOperation = 'destination-out';
  lctx.fillStyle = '#000';
  for (const op of plan.openings) {
    const g = openingGeom(plan, op);
    if (!g) continue;
    const h = op.w / 2, th = g.t / 2 + (ow + 1) / S;
    const P = (a, b) => [X(g.c.x + g.ux * a + g.nx * b), Y(g.c.y + g.uy * a + g.ny * b)];
    lctx.beginPath();
    [[-h, -th], [h, -th], [h, th], [-h, th]].forEach(([a, b], i) => { const p = P(a, b); i ? lctx.lineTo(p[0], p[1]) : lctx.moveTo(p[0], p[1]); });
    lctx.closePath(); lctx.fill();
  }
  lctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();

  // sélection : mur
  if (sel?.type === 'wall') {
    const w = plan.walls.find((q) => q.id === sel.id);
    const ch = w && wallChain(plan, w.id);
    if (ch && ch.segments.length > 1) {
      ctx.lineCap = 'butt';
      for (const sg of ch.segments) {
        if (sg.id === sel.id) continue;
        const ww = plan.walls.find((q) => q.id === sg.id), a = plan.nodes[sg.from], b = plan.nodes[sg.to];
        ctx.lineWidth = Math.max(ww.t * S, 2.2) + 5; ctx.strokeStyle = 'rgba(37,99,235,.13)';
        ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); ctx.stroke();
      }
    }
    if (w) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(w.t * S, 2.2) + 7; ctx.strokeStyle = 'rgba(37,99,235,.28)';
      ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); ctx.stroke();
    }
  }
  if (sel?.type === 'room') {
    const r = rooms.find((q) => q.id === sel.id);
    if (r) { polyPath(ctx, r.inner, X, Y); ctx.lineWidth = 2.5; ctx.strokeStyle = BLUE; ctx.setLineDash([8, 5]); ctx.stroke(); ctx.setLineDash([]); }
  }

  // symboles d'ouvertures
  for (const op of plan.openings) {
    const g = openingGeom(plan, op);
    if (!g) continue;
    drawOpeningSymbol(ctx, g, op, S, X, Y);
    if (sel?.type === 'opening' && sel.id === op.id) {
      const h = op.w / 2 + 4, th = g.t / 2 + 6 / S;
      const P = (a, b) => [X(g.c.x + g.ux * a + g.nx * b), Y(g.c.y + g.uy * a + g.ny * b)];
      ctx.beginPath();
      [[-h, -th], [h, -th], [h, th], [-h, th]].forEach(([a, b], i) => { const p = P(a, b); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath(); ctx.lineWidth = 2; ctx.strokeStyle = BLUE; ctx.stroke();
    }
  }

  // mobilier
  for (const f of plan.furniture) drawFurniture(ctx, f, S, X, Y, sel?.type === 'furniture' && sel.id === f.id);

  // noms et surfaces
  for (const r of rooms) {
    if (Math.sqrt(r.area) * S < 70) continue;
    const cx = X(r.center.x), cy = Y(r.center.y);
    const halo = r.color || DEFAULT_ROOM;
    if (r.name) {
      haloText(ctx, r.name, cx, cy - 9, { fg: '#1e293b', font: '700 14px system-ui, sans-serif', halo, w: 4 });
      haloText(ctx, fmtArea(r.area), cx, cy + 8, { fg: '#64748b', font: '500 12px system-ui, sans-serif', halo, w: 4 });
    } else {
      haloText(ctx, fmtArea(r.area), cx, cy, { fg: '#64748b', font: '600 12px system-ui, sans-serif', halo, w: 4 });
    }
  }

  // cotes (intérieures, extérieures ou à l'axe selon le réglage du plan)
  if (o.dims) {
    const mode = o.dimRef || 'axis';
    const lay = o.layout;
    const labels = lay ? dimLabels(plan, lay, mode, 11 / S) : dimLabels(plan, { sides: new Map() }, 'axis');
    const selSide = sel?.type === 'wall' && lay ? resolveSide(plan, lay, sel.id, sel.side || 1, mode).side : 0;
    for (const l of labels) {
      if (l.len * S < 38) continue;
      const hot = sel?.type === 'wall' && sel.id === l.wall && l.side === selSide;
      const txt = (o.isLocked?.(l.wall, l.side) ? '🔒 ' : '') + fmtLen(l.len);
      if (hot) pill(ctx, txt, X(l.x), Y(l.y), { fg: '#fff', bg: BLUE, border: BLUE });
      else haloText(ctx, txt, X(l.x), Y(l.y));
    }
  }
  if (sel?.type === 'opening') {
    const op = plan.openings.find((q) => q.id === sel.id);
    const g = op && openingGeom(plan, op);
    if (g) pill(ctx, fmtLen(op.w), X(g.c.x + g.nx * (g.t / 2 + 16 / S)), Y(g.c.y + g.ny * (g.t / 2 + 16 / S)), { fg: '#fff', bg: BLUE, border: BLUE });
  }
  if (sel?.type === 'furniture') {
    const f = plan.furniture.find((q) => q.id === sel.id);
    if (f) {
      pill(ctx, `${fmtLen(f.w)} × ${fmtLen(f.d)}`, X(f.x), Y(f.y + Math.max(f.w, f.d) / 2 + 22 / S), { fg: '#fff', bg: BLUE, border: BLUE });
      if (o.handles) {
        const hp = rotateHandle(f, S);
        const top = { x: f.x + Math.sin((f.rot * Math.PI) / 180) * (f.d / 2), y: f.y - Math.cos((f.rot * Math.PI) / 180) * (f.d / 2) };
        ctx.beginPath(); ctx.moveTo(X(top.x), Y(top.y)); ctx.lineTo(X(hp.x), Y(hp.y)); ctx.lineWidth = 1.5; ctx.strokeStyle = BLUE; ctx.stroke();
        ctx.beginPath(); ctx.arc(X(hp.x), Y(hp.y), 11, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(X(hp.x), Y(hp.y), 5, -2.5, 1.2); ctx.stroke();
      }
    }
  }

  // nœuds : seuls ceux du mur sélectionné (poignées) ou, en mode mur, tous les points (discrets)
  if (o.showNodes) {
    for (const [id, n] of Object.entries(plan.nodes)) {
      const hot = sel?.type === 'wall' && plan.walls.some((w) => w.id === sel.id && (w.a === id || w.b === id));
      if (!hot && !o.allNodes) continue;
      ctx.beginPath(); ctx.arc(X(n.x), Y(n.y), hot ? 8 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = hot ? 2.2 : 1.1; ctx.strokeStyle = hot ? BLUE : '#7b8798'; ctx.stroke();
    }
  }

  // fantôme d'ouverture
  if (o.ghost) {
    const gh = o.ghost;
    const g = openingGeom(plan, { wall: gh.wall, pos: gh.pos });
    if (g) {
      const h = gh.w / 2, th = g.t / 2 + 4 / S;
      const P = (a, b) => [X(g.c.x + g.ux * a + g.nx * b), Y(g.c.y + g.uy * a + g.ny * b)];
      ctx.beginPath();
      [[-h, -th], [h, -th], [h, th], [-h, th]].forEach(([a, b], i) => { const p = P(a, b); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath(); ctx.fillStyle = 'rgba(37,99,235,.25)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = BLUE; ctx.stroke();
    }
  }

  // outil Mesure
  const ms = o.meas;
  if (ms) {
    const pts = [ms.A, ms.B || ms.preview].filter(Boolean);
    if (ms.A && !ms.B && !ms.preview) pts.length = 1;
    const mark = (P, c) => { ctx.beginPath(); ctx.arc(X(P.x), Y(P.y), 5, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); };
    if (pts.length === 2) {
      const [P, Q] = pts;
      const dxs = X(Q.x) - X(P.x), dys = Y(Q.y) - Y(P.y), ls = Math.hypot(dxs, dys) || 1;
      const nx = -dys / ls * 6, ny = dxs / ls * 6;
      ctx.beginPath(); ctx.setLineDash(ms.B ? [] : [6, 5]); ctx.lineWidth = 1.6; ctx.strokeStyle = BLUE;
      ctx.moveTo(X(P.x), Y(P.y)); ctx.lineTo(X(Q.x), Y(Q.y));
      ctx.moveTo(X(P.x) - nx, Y(P.y) - ny); ctx.lineTo(X(P.x) + nx, Y(P.y) + ny);
      ctx.moveTo(X(Q.x) - nx, Y(Q.y) - ny); ctx.lineTo(X(Q.x) + nx, Y(Q.y) + ny);
      ctx.stroke(); ctx.setLineDash([]);
      const dd = Math.hypot(Q.x - P.x, Q.y - P.y);
      pill(ctx, fmtLen(dd), (X(P.x) + X(Q.x)) / 2 + nx * 2.2, (Y(P.y) + Y(Q.y)) / 2 + ny * 2.2, { fg: '#fff', bg: BLUE, border: BLUE });
      mark(P, BLUE); mark(Q, ms.B ? BLUE : '#93b4f5');
    } else if (pts.length === 1) mark(pts[0], BLUE);
    if (!ms.B && ms.preview && !ms.A) mark(ms.preview, '#93b4f5');
  }

  // tracé en cours
  const d = o.draft;
  if (d) {
    const pv = d.preview;
    for (const gd of d.guides || []) {
      ctx.beginPath(); ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(16,185,129,.8)'; ctx.lineWidth = 1;
      if (gd.x !== undefined) { ctx.moveTo(X(gd.x), 0); ctx.lineTo(X(gd.x), H); } else { ctx.moveTo(0, Y(gd.y)); ctx.lineTo(W, Y(gd.y)); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (d.last && pv) {
      ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(plan.settings.wallT * S, 2); ctx.strokeStyle = 'rgba(37,99,235,.45)';
      ctx.beginPath(); ctx.moveTo(X(d.last.x), Y(d.last.y)); ctx.lineTo(X(pv.x), Y(pv.y)); ctx.stroke();
      const len = Math.hypot(pv.x - d.last.x, pv.y - d.last.y);
      let ang = (Math.atan2(-(pv.y - d.last.y), pv.x - d.last.x) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      const shown = Math.max(0, len + (o.dimDelta || 0));
      const tag = o.dimRef === 'inner' ? ' int.' : o.dimRef === 'outer' ? ' ext.' : '';
      pill(ctx, `${fmtLen(shown)}${tag} · ${Math.round(ang)}°`, (X(d.last.x) + X(pv.x)) / 2, (Y(d.last.y) + Y(pv.y)) / 2 - 18, { fg: '#fff', bg: BLUE, border: BLUE });
    }
    if (d.last) {
      ctx.beginPath(); ctx.arc(X(d.last.x), Y(d.last.y), 6, 0, Math.PI * 2); ctx.fillStyle = BLUE; ctx.fill();
    }
    if (pv) {
      ctx.beginPath(); ctx.arc(X(pv.x), Y(pv.y), pv.node || pv.wall ? 10 : 7, 0, Math.PI * 2);
      ctx.fillStyle = pv.node || pv.wall ? 'rgba(16,185,129,.35)' : 'rgba(37,99,235,.2)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = pv.node || pv.wall ? '#10b981' : BLUE; ctx.stroke();
    }
  }
  if (o.mergeMark) {
    ctx.beginPath(); ctx.arc(X(o.mergeMark.x), Y(o.mergeMark.y), 14, 0, Math.PI * 2);
    ctx.lineWidth = 3; ctx.strokeStyle = '#10b981'; ctx.stroke();
  }
  ctx.restore();
}
