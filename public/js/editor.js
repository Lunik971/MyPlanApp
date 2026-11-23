// Éditeur de plan : interactions tactiles/souris, sélection, annuler/rétablir.
import * as G from './geometry.js';
import { renderPlan, rotateHandle } from './render.js';

const TAP_PX = 7;
const NICE = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const niceUp = (v) => NICE.find((n) => n >= v) || NICE.at(-1);
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

export class Editor {
  /**
   * hooks: { change(), select(sel), draft(draft|null), tool(tool), toast(msg) }
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.hooks = hooks;
    this.plan = G.emptyPlan();
    this.rooms = [];
    this.layout = { rooms: [], sides: new Map() };
    this.view = { s: 0.4, ox: 40, oy: 40 };
    this.tool = 'select';
    this.openingKind = 'door';
    this.sel = null;
    this.draft = null;
    this.meas = null;
    this.ghost = null;
    this.mergeMark = null;
    this.undoStack = [];
    this.redoStack = [];
    this.pointers = new Map();
    this.gesture = null;
    this.pinch = null;
    this.locked = false;
    this._raf = 0;
    this.W = 300; this.H = 300;
    this.inset = 0; // hauteur masquée en bas par le panneau d'outils

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e, true));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
    this._key = (e) => this.onKey(e);
    window.addEventListener('keydown', this._key);
    this.resize();
  }

  destroy() {
    this._ro.disconnect();
    window.removeEventListener('keydown', this._key);
  }

  // ───────── plan / historique ─────────

  setPlan(plan, { fit = true } = {}) {
    this.plan = G.normalizePlan(plan);
    this.relayout();
    this.undoStack = []; this.redoStack = [];
    this.sel = null; this.draft = null; this.ghost = null;
    this.hooks.select?.(null);
    this.hooks.draft?.(null);
    this.hooks.history?.();
    if (fit) this.fit();
    this.draw();
  }

  snapshot() {
    this.undoStack.push(JSON.stringify(this.plan));
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack = [];
    this.hooks.history?.();
  }

  relayout() {
    this.layout = G.computeLayout(this.plan);
    this.rooms = this.layout.rooms;
  }

  afterChange() {
    this.relayout();
    this.checkSelection();
    this.hooks.change?.();
    this.draw();
  }

  mutate(fn) {
    this.snapshot();
    fn(this.plan);
    if (!this.guardLocks()) return;
    this.afterChange();
  }

  // Refuse (et annule) une modification qui ferait changer une cote verrouillée
  guardLocks(ignoreId) {
    const prevJson = this.undoStack.at(-1);
    if (!prevJson || !this.plan.locks?.length) return true;
    const prev = G.normalizePlan(JSON.parse(prevJson));
    const bad = G.brokenLocks(prev, this.plan, ignoreId);
    if (!bad) return true;
    this.undoStack.pop();
    this.plan = prev;
    this.afterChange();
    this.hooks.history?.();
    this.hooks.toast?.(`🔒 Cote verrouillée (${G.fmtLen(bad.len)}) : déverrouillez-la pour la modifier`);
    return false;
  }

  lockSpec(kind) {
    const w = this.selected;
    if (!w) return null;
    const ref = this.dimRef;
    const r = G.resolveSide(this.plan, this.layout, w.id, this.sel.side || 1, ref);
    return { kind, wall: w.id, side: r.side, ref, side0: r.side };
  }

  isLocked(kind) {
    const sp = this.lockSpec(kind);
    return !!(sp && G.findLock(this.plan, sp));
  }

  toggleLock(kind, len) {
    const sp = this.lockSpec(kind);
    if (!sp) return;
    const ex = G.findLock(this.plan, sp);
    this.snapshot();
    if (ex) G.removeLock(this.plan, ex.id);
    else G.upsertLock(this.plan, { kind: sp.kind, wall: sp.wall, side: sp.side, ref: sp.ref, len });
    this.afterChange();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.plan));
    this.plan = G.normalizePlan(JSON.parse(this.undoStack.pop()));
    this.draft = this.draft?.last ? { ...this.draft, last: null, first: null, count: 0 } : this.draft;
    this.afterChange();
    this.hooks.history?.();
    this.hooks.draft?.(this.draft);
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.plan));
    this.plan = G.normalizePlan(JSON.parse(this.redoStack.pop()));
    this.afterChange();
    this.hooks.history?.();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  checkSelection() {
    const s = this.sel;
    if (!s) return;
    let ok = true;
    if (s.type === 'wall') ok = this.plan.walls.some((w) => w.id === s.id);
    else if (s.type === 'opening') ok = this.plan.openings.some((o) => o.id === s.id);
    else if (s.type === 'furniture') ok = this.plan.furniture.some((f) => f.id === s.id);
    else if (s.type === 'room') ok = this.rooms.some((r) => r.id === s.id);
    if (!ok) { this.sel = null; this.hooks.select?.(null); }
  }

  select(sel) {
    this.sel = sel;
    this.hooks.select?.(sel);
    this.draw();
  }

  get selected() {
    const s = this.sel;
    if (!s) return null;
    if (s.type === 'wall') return this.plan.walls.find((w) => w.id === s.id) || null;
    if (s.type === 'opening') return this.plan.openings.find((o) => o.id === s.id) || null;
    if (s.type === 'furniture') return this.plan.furniture.find((f) => f.id === s.id) || null;
    if (s.type === 'room') return this.rooms.find((r) => r.id === s.id) || null;
    return null;
  }

  // ───────── outils ─────────

  setTool(tool) {
    this.tool = tool;
    this.draft = tool === 'wall' ? { last: null, first: null, preview: null, guides: [], count: 0 } : null;
    this.meas = tool === 'measure' ? { A: null, B: null, preview: null } : null;
    this.hooks.meas?.(this.meas);
    this.ghost = null;
    if (tool !== 'select') this.select(null);
    this.hooks.tool?.(tool);
    this.hooks.draft?.(this.draft);
    this.draw();
  }

  setOpeningKind(k) { this.openingKind = k; this.draw(); }

  finishDraft() {
    if (!this.draft) return;
    this.draft = { last: null, first: null, preview: null, guides: [], count: 0 };
    this.hooks.draft?.(this.draft);
    this.draw();
  }

  // ───────── vue ─────────

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, Math.round(r.width)); this.H = Math.max(1, Math.round(r.height));
    for (const c of [this.canvas, this.layer]) { c.width = Math.round(this.W * dpr); c.height = Math.round(this.H * dpr); }
    this.canvas.style.width = this.W + 'px'; this.canvas.style.height = this.H + 'px';
    this.dpr = dpr;
    this.draw();
  }

  toPlan(sp) { return { x: (sp.x - this.view.ox) / this.view.s, y: (sp.y - this.view.oy) / this.view.s }; }
  toScreen(p) { return { x: p.x * this.view.s + this.view.ox, y: p.y * this.view.s + this.view.oy }; }

  setInset(px) {
    this.inset = Math.max(0, Math.round(px));
  }

  get viewH() { return Math.max(50, this.H - this.inset); }

  fit(boundsOverride) {
    const b = boundsOverride || G.planBounds(this.plan) || { x0: 0, y0: 0, x1: 1000, y1: 700 };
    const pad = 36;
    const bw = Math.max(b.x1 - b.x0, 200), bh = Math.max(b.y1 - b.y0, 200);
    const VH = this.viewH;
    const s = G.clamp(Math.min((this.W - pad * 2) / bw, (VH - pad * 2) / bh), 0.05, 3);
    this.view = { s, ox: (this.W - bw * s) / 2 - b.x0 * s, oy: (VH - bh * s) / 2 - b.y0 * s };
    this.draw();
  }

  // Fait défiler la vue pour qu'un point du plan reste dans la zone visible (au-dessus du panneau).
  ensureVisible(p, margin = 56) {
    const sp = this.toScreen(p);
    let dx = 0, dy = 0;
    const bottom = this.H - this.inset - margin;
    if (sp.y > bottom) dy = bottom - sp.y; else if (sp.y < margin) dy = margin - sp.y;
    if (sp.x > this.W - margin) dx = this.W - margin - sp.x; else if (sp.x < margin) dx = margin - sp.x;
    if (dx || dy) { this.view = { ...this.view, ox: this.view.ox + dx, oy: this.view.oy + dy }; this.draw(); }
  }

  focusOn(b) { this.fit({ x0: b.x0 - 80, y0: b.y0 - 80, x1: b.x1 + 80, y1: b.y1 + 80 }); }

  zoomAt(sp, factor) {
    const s = G.clamp(this.view.s * factor, 0.04, 8);
    const p = this.toPlan(sp);
    this.view = { s, ox: sp.x - p.x * s, oy: sp.y - p.y * s };
    this.draw();
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const sp = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (e.ctrlKey || Math.abs(e.deltaY) >= 40 || e.deltaMode) this.zoomAt(sp, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    else { this.view.ox -= e.deltaX; this.view.oy -= e.deltaY; this.draw(); }
  }

  // ───────── magnétisme ─────────

  snapStep() { return Math.max(this.plan.settings.grid || 10, niceUp(6 / this.view.s)); }

  snap(sp, { exclude } = {}) {
    const S = this.view.s, p = this.toPlan(sp), plan = this.plan;
    const res = { x: p.x, y: p.y, node: null, wall: null, guides: [] };
    let best = null, bd = 15 / S;
    for (const [id, n] of Object.entries(plan.nodes)) {
      if (id === exclude) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bd) { bd = d; best = id; }
    }
    if (best) return { ...res, x: plan.nodes[best].x, y: plan.nodes[best].y, node: best };
    let bw = null, bwd = 10 / S, bp = null;
    for (const w of plan.walls) {
      if (exclude && (w.a === exclude || w.b === exclude)) continue;
      const pr = G.projectToSegment(p, plan.nodes[w.a], plan.nodes[w.b]);
      if (pr.d < bwd && pr.t > 0 && pr.t < 1) { bwd = pr.d; bw = w.id; bp = pr; }
    }
    if (bw && !exclude) return { ...res, x: bp.x, y: bp.y, wall: bw };

    const step = this.snapStep();
    const from = this.draft?.last;
    if (from) {
      const dx = p.x - from.x, dy = p.y - from.y, L = Math.hypot(dx, dy);
      if (L < 0.5) return { ...res, x: from.x, y: from.y };
      let ang = Math.atan2(dy, dx), locked = false;
      const a45 = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(angDiff(ang, a45)) < (6 * Math.PI) / 180) { ang = a45; locked = true; }
      const len = Math.max(step, Math.round(L / step) * step);
      res.x = from.x + Math.cos(ang) * len; res.y = from.y + Math.sin(ang) * len;
      if (locked) {
        const horiz = Math.abs(Math.sin(ang)) < 1e-6, vert = Math.abs(Math.cos(ang)) < 1e-6;
        for (const n of Object.values(plan.nodes)) {
          if (horiz && Math.abs(res.x - n.x) < 8 / S) { res.x = n.x; res.guides.push({ x: n.x }); break; }
          if (vert && Math.abs(res.y - n.y) < 8 / S) { res.y = n.y; res.guides.push({ y: n.y }); break; }
        }
      }
    } else {
      res.x = Math.round(p.x / step) * step; res.y = Math.round(p.y / step) * step;
      for (const [id, n] of Object.entries(plan.nodes)) {
        if (id === exclude) continue;
        if (Math.abs(p.x - n.x) < 8 / S) { res.x = n.x; res.guides.push({ x: n.x }); break; }
      }
      for (const [id, n] of Object.entries(plan.nodes)) {
        if (id === exclude) continue;
        if (Math.abs(p.y - n.y) < 8 / S) { res.y = n.y; res.guides.push({ y: n.y }); break; }
      }
    }
    res.x = G.round1(res.x); res.y = G.round1(res.y);
    return res;
  }

  // ───────── hit-test ─────────

  hit(sp) {
    const S = this.view.s, p = this.toPlan(sp), plan = this.plan;
    const sel = this.sel;
    if (sel?.type === 'furniture') {
      const f = plan.furniture.find((q) => q.id === sel.id);
      if (f) { const h = rotateHandle(f, S); if (Math.hypot(h.x - p.x, h.y - p.y) < 16 / S) return { type: 'rotate', id: f.id }; }
    }
    if (sel?.type === 'wall') {
      const w = plan.walls.find((q) => q.id === sel.id);
      if (w) for (const nid of [w.a, w.b]) { const n = plan.nodes[nid]; if (Math.hypot(n.x - p.x, n.y - p.y) < 18 / S) return { type: 'node', id: nid }; }
    }
    for (let i = plan.furniture.length - 1; i >= 0; i--) {
      if (G.pointInFurniture(p, plan.furniture[i])) return { type: 'furniture', id: plan.furniture[i].id };
    }
    for (const o of plan.openings) {
      const g = G.openingGeom(plan, o);
      if (!g) continue;
      const along = (p.x - g.c.x) * g.ux + (p.y - g.c.y) * g.uy;
      const across = (p.x - g.c.x) * g.nx + (p.y - g.c.y) * g.ny;
      if (Math.abs(along) <= o.w / 2 + 6 / S && Math.abs(across) <= Math.max(g.t / 2, 10 / S)) return { type: 'opening', id: o.id };
    }
    if (plan.settings.dims) {
      const mode = plan.settings.dimRef || 'inner';
      for (const l of G.dimLabels(plan, this.layout, mode, 11 / S)) {
        const sp = this.toScreen(l), cp = this.toScreen(p);
        if (l.len * S >= 38 && Math.abs(sp.x - cp.x) < 28 && Math.abs(sp.y - cp.y) < 12) return { type: 'label', wall: l.wall, side: l.side };
      }
    }
    let bn = null, bnd = 14 / S;
    for (const [id, n] of Object.entries(plan.nodes)) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bnd) { bnd = d; bn = id; }
    }
    if (bn) return { type: 'node', id: bn };
    let bw = null, bwd = Infinity;
    for (const w of plan.walls) {
      const pr = G.projectToSegment(p, plan.nodes[w.a], plan.nodes[w.b]);
      const lim = Math.max(w.t / 2 + 4 / S, 11 / S);
      if (pr.d < lim && pr.d < bwd) { bwd = pr.d; bw = w.id; }
    }
    if (bw) return { type: 'wall', id: bw };
    for (const r of this.rooms) if (G.pointInPoly(p, r.inner)) return { type: 'room', id: r.id };
    return null;
  }

  // Côté (+1 gauche / -1 droite de a→b) où se trouve le point p par rapport au mur
  tapSide(wallId, p) {
    const w = this.plan.walls.find((q) => q.id === wallId);
    if (!w) return 1;
    const wi = G.wallInfo(this.plan, w);
    return (p.x - wi.a.x) * wi.nx + (p.y - wi.a.y) * wi.ny >= 0 ? 1 : -1;
  }

  get dimRef() { return this.plan.settings.dimRef || 'inner'; }

  // Écart entre la cote affichée et la longueur à l'axe, pour un mur dont les deux bouts sont d'équerre
  dimDelta() {
    const t = this.plan.settings.wallT || 10;
    return this.dimRef === 'inner' ? -t : this.dimRef === 'outer' ? t : 0;
  }

  // Mesures du mur sélectionné selon la référence choisie (intérieur / extérieur / axe)
  measure() {
    const w = this.sel?.type === 'wall' ? this.selected : null;
    if (!w) return null;
    const mode = this.dimRef;
    const wi = G.wallInfo(this.plan, w);
    const r = G.resolveSide(this.plan, this.layout, w.id, this.sel.side || 1, mode);
    const cm = G.chainMeasure(this.plan, this.layout, w.id, r.side);
    const other = r.entry ? G.sideEntry(this.plan, this.layout, w.id, -r.side) : null;
    let faceName = 'axe';
    if (r.entry) {
      if (r.entry.kind === 'outer') faceName = 'extérieur';
      else faceName = this.rooms.find((q) => q.id === r.entry.room)?.name || 'pièce';
    }
    return {
      mode, side: r.side, entry: r.entry, faceName,
      len: r.entry ? r.entry.len : wi.len, axisLen: wi.len,
      segs: cm.lens, total: cm.total, index: cm.ch.index, count: cm.ch.segments.length,
      canSwitch: !!(r.entry && other && other.kind === r.entry.kind),
      locked: this.isLocked('wall'), chainLocked: this.isLocked('chain'),
    };
  }

  switchSide() {
    const m = this.measure();
    if (!m?.canSwitch) return;
    this.select({ type: 'wall', id: this.sel.id, side: -m.side });
  }

  wallNearPoint(p) {
    let bw = null, bd = Infinity;
    for (const w of this.plan.walls) {
      const pr = G.projectToSegment(p, this.plan.nodes[w.a], this.plan.nodes[w.b]);
      if (pr.d < bd) { bd = pr.d; bw = w.id; }
    }
    return bw;
  }

  // ───────── pointeurs ─────────

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Clic droit (souris) : quitte le mode en cours et revient à la sélection ;
  // en mode sélection, il désélectionne.
  rightClick() {
    if (this.tool !== 'select') this.setTool('select');
    else if (this.sel) this.select(null);
  }

  onDown(e) {
    if (e.pointerType === 'mouse' && e.button === 2) { e.preventDefault(); this.rightClick(); return; }
    if (this.pointers.size === 0) this.locked = false;
    this.canvas.setPointerCapture?.(e.pointerId);
    const sp = this.pos(e);
    this.pointers.set(e.pointerId, { ...sp });
    if (this.pointers.size === 2) { this.startPinch(); return; }
    if (this.pointers.size > 2 || this.locked) return;
    const g = { kind: 'none', start: sp, startPlan: this.toPlan(sp), moved: false, snap: false, view0: { ...this.view } };
    this.gesture = g;
    if (e.pointerType === 'mouse' && e.button !== 0) { g.kind = 'pan'; return; } // bouton du milieu : déplacer la vue

    if (this.tool === 'select') {
      const h = this.hit(sp);
      g.hit = h;
      if (!h) { g.kind = 'pan'; return; }
      if (h.type === 'rotate') { g.kind = 'rotate'; g.f = this.plan.furniture.find((q) => q.id === h.id); return; }
      if (h.type === 'furniture') {
        this.select({ type: 'furniture', id: h.id });
        const f = this.plan.furniture.find((q) => q.id === h.id);
        g.kind = 'dragFurniture'; g.orig = { x: f.x, y: f.y }; return;
      }
      if (h.type === 'opening') { this.select({ type: 'opening', id: h.id }); g.kind = 'dragOpening'; return; }
      if (h.type === 'label') { g.kind = 'pan'; return; } // toucher un chiffre sélectionne ce mur et cette face
      if (h.type === 'node') { g.kind = 'dragNode'; g.node = h.id; g.orig = { ...this.plan.nodes[h.id] }; return; }
      if (h.type === 'wall') {
        this.select({ type: 'wall', id: h.id, side: this.tapSide(h.id, g.startPlan) });
        const w = this.plan.walls.find((q) => q.id === h.id);
        const wi = G.wallInfo(this.plan, w);
        g.kind = 'dragWall'; g.w = w; g.n = { x: wi.nx, y: wi.ny };
        g.origA = { ...this.plan.nodes[w.a] }; g.origB = { ...this.plan.nodes[w.b] };
        return;
      }
      g.kind = 'pan'; // un glisser sur une pièce déplace la vue ; un simple toucher la sélectionne
    } else if (this.tool === 'wall') {
      g.kind = 'wallPlace';
      this.updatePreview(sp);
    } else if (this.tool === 'measure') {
      g.kind = 'measPlace';
      this.updateMeasPreview(sp);
    } else if (this.tool === 'opening') {
      g.kind = 'openingPlace';
      this.updateGhost(sp);
    } else {
      g.kind = 'pan';
    }
  }

  onMove(e) {
    const prev = this.pointers.get(e.pointerId);
    const sp = this.pos(e);
    if (prev) { prev.x = sp.x; prev.y = sp.y; }
    if (this.pinch && this.pointers.size >= 2) { this.updatePinch(); return; }
    const g = this.gesture;
    if (!g || this.locked) return;
    if (!g.moved && Math.hypot(sp.x - g.start.x, sp.y - g.start.y) > TAP_PX) g.moved = true;
    const p = this.toPlan(sp);
    const plan = this.plan;

    switch (g.kind) {
      case 'pan':
        if (g.moved) { this.view.ox = g.view0.ox + sp.x - g.start.x; this.view.oy = g.view0.oy + sp.y - g.start.y; this.draw(); }
        break;
      case 'wallPlace': this.updatePreview(sp); break;
      case 'openingPlace': this.updateGhost(sp); break;
      case 'measPlace': this.updateMeasPreview(sp); break;
      case 'dragFurniture': {
        if (!g.moved) break;
        if (!g.snap) { this.snapshot(); g.snap = true; }
        const f = plan.furniture.find((q) => q.id === this.sel?.id);
        if (!f) break;
        const st = 5;
        f.x = G.round1(Math.round((g.orig.x + p.x - g.startPlan.x) / st) * st);
        f.y = G.round1(Math.round((g.orig.y + p.y - g.startPlan.y) / st) * st);
        this.draw();
        break;
      }
      case 'rotate': {
        if (!g.moved) break;
        if (!g.snap) { this.snapshot(); g.snap = true; }
        const f = g.f;
        let deg = (Math.atan2(p.y - f.y, p.x - f.x) * 180) / Math.PI + 90;
        const near = Math.round(deg / 15) * 15;
        if (Math.abs(deg - near) < 5) deg = near;
        f.rot = ((Math.round(deg * 10) / 10) % 360 + 360) % 360;
        this.draw();
        this.hooks.live?.();
        break;
      }
      case 'dragOpening': {
        if (!g.moved) break;
        if (!g.snap) { this.snapshot(); g.snap = true; }
        const o = plan.openings.find((q) => q.id === this.sel?.id);
        if (!o) break;
        const near = this.nearestWall(p, 40 / this.view.s);
        if (near) {
          o.wall = near.wall.id; o.pos = G.round1(near.t * near.len);
          G.clampOpening(plan, o);
        }
        this.draw();
        break;
      }
      case 'dragNode': {
        if (!g.moved) break;
        if (!g.snap) { this.snapshot(); g.snap = true; }
        const s = this.snap(sp, { exclude: g.node });
        G.moveNode(plan, g.node, s.node ? s.x : s.x, s.node ? s.y : s.y);
        this.mergeMark = s.node ? { x: s.x, y: s.y } : null;
        g.mergeWith = s.node || null;
        this.relayout();
        this.draw();
        this.hooks.live?.();
        break;
      }
      case 'dragWall': {
        if (!g.moved) break;
        if (!g.snap) { this.snapshot(); g.snap = true; }
        const st = this.snapStep();
        const d = Math.round(((p.x - g.startPlan.x) * g.n.x + (p.y - g.startPlan.y) * g.n.y) / st) * st;
        G.moveNode(plan, g.w.a, g.origA.x + g.n.x * d, g.origA.y + g.n.y * d);
        G.moveNode(plan, g.w.b, g.origB.x + g.n.x * d, g.origB.y + g.n.y * d);
        this.relayout();
        this.draw();
        this.hooks.live?.();
        break;
      }
      default: break;
    }
  }

  onUp(e, cancelled = false) {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!had) return;
    if (this.pinch) {
      if (this.pointers.size < 2) { this.pinch = null; this.gesture = null; this.locked = true; }
      return;
    }
    const g = this.gesture;
    if (this.pointers.size > 0 || !g || this.locked) return;
    this.gesture = null;
    const sp = this.pos(e);
    const plan = this.plan;

    if (cancelled) { this.mergeMark = null; if (g.snap) this.afterChange(); else this.draw(); return; }

    switch (g.kind) {
      case 'pan':
        if (!g.moved) {
          if (g.hit?.type === 'label') this.select({ type: 'wall', id: g.hit.wall, side: g.hit.side });
          else if (g.hit?.type === 'room') this.select({ type: 'room', id: g.hit.id });
          else if (this.sel) this.select(null);
        }
        break;
      case 'dragNode':
        if (!g.moved) {
          const wid = this.wallNearPoint(this.toPlan(g.start));
          const w = plan.walls.find((q) => (q.a === g.node || q.b === g.node) && q.id === wid)
            || plan.walls.find((q) => q.a === g.node || q.b === g.node);
          if (w) this.select({ type: 'wall', id: w.id, side: this.tapSide(w.id, this.toPlan(g.start)) });
        } else {
          if (g.mergeWith && plan.nodes[g.mergeWith]) G.mergeNodes(plan, g.mergeWith, g.node);
          this.mergeMark = null;
          if (!this.guardLocks()) break;
          this.afterChange();
        }
        break;
      case 'dragWall': case 'dragFurniture': case 'dragOpening': case 'rotate':
        if (g.snap && this.guardLocks()) this.afterChange();
        break;
      case 'wallPlace': this.commitPoint(); break;
      case 'openingPlace': this.placeOpening(sp); break;
      case 'measPlace': this.commitMeasPoint(); break;
      default: break;
    }
    this.draw();
  }

  onKey(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
    else if (e.key === 'Escape') { if (this.draft?.last) this.finishDraft(); else { this.select(null); this.setTool('select'); } }
  }

  // ───────── pincement ─────────

  startPinch() {
    const pts = [...this.pointers.values()];
    this.gesture = null;
    this.mergeMark = null;
    this.pinch = {
      d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      mid0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      view0: { ...this.view },
    };
    this.ghost = null;
    if (this.draft) { this.draft.preview = null; this.draft.guides = []; }
    this.draw();
  }

  updatePinch() {
    const pts = [...this.pointers.values()];
    const pn = this.pinch;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const s = G.clamp(pn.view0.s * (d / pn.d0), 0.04, 8);
    const pm = { x: (pn.mid0.x - pn.view0.ox) / pn.view0.s, y: (pn.mid0.y - pn.view0.oy) / pn.view0.s };
    this.view = { s, ox: mid.x - pm.x * s, oy: mid.y - pm.y * s };
    this.draw();
  }

  // ───────── outil Mesure ─────────

  // Accroche obligatoire : bouts et coins de murs (rayon large), puis faces et axe des murs.
  // Hors d'un mur, aucun point n'est posé.
  measSnap(sp) {
    const S = this.view.s, p = this.toPlan(sp), plan = this.plan;
    const wallsAt = (P) => plan.walls.filter((w) => {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      return a && b && G.projectToSegment(P, a, b).d <= w.t / 2 + 0.6;
    }).map((w) => w.id);
    // 1) bouts / coins : angles des faces, bouts de murs, nœuds
    const pts = [];
    for (const e of this.layout.sides.values()) pts.push(e.p0);
    for (const n of Object.values(plan.nodes)) pts.push(n);
    for (const w of plan.walls) {
      const wi = G.wallInfo(plan, w);
      for (const q of [wi.a, wi.b]) for (const sg of [-1, 1]) pts.push({ x: q.x + wi.nx * sg * w.t / 2, y: q.y + wi.ny * sg * w.t / 2 });
    }
    // bords des ouvertures (portes, arches, fenêtres…) : sur les deux faces et à l'axe
    for (const o of plan.openings) {
      const g = G.openingGeom(plan, o);
      if (!g) continue;
      for (const sd of [-1, 1]) for (const off of [-g.t / 2, 0, g.t / 2]) {
        pts.push({ x: g.c.x + g.ux * sd * o.w / 2 + g.nx * off, y: g.c.y + g.uy * sd * o.w / 2 + g.ny * off });
      }
    }
    let best = null, bd = 20 / S;
    for (const q of pts) {
      const d = G.dist(q, p);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) return { x: G.round1(best.x), y: G.round1(best.y), walls: wallsAt(best), kind: 'corner' };
    // 2) faces et axe des murs
    let cand = null, cd = 18 / S;
    for (const w of plan.walls) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      const pr = G.projectToSegment(p, a, b);
      const wi = G.wallInfo(plan, w);
      const sg = (p.x - pr.x) * wi.nx + (p.y - pr.y) * wi.ny >= 0 ? 1 : -1;
      for (const off of [w.t / 2, 0]) {
        const d = Math.abs(pr.d - off) + (off === 0 ? 4 / S : 0);
        if (d < cd) { cd = d; cand = { x: pr.x + wi.nx * sg * off, y: pr.y + wi.ny * sg * off, walls: [w.id], kind: off ? 'face' : 'axis' }; }
      }
    }
    if (cand) return { x: G.round1(cand.x), y: G.round1(cand.y), walls: cand.walls, kind: cand.kind };
    return null;
  }

  // Entre deux murs parallèles : mesure perpendiculaire, plus facile à viser
  measAlign(A, s) {
    if (s.walls.length !== 1 || !A.walls?.length || s.kind === 'corner') return s;
    const wb = this.plan.walls.find((q) => q.id === s.walls[0]);
    const ub = G.wallInfo(this.plan, wb);
    for (const id of A.walls) {
      if (id === wb.id) continue;
      const wa = this.plan.walls.find((q) => q.id === id);
      const ua = G.wallInfo(this.plan, wa);
      if (Math.abs(ua.nx * ub.ny - ua.ny * ub.nx) < 0.02) {
        const k = (s.x - A.x) * ua.nx + (s.y - A.y) * ua.ny;
        return { ...s, x: G.round1(A.x + ua.nx * k), y: G.round1(A.y + ua.ny * k) };
      }
    }
    return s;
  }

  updateMeasPreview(sp) {
    const m = this.meas;
    if (!m) return;
    let s = this.measSnap(sp);
    if (s && m.A && !m.B) s = this.measAlign(m.A, s);
    m.preview = s;
    this.draw();
  }

  commitMeasPoint() {
    const m = this.meas, pv = m?.preview;
    if (!m) return;
    if (!pv) { this.hooks.toast?.('Touchez un mur ou une extrémité de mur'); return; }
    if (!m.A || m.B) { m.A = pv; m.B = null; }
    else { if (G.dist(m.A, pv) < 1) return; m.B = pv; }
    m.preview = null;
    this.hooks.meas?.(m);
    this.draw();
  }

  measInfo() {
    const m = this.meas;
    if (!m?.B) return null;
    const spec = G.gapSpec(this.plan, m.A, m.B);
    return { len: G.dist(m.A, m.B), lockable: !!spec, locked: !!(spec && G.findLock(this.plan, spec)) };
  }

  resetMeasure() {
    if (!this.meas) return;
    this.meas = { A: null, B: null, preview: null };
    this.hooks.meas?.(this.meas);
    this.draw();
  }

  toggleMeasureLock() {
    const m = this.meas;
    const spec = m?.B && G.gapSpec(this.plan, m.A, m.B);
    if (!spec) { this.hooks.toast?.('Posez les deux points sur des murs parallèles pour verrouiller'); return; }
    const ex = G.findLock(this.plan, spec);
    this.snapshot();
    if (ex) G.removeLock(this.plan, ex.id); else G.upsertLock(this.plan, spec);
    this.afterChange();
    this.hooks.meas?.(m);
  }

  // Saisie de la cote : décale ce qui est au-delà de B (ou en deçà de A), puis verrouille
  applyMeasure(len, move = 'b') {
    const m = this.meas;
    if (!m?.B || !(len >= 1)) return false;
    const spec = G.gapSpec(this.plan, m.A, m.B);
    const ex = spec && G.findLock(this.plan, spec);
    const L = G.dist(m.A, m.B), dx = (m.B.x - m.A.x) / L, dy = (m.B.y - m.A.y) / L;
    this.snapshot();
    if (!G.adjustMeasure(this.plan, m.A, m.B, len, { move })) { this.undoStack.pop(); return false; }
    if (!this.guardLocks(ex?.id)) return false;
    if (move === 'a') m.A = { ...m.A, x: G.round1(m.B.x - dx * len), y: G.round1(m.B.y - dy * len) };
    else m.B = { ...m.B, x: G.round1(m.A.x + dx * len), y: G.round1(m.A.y + dy * len) };
    if (spec) G.upsertLock(this.plan, { ...spec, len }); // une cote saisie est verrouillée
    this.afterChange();
    this.hooks.meas?.(m);
    return true;
  }

  // ───────── tracé de murs ─────────

  updatePreview(sp) {
    const s = this.snap(sp);
    this.draft.preview = s;
    this.draft.guides = s.guides;
    this.draw();
  }

  commitPoint() {
    const d = this.draft;
    const pv = d?.preview;
    if (!pv) return;
    if (!d.last) {
      d.last = { x: pv.x, y: pv.y }; d.first = { x: pv.x, y: pv.y }; d.count = 0;
      d.preview = null;
      this.ensureVisible(d.last);
      this.hooks.draft?.(d); this.draw();
      return;
    }
    if (G.dist(d.last, pv) < 3) { this.finishDraft(); return; }
    this.addSegment(pv.x, pv.y);
  }

  addSegment(x, y) {
    const d = this.draft;
    this.snapshot();
    G.insertWall(this.plan, d.last.x, d.last.y, x, y, this.plan.settings.wallT);
    d.last = { x, y }; d.count++;
    const closed = d.count >= 2 && d.first && G.dist(d.first, d.last) < 1;
    d.preview = null; d.guides = [];
    this.ensureVisible(d.last);
    this.afterChange();
    if (closed) { this.finishDraft(); this.hooks.toast?.('Pièce fermée'); } else this.hooks.draft?.(d);
  }

  // Longueur saisie au clavier : prolonge dans la direction visée
  drawLength(len, dir) {
    const d = this.draft;
    if (!d?.last || !(len >= 1)) return false;
    let dx = 1, dy = 0;
    if (dir) { dx = dir.x; dy = dir.y; }
    else if (d.preview) {
      const ref = { x: d.preview.x - d.last.x, y: d.preview.y - d.last.y };
      const L = Math.hypot(ref.x, ref.y);
      if (L > 0.5) { dx = ref.x / L; dy = ref.y / L; }
    } else if (d.lastDir) { dx = d.lastDir.x; dy = d.lastDir.y; }
    const axisLen = len - this.dimDelta(); // la cote saisie est dans la référence choisie
    if (axisLen < 1) return false;
    const x = G.round1(d.last.x + dx * axisLen), y = G.round1(d.last.y + dy * axisLen);
    d.lastDir = { x: dx, y: dy };
    this.addSegment(x, y);
    return true;
  }

  // ───────── ouvertures ─────────

  nearestWall(p, tol) {
    let best = null;
    for (const w of this.plan.walls) {
      const wi = G.wallInfo(this.plan, w);
      const pr = G.projectToSegment(p, wi.a, wi.b);
      if (pr.d <= Math.max(tol, w.t) && (!best || pr.d < best.d)) best = { wall: w, t: pr.t, d: pr.d, len: wi.len };
    }
    return best;
  }

  updateGhost(sp) {
    const p = this.toPlan(sp);
    const near = this.nearestWall(p, 30 / this.view.s);
    const def = G.OPENING_KINDS[this.openingKind];
    if (near) {
      const w = Math.min(def.w, near.len);
      this.ghost = { wall: near.wall.id, pos: G.clamp(near.t * near.len, w / 2, near.len - w / 2), w };
    } else this.ghost = null;
    this.draw();
  }

  placeOpening(sp) {
    // toucher une ouverture existante la sélectionne
    const h = this.hit(sp);
    this.ghost = null;
    if (h?.type === 'opening') { this.select({ type: 'opening', id: h.id }); return; }
    const near = this.nearestWall(this.toPlan(sp), 30 / this.view.s);
    if (!near) { this.draw(); return; }
    let created;
    this.mutate((plan) => {
      created = G.addOpening(plan, near.wall.id, near.t * near.len, this.openingKind);
    });
    this.select({ type: 'opening', id: created.id });
  }

  // ───────── actions du panneau ─────────

  // Longueur du segment sélectionné, dans la référence choisie (face intérieure / extérieure ou axe)
  applyWallLength(len, opts) {
    if (this.sel?.type !== 'wall') return false;
    const r = G.resolveSide(this.plan, this.layout, this.sel.id, this.sel.side || 1, this.dimRef);
    this.snapshot();
    const ok = r.entry
      ? G.setWallFaceLength(this.plan, this.sel.id, r.side, len, opts)
      : G.setWallLength(this.plan, this.sel.id, len, opts);
    if (!ok) { this.undoStack.pop(); this.afterChange(); return false; }
    const spec = { kind: 'wall', wall: this.sel.id, side: r.side, ref: this.dimRef, len };
    if (!this.guardLocks(G.findLock(this.plan, spec)?.id)) return false;
    G.upsertLock(this.plan, spec); // une cote saisie est verrouillée
    this.afterChange();
    return true;
  }

  // Longueur totale du mur entier (tous les segments alignés), dans la même référence
  applyChainLength(total, opts) {
    if (this.sel?.type !== 'wall') return false;
    const r = G.resolveSide(this.plan, this.layout, this.sel.id, this.sel.side || 1, this.dimRef);
    this.snapshot();
    const ok = r.entry
      ? G.setChainFaceLength(this.plan, this.sel.id, r.side, total, opts)
      : G.setChainLength(this.plan, this.sel.id, total, opts);
    if (!ok) { this.undoStack.pop(); this.afterChange(); return false; }
    const spec = { kind: 'chain', wall: this.sel.id, side: r.side, ref: this.dimRef, len: total };
    if (!this.guardLocks(G.findLock(this.plan, spec)?.id)) return false;
    G.upsertLock(this.plan, spec);
    this.afterChange();
    return true;
  }

  setWallThickness(t) {
    if (this.sel?.type !== 'wall' || !(t >= 1)) return;
    this.mutate((plan) => { const w = plan.walls.find((q) => q.id === this.sel.id); if (w) w.t = G.round1(Math.min(t, 100)); });
  }

  updateOpening(patch) {
    if (this.sel?.type !== 'opening') return;
    this.mutate((plan) => {
      const o = plan.openings.find((q) => q.id === this.sel.id);
      if (!o) return;
      if (patch.kind && patch.kind !== o.kind) {
        const def = G.OPENING_KINDS[patch.kind];
        Object.assign(o, { kind: patch.kind, w: def.w, h: def.h, sill: def.sill });
        delete patch.kind;
      }
      Object.assign(o, patch);
      G.clampOpening(plan, o);
    });
  }

  updateFurniture(patch) {
    if (this.sel?.type !== 'furniture') return;
    this.mutate((plan) => {
      const f = plan.furniture.find((q) => q.id === this.sel.id);
      if (!f) return;
      Object.assign(f, patch);
      f.w = G.round1(G.clamp(f.w, 5, 2000)); f.d = G.round1(G.clamp(f.d, 5, 2000));
      f.rot = ((f.rot % 360) + 360) % 360;
    });
  }

  addFurniture(spec) {
    const room = this.sel?.type === 'room' ? this.selected : null;
    const c = room ? room.center : this.toPlan({ x: this.W / 2, y: this.viewH / 2 });
    let f;
    this.mutate((plan) => { f = G.addFurniture(plan, spec, Math.round(c.x / 5) * 5, Math.round(c.y / 5) * 5); });
    this.setTool('select');
    this.select({ type: 'furniture', id: f.id });
  }

  duplicateSelection() {
    if (this.sel?.type !== 'furniture') return;
    let n;
    this.mutate((plan) => {
      const f = plan.furniture.find((q) => q.id === this.sel.id);
      n = { ...f, id: G.uid('f'), x: f.x + 30, y: f.y + 30 };
      plan.furniture.push(n);
    });
    this.select({ type: 'furniture', id: n.id });
  }

  deleteSelection() {
    const s = this.sel;
    if (!s) return;
    if (s.type === 'wall') this.mutate((plan) => G.removeWall(plan, s.id));
    else if (s.type === 'opening') this.mutate((plan) => { plan.openings = plan.openings.filter((o) => o.id !== s.id); });
    else if (s.type === 'furniture') this.mutate((plan) => { plan.furniture = plan.furniture.filter((f) => f.id !== s.id); });
    else if (s.type === 'room') {
      const r = this.selected;
      if (r?.labelId) this.mutate((plan) => { plan.rooms = plan.rooms.filter((l) => l.id !== r.labelId); });
    }
    this.select(null);
  }

  setRoom(patch) {
    const r = this.selected;
    if (this.sel?.type !== 'room' || !r) return;
    this.mutate((plan) => G.setRoomMeta(plan, r, patch));
  }

  setSetting(k, v) {
    this.plan.settings[k] = v;
    this.hooks.change?.();
    this.draw();
  }

  // ───────── dessin ─────────

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.paint(); });
  }

  paint() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    renderPlan(ctx, this.W, this.H, this.plan, this.rooms, this.view, {
      layer: this.layer,
      sel: this.sel,
      grid: true,
      dims: this.plan.settings.dims,
      showNodes: this.tool === 'select' || this.tool === 'wall',
      allNodes: this.tool === 'wall',
      handles: this.tool === 'select',
      draft: this.tool === 'wall' ? this.draft : null,
      ghost: this.tool === 'opening' ? this.ghost : null,
      mergeMark: this.mergeMark,
      layout: this.layout,
      dimRef: this.dimRef,
      dimDelta: this.dimDelta(),
      meas: this.tool === 'measure' ? this.meas : null,
      isLocked: (wall, side) => (this.plan.locks || []).some((l) => (l.kind === 'wall' || l.kind === 'chain') && l.wall === wall && l.side === side && l.ref === this.dimRef) || false,
    });
  }

  // ───────── export ─────────

  exportCanvas(title = '') {
    const b = G.planBounds(this.plan);
    if (!b) return null;
    const pad = 70;
    const bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
    const s = Math.min(3, 2400 / bw);
    const head = 90;
    const W = Math.round(bw * s), H = Math.round(bh * s + head);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
    const view = { s, ox: (pad - b.x0) * s, oy: (pad - b.y0) * s + head };
    renderPlan(ctx, W, H, this.plan, this.rooms, view, { layer, dims: this.plan.settings.dims, bg: '#fff', layout: this.layout, dimRef: this.dimRef });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, head);
    const total = this.rooms.reduce((a, r) => a + r.area, 0);
    ctx.fillStyle = '#111827'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = '700 34px system-ui, sans-serif'; ctx.fillText(title || 'Plan', 28, 48);
    ctx.font = '500 22px system-ui, sans-serif'; ctx.fillStyle = '#475569';
    ctx.fillText(`${this.rooms.length} pièce(s) · surface habitable ${G.fmtArea(total)}`, 28, 78);
    return c;
  }
}
