import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { createPartMaterials, createEdgesOverlay, PALETTE } from './materials.js';

function bakeWorldGeometry(mesh) {
  mesh.updateMatrixWorld(true);
  const src = mesh.geometry;
  const pos = src.attributes.position;
  const idx = src.index;
  const count = idx ? idx.count : pos.count;
  const out = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  const m = mesh.matrixWorld;
  for (let i = 0; i < count; i++) {
    const vi = idx ? idx.getX(i) : i;
    v.fromBufferAttribute(pos, vi).applyMatrix4(m);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.computeVertexNormals();
  return geo;
}

function splitGeometryByKeys(geometry, keys, mode) {
  const pos = geometry.attributes.position;
  const triCount = Math.floor(pos.count / 3);
  const buckets = keys.map(() => []);

  const keyMeta = keys.map((k) => {
    const rad = (-k.rot * Math.PI) / 180;
    const hw = mode === 'keycaps' ? (18.05 + (k.w_u - 1) * 19.05) / 2 + 0.45 : 8.2;
    const hd = mode === 'keycaps' ? 18.05 / 2 + 0.45 : 8.2;
    return { x: k.x, y: k.y, ca: Math.cos(rad), sa: Math.sin(rad), hw, hd };
  });

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const x0 = pos.getX(i0), y0 = pos.getY(i0), z0 = pos.getZ(i0);
    const x1 = pos.getX(i0 + 1), y1 = pos.getY(i0 + 1), z1 = pos.getZ(i0 + 1);
    const x2 = pos.getX(i0 + 2), y2 = pos.getY(i0 + 2), z2 = pos.getZ(i0 + 2);
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;

    let bestIdx = -1;
    let bestScore = Infinity;
    for (let k = 0; k < keyMeta.length; k++) {
      const m = keyMeta[k];
      const dx = cx - m.x;
      const dy = cy - m.y;
      const lx = dx * m.ca - dy * m.sa;
      const ly = dx * m.sa + dy * m.ca;
      const nx = lx / m.hw;
      const ny = ly / m.hd;
      const inside = Math.abs(nx) <= 1.0 && Math.abs(ny) <= 1.0;
      const score = (inside ? 0 : 100) + nx * nx + ny * ny;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = k;
      }
    }
    buckets[bestIdx].push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
  }

  return buckets.map((arr) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  });
}

/**
 * Split a merged fastener BufferGeometry into exact per-body geometries using
 * CAD body_meta bounding boxes (with nearest-center fallback so 0 triangles are lost).
 */
function splitGeometryByFastenerInstances(geometry, instances) {
  const pos = geometry.attributes.position;
  const triCount = Math.floor(pos.count / 3);
  const buckets = instances.map(() => []);

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const x0 = pos.getX(i0), y0 = pos.getY(i0), z0 = pos.getZ(i0);
    const x1 = pos.getX(i0 + 1), y1 = pos.getY(i0 + 1), z1 = pos.getZ(i0 + 1);
    const x2 = pos.getX(i0 + 2), y2 = pos.getY(i0 + 2), z2 = pos.getZ(i0 + 2);
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const cz = (z0 + z1 + z2) / 3;

    let bestIdx = 0;
    let bestScore = Infinity;
    for (let k = 0; k < instances.length; k++) {
      const bb = instances[k].bbox_local;
      const pad = 0.45;
      const inside =
        cx >= bb[0][0] - pad && cx <= bb[1][0] + pad &&
        cy >= bb[0][1] - pad && cy <= bb[1][1] + pad &&
        cz >= bb[0][2] - pad && cz <= bb[1][2] + pad;
      const ctr = instances[k].center_local;
      const dx = cx - ctr[0];
      const dy = cy - ctr[1];
      const dz = cz - ctr[2];
      const score = (inside ? 0 : 10000) + dx * dx + dy * dy + dz * dz;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = k;
      }
    }
    buckets[bestIdx].push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
  }

  return buckets.map((arr) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  });
}

