import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { STLLoader } from './vendor/STLLoader.js';

const FOCUS = '#e79535', PICK = '#168b9b', INK = '#26332f';
const DIRECTIONS = { top: [0, -.001, 1], bottom: [0, -.001, -1], front: [0, -1, .015], iso: [.25, -.85, .85] };
// Hardware smaller than this (mm) gets an on-screen ring per instance so it does not vanish at full-board scale.
const MARK_SIZE = 14;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function ringTexture(color) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.lineWidth = 12; g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(32, 32, 24, 0, 7); g.stroke();
  g.lineWidth = 6; g.strokeStyle = color; g.beginPath(); g.arc(32, 32, 24, 0, 7); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function arrowMesh(from, to) {
  const origin = new THREE.Vector3(...from), delta = new THREE.Vector3(...to).sub(origin);
  const length = delta.length(), head = Math.min(6, length * .45);
  const material = new THREE.MeshBasicMaterial({ color: '#c96f0c', depthTest: false, transparent: true, opacity: .95 });
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.75, .75, length - head, 12), material);
  shaft.position.y = (length - head) / 2;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(2.4, head, 18), material);
  cone.position.y = length - head / 2;
  group.add(shaft, cone);
  group.position.copy(origin);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  group.traverse(o => { o.renderOrder = 10; });
  return group;
}

