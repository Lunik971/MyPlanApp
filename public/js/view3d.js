// Vue 3D du plan (three.js) : murs extrudés avec ouvertures, sols colorés par pièce, portes, fenêtres, meubles.
// Charge three.js à la demande (importmap dans index.html) : la vue 2D n'en dépend pas.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as G from './geometry.js';

const FURN_H = {
  bed140: 50, bed160: 50, bed90: 45, nightstand: 50, wardrobe: 200, dresser: 85, sofa2: 80, sofa3: 80, armchair: 80,
  coffee: 40, tv: 55, shelf: 180, table160: 75, tableround: 75, chair: 90, fridge: 180, hob: 90, sink: 90, counter: 90,
  washer: 85, bath: 55, shower: 6, basin: 85, wc: 40, desk: 75, officechair: 90, rect: 70, round: 70,
};
const FURN_COLOR = { Chambre: '#c9a27a', Salon: '#8aa3c2', Repas: '#c9a27a', Cuisine: '#b8c2cc', Bain: '#d9e6ee', Bureau: '#a8b89a', Autre: '#c7c7c7' };

export async function createView3D(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  } catch { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xeef2f7);
  container.append(renderer.domElement);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 10, 200000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.screenSpacePanning = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xc9d3e0, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  const content = new THREE.Group();
  scene.add(content);
  let info = { cx: 0, cz: 0, size: 600 };
  let running = false, raf = 0;
  let wallMode = 'full';
  let lastPlan = null, lastLayout = null;

  const matWall = new THREE.MeshStandardMaterial({ color: 0xf7f8fa, roughness: 0.95 });
  const matEdge = new THREE.LineBasicMaterial({ color: 0x8b95a5 });
  const matGlass = new THREE.MeshStandardMaterial({ color: 0x9cc7f0, transparent: true, opacity: 0.35, roughness: 0.1 });
  const matDoor = new THREE.MeshStandardMaterial({ color: 0xb9824f, roughness: 0.7 });
  const matFrame = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 });

  // vantail vitré façon menuiserie : montants + traverses blancs, grand vitrage en haut, panneau plein en bas
  function glazedLeaf(len, hh) {
    const g = new THREE.Group();
    const bar = (w, h, d, x, y, mat = matFrame) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, 0);
      m.castShadow = true;
      g.add(m);
    };
    const st = Math.min(6, len / 4), th = 5;
    const mid = hh * 0.3;                                   // hauteur du panneau plein
    bar(st, hh, th, -len / 2 + st / 2, hh / 2);             // montants
    bar(st, hh, th, len / 2 - st / 2, hh / 2);
    bar(len, 7, th, 0, hh - 3.5);                           // traverse haute
    bar(len, 6, th, 0, 3);                                  // traverse basse
    bar(len - 2 * st, 7, th, 0, mid);                       // traverse intermédiaire
    bar(len - 2 * st, mid - 9, 3, 0, (mid + 3) / 2 + 0.2);  // panneau plein du bas
    bar(len - 2 * st, hh - mid - 14, 1.2, 0, (mid + 3.5 + hh - 7) / 2, matGlass); // vitrage
    return g;
  }

  const resize = () => {
    const w = container.clientWidth || 300, h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const disposeGroup = (grp) => {
    grp.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material && o.material.dispose && ![matWall, matEdge, matGlass, matDoor, matFrame].includes(o.material)) o.material.dispose();
    });
    grp.clear();
  };

  // boîte alignée sur le mur : s0..s1 le long du mur (depuis le point a), y0..y1 en hauteur
  function wallBox(wi, t, s0, s1, y0, y1, mat = matWall, edges = true) {
    const len = s1 - s0, h = y1 - y0;
    if (len < 0.5 || h < 0.5) return null;
    const geo = new THREE.BoxGeometry(len, h, t);
    const m = new THREE.Mesh(geo, mat);
    const sm = (s0 + s1) / 2;
    m.position.set(wi.a.x + wi.ux * sm, y0 + h / 2, wi.a.y + wi.uy * sm);
    m.rotation.y = -Math.atan2(wi.uy, wi.ux);
    m.castShadow = true; m.receiveShadow = true;
    const grp = new THREE.Group();
    grp.add(m);
    if (edges) {
      const ls = new THREE.LineSegments(new THREE.EdgesGeometry(geo), matEdge);
      ls.position.copy(m.position); ls.rotation.copy(m.rotation);
      grp.add(ls);
    }
    return grp;
  }

  function labelSprite(text, sub) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 160;
    const x = c.getContext('2d');
    x.font = '700 54px system-ui, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineJoin = 'round';
    const draw = (str, yy, font) => {
      x.font = font;
      x.lineWidth = 10; x.strokeStyle = 'rgba(255,255,255,.95)'; x.strokeText(str, 256, yy);
      x.fillStyle = '#243447'; x.fillText(str, 256, yy);
    };
    if (text) { draw(text, 54, '700 54px system-ui, sans-serif'); draw(sub, 114, '600 40px system-ui, sans-serif'); } else draw(sub, 80, '600 44px system-ui, sans-serif');
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(260, 81, 1);
    return sp;
  }

  function build(plan, layout) {
    disposeGroup(content);
    const wallH = wallMode === 'low' ? 100 : (plan.settings.wallH || 250);
    const bb = G.planBounds(plan);
    if (!bb) return;
    info = { cx: (bb.x0 + bb.x1) / 2, cz: (bb.y0 + bb.y1) / 2, size: Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0, 300), radius: Math.max(Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2, 200) };

    // sol général
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(info.size * 4, info.size * 4), new THREE.MeshStandardMaterial({ color: 0xe3e8ef, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(info.cx, -2, info.cz); ground.receiveShadow = true;
    content.add(ground);

    // sols des pièces
    for (const r of layout.rooms) {
      if (r.inner.length < 3) continue;
      const shape = new THREE.Shape(r.inner.map((p) => new THREE.Vector2(p.x, p.y)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(Math.PI / 2); // (x, y) → (x, 0, y)
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(r.color || '#e9e2d3'), roughness: 0.9, side: THREE.DoubleSide }));
      mesh.position.y = 0.4; mesh.receiveShadow = true;
      content.add(mesh);
      const sp = labelSprite(r.name, G.fmtArea(r.area));
      sp.position.set(r.center.x, wallMode === 'low' ? 12 : 40, r.center.y);
      content.add(sp);
    }

    // murs, ouvertures, portes, fenêtres
    for (const w of plan.walls) {
      const a = plan.nodes[w.a], b = plan.nodes[w.b];
      if (!a || !b) continue;
      const wi = G.wallInfo(plan, w);
      const ea = G.endInset(plan, w, w.a), eb = G.endInset(plan, w, w.b);
      const ops = plan.openings.filter((o) => o.wall === w.id).sort((p, q) => p.pos - q.pos);
      let cur = -ea;
      const add = (g) => { if (g) content.add(g); };
      for (const o of ops) {
        const s0 = Math.max(cur, o.pos - o.w / 2), s1 = o.pos + o.w / 2;
        add(wallBox(wi, w.t, cur, s0, 0, wallH));
        const sill = Math.min(o.sill || 0, wallH), top = Math.min((o.sill || 0) + o.h, wallH);
        if (sill > 0) add(wallBox(wi, w.t, s0, s1, 0, sill));
        if (top < wallH) add(wallBox(wi, w.t, s0, s1, top, wallH));
        const isWin = o.kind === 'window' || o.kind === 'bay';
        const half = o.w / 2, cx = wi.a.x + wi.ux * o.pos, cy = wi.a.y + wi.uy * o.pos;
        if (o.kind === 'frenchwin') {
          // 4 vantaux fermés : partie basse pleine (panneau) + vitrage, cadres blancs
          const fh = Math.min(o.h, wallH), q = o.w / 4;
          for (let i = 0; i < 4; i++) {
            const gl = glazedLeaf(q, fh);
            const sm = o.pos - half + (i + 0.5) * q;
            gl.position.set(wi.a.x + wi.ux * sm, 0, wi.a.y + wi.uy * sm);
            gl.rotation.y = -Math.atan2(wi.uy, wi.ux);
            content.add(gl);
          }
        } else if (isWin) add(wallBox(wi, 2, s0, s1, sill, top, matGlass, false));
        else if (o.kind === 'door' || o.kind === 'double' || o.kind === 'doubleglass') {
          // vantail(s) ouvert(s) à 90°, côté « side » (comme le symbole en 2D)
          const side = o.side || 1, hh = Math.min(o.h, wallH);
          const glazed = o.kind === 'doubleglass';
          const leaf = (hx, hy, len) => {
            let m;
            if (glazed) m = glazedLeaf(len, hh);
            else { m = new THREE.Mesh(new THREE.BoxGeometry(len, hh, 4), matDoor); m.castShadow = true; m.position.y = hh / 2; }
            // le vantail ouvert part de la charnière, perpendiculaire au mur, du côté « side »
            m.position.x = hx + wi.nx * side * len / 2;
            m.position.z = hy + wi.ny * side * len / 2;
            m.rotation.y = -Math.atan2(wi.ny * side, wi.nx * side);
            content.add(m);
          };
          if (o.kind === 'double' || glazed) {
            leaf(cx - wi.ux * half, cy - wi.uy * half, half);
            leaf(cx + wi.ux * half, cy + wi.uy * half, half);
          } else {
            const hd = o.flip ? 1 : -1;
            leaf(cx + wi.ux * half * hd, cy + wi.uy * half * hd, o.w);
          }
        }
        cur = s1;
      }
      add(wallBox(wi, w.t, cur, wi.len + eb, 0, wallH));
    }

    // meubles
    const catOf = Object.fromEntries(G.FURNITURE.map((f) => [f.kind, f.cat]));
    for (const f of plan.furniture) {
      const h = FURN_H[f.kind] || 70;
      const col = new THREE.Color(FURN_COLOR[catOf[f.kind]] || '#c7c7c7');
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 });
      const geo = f.shape === 'round' ? new THREE.CylinderGeometry(f.w / 2, f.w / 2, h, 32) : new THREE.BoxGeometry(f.w, h, f.d);
      const m = new THREE.Mesh(geo, mat);
      if (f.shape === 'round' && f.w !== f.d) m.scale.z = f.d / f.w;
      m.position.set(f.x, h / 2, f.y);
      m.rotation.y = -((f.rot || 0) * Math.PI) / 180;
      m.castShadow = true; m.receiveShadow = true;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x6b7686 }));
      edges.position.copy(m.position); edges.rotation.copy(m.rotation); edges.scale.copy(m.scale);
      content.add(m, edges);
    }

    // lumière : couvre toute l'emprise
    const R = info.size;
    sun.position.set(info.cx - R * 0.6, R * 1.4, info.cz - R * 0.4);
    sun.target.position.set(info.cx, 0, info.cz);
    const sc = sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 10; sc.far = R * 4;
    sc.updateProjectionMatrix();
  }

  // distance qui fait tenir tout le plan à l'écran, même en portrait (champ horizontal plus étroit)
  const fitDistance = () => {
    const v = (camera.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
    return (info.radius / Math.sin(Math.min(v, hf) / 2)) * 1.08;
  };
  function perspective() {
    const d = fitDistance(), dir = new THREE.Vector3(0.45, 0.8, 0.9).normalize();
    controls.target.set(info.cx, 0, info.cz);
    camera.position.set(info.cx + dir.x * d, dir.y * d, info.cz + dir.z * d);
    controls.update();
  }
  function top() {
    const d = fitDistance();
    controls.target.set(info.cx, 0, info.cz);
    camera.position.set(info.cx, d, info.cz + 0.01);
    controls.update();
  }

  const loop = () => {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };

  return {
    show(plan, layout) {
      lastPlan = plan; lastLayout = layout;
      container.hidden = false;
      resize();
      build(plan, layout);
      perspective();
      if (!running) { running = true; loop(); }
    },
    hide() { running = false; cancelAnimationFrame(raf); container.hidden = true; },
    perspective, top,
    setWallMode(m) { wallMode = m; if (lastPlan) build(lastPlan, lastLayout); },
    get wallMode() { return wallMode; },
    stats() { let n = 0; content.traverse((o) => { if (o.isMesh) n++; }); return { meshes: n }; },
    dispose() { running = false; cancelAnimationFrame(raf); ro.disconnect(); disposeGroup(content); renderer.dispose(); renderer.domElement.remove(); },
  };
}