function buildProceduralDiodes(keys, materialRecords, pickableMeshes) {
  const diodeGroup = new THREE.Group();
  diodeGroup.name = 'procedural-diodes';

  const bodyGeo = new THREE.CylinderGeometry(0.75, 0.75, 3.2, 8);
  bodyGeo.rotateZ(Math.PI / 2);
  const bandGeo = new THREE.CylinderGeometry(0.79, 0.79, 0.72, 8);
  bandGeo.rotateZ(Math.PI / 2);
  const leadGeo = new THREE.CylinderGeometry(0.22, 0.22, 5.6, 6);
  leadGeo.rotateZ(Math.PI / 2);

  const glassRec = createPartMaterials('diodes', 'G2-CORE', '#e06d2b', false, 'wiring');
  glassRec.isElectronic = true;
  glassRec.alwaysColor = true;
  const bandRec = createPartMaterials('diodes', 'G2-CORE', '#1e1e1e', false, 'wiring');
  bandRec.isElectronic = true;
  bandRec.alwaysColor = true;
  const leadRec = createPartMaterials('diodes', 'G2-CORE', '#b89f78', false, 'wiring');
  leadRec.isElectronic = true;
  leadRec.alwaysColor = true;
  materialRecords.push(glassRec, bandRec, leadRec);

  for (const k of keys) {
    const g = new THREE.Group();
    g.name = `diode-${k.id}`;
    g.userData = { keyId: k.id, row: k.row, col: k.col };

    const pickInfo = {
      type: 'diode',
      id: `DIO-${String(k.id).padStart(2, '0')}`,
      partId: 'diodes',
      label: '1N4148 Diode',
      layer: 'wiring',
      step: 2,
      group: 'G2-CORE',
      row: k.row,
      col: k.col,
      keyId: k.id,
    };

    const body = new THREE.Mesh(bodyGeo, glassRec.surface);
    body.userData.pickInfo = pickInfo;
    pickableMeshes.push(body);
    const band = new THREE.Mesh(bandGeo, bandRec.surface);
    band.position.x = 1.0;
    const lead = new THREE.Mesh(leadGeo, leadRec.surface);

    g.add(lead, body, band);
    const [p0x, p0y] = k.pins[0];
    const rad = (k.rot * Math.PI) / 180;
    const dx = Math.cos(rad) * 2.1;
    const dy = Math.sin(rad) * 2.1;
    g.position.set(p0x + dx, p0y + dy, k.pin_tip_z + 0.65);
    g.rotation.z = rad;
    diodeGroup.add(g);
  }
  return diodeGroup;
}

function buildProceduralMatrixWires(keys, pads, spineGrooves, materialRecords) {
  const wireGroup = new THREE.Group();
  wireGroup.name = 'procedural-matrix-wires';

  const rowColors = ['#d55e00', '#2b6cb0', '#2e8b6a', '#9c527a'];
  const colColor = '#3f4954';
  const padByRole = new Map(pads.map((p) => [p.role, p]));

  const colRec = createPartMaterials('matrix-wires', 'G2-CORE', colColor, false, 'wiring');
  colRec.isElectronic = true;
  colRec.alwaysColor = true;
  materialRecords.push(colRec);

  function addTube(points, material, name) {
    if (points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.18);
    const segs = Math.max(12, points.length * 8);
    const geo = new THREE.TubeGeometry(curve, segs, 0.24, 6, false);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    wireGroup.add(mesh);
  }

  const groovesY = spineGrooves.ys || [49, 64, 72];
  const grooveZ = spineGrooves.z || 4.0;
  const seamX = spineGrooves.seam_x || 131.0;

  for (let r = 0; r < 4; r++) {
    const rowRec = createPartMaterials('matrix-wires', 'G2-CORE', rowColors[r], false, 'wiring');
    rowRec.isElectronic = true;
    rowRec.alwaysColor = true;
    materialRecords.push(rowRec);

    const rowKeys = keys.filter((k) => k.row === r).sort((a, b) => a.x - b.x);
    if (!rowKeys.length) continue;

    const zWire = rowKeys[0].pin_tip_z + 0.2;
    const left = rowKeys.filter((k) => k.x < seamX);
    const right = rowKeys.filter((k) => k.x >= seamX);
    const pts = [];

    for (const k of left) {
      pts.push(new THREE.Vector3(k.pins[0][0] + 2.8, k.pins[0][1], zWire));
    }
    if (left.length && right.length) {
      const avgY = (left[left.length - 1].y + right[0].y) / 2;
      const gy = groovesY.reduce((best, y) => (Math.abs(y - avgY) < Math.abs(best - avgY) ? y : best), groovesY[0]);
      pts.push(new THREE.Vector3(spineGrooves.x_min - 1.5, gy, grooveZ));
      pts.push(new THREE.Vector3(spineGrooves.x_max + 1.5, gy, grooveZ));
    }
    for (const k of right) {
      pts.push(new THREE.Vector3(k.pins[0][0] + 2.8, k.pins[0][1], zWire));
    }
    const pad = padByRole.get(`R${r}`);
    if (pad) {
      pts.push(new THREE.Vector3(pad.x, pad.y, pad.z + 0.6));
    }
    addTube(pts, rowRec.surface, `wire-R${r}`);
  }

  for (let c = 0; c < 12; c++) {
    const colKeys = keys.filter((k) => k.col === c).sort((a, b) => b.y - a.y);
    if (!colKeys.length) continue;
    const zWire = colKeys[0].pin_tip_z + 1.1;
    const pts = colKeys.map((k) => new THREE.Vector3(k.pins[1][0], k.pins[1][1], zWire));
    const pad = padByRole.get(`C${c}`);
    if (pad) {
      const last = pts[pts.length - 1];
      pts.push(new THREE.Vector3((last.x + pad.x) / 2, (last.y + pad.y) / 2, Math.min(zWire, pad.z + 1.2)));
      pts.push(new THREE.Vector3(pad.x, pad.y, pad.z + 0.6));
    }
    addTube(pts, colRec.surface, `wire-C${c}`);
  }

  return wireGroup;
}