export async function createViewer(host, data, onSelect, options = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor('#f5f6f3');
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '회전하고 확대할 수 있는 조립 모델');
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7d878c, 1.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  const fill = new THREE.DirectionalLight(0xe4ecff, .7);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -.0004; key.shadow.normalBias = .35; key.shadow.radius = 3;
  scene.add(key, key.target, fill, fill.target);
  const root = new THREE.Group(); scene.add(root);
  const arrows = new THREE.Group(); scene.add(arrows);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: .13 }));
  ground.receiveShadow = true; scene.add(ground);
  const camera = new THREE.PerspectiveCamera(35, 1, .5, 5000); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = .14; controls.zoomToCursor = true;
  controls.minDistance = 8; controls.maxDistance = 1600;
  const loader = new STLLoader(), meshes = [], rings = { focus: ringTexture(FOCUS), pick: ringTexture(PICK) };
  try {
    await Promise.all(data.parts.flatMap(p => (p.pieces || []).map(piece => ({ p, piece }))).map(async ({ p, piece }) => {
      const geometry = await loader.loadAsync(piece.mesh);
      geometry.computeVertexNormals(); geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial({ color: piece.color || p.color, roughness: .6, metalness: .08,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { ...p, baseColor: piece.color || p.color, pieceBodies: piece.bodies, instances: piece.instances || [] };
      const tiny = ([lo, hi]) => Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) <= MARK_SIZE;
      // Only parts made wholly of small instances (screws, nuts, magnets), not a switch's stem or a board's pins.
      const small = p.pieces.every(pc => (pc.instances || []).length && pc.instances.every(tiny)) ? piece.instances : [];
      if (small.length) {
        const points = new THREE.BufferGeometry();
        points.setAttribute('position', new THREE.Float32BufferAttribute(small.flatMap(([lo, hi]) => [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]), 3));
        const marks = new THREE.Points(points, new THREE.PointsMaterial({ map: rings.focus, size: 26, sizeAttenuation: false,
          transparent: true, depthTest: false, depthWrite: false }));
        marks.renderOrder = 20; marks.visible = false; marks.raycast = () => {};
        mesh.userData.marks = marks; mesh.add(marks);
      }
      root.add(mesh); meshes.push(mesh);
    }));
  } catch (e) { renderer.dispose(); host.replaceChildren(); throw e; }

  // Light, shadow camera and ground follow the assembled model's extent.
  const model = new THREE.Box3(); meshes.forEach(m => model.union(m.geometry.boundingBox));
  const middle = model.getCenter(new THREE.Vector3()), span = model.getSize(new THREE.Vector3()).length();
  key.target.position.copy(middle); fill.target.position.copy(middle);
  key.position.copy(middle).add(new THREE.Vector3(-.35, -.55, 1).setLength(span * 1.6));
  fill.position.copy(middle).add(new THREE.Vector3(.8, .6, .35).setLength(span * 1.6));
  Object.assign(key.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 3.5 });
  key.shadow.camera.updateProjectionMatrix();
  ground.scale.set(span * 4, span * 4, 1); ground.position.set(middle.x, middle.y, model.min.z - .4);

  let externalChange = null, applyingPose = false, raf = 0, tween = 0, placed = false;
  const draw = () => {
    ground.visible = camera.position.z > ground.position.z + 2;
    renderer.render(scene, camera);
  };
  const tick = () => { raf = 0; if (controls.update()) kick(); };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  controls.addEventListener('change', () => { draw(); kick(); if (!applyingPose) externalChange?.(getPose()); });
  controls.addEventListener('start', () => { cancelAnimationFrame(tween); tween = 0; });
  const size = new THREE.Vector2();
  function syncSize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return false;
    if (renderer.getSize(size).x !== w || size.y !== h) { renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    return true;
  }
  const resize = new ResizeObserver(() => { if (syncSize()) draw(); }); resize.observe(host);

  function edges(mesh) {
    if (mesh.userData.edges) return;
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 32),
      new THREE.LineBasicMaterial({ color: INK, transparent: true, depthWrite: false }));
    lines.raycast = () => {}; mesh.userData.edges = lines; mesh.add(lines);
  }
  function boxOf(list) {
    const box = new THREE.Box3();
    for (const m of list) box.union(m.geometry.boundingBox.clone().translate(m.position));
    return box;
  }
  function stopMomentum() {
    cancelAnimationFrame(tween); tween = 0;
    controls.enableDamping = false; controls.update(); controls.enableDamping = true;
  }
  function moveTo(position, target, animate = true) {
    stopMomentum();
    if (!animate || !placed || reducedMotion()) {
      camera.position.copy(position); controls.target.copy(target); controls.update(); placed = true; draw(); return;
    }
    const p0 = camera.position.clone(), t0 = controls.target.clone(), start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / 420), e = k < .5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      camera.position.lerpVectors(p0, position, e); controls.target.lerpVectors(t0, target, e);
      controls.update(); draw();
      tween = k < 1 ? requestAnimationFrame(step) : 0;
    };
    tween = requestAnimationFrame(step);
  }
  // Fit the box's projected corners (not its bounding sphere) to the canvas from the given direction.
  function fit(box, kind, animate) {
    if (box.isEmpty()) return;
    syncSize();
    const dir = kind instanceof THREE.Vector3 ? kind.clone().normalize() : new THREE.Vector3(...(DIRECTIONS[kind] || DIRECTIONS.iso)).normalize();
    const right = new THREE.Vector3(), up = new THREE.Vector3(), back = new THREE.Vector3();
    new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), camera.up).extractBasis(right, up, back);
    let center = box.getCenter(new THREE.Vector3());
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const xs = corners.map(c => c.clone().sub(center).dot(right)), ys = corners.map(c => c.clone().sub(center).dot(up));
    center.addScaledVector(right, (Math.max(...xs) + Math.min(...xs)) / 2).addScaledVector(up, (Math.max(...ys) + Math.min(...ys)) / 2);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * camera.aspect, margin = 1.08;
    let distance = 0;
    for (const c of corners) {
      const v = c.clone().sub(center);
      distance = Math.max(distance, v.dot(back) + Math.abs(v.dot(right)) * margin / tanH, v.dot(back) + Math.abs(v.dot(up)) * margin / tanV);
    }
    moveTo(center.clone().addScaledVector(dir, distance), center, animate);
  }
  // Frame the parts being worked on, widened to a share of the whole so the surroundings stay readable.
  function view(kind = 'iso', animate = true) {
    if (options.bounds) return fit(new THREE.Box3(new THREE.Vector3(...options.bounds[0]), new THREE.Vector3(...options.bounds[1])), kind, animate);
    const visible = meshes.filter(m => m.visible), focused = visible.filter(m => m.userData.focus);
    const all = boxOf(visible);
    if (!focused.length || focused.length === visible.length) return fit(all, kind, animate);
    const box = boxOf(focused), size = box.getSize(new THREE.Vector3()), whole = all.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y) >= Math.max(whole.x, whole.y) * .6) return fit(all, kind, animate);
    const need = Math.max(whole.x, whole.y) * .5;
    box.expandByVector(new THREE.Vector3(Math.max(0, (need - size.x) / 2), Math.max(0, (need * .6 - size.y) / 2), 0));
    fit(box.intersect(all), kind, animate);
  }
  function frame(id) {
    const list = meshes.filter(m => m.visible && m.userData.id === id);
    if (!list.length) return;
    const box = boxOf(list), size = box.getSize(new THREE.Vector3());
    const pad = Math.max(0, 60 - Math.max(size.x, size.y)) / 2;
    box.expandByVector(new THREE.Vector3(pad, pad, 0));
    fit(box, camera.position.clone().sub(controls.target));
  }
  function show(step, pick, amount) {
    const solo = pick && !step.show.includes(pick) && meshes.some(m => m.userData.id === pick);
    for (const mesh of meshes) {
      const p = mesh.userData;
      mesh.visible = solo ? p.id === pick : step.show.includes(p.id);
      if (!solo && step.hardwareStages && p.pieceBodies.some(b => b.startsWith('REF_M2_'))) {
        mesh.visible &&= p.pieceBodies.some(b => step.hardwareStages.some(prefix => b.startsWith(prefix)));
      }
      p.focus = pick ? p.id === pick : step.focus.includes(p.id);
      if (step.focusOnly && !p.focus) mesh.visible = false;
    }
    const visible = meshes.filter(m => m.visible);
    // When everything on screen is the work (first step), keep the real colours instead of one flat highlight.
    const highlight = visible.some(m => !m.userData.focus);
    for (const mesh of meshes) {
      const p = mesh.userData, focus = p.focus && mesh.visible;
      const ghost = !p.focus && (p.id === 'housing' || (options.ghost && step.focus.length > 0));
      mesh.material.color.set(p.preserveColors ? p.baseColor : p.id === pick ? PICK : focus && highlight && p.id !== 'switches' ? FOCUS : p.baseColor);
      mesh.material.emissive.set(focus && highlight ? '#2b1906' : '#000000');
      mesh.material.transparent = ghost;
      mesh.material.opacity = ghost ? (p.id === 'housing' ? .1 : .26) : 1;
      mesh.material.depthWrite = !ghost;
      mesh.castShadow = !ghost; mesh.receiveShadow = !ghost;
      if (mesh.visible) {
        edges(mesh);
        p.edges.material.opacity = ghost ? (p.id === 'housing' ? .1 : .2) : focus && highlight ? .6 : .38;
      }
      if (p.marks) {
        p.marks.visible = focus && highlight && !amount;
        p.marks.material.map = p.id === pick ? rings.pick : rings.focus;
      }
      const b = p.bbox, x = (b[0][0] + b[1][0]) / 2, y = (b[0][1] + b[1][1]) / 2;
      const rank = p.explode_rank ?? (p.id === 'keycaps' ? 5 : p.id.startsWith('COVER') || p.id === 'magnets' ? 4 : p.id === 'switches' ? 3 : p.id.startsWith('PLATE_') ? 2 : p.id === 'housing' ? -1 : 0);
      mesh.position.set(options.verticalExplode ? 0 : (x - 142) * amount * .4, options.verticalExplode ? 0 : (y - 46) * amount * .5, rank * amount * 20);
    }
    const low = boxOf(visible);
    if (!low.isEmpty()) ground.position.z = low.min.z - .4;
    arrows.clear();
    if (!amount && !solo && !step.focusOnly) for (const a of step.placement || []) arrows.add(arrowMesh(a.from, a.to));
    if (solo) view('iso'); else draw();
  }
  const ray = new THREE.Raycaster(), point = new THREE.Vector2();
  function hit(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    point.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
    ray.setFromCamera(point, camera);
    const hits = ray.intersectObjects(meshes.filter(m => m.visible), false);
    return hits.find(h => !h.object.material.transparent) || hits[0];
  }
  let down;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const h = hit(e); if (h) onSelect(h.object.userData.id);
  });
  // Double-click (or double-tap) moves the orbit centre to that spot and closes in.
  renderer.domElement.addEventListener('dblclick', e => {
    const h = hit(e); if (!h) return;
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(Math.max(45, offset.length() * .45));
    moveTo(h.point.clone().add(offset), h.point.clone());
  });
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); options.onLost?.(); });
  function getPose() { return { position: camera.position.toArray(), target: controls.target.toArray() }; }
  function setPose(p) { applyingPose = true; camera.position.fromArray(p.position); controls.target.fromArray(p.target); controls.update(); draw(); applyingPose = false; }
  function onChange(fn) { externalChange = fn; }
  function dispose() {
    cancelAnimationFrame(raf); cancelAnimationFrame(tween); resize.disconnect(); controls.dispose();
    scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    Object.values(rings).forEach(t => t.dispose()); renderer.dispose(); host.replaceChildren();
  }
  return { show, view, frame, getPose, setPose, onChange, dispose };
}
