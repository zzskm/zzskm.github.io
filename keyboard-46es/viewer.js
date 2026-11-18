import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const FOCUS = '#e79535', PICK = '#168b9b', INK = '#26332f', DONE = '#2f8f5b', DIM = '#c8452c';
const DIRECTIONS = { top: [0, -.001, 1], bottom: [0, -.001, -1], front: [0, -1, .015], iso: [.25, -.85, .85] };
// Hardware smaller than this (mm) gets an on-screen ring per instance so it does not vanish at full-board scale.
const MARK_SIZE = 14;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// A single ring per instance; a double ring where CAD stacks two of them at one spot (leg magnet pairs).
// `models/assembly.glb#part-20-03`: one GLB per build (assembly.py, glb.py), loaded once and shared by its pieces.
// Its positions are uint16 in each mesh's box (KHR_mesh_quantization); unpack them to millimetres and drop the
// index so computeVertexNormals gives flat CAD faces, exactly as the per-piece STLs used to.
const glbFiles = new Map();
async function meshGeometry(ref, onProgress) {
  const [url, name] = ref.split('#');
  if (!glbFiles.has(url)) glbFiles.set(url, new GLTFLoader().loadAsync(url, event => onProgress?.(event.loaded))
    .then(gltf => { gltf.scene.updateMatrixWorld(true); return gltf.scene; })
    .catch(error => { glbFiles.delete(url); throw error; }));  // a failed download can be retried
  const node = (await glbFiles.get(url)).getObjectByName(name);
  if (!node?.isMesh) throw new Error(`mesh ${name} missing in ${url}`);
  const source = node.geometry, position = source.attributes.position, xyz = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) { xyz[3 * i] = position.getX(i); xyz[3 * i + 1] = position.getY(i); xyz[3 * i + 2] = position.getZ(i); }
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(xyz, 3)); geometry.setIndex(source.index);
  geometry.applyMatrix4(node.matrixWorld);
  geometry = geometry.toNonIndexed(); geometry.computeVertexNormals(); geometry.computeBoundingBox();
  return geometry;
}

