// Rendu 2D du plan sur un canvas. Aucune mutation du plan ici.
import { openingGeom, furnitureCorners, fmtLen, fmtArea, wallInfo } from './geometry.js';

export const ROOM_COLORS = ['#e8f0fb', '#e4f4e8', '#fdf0dc', '#fbe6ec', '#ece6fa', '#dff3f5', '#f5f0d2', '#eceff1'];
const DEFAULT_ROOM = '#f4f7fb';
const WALL = '#2b313a';
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
  ctx.beginPath(); ctx.strokeStyle = '#edf0f4';
  for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const sx = Math.round(x * S + view.ox) + 0.5; line(sx, 0, sx, H); }
  for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const sy = Math.round(y * S + view.oy) + 0.5; line(0, sy, W, sy); }
  ctx.stroke();
  if (step < 100 && 100 * S >= 18) {
    ctx.beginPath(); ctx.strokeStyle = '#dde2e8';
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
    ctx.beginPath(); ctx.moveTo(X(hx), Y(hy)); ctx.lineTo(X(ex), Y(ey));
    ctx.lineWidth = 2; ctx.strokeStyle = '#1f2937'; ctx.stroke();
    const a0 = Math.atan2(diry, dirx), a1 = Math.atan2(ny * side, nx * side);
    let diff = a1 - a0;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    ctx.beginPath(); ctx.arc(X(hx), Y(hy), r * S, a0, a1, diff < 0);
    ctx.lineWidth = 1; ctx.strokeStyle = '#6b7280'; ctx.stroke();
  };
  if (o.kind === 'double') {
    leaf(c.x - ux * half, c.y - uy * half, ux, uy, half);
    leaf(c.x + ux * half, c.y + uy * half, -ux, -uy, half);
  } else {
    const hd = o.flip ? 1 : -1;
    leaf(c.x + ux * half * hd, c.y + uy * half * hd, -ux * hd, -uy * hd, o.w);
  }
}

function drawOpeningSymbol(ctx, g, o, S, X, Y) {
  const { ux, uy, nx, ny, c, t } = g;
  const half = o.w / 2;
  const P = (a, b) => [X(c.x + ux * a + nx * b), Y(c.y + uy * a + ny * b)];
  const seg = (a1, b1, a2, b2) => { const p = P(a1, b1), q = P(a2, b2); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
  ctx.lineWidth = 1.2; ctx.strokeStyle = '#1f2937';
  if (o.kind === 'door' || o.kind === 'double') {
    // seuil
    ctx.beginPath(); seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2); ctx.stroke();
    drawDoorSymbol(ctx, g, o, S, X, Y);
  } else if (o.kind === 'window') {
    ctx.beginPath();
    seg(-half, t / 2, half, t / 2); seg(-half, -t / 2, half, -t / 2);
    seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2);
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.6; seg(-half, 0, half, 0); ctx.stroke();
  } else if (o.kind === 'bay') {
    ctx.beginPath();
    seg(-half, t / 2, half, t / 2); seg(-half, -t / 2, half, -t / 2);
    seg(-half, t / 2, -half, -t / 2); seg(half, t / 2, half, -t / 2);
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.6;
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
  lctx.lineCap = 'square'; lctx.strokeStyle = WALL;
  for (const w of plan.walls) {
    const a = plan.nodes[w.a], b = plan.nodes[w.b];
    if (!a || !b) continue;
    lctx.lineWidth = Math.max(w.t * S, 1.5);
    lctx.beginPath(); lctx.moveTo(X(a.x), Y(a.y)); lctx.lineTo(X(b.x), Y(b.y)); lctx.stroke();
  }
  lctx.globalCompositeOperation = 'destination-out';
  lctx.fillStyle = '#000';
  for (const op of plan.openings) {
    const g = openingGeom(plan, op);
    if (!g) continue;
    const h = op.w / 2, th = g.t / 2 + 2 / S;
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
    if (w) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      ctx.lineCap = 'butt'; ctx.lineWidth = w.t * S + 8; ctx.strokeStyle = 'rgba(37,99,235,.35)';
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
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#1f2937';
    if (r.name) {
      ctx.font = '700 14px system-ui, sans-serif'; ctx.fillText(r.name, cx, cy - 9);
      ctx.font = '500 12px system-ui, sans-serif'; ctx.fillStyle = '#475569'; ctx.fillText(fmtArea(r.area), cx, cy + 8);
    } else {
      ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = '#475569'; ctx.fillText(fmtArea(r.area), cx, cy);
    }
  }

  // cotes
  if (o.dims) {
    for (const w of plan.walls) {
      const wi = wallInfo(plan, w);
      if (wi.len * S < 38) continue;
      const hot = sel?.type === 'wall' && sel.id === w.id;
      pill(ctx, fmtLen(wi.len), X((wi.a.x + wi.b.x) / 2), Y((wi.a.y + wi.b.y) / 2), hot ? { fg: '#fff', bg: BLUE, border: BLUE } : {});
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

  // nœuds
  if (o.showNodes) {
    for (const [id, n] of Object.entries(plan.nodes)) {
      const hot = sel?.type === 'wall' && plan.walls.some((w) => w.id === sel.id && (w.a === id || w.b === id));
      ctx.beginPath(); ctx.arc(X(n.x), Y(n.y), hot ? 9 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = hot ? 2.5 : 1.3; ctx.strokeStyle = hot ? BLUE : '#64748b'; ctx.stroke();
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
      pill(ctx, `${fmtLen(len)} · ${Math.round(ang)}°`, (X(d.last.x) + X(pv.x)) / 2, (Y(d.last.y) + Y(pv.y)) / 2 - 18, { fg: '#fff', bg: BLUE, border: BLUE });
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
