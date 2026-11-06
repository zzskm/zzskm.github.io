import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { STLLoader } from './vendor/STLLoader.js';

export async function createViewer(host, data, onSelect) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor('#e8edf0');
  host.append(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '회전하고 확대할 수 있는 조립 모델');
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x65717a, 2.6));
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(100, -200, 300); scene.add(light);
  const root = new THREE.Group(); scene.add(root);
  const camera = new THREE.PerspectiveCamera(35, 1, .1, 5000); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; controls.minDistance = 8; controls.maxDistance = 1600;
  const loader = new STLLoader(), meshes = [], thumbs = new Map();
  try {
    await Promise.all(data.parts.flatMap(p => (p.pieces || []).map(piece => ({p,piece}))).map(async ({p,piece}) => {
      const geometry = await loader.loadAsync(piece.mesh);
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ color:piece.color || p.color, roughness:.65, metalness:.12, side:THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = {...p, baseColor:piece.color || p.color, pieceBodies:piece.bodies}; root.add(mesh); meshes.push(mesh);
    }));
  } catch (e) { renderer.dispose(); host.replaceChildren(); throw e; }
  const draw = () => renderer.render(scene, camera);
  controls.addEventListener('change', draw);
  const resize = new ResizeObserver(() => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); camera.aspect = w/h; camera.updateProjectionMatrix(); draw();
  }); resize.observe(host);
  function view(kind = 'iso') {
    const box = new THREE.Box3();
    meshes.filter(m => m.visible).forEach(m => box.expandByObject(m));
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const distance = size.length() / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov/2))) / Math.min(camera.aspect, 1) * 1.12;
    const direction = kind === 'top' ? new THREE.Vector3(0,-.001,1) : kind === 'bottom' ? new THREE.Vector3(0,-.001,-1) : kind === 'front' ? new THREE.Vector3(0,-1,.015) : new THREE.Vector3(.25,-.85,.85);
    camera.position.copy(center).addScaledVector(direction.normalize(), distance);
    controls.target.copy(center); controls.update(); draw();
  }
  function show(step, pick, amount) {
    const solo = pick && !step.show.includes(pick) && meshes.some(m => m.userData.id === pick);
    for (const mesh of meshes) {
      const p = mesh.userData;
      mesh.visible = solo ? p.id === pick : step.show.includes(p.id);
      if (!solo && step.hardwareStages && p.pieceBodies.some(b => b.startsWith('REF_M2_'))) {
        mesh.visible &&= p.pieceBodies.some(b => step.hardwareStages.some(prefix => b.startsWith(prefix)));
      }
      const focus = pick ? p.id === pick : step.focus.includes(p.id);
      mesh.material.color.set(p.id === pick ? '#168b9b' : focus && p.id !== 'switches' ? '#e79535' : p.baseColor);
      mesh.material.emissive.set(focus ? '#33200a' : '#000000');
      mesh.material.transparent = p.id === 'housing' && !focus;
      mesh.material.opacity = mesh.material.transparent ? .22 : 1;
      mesh.material.depthWrite = !mesh.material.transparent;
      const b = p.bbox, x = (b[0][0]+b[1][0])/2, y=(b[0][1]+b[1][1])/2;
      const rank = p.id === 'keycaps' ? 5 : p.id.startsWith('COVER') || p.id === 'magnets' ? 4 : p.id === 'switches' ? 3 : p.id.startsWith('PLATE_') ? 2 : p.id === 'housing' ? -1 : 0;
      mesh.position.set((x-142)*amount*.4, (y-46)*amount*.5, rank*amount*20);
    }
    if (solo) view('iso'); else draw();
  }
  const ray = new THREE.Raycaster(), point = new THREE.Vector2();
  let down;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX,e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX-down[0],e.clientY-down[1]) > 5) return;
    const rect=renderer.domElement.getBoundingClientRect();
    point.set((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1);
    ray.setFromCamera(point,camera);
    const hits=ray.intersectObjects(meshes.filter(m=>m.visible));
    if (hits.length) onSelect(hits[0].object.userData.id);
  });
  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault(); document.getElementById('assembly-status').textContent='3D 연결이 끊겼습니다. 참고 이미지를 이용하거나 새로고침하세요.';
    document.getElementById('asm-fallback').open=true;
  });
  // Reuse the same GPU context to render and cache an isolated preview of each CAD part.
  function thumbnail(id, target) {
    if (!thumbs.has(id)) {
      const selected=meshes.filter(m=>m.userData.id===id); if (!selected.length) return;
      const visible=meshes.map(m=>m.visible), position=camera.position.clone(), aim=controls.target.clone();
      const oldAspect=camera.aspect;
      const saved=selected.map(m=>({m, color:m.material.color.clone(), position:m.position.clone()}));
      meshes.forEach(m=>{m.visible=selected.includes(m);});
      selected.forEach(m=>{m.position.set(0,0,0); m.material.color.set(m.userData.baseColor);});
      const w=host.clientWidth,h=host.clientHeight;
      renderer.setSize(160,110,false); camera.aspect=160/110; camera.updateProjectionMatrix(); view('iso');
      thumbs.set(id, renderer.domElement.toDataURL('image/png'));
      meshes.forEach((m,i)=>{m.visible=visible[i];});
      saved.forEach(({m,position,color})=>{m.position.copy(position);m.material.color.copy(color);});
      renderer.setSize(w,h); camera.aspect=oldAspect; camera.updateProjectionMatrix(); camera.position.copy(position); controls.target.copy(aim); controls.update(); draw();
    }
    const img=document.createElement('img'); img.src=thumbs.get(id); img.alt=''; target.replaceChildren(img);
  }
  return { show, view, thumbnail };
}