function measureHousingFloorTiltRad(housingGeometries) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const geo of housingGeometries) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const frontBand = minY + 12.0;
  const backBand = maxY - 12.0;
  let zFront = Infinity;
  let yFrontAtZ = minY;
  let zBack = Infinity;
  let yBackAtZ = maxY;

  for (const geo of housingGeometries) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (y <= frontBand && z < zFront) {
        zFront = z;
        yFrontAtZ = y;
      }
      if (y >= backBand && z < zBack) {
        zBack = z;
        yBackAtZ = y;
      }
    }
  }
  const dy = Math.max(1e-3, yBackAtZ - yFrontAtZ);
  return Math.atan2(zFront - zBack, dy);
}

export async function buildAssemblyScene(data, onProgress) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      'models/assembly.glb',
      resolve,
      (ev) => {
        if (onProgress && data.model_bytes) {
          onProgress(Math.min(1, ev.loaded / data.model_bytes));
        }
      },
      reject,
    );
  });

  const meshByName = new Map();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    if (obj.isMesh && obj.name) {
      meshByName.set(obj.name, obj);
    }
  });

  const assemblyRoot = new THREE.Group();
  assemblyRoot.name = 'assembly-root';

  const groups = new Map();
  const groupList = [];
  const stepIndexByGroup = new Map();
  data.steps.forEach((step, idx) => {
    const g = new THREE.Group();
    g.name = step.code;
    g.userData = {
      id: step.id,
      code: step.code,
      label: step.label,
      color: step.color || '#485159',
      explodeZ: step.explode_z,
    };
    assemblyRoot.add(g);
    groups.set(step.code, g);
    groupList.push(g);
    stepIndexByGroup.set(step.code, idx);
  });

  const materialRecords = [];
  const partNodes = new Map();
  const partLayerById = new Map();
  const partMetaById = new Map(data.parts.map((p) => [p.id, p]));
  const sampleObjects = new Map();
  const pickableMeshes = [];
  const fastenerNodes = new Map(); // traceId -> { node, inst }
  const fastenerInstancesByPart = new Map();
  for (const inst of data.fastener_instances || []) {
    if (!fastenerInstancesByPart.has(inst.part_id)) {
      fastenerInstancesByPart.set(inst.part_id, []);
    }
    fastenerInstancesByPart.get(inst.part_id).push(inst);
  }

  const housingGeos = [];
  let switchGroups = [];
  let keycapGroups = [];

  for (const part of data.parts) {
    const group = groups.get(part.group);
    if (!group) continue;
    partLayerById.set(part.id, part.layer);
    const isCover = part.id.startsWith('COVER_');

    if (part.id === 'switches') {
      const container = new THREE.Group();
      container.name = 'part-switches';
      switchGroups = data.keys.map((k) => {
        const sg = new THREE.Group();
        sg.name = `switch-${k.id}`;
        sg.userData = { keyId: k.id, x: k.x, y: k.y, rot: k.rot, w_u: k.w_u, seat_z: k.seat_z };
        container.add(sg);
        return sg;
      });
      for (const piece of part.pieces) {
        const meshName = piece.mesh.split('#')[1];
        const srcMesh = meshByName.get(meshName);
        if (!srcMesh) throw new Error(`Missing GLB mesh: ${meshName}`);
        const baked = bakeWorldGeometry(srcMesh);
        const splitGeos = splitGeometryByKeys(baked, data.keys, 'switches');
        baked.dispose();
        for (let idx = 0; idx < data.keys.length; idx++) {
          const k = data.keys[idx];
          const g = splitGeos[idx];
          if (g.attributes.position.count === 0) {
            throw new Error(`Empty switch geometry for key ${k.id} (${piece.role})`);
          }
          const rec = createPartMaterials(`switch-${piece.role}`, 'G4-SW', piece.color, false, part.layer);
          rec.switchKeyId = k.id;
          rec.alwaysColor = piece.role === 'stem' || piece.role === 'contact';
          materialRecords.push(rec);

          const m = new THREE.Mesh(g, rec.surface);
          m.castShadow = true;
          m.receiveShadow = true;
          m.userData.pickInfo = {
            type: 'switch',
            id: `SW #${k.id}`,
            keyId: k.id,
            partId: 'switches',
            layer: part.layer,
            step: part.step,
            group: part.group,
            w_u: k.w_u,
            row: k.row,
            col: k.col,
            legend: k.legend,
          };
          pickableMeshes.push(m);
          switchGroups[idx].add(m);
          if (piece.role === 'upper' || piece.role === 'lower') {
            switchGroups[idx].add(createEdgesOverlay(g, rec.edge, 38));
          }
        }
      }
      group.add(container);
      partNodes.set(part.id, container);
      sampleObjects.set('switches', switchGroups[0]);
      continue;
    }

    if (part.id === 'keycaps') {
      const container = new THREE.Group();
      container.name = 'part-keycaps';
      keycapGroups = data.keys.map((k) => {
        const kg = new THREE.Group();
        kg.name = `keycap-${k.id}`;
        kg.userData = { keyId: k.id, w_u: k.w_u, x: k.x, y: k.y, rot: k.rot };
        container.add(kg);
        return kg;
      });
      const piece = part.pieces[0];
      const meshName = piece.mesh.split('#')[1];
      const srcMesh = meshByName.get(meshName);
      if (!srcMesh) throw new Error(`Missing GLB mesh: ${meshName}`);
      const baked = bakeWorldGeometry(srcMesh);
      const splitGeos = splitGeometryByKeys(baked, data.keys, 'keycaps');
      baked.dispose();

      for (let idx = 0; idx < data.keys.length; idx++) {
        const k = data.keys[idx];
        const g = splitGeos[idx];
        if (g.attributes.position.count === 0) {
          throw new Error(`Empty keycap geometry for key ${k.id}`);
        }
        const isAccentCap = k.w_u !== 1.0;
        const capHex = isAccentCap ? '#dfd6c8' : '#eee9e0';
        const rec = createPartMaterials('keycaps', 'G6-KEYCAP', capHex, false, part.layer);
        rec.keycapKeyId = k.id;
        rec.keycapW = k.w_u;
        materialRecords.push(rec);

        const m = new THREE.Mesh(g, rec.surface);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.pickInfo = {
          type: 'keycap',
          id: `KEY #${k.id}`,
          keyId: k.id,
          partId: 'keycaps',
          layer: part.layer,
          step: part.step,
          group: part.group,
          w_u: k.w_u,
          row: k.row,
          col: k.col,
          legend: k.legend,
        };
        pickableMeshes.push(m);
        keycapGroups[idx].add(m);
        keycapGroups[idx].add(createEdgesOverlay(g, rec.edge, 28));

        const sampleKey = `keycap:${k.w_u}`;
        if (!sampleObjects.has(sampleKey)) {
          sampleObjects.set(sampleKey, keycapGroups[idx]);
        }
      }
      group.add(container);
      partNodes.set(part.id, container);
      continue;
    }

    if (part.fastener && fastenerInstancesByPart.has(part.id)) {
      const partGroup = new THREE.Group();
      partGroup.name = `part-${part.id}`;
      partGroup.userData = { partId: part.id, instanceCount: part.instance_count };

      const fInsts = fastenerInstancesByPart.get(part.id);
      const piece = part.pieces[0];
      const meshName = piece.mesh.split('#')[1];
      const srcMesh = meshByName.get(meshName);
      if (!srcMesh) throw new Error(`Missing GLB mesh: ${meshName}`);
      const baked = bakeWorldGeometry(srcMesh);
      const splitGeos = splitGeometryByFastenerInstances(baked, fInsts);
      baked.dispose();

      const rec = createPartMaterials(part.id, part.group, piece.color || part.color, false, part.layer);
      materialRecords.push(rec);

      for (let k = 0; k < fInsts.length; k++) {
        const inst = fInsts[k];
        const g = splitGeos[k];
        const fNode = new THREE.Group();
        fNode.name = `fastener-${inst.id}`;
        fNode.userData = { fastenerId: inst.id, partId: part.id };

        const m = new THREE.Mesh(g, rec.surface);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.pickInfo = {
          type: 'fastener',
          id: inst.id,
          bodyName: inst.body_name,
          partId: inst.part_id,
          label: inst.label,
          spec: inst.spec_label,
          standard: inst.standard,
          qty: inst.qty_in_part,
          step: inst.step,
          group: inst.group,
          layer: inst.layer,
          target: inst.target,
          centerLocal: inst.center_local,
        };
        pickableMeshes.push(m);
        fNode.add(m);
        fNode.add(createEdgesOverlay(g, rec.edge, 36));
        partGroup.add(fNode);
        fastenerNodes.set(inst.id, { node: fNode, inst });
      }

      group.add(partGroup);
      partNodes.set(part.id, partGroup);
      sampleObjects.set(part.id, partGroup);
      continue;
    }

    const partGroup = new THREE.Group();
    partGroup.name = `part-${part.id}`;
    partGroup.userData = { partId: part.id, instanceCount: part.instance_count };

    for (const piece of part.pieces) {
      const meshName = piece.mesh.split('#')[1];
      const srcMesh = meshByName.get(meshName);
      if (!srcMesh) throw new Error(`Missing GLB mesh: ${meshName}`);
      const baked = bakeWorldGeometry(srcMesh);
      if (part.id === 'housing') {
        housingGeos.push(baked);
      }
      const hex = piece.color || part.color;
      const rec = createPartMaterials(part.id, part.group, hex, isCover, part.layer);
      if (part.preserveColors) rec.alwaysColor = true;
      materialRecords.push(rec);

      const m = new THREE.Mesh(baked, rec.surface);
      m.castShadow = !isCover;
      m.receiveShadow = true;
      m.userData.pickInfo = {
        type: 'part',
        id: part.id,
        partId: part.id,
        label: part.label,
        layer: part.layer,
        step: part.step,
        group: part.group,
        material: part.material,
        volumeCm3: part.volume_cm3,
        qty: part.instance_count,
      };
      pickableMeshes.push(m);
      partGroup.add(m);
      partGroup.add(createEdgesOverlay(baked, rec.edge, part.id === 'housing' ? 28 : 34));
    }

    group.add(partGroup);
    partNodes.set(part.id, partGroup);
    sampleObjects.set(part.id, partGroup);
  }

  if (switchGroups.length !== 46 || keycapGroups.length !== 46) {
    throw new Error(`Expected 46 switches/keycaps, got ${switchGroups.length}/${keycapGroups.length}`);
  }
  if (fastenerNodes.size !== 42) {
    throw new Error(`Expected 42 fastener instances, got ${fastenerNodes.size}`);
  }

  // Procedural G2-CORE electronics: 46 diodes & 4x12 matrix wires
  const g2 = groups.get('G2-CORE');
  const diodeGroup = buildProceduralDiodes(data.keys, materialRecords, pickableMeshes);
  const wireGroup = buildProceduralMatrixWires(data.keys, data.controller_pads, data.spine_grooves, materialRecords);
  g2.add(diodeGroup);
  g2.add(wireGroup);
  partNodes.set('diodes', diodeGroup);
  partNodes.set('matrix-wires', wireGroup);
  partLayerById.set('diodes', 'wiring');
  partLayerById.set('matrix-wires', 'wiring');
  sampleObjects.set('diodes', diodeGroup.children[0]);

  // Floor tilt alignment directly from actual CAD housing bottom mesh vertices
  const tiltRad = measureHousingFloorTiltRad(housingGeos);
  assemblyRoot.rotation.x = tiltRad;
  assemblyRoot.updateMatrixWorld(true);

  const rawBox = new THREE.Box3().setFromObject(assemblyRoot);
  const rawCenter = new THREE.Vector3();
  rawBox.getCenter(rawCenter);
  assemblyRoot.position.set(-rawCenter.x, -rawCenter.y, -rawBox.min.z);
  assemblyRoot.updateMatrixWorld(true);

  const toWorld = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(assemblyRoot.matrixWorld);

  // Assemble 150 scan target world coordinates (42 fasteners + 92 switch pins + 16 Pro Micro pads)
  const scanTargets = [];
  for (const inst of data.fastener_instances || []) {
    const [cx, cy, cz] = inst.center_local;
    scanTargets.push({
      kind: 'fastener',
      id: inst.id,
      partId: inst.part_id,
      layer: inst.layer,
      worldPos: toWorld(cx, cy, cz),
    });
  }
  const contactPinWorlds = [];
  for (const k of data.keys) {
    for (const [px, py] of k.pins) {
      const wp = toWorld(px, py, k.pin_tip_z);
      contactPinWorlds.push(wp);
      scanTargets.push({ kind: 'pin', keyId: k.id, layer: 'switches', worldPos: wp });
    }
  }
  if (contactPinWorlds.length !== 92) {
    throw new Error(`Expected 92 contact pins, got ${contactPinWorlds.length}`);
  }
  for (const pad of data.controller_pads) {
    scanTargets.push({ kind: 'pad', role: pad.role, layer: 'wiring', worldPos: toWorld(pad.x, pad.y, pad.z) });
  }

  // Anchors for Core Focus leader lines & close-up key
  const ctrlPart = partMetaById.get('controller');
  const ctrlBox = new THREE.Box3().setFromObject(partNodes.get('controller'));
  const ctrlCenter = ctrlBox.getCenter(new THREE.Vector3());

  const diodeLeft = diodeGroup.children
    .map((ch) => ({ ch, pos: new THREE.Box3().setFromObject(ch).getCenter(new THREE.Vector3()) }))
    .sort((a, b) => a.pos.x - b.pos.x)[4];
  const diodeAnchor = diodeLeft ? diodeLeft.pos : new THREE.Box3().setFromObject(diodeGroup.children[0]).getCenter(new THREE.Vector3());

  const padsAvg = new THREE.Vector3();
  for (const p of data.controller_pads) padsAvg.add(toWorld(p.x, p.y, p.z));
  padsAvg.divideScalar(Math.max(1, data.controller_pads.length));

  const m3Part = partMetaById.get('m3-upper');
  const m3Centers = (m3Part?.body_centers || []).map((c) => toWorld(...c)).sort((a, b) => b.x - a.x);
  const m3Anchor = m3Centers[0] || new THREE.Vector3(80, 20, 18);

  const closeupKey = data.keys.find((k) => k.id === data.closeup_key_id) || data.keys[39];
  const closeupSwitchGroup = switchGroups[closeupKey.id - 1];
  const closeupWorldCenter = toWorld(closeupKey.x, closeupKey.y, closeupKey.seat_z + 2.5);
  const closeupFlangeWorld = toWorld(closeupKey.x, closeupKey.y, closeupKey.seat_z + 0.6);

  const nonCountable = new Set(data.non_countable_parts || []);
  const stepColorByCode = new Map(data.steps.map((s) => [s.code, s.color || '#485159']));

  // Single SSOT metrics aggregator (zero hardcoding in HUD/BOM/Report)
  function computeMetrics() {
    assemblyRoot.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(assemblyRoot);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bbox.getSize(size);
    bbox.getCenter(center);

    const keycapsByWidth = {};
    for (const kg of keycapGroups) {
      const key = String(kg.userData.w_u);
      keycapsByWidth[key] = (keycapsByWidth[key] || 0) + 1;
    }

    const partCountOf = (pid) => {
      if (nonCountable.has(pid)) return 0;
      if (pid === 'switches') return switchGroups.length;
      if (pid === 'keycaps') return keycapGroups.length;
      if (pid === 'diodes') return diodeGroup.children.length;
      const meta = partMetaById.get(pid);
      return meta && meta.countable !== false ? meta.instance_count : 0;
    };

    const groupMetrics = data.steps.map((s) => {
      const count = s.parts.reduce((acc, pid) => acc + partCountOf(pid), 0);
      return {
        id: s.id,
        code: s.code,
        label: s.label,
        color: s.color || '#485159',
        explodeZ: s.explode_z,
        count,
        parts: [...s.parts],
      };
    });

    const layerMetrics = (data.visibility_layers || []).map((ly) => {
      const count = ly.parts.reduce((acc, pid) => acc + partCountOf(pid), 0);
      return {
        id: ly.id,
        label: ly.label,
        hotkey: ly.hotkey || null,
        parts: [...ly.parts],
        count,
      };
    });

    const bomMetrics = data.bom_groups.map((item) => {
      let count = 0;
      let layerIds = [];
      if (typeof item.keycap_w_u === 'number') {
        count = keycapsByWidth[String(item.keycap_w_u)] || 0;
        layerIds = ['keycaps'];
      } else {
        count = (item.parts || []).reduce((acc, pid) => acc + partCountOf(pid), 0);
        layerIds = [...new Set((item.parts || []).map((pid) => partLayerById.get(pid)).filter(Boolean))];
      }
      return {
        id: item.id,
        code: item.code,
        spec: item.spec || '',
        group: item.group,
        groupColor: stepColorByCode.get(item.group) || '#485159',
        sample: item.sample,
        thumbnailBody: item.thumbnail_body || null,
        parts: item.parts ? [...item.parts] : ['keycaps'],
        keycap_w_u: typeof item.keycap_w_u === 'number' ? item.keycap_w_u : null,
        layerIds,
        count,
      };
    });

    const totalParts = bomMetrics.reduce((acc, b) => acc + b.count, 0);
    const groupSum = groupMetrics.reduce((acc, g) => acc + g.count, 0);
    const layerSum = layerMetrics.reduce((acc, l) => acc + l.count, 0);
    if (totalParts !== groupSum || totalParts !== layerSum) {
      throw new Error(`SSOT parity error: BOM(${totalParts}) / steps(${groupSum}) / layers(${layerSum})`);
    }

    // 3D printed parts stats from CAD volume_cm3 & material
    const printedParts = data.parts.filter((p) => p.category === 'printed');
    const totalCm3 = Number(printedParts.reduce((acc, p) => acc + (p.volume_cm3 || 0), 0).toFixed(1));
    const bodyCount = printedParts.reduce((acc, p) => acc + p.instance_count, 0);
    const uniqueStls = printedParts.reduce((acc, p) => acc + (p.unique_stl_count || 1), 0);
    const mjfCount = printedParts.filter((p) => p.material === 'MJF PA12').reduce((acc, p) => acc + p.instance_count, 0);
    const resinCount = printedParts.filter((p) => p.material === 'SLA 8001 Resin').reduce((acc, p) => acc + p.instance_count, 0);

    // Fastener breakdown from 42 CAD instances
    const fList = data.fastener_instances || [];
    const fastenerBreakdown = {
      total: fList.length,
      m3: fList.filter((f) => f.part_id === 'm3-upper').length,
      ins: fList.filter((f) => f.part_id === 'inserts').length,
      m2: fList.filter((f) => ['case-screws', 'm2-bracket', 'm2-plate', 'm2-5'].includes(f.part_id)).length,
      nut: fList.filter((f) => f.kind === 'nut').length,
      mag: fList.filter((f) => f.kind === 'magnet').length,
    };

    const rows = 4;
    const cols = 12;
    const slots = rows * cols;
    const matrixStats = {
      rows,
      cols,
      slots,
      used: switchGroups.length,
      unused: slots - switchGroups.length,
      diodes: diodeGroup.children.length,
      wires: wireGroup.children.length,
    };

    return {
      bbox,
      center,
      widthMm: Number(size.x.toFixed(1)),
      depthMm: Number(size.y.toFixed(1)),
      heightMm: Number(size.z.toFixed(1)),
      tiltDeg: Number(Math.abs(THREE.MathUtils.radToDeg(tiltRad)).toFixed(1)),
      tiltRad,
      switches: switchGroups.length,
      keycaps: keycapGroups.length,
      keycapsByWidth,
      diodes: diodeGroup.children.length,
      wires: wireGroup.children.length,
      pins: contactPinWorlds.length,
      fasteners: fastenerBreakdown.total,
      fastenerBreakdown,
      pads: scanTargets.filter((t) => t.kind === 'pad').length,
      scanPointsTotal: scanTargets.length,
      printStats: { totalCm3, bodyCount, uniqueStls, mjfCount, resinCount },
      matrixStats,
      cadVerification: data.cad_verification || null,
      groups: groupMetrics,
      layers: layerMetrics,
      bom: bomMetrics,
      totalParts,
      stepsCount: data.steps.length,
      groupsCount: groupList.length,
      durationSec: data.duration_sec,
      closeupKeyId: closeupKey.id,
      closeupWorldCenter,
      closeupFlangeWorld,
      anchors: {
        mcu: ctrlCenter,
        diode: diodeAnchor,
        pads: padsAvg,
        fastener: m3Anchor,
      },
      ctrlName: ctrlPart ? ctrlPart.label : 'Pro Micro',
    };
  }

  const metrics = computeMetrics();

  // Ground shadow catcher & architectural corner ticks at Z = 0
  const groundGroup = new THREE.Group();
  groundGroup.name = 'ground-stage';

  const shadowMat = new THREE.ShadowMaterial({ color: PALETTE.ink, opacity: 0.08, depthWrite: false });
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(metrics.widthMm * 2.8, metrics.depthMm * 3.2),
    shadowMat,
  );
  shadowPlane.position.set(0, 0, -0.1);
  shadowPlane.receiveShadow = true;
  groundGroup.add(shadowPlane);

  const padX = metrics.widthMm / 2 + 10;
  const padY = metrics.depthMm / 2 + 10;
  const tk = 8;
  const tickPts = [
    [-padX, -padY, 0], [-padX + tk, -padY, 0], [-padX, -padY, 0], [-padX, -padY + tk, 0],
    [padX, -padY, 0], [padX - tk, -padY, 0], [padX, -padY, 0], [padX, -padY + tk, 0],
    [padX, padY, 0], [padX - tk, padY, 0], [padX, padY, 0], [padX, padY - tk, 0],
    [-padX, padY, 0], [-padX + tk, padY, 0], [-padX, padY, 0], [-padX, padY - tk, 0],
  ];
  const tickGeo = new THREE.BufferGeometry();
  tickGeo.setAttribute('position', new THREE.Float32BufferAttribute(tickPts.flat(), 3));
  const tickMat = new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.24, depthWrite: false });
  const tickLines = new THREE.LineSegments(tickGeo, tickMat);
  groundGroup.add(tickLines);

  return {
    assemblyRoot,
    groundGroup,
    groundMaterials: { shadowMat, tickMat },
    groups,
    groupList,
    stepIndexByGroup,
    partNodes,
    partLayerById,
    fastenerNodes,
    fastenerInstances: data.fastener_instances || [],
    pickableMeshes,
    switchGroups,
    keycapGroups,
    closeupSwitchGroup,
    diodeGroup,
    wireGroup,
    materialRecords,
    scanTargets,
    sampleObjects,
    metrics,
    computeMetrics,
  };
}