function ringTexture(color, double = false) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), radii = double ? [26, 15] : [24];
  for (const r of radii) { g.lineWidth = 12; g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(32, 32, r, 0, 7); g.stroke(); }
  for (const r of radii) { g.lineWidth = double ? 5 : 6; g.strokeStyle = color; g.beginPath(); g.arc(32, 32, r, 0, 7); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// A ticked spot: the builder tapped the ring after seating that screw, insert or magnet.
function checkTexture(double = false) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  if (double) for (const [w, s] of [[9, 'rgba(255,255,255,.9)'], [4, DONE]]) { g.lineWidth = w; g.strokeStyle = s; g.beginPath(); g.arc(32, 32, 27, 0, 7); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.arc(32, 32, double ? 21 : 25, 0, 7); g.fill();
  g.fillStyle = DONE; g.beginPath(); g.arc(32, 32, double ? 18 : 22, 0, 7); g.fill();
  g.lineWidth = 6; g.lineCap = g.lineJoin = 'round'; g.strokeStyle = '#ffffff';
  g.beginPath(); g.moveTo(21, 33); g.lineTo(29, 41); g.lineTo(44, 24); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Section caps: with a clipping plane on, the inside (back faces) of a cut solid shows through the
// cut, so drawing back faces as a hatch reads as a cut face without capping geometry.
function hatchBackFaces(material) {
  const cap = { value: new THREE.Color(INK) }, on = { value: 0 };
  material.userData.cap = cap; material.userData.capOn = on;
  material.onBeforeCompile = shader => {
    shader.uniforms.uCap = cap; shader.uniforms.uCapOn = on;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uCap;\nuniform float uCapOn;\nvoid main() {')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  if (uCapOn > .5 && !gl_FrontFacing) {
    float h = step(.6, fract((gl_FragCoord.x - gl_FragCoord.y) / 9.));
    gl_FragColor = vec4(mix(uCap, uCap * .62, h), 1.);
  }`);
  };
  material.customProgramCacheKey = () => 'hatch';
}

// One geometry per CAD instance box: a triangle belongs to the box that holds its centre (else the nearest one).
function splitInstances(geometry, boxes) {
  const pos = geometry.attributes.position.array, nor = geometry.attributes.normal.array;
  const parts = boxes.map(() => ({ pos: [], nor: [] })), e = .05;
  const centres = boxes.map(([lo, hi]) => [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
  for (let i = 0; i < pos.length; i += 9) {
    const c = [0, 1, 2].map(k => (pos[i + k] + pos[i + 3 + k] + pos[i + 6 + k]) / 3);
    let k = boxes.findIndex(([lo, hi]) => c.every((v, j) => v >= lo[j] - e && v <= hi[j] + e));
    if (k < 0) k = centres.reduce((best, m, j) => Math.hypot(m[0] - c[0], m[1] - c[1], m[2] - c[2]) < Math.hypot(centres[best][0] - c[0], centres[best][1] - c[1], centres[best][2] - c[2]) ? j : best, 0);
    for (let j = i; j < i + 9; j++) { parts[k].pos.push(pos[j]); parts[k].nor.push(nor[j]); }
  }
  if (parts.some(part => !part.pos.length)) return [[geometry, boxes]];  // boxes that do not match the mesh: keep it whole
  return parts.map((part, k) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(part.nor, 3));
    g.computeBoundingBox();
    return [g, [boxes[k]]];
  });
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
  // Text that follows a 3D point (laid-out part names, box sizes); never takes pointer events.
  const overlay = document.createElement('div'); overlay.className = 'asm-overlay'; host.append(overlay);
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
  // OrbitControls sets touch-action none on the canvas, which overrides the host's pan-y: give vertical swipes
  // back to the page (one finger turns the model sideways). A host with touch-action none (expanded view,
  // comparison) still wins, so there one finger turns freely.
  renderer.domElement.style.touchAction = 'pan-y';
  controls.enableDamping = true; controls.dampingFactor = .14; controls.zoomToCursor = true;
  controls.minDistance = 8; controls.maxDistance = 2400;  // far enough to take in every part laid out
  const meshes = [];
  const rings = { focus: ringTexture(FOCUS), pick: ringTexture(PICK), focus2: ringTexture(FOCUS, true), pick2: ringTexture(PICK, true),
    done: checkTexture(), done2: checkTexture(true) };
  const checked = new Set();  // `${part id}|${piece}:${instance}` of the spots ticked in this step
  // One plane for every part; off until section() turns it on. Points on the negative side are cut away.
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), cut = [];
  renderer.localClippingEnabled = true;
  // Rings for the open spots of a mesh and ticks for the checked ones, single and stacked apart.
  function remark(mesh) {
    const p = mesh.userData;
    for (const old of p.marks) { mesh.remove(old); old.geometry.dispose(); old.material.dispose(); }
    p.marks = [];
    for (const double of [false, true]) for (const done of [false, true]) {
      const group = p.spots.filter(s => s.double === double && checked.has(`${p.id}|${s.key}`) === done);
      if (!group.length) continue;
      const points = new THREE.BufferGeometry();
      points.setAttribute('position', new THREE.Float32BufferAttribute(group.flatMap(s => s.at), 3));
      const marks = new THREE.Points(points, new THREE.PointsMaterial({ map: done ? rings[double ? 'done2' : 'done'] : rings.focus,
        size: double ? 30 : 26, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false }));
      marks.renderOrder = 20; marks.visible = false; marks.raycast = () => {}; marks.userData = { double, done };
      p.marks.push(marks); mesh.add(marks);
    }
  }
  try {
    await Promise.all(data.parts.flatMap(p => (p.pieces || []).map(piece => ({ p, piece }))).map(async ({ p, piece }) => {
      const whole = await meshGeometry(piece.mesh, options.onProgress);
      const tiny = ([lo, hi]) => Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) <= MARK_SIZE;
      // Only parts made wholly of small instances (screws, nuts, magnets), not a switch's stem or a board's pins.
      const small = p.pieces.every(pc => (pc.instances || []).length && pc.instances.every(tiny)) ? piece.instances : [];
      // Small hardware becomes one mesh per screw so each can lie in its own place when the parts are laid out.
      const chunks = small.length > 1 ? splitInstances(whole, small) : [[whole, small]];
      if (chunks[0][0] !== whole) whole.dispose();
      const at = p.pieces.indexOf(piece);
      for (const [geometry, own] of chunks) {
        const material = new THREE.MeshStandardMaterial({ color: piece.color || p.color, roughness: .6, metalness: .08,
          side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clipShadows: true });
        hatchBackFaces(material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData = { ...p, baseColor: piece.color || p.color, pieceBodies: piece.bodies, instances: piece.instances || [],
          loose: small.length > 0, marks: [], home: new THREE.Vector3(), lift: 0, slot: null };
        // The key names the instance by its place in the build's sorted list, so a saved tick finds it again.
        mesh.userData.spots = own.map(b => ({ key: `${at}:${piece.instances.indexOf(b)}`, double: b[2] > 1,
          at: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2] }));
        remark(mesh);
        root.add(mesh); meshes.push(mesh);
      }
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
  // Part motion (apart from the camera): liftK raises the parts being fitted by the step's illustrationLift,
  // glow flashes them once seated, knollK carries every part to its place in the laid-out view.
  let motion = null, motionFrame = 0, liftK = 0, glow = 0, knolled = false, knollK = 0, dimsOn = false;
  const knollBox = new THREE.Box3(), WARM = new THREE.Color('#2b1906'), HOT = new THREE.Color('#9a5207');
  const smooth = k => k < .5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
  const tags = [], projected = new THREE.Vector3();
  function tag(kind, html = '') {
    const el = document.createElement('span'); el.className = `asm-tag ${kind}`; el.innerHTML = html; overlay.append(el);
    const t = { el, kind, at: new THREE.Vector3(), hidden: false }; tags.push(t); return t;
  }
  function dropTags(kind) {
    for (let i = tags.length - 1; i >= 0; i--) if (tags[i].kind === kind) { tags[i].el.remove(); tags.splice(i, 1); }
  }
  function placeTags() {
    const w = host.clientWidth, h = host.clientHeight;
    for (const t of tags) {
      projected.copy(t.at).project(camera);
      const off = t.hidden || projected.z > 1;
      t.el.style.display = off ? 'none' : '';
      if (!off) t.el.style.transform = `translate(${((projected.x + 1) / 2 * w).toFixed(1)}px, ${((1 - projected.y) / 2 * h).toFixed(1)}px) translate(-50%, ${t.kind === 'part' ? '0' : '-50%'})`;
    }
  }
  const draw = () => {
    ground.visible = camera.position.z > ground.position.z + 2;
    if (dimsOn) measure();
    renderer.render(scene, camera);
    if (tags.length) placeTags();
  };
  // One part motion at a time; starting another (or showing a step) first jumps the running one to its end.
  function run(duration, frame, done) {
    stopMotion();
    if (duration <= 0) { frame(1); done?.(); draw(); return; }
    const start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / duration);
      frame(k); draw();
      if (k < 1) motionFrame = requestAnimationFrame(step); else { motion = null; done?.(); draw(); }
    };
    motion = () => { cancelAnimationFrame(motionFrame); frame(1); done?.(); };
    motionFrame = requestAnimationFrame(step);
  }
  function stopMotion() { if (!motion) return; const finish = motion; motion = null; finish(); }
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
      new THREE.LineBasicMaterial({ color: INK, transparent: true, depthWrite: false, clippingPlanes: cut.length ? cut : null }));
    lines.raycast = () => {}; mesh.userData.edges = lines; mesh.add(lines);
  }
  // Where a part rests once any motion ends: its step position, or its slot while the parts are laid out.
  const rest = m => knolled && m.userData.slot ? m.userData.slot : m.userData.home;
  function boxOf(list, moving = false) {
    const box = new THREE.Box3();
    for (const m of list) box.union(m.geometry.boundingBox.clone().translate(moving ? m.position : rest(m)));
    return box;
  }
  function place() {
    for (const mesh of meshes) {
      const u = mesh.userData;
      mesh.position.copy(u.home); mesh.position.z += u.lift * liftK;
      if (u.slot && knollK) mesh.position.lerp(u.slot, knollK);
    }
    overlay.style.setProperty('--knoll', knollK.toFixed(3));
  }
  function shine(ping = 0) {
    for (const mesh of meshes) {
      if (!mesh.userData.glows) continue;
      mesh.material.emissive.lerpColors(WARM, HOT, glow);
      for (const marks of mesh.userData.marks) marks.material.size = (marks.userData.double ? 30 : 26) * (1 + ping);
    }
  }
  // Replay the step: parts with an illustrationLift start raised and come down, then everything being
  // fitted flashes and its rings close in. Steps without a lift only flash: no direction is implied.
  function play() {
    stopMotion();
    if (!current || knolled || sectioned || current.amount || current.pick || reducedMotion()) return false;
    const moving = meshes.filter(m => m.visible && m.userData.glows);
    if (!moving.length) return false;
    const lifted = moving.some(m => m.userData.lift);
    const hold = lifted ? 350 : 0, drop = lifted ? 850 : 0, flash = 700, total = hold + drop + flash;
    run(total, k => {
      const t = k * total, f = Math.min(1, Math.max(0, (t - hold - drop) / flash));
      liftK = lifted ? 1 - smooth(Math.min(1, Math.max(0, (t - hold) / drop))) : 0;
      glow = t < hold + drop || f >= 1 ? 0 : Math.sin(Math.PI * f);
      place(); shine(t < hold + drop ? 0 : 1 - smooth(f));
    });
    return true;
  }
  // Lay the visible parts out flat in rows, printed parts first, each with its name and the step's quantity.
  function slots() {
    dropTags('part'); knollBox.makeEmpty();
    const groups = new Map();
    for (const m of meshes) {
      m.userData.slot = null;
      if (m.visible) groups.set(m.userData.id, [...(groups.get(m.userData.id) || []), m]);
    }
    if (!groups.size) return;
    const between = 5, gap = 18;
    const items = [...groups].map(([id, list]) => {
      const units = (list[0].userData.loose ? list.map(m => [m]) : [list]).map(ms => {
        const box = new THREE.Box3(); ms.forEach(m => box.union(m.geometry.boundingBox));
        return { ms, box, size: box.getSize(new THREE.Vector3()) };
      }).sort((a, b) => a.box.min.x - b.box.min.x);
      const w = units.reduce((sum, u) => sum + u.size.x, 0) + between * (units.length - 1);
      return { id, p: list[0].userData, units, w, d: Math.max(...units.map(u => u.size.y)) };
    });
    const printed = it => it.p.category === '출력 부품' ? 0 : 1;
    items.sort((a, b) => printed(a) - printed(b) || b.w * b.d - a.w * a.d);
    const cw = Math.max(1, host.clientWidth), ch = Math.max(1, host.clientHeight);
    const aspect = Math.max(.6, Math.min(2.4, cw / ch)), nameW = cw < 500 ? 78 : 104, nameH = cw < 500 ? 30 : 34;
    // A name needs about 104 px across and 34 px under its part, whatever the zoom: pack, see what scale the
    // rows end up at on this canvas, and pack again with cells and row spacing that wide in millimetres.
    // Capped, so a small canvas with many parts gets crowded names instead of a layout too wide to zoom out to.
    let least = 64, row = 34, rows, depths, depth;
    for (let pass = 0; pass < 4; pass++) {
      for (const it of items) it.cell = Math.max(it.w, least);
      const area = items.reduce((sum, it) => sum + (it.cell + gap) * (it.d + row), 0);
      const limit = Math.max(...items.map(it => it.cell), Math.sqrt(area * aspect));
      rows = [[]]; let x = 0;
      for (const it of items) {
        if (x && x + it.cell > limit) { rows.push([]); x = 0; }
        rows.at(-1).push(it); x += it.cell + gap;
      }
      depths = rows.map(r => Math.max(...r.map(it => it.d)));
      depth = depths.reduce((a, b) => a + b, 0) + row * (rows.length - 1);
      const width = Math.max(...rows.map(r => r.reduce((sum, it) => sum + it.cell, 0) + gap * (r.length - 1)));
      const scale = Math.min(cw / (width * 1.1), ch / ((depth + row) * 1.0));  // px per mm once fitted
      const cell = Math.min(150, nameW / scale - gap), under = Math.min(70, nameH / scale);
      if (cell <= least * 1.05 && under <= row * 1.05) break;
      least = Math.max(least, cell); row = Math.max(row, under);
    }
    const floor = Math.min(...items.flatMap(it => it.units.map(u => u.box.min.z)));
    let y = middle.y + depth / 2;
    rows.forEach((r, i) => {
      let left = middle.x - (r.reduce((sum, it) => sum + it.cell, 0) + gap * (r.length - 1)) / 2;
      for (const it of r) {
        const cx = left + it.cell / 2, cy = y - depths[i] / 2; let ux = cx - it.w / 2;
        for (const u of it.units) {
          const c = u.box.getCenter(new THREE.Vector3());
          const offset = new THREE.Vector3(ux + u.size.x / 2 - c.x, cy - c.y, floor - u.box.min.z);
          for (const m of u.ms) m.userData.slot = offset.clone();
          knollBox.union(u.box.clone().translate(offset)); ux += u.size.x + between;
        }
        const need = current.step.needs?.[it.id];
        tag('part', `<b>${it.p.label}</b>${need == null ? '' : ` × ${need}`}`).at.set(cx, cy - it.d / 2 - 4, floor);
        left += it.cell + gap;
      }
      y -= depths[i] + row;
    });
    knollBox.min.y -= row * .8;  // room for the names under the front row
  }
  function knoll(on) {
    on = !!on;
    if (!current || on === knolled) return;
    stopMotion(); knolled = on;
    // On: show() lays out the slots. Off: show() restores the step and the old slots stay to fly home from.
    show(current.step, current.pick, on ? 0 : current.amount);
    const from = on ? 0 : 1;
    knollK = from; place();
    run(reducedMotion() ? 0 : 900, k => { knollK = from + (1 - 2 * from) * smooth(k); place(); }, () => {
      if (on) return;
      for (const m of meshes) m.userData.slot = null;
      dropTags('part');
    });
  }
  // Outer box of the picked part, else of the parts being fitted, else of everything but the case: sizes
  // come from the CAD meshes, so they are design values, not measurements of a print.
  const dimBox = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: DIM, depthTest: false, transparent: true, opacity: .9 }));
  dimBox.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(72), 3));
  dimBox.renderOrder = 15; dimBox.visible = false; dimBox.frustumCulled = false; dimBox.raycast = () => {}; scene.add(dimBox);
  const dimTags = [];
  function measure() {
    const visible = meshes.filter(m => m.visible), picked = visible.filter(m => m.userData.id === current?.pick);
    const solid = visible.filter(m => m.userData.id !== 'housing'), focused = solid.filter(m => m.userData.focus);
    const box = boxOf(picked.length ? picked : focused.length ? focused : solid.length ? solid : visible, true);
    dimBox.visible = !box.isEmpty();
    for (const t of dimTags) t.hidden = box.isEmpty();
    if (box.isEmpty()) return;
    const a = box.min, b = box.max, xyz = dimBox.geometry.attributes.position; let i = 0;
    const edge = (p, q) => { xyz.setXYZ(i++, ...p); xyz.setXYZ(i++, ...q); };
    for (const z of [a.z, b.z]) { edge([a.x, a.y, z], [b.x, a.y, z]); edge([b.x, a.y, z], [b.x, b.y, z]); edge([b.x, b.y, z], [a.x, b.y, z]); edge([a.x, b.y, z], [a.x, a.y, z]); }
    for (const [x, y] of [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]]) edge([x, y, a.z], [x, y, b.z]);
    xyz.needsUpdate = true;
    // Label the two floor-side edges nearest the viewer and the upright at the far end of the near edge.
    const c = box.getCenter(new THREE.Vector3()), eye = camera.position, size = box.getSize(new THREE.Vector3());
    const nearX = eye.x < c.x ? a.x : b.x, farX = eye.x < c.x ? b.x : a.x, nearY = eye.y < c.y ? a.y : b.y, low = eye.z > c.z ? a.z : b.z;
    [[c.x, nearY, low, size.x], [nearX, c.y, low, size.y], [farX, nearY, c.z, size.z]].forEach(([x, y, z, n], k) => {
      const t = dimTags[k], text = n.toFixed(1);
      t.at.set(x, y, z);
      if (t.text !== text) { t.text = text; t.el.innerHTML = `${text}<small> mm</small>`; }
    });
  }
  function dims(on) {
    dimsOn = !!on; dimBox.visible = dimsOn;
    if (dimsOn && !dimTags.length) for (let k = 0; k < 3; k++) dimTags.push(tag('dim'));
    if (!dimsOn) { dropTags('dim'); dimTags.length = 0; }
    draw();
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
    if (kind === 'section' && sectioned) return fit(sectionBox(), sectionDirection(), animate);
    if (kind === 'section') kind = 'iso';
    if (kind === 'knoll') {  // the laid-out parts from above the front edge, names readable
      if (knolled && !knollBox.isEmpty()) return fit(knollBox, new THREE.Vector3(0, -.5, 1), animate);
      kind = 'iso';
    }
    if (options.bounds) return fit(new THREE.Box3(new THREE.Vector3(...options.bounds[0]), new THREE.Vector3(...options.bounds[1])), kind, animate);
    const visible = meshes.filter(m => m.visible), focused = visible.filter(m => m.userData.focus);
    const all = boxOf(visible);
    if (knolled || !focused.length || focused.length === visible.length) return fit(all, kind, animate);
    const box = boxOf(focused), size = box.getSize(new THREE.Vector3()), whole = all.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y) >= Math.max(whole.x, whole.y) * .6) return fit(all, kind, animate);
    // A tall (portrait) canvas fits the board's width only, so give it less surrounding context.
    const need = Math.max(whole.x, whole.y) * (camera.aspect < .8 ? .3 : .5);
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
  // Section: cut along x or y at `at`, removing the side the viewer looks from (front for y, left for x),
  // seen from below when `below` (steps worked on the underside). Placement arrows would cover the cut.
  let sectioned = null, current = null;
  function sectionDirection() {
    const z = sectioned.below ? -.4 : .4;
    return sectioned.axis === 'x' ? new THREE.Vector3(-1, -.35, z) : new THREE.Vector3(.3, -1, z);
  }
  // Frame a slab just behind the cut, about 90 mm wide around the body it goes through.
  function sectionBox() {
    const all = boxOf(meshes.filter(m => m.visible)), { axis, at } = sectioned;
    const c = sectioned.center || all.getCenter(new THREE.Vector3()).toArray();
    const box = all.clone(), across = axis === 'x' ? 'y' : 'x', i = across === 'x' ? 0 : 1;
    box.min[across] = Math.max(box.min[across], c[i] - 45); box.max[across] = Math.min(box.max[across], c[i] + 45);
    box.min[axis] = Math.max(box.min[axis], at); box.max[axis] = Math.min(box.max[axis], at + 14);
    return box.isEmpty() ? all : box;
  }
  function section(spec) {
    sectioned = spec ? { axis: spec.axis === 'x' ? 'x' : 'y', at: +spec.at, center: spec.center, below: !!spec.below } : null;
    arrows.visible = !sectioned;
    cut.length = 0;
    if (sectioned) {
      plane.normal.set(sectioned.axis === 'x' ? 1 : 0, sectioned.axis === 'y' ? 1 : 0, 0);
      plane.constant = -sectioned.at; cut.push(plane);
    }
    for (const m of meshes) {
      m.material.clippingPlanes = cut.length ? cut : null; m.material.needsUpdate = true;
      if (m.userData.edges) { m.userData.edges.material.clippingPlanes = m.material.clippingPlanes; m.userData.edges.material.needsUpdate = true; }
    }
    restyle(); draw();
  }
  // Slider range: what is on screen, not the trial coupons laid out beside the board.
  function sectionRange(axis) { const b = boxOf(meshes.filter(m => m.visible)); return [b.min[axis], b.max[axis]]; }
  function show(step, pick, amount) {
    stopMotion();
    current = { step, pick, amount };
    const solo = pick && !step.show.includes(pick) && meshes.some(m => m.userData.id === pick);
    for (const mesh of meshes) {
      const p = mesh.userData;
      // What the step itself shows, whatever is picked: the fastener spots to tick come from this.
      p.inStep = step.show.includes(p.id) && !(step.hardwareStages && p.pieceBodies.some(b => b.startsWith('REF_M2_'))
        && !p.pieceBodies.some(b => step.hardwareStages.some(prefix => b.startsWith(prefix))));
      mesh.visible = solo ? p.id === pick : p.inStep;
      p.focus = pick ? p.id === pick : step.focus.includes(p.id);
      if (step.focusOnly && !p.focus) mesh.visible = false;
      if (knolled && p.id === 'housing') mesh.visible = false;  // the reference case is not a part to lay out
      p.lift = !pick && !amount && !knolled && step.focus.includes(p.id) ? +step.illustrationLift?.[p.id] || 0 : 0;
    }
    liftK = 0; glow = 0;
    restyle();
    for (const mesh of meshes) {
      const p = mesh.userData;
      const b = p.bbox, x = (b[0][0] + b[1][0]) / 2, y = (b[0][1] + b[1][1]) / 2;
      const rank = p.explode_rank ?? (p.id === 'keycaps' ? 5 : p.id.startsWith('COVER') || p.id === 'magnets' ? 4 : p.id === 'switches' ? 3 : p.id.startsWith('PLATE_') ? 2 : p.id === 'housing' ? -1 : 0);
      p.home.set(options.verticalExplode ? 0 : (x - 142) * amount * .4, options.verticalExplode ? 0 : (y - 46) * amount * .5, rank * amount * 20);
    }
    if (knolled) slots();
    place();
    const low = boxOf(meshes.filter(m => m.visible));
    if (!low.isEmpty()) ground.position.z = low.min.z - .4;
    arrows.clear();
    if (!amount && !solo && !step.focusOnly && !knolled) for (const a of step.placement || []) arrows.add(arrowMesh(a.from, a.to));
    if (solo) view(knolled ? 'knoll' : 'iso'); else draw();
  }
  // Fastener spots of the step (not of a picked part), as `${part id}|${piece}:${instance}`.
  function spots() {
    if (!current) return [];
    return meshes.filter(m => m.userData.inStep && current.step.focus.includes(m.userData.id))
      .flatMap(m => m.userData.spots.map(s => `${m.userData.id}|${s.key}`));
  }
  function setChecked(keys) {
    checked.clear(); for (const k of keys) checked.add(k);
    for (const m of meshes) if (m.userData.spots.length) remark(m);
    restyle(); draw();
  }
  // Rings on screen now, in page coordinates: a click within reach of one ticks it instead of picking a part.
  function markPoints() {
    const rect = renderer.domElement.getBoundingClientRect(), out = [];
    for (const mesh of meshes) {
      if (!mesh.visible || !mesh.userData.marks.some(m => m.visible)) continue;
      for (const s of mesh.userData.spots) {
        projected.set(...s.at).add(mesh.position).project(camera);
        if (projected.z <= 1) out.push({ key: `${mesh.userData.id}|${s.key}`, x: rect.left + (projected.x + 1) / 2 * rect.width, y: rect.top + (1 - projected.y) / 2 * rect.height });
      }
    }
    return out;
  }
  // Colours, ghosting, edges and rings for the current step. A section shows every part solid: the cut
  // already opens the housing, and see-through parts would show their own far walls as hatch.
  function restyle() {
    if (!current) return;
    const { step, pick, amount } = current;
    // When everything on screen is the work (first step), keep the real colours instead of one flat highlight.
    const highlight = meshes.some(m => m.visible && !m.userData.focus);
    for (const mesh of meshes) {
      const p = mesh.userData, focus = p.focus && mesh.visible;
      const ghost = !sectioned && !p.focus && (p.id === 'housing' || (options.ghost && step.focus.length > 0));
      const color = new THREE.Color(p.preserveColors ? p.baseColor : p.id === pick ? PICK : focus && highlight && p.id !== 'switches' ? FOCUS : p.baseColor);
      if (sectioned && p.id === 'housing') color.lerp(new THREE.Color('#ffffff'), .55);
      mesh.material.color.copy(color);
      mesh.material.emissive.set(focus && highlight ? '#2b1906' : '#000000');
      mesh.material.userData.cap.value.copy(color).lerp(new THREE.Color(INK), .45);
      mesh.material.userData.capOn.value = sectioned ? 1 : 0;
      mesh.material.transparent = ghost;
      mesh.material.opacity = ghost ? (p.id === 'housing' ? .1 : .26) : 1;
      mesh.material.depthWrite = !ghost;
      mesh.castShadow = !ghost; mesh.receiveShadow = !ghost;
      if (mesh.visible) {
        edges(mesh);
        p.edges.material.opacity = ghost ? (p.id === 'housing' ? .1 : .2) : focus && highlight ? .6 : .38;
      }
      p.glows = focus && highlight;
      for (const marks of p.marks) {
        marks.visible = focus && highlight && !amount && !sectioned && !knolled;
        marks.material.size = marks.userData.double ? 30 : 26;
        if (!marks.userData.done) marks.material.map = rings[(p.id === pick ? 'pick' : 'focus') + (marks.userData.double ? '2' : '')];
      }
    }
  }
  const ray = new THREE.Raycaster(), point = new THREE.Vector2();
  function hit(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    point.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
    ray.setFromCamera(point, camera);
    const hits = ray.intersectObjects(meshes.filter(m => m.visible), false)
      .filter(h => !sectioned || plane.distanceToPoint(h.point) >= -.01);
    return hits.find(h => !h.object.material.transparent) || hits[0];
  }
  let down;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    if (options.onMark) {
      const near = markPoints().map(m => ({ ...m, d: Math.hypot(e.clientX - m.x, e.clientY - m.y) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d <= 20) return options.onMark(near.key);
    }
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
    cancelAnimationFrame(raf); cancelAnimationFrame(tween); cancelAnimationFrame(motionFrame); motion = null;
    resize.disconnect(); controls.dispose();
    scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    Object.values(rings).forEach(t => t.dispose()); renderer.dispose(); host.replaceChildren();
  }
  return { show, view, frame, section, sectionRange, getPose, setPose, onChange, dispose,
    play, knoll, dims, spots, setChecked, markPoints };
}
