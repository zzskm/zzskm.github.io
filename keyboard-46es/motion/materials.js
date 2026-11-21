import * as THREE from '../vendor/three.module.js';

export const PALETTE = Object.freeze({
  bg: 0xf2eee6,
  bgCss: '#F2EEE6',
  ink: 0x1e1e1e,
  inkCss: '#1E1E1E',
  orange: 0xe8612c,
  orangeCss: '#E8612C',
  blue: 0x2b6cb0,
  blueCss: '#2B6CB0',
  monoLight: 0xe6e1d6,
  monoMid: 0xd4cec2,
  monoDark: 0xbcb5a8,
  xrayTint: 0x2a2d30,
});

const MONO_TONE_BY_GROUP = {
  'G1-BASE': 0xe3ddd2,
  'G2-CORE': 0xd4cdc0,
  'G3-PLATE': 0xcfc8bc,
  'G4-SW': 0xe8e2d7,
  'G5-COVER': 0xdde5ec,
  'G6-KEYCAP': 0xf3efe6,
};

const FASTENER_FINISH = {
  inserts: { roughness: 0.34, metalness: 0.48 },
  'm3-upper': { roughness: 0.36, metalness: 0.50 },
  'case-screws': { roughness: 0.30, metalness: 0.56 },
  'm2-bracket': { roughness: 0.28, metalness: 0.58 },
  'm2-plate': { roughness: 0.28, metalness: 0.58 },
  'm2-5': { roughness: 0.28, metalness: 0.58 },
  'm2-nuts-bracket': { roughness: 0.26, metalness: 0.60 },
  'm2-nuts-plate': { roughness: 0.26, metalness: 0.60 },
  magnets: { roughness: 0.20, metalness: 0.68 },
};

export function createPartMaterials(partId, groupCode, baseHex, isCover = false, layer = '') {
  const monoColor = new THREE.Color(MONO_TONE_BY_GROUP[groupCode] ?? PALETTE.monoMid);
  const coreColor = new THREE.Color(baseHex || '#87959f');
  const xrayColor = new THREE.Color(PALETTE.xrayTint);
  const fFinish = FASTENER_FINISH[partId];

  const surface = new THREE.MeshStandardMaterial({
    color: monoColor.clone(),
    roughness: fFinish ? fFinish.roughness : isCover ? 0.32 : 0.78,
    metalness: fFinish ? fFinish.metalness : 0.06,
    flatShading: true,
    transparent: false,
    opacity: 1.0,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const edge = new THREE.LineBasicMaterial({
    color: PALETTE.ink,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });

  return {
    surface,
    edge,
    monoColor,
    coreColor,
    xrayColor,
    isCover,
    isFastener: Boolean(fFinish),
    alwaysColor: Boolean(fFinish),
    groupCode,
    partId,
    layer,
  };
}

export function createEdgesOverlay(geometry, edgeMaterial, thresholdDeg = 32) {
  const edgeGeo = new THREE.EdgesGeometry(geometry, thresholdDeg);
  const lines = new THREE.LineSegments(edgeGeo, edgeMaterial);
  lines.renderOrder = 2;
  return lines;
}

/**
 * Unified X-Ray scan target classifier used by both 3D markers and HUD telemetry
 * so blue indicator color and OK counters are always 1:1 synchronized (Bug B fix).
 */
export function evaluateScanTarget(target, scanZ, bandMm = 2.0) {
  const dz = target.worldPos.z - scanZ;
  if (dz <= -bandMm * 0.45) return 'passed';
  if (dz <= bandMm) return 'active';
  return 'pending';
}

export function createScanPlane(bbox) {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);

  const w = size.x + 36;
  const d = size.y + 36;
  const group = new THREE.Group();
  group.name = 'xray-scan-plane';
  group.visible = false;

  const planeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(PALETTE.orange) },
      uOpacity: { value: 0.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float ex = min(vUv.x, 1.0 - vUv.x);
        float ey = min(vUv.y, 1.0 - vUv.y);
        float edge = 1.0 - smoothstep(0.0, 0.035, min(ex, ey));
        float gridX = step(0.96, fract(vUv.x * 24.0));
        float gridY = step(0.96, fract(vUv.y * 10.0));
        float alpha = (0.10 + 0.16 * max(gridX, gridY) + 0.55 * edge) * uOpacity;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, d), planeMat);
  plane.position.set(center.x, center.y, 0);
  plane.renderOrder = 10;
  group.add(plane);

  const borderGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d));
  const borderMat = new THREE.LineBasicMaterial({
    color: PALETTE.orange,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const border = new THREE.LineSegments(borderGeo, borderMat);
  border.position.set(center.x, center.y, 0);
  border.renderOrder = 11;
  group.add(border);

  return { group, planeMat, borderMat };
}

export function createScanIndicators(targets) {
  const count = targets.length;
  const geo = new THREE.OctahedronGeometry(1.45, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  mesh.name = 'xray-scan-indicators';
  mesh.renderOrder = 20;
  mesh.visible = false;
  mesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const cOrange = new THREE.Color(PALETTE.orange);
  const cBlue = new THREE.Color(PALETTE.blue);
  const cDim = new THREE.Color(0x9a9488);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < count; i++) {
    dummy.position.set(0, 0, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, cDim);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  function update(scanZ, activeOpacity, hiddenLayers = null, bandMm = 2.0) {
    if (activeOpacity <= 0.005 || count === 0) {
      mesh.visible = false;
      return {
        fastenersOk: 0,
        pinsOk: 0,
        padsOk: 0,
        fastenersTotal: 0,
        pinsTotal: 0,
        padsTotal: 0,
        detected: 0,
      };
    }
    mesh.visible = true;
    mat.opacity = 0.94 * activeOpacity;

    let fastenersOk = 0;
    let pinsOk = 0;
    let padsOk = 0;
    let fastenersTotal = 0;
    let pinsTotal = 0;
    let padsTotal = 0;
    let detected = 0;

    for (let i = 0; i < count; i++) {
      const t = targets[i];
      if (hiddenLayers && t.layer && hiddenLayers.has(t.layer)) {
        dummy.position.copy(t.worldPos);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }

      if (t.kind === 'fastener') fastenersTotal++;
      else if (t.kind === 'pin') pinsTotal++;
      else if (t.kind === 'pad') padsTotal++;

      const status = evaluateScanTarget(t, scanZ, bandMm);
      const dz = t.worldPos.z - scanZ;
      let scale = 0.0001;
      if (status === 'passed') {
        scale = t.kind === 'pin' ? 0.72 : t.kind === 'pad' ? 0.65 : 0.95;
        tmpColor.copy(cBlue);
        if (t.kind === 'fastener') fastenersOk++;
        else if (t.kind === 'pin') pinsOk++;
        else if (t.kind === 'pad') padsOk++;
      } else if (status === 'active') {
        const u = Math.max(0, 1.0 - Math.abs(dz) / bandMm);
        scale = (t.kind === 'pin' ? 0.95 : 1.25) * (0.9 + 0.45 * u);
        tmpColor.copy(cOrange);
        detected++;
      } else {
        scale = 0.25;
        tmpColor.copy(cDim);
      }
      dummy.position.copy(t.worldPos);
      dummy.scale.setScalar(scale * activeOpacity);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return {
      fastenersOk,
      pinsOk,
      padsOk,
      fastenersTotal,
      pinsTotal,
      padsTotal,
      detected,
    };
  }

  return { mesh, update };
}

/**
 * Local-axis bolt insertion guides: dashed axis line (with computeLineDistances)
 * + thin 0.28 mm cylinder + seated hole target ring with blue lock pulse.
 * Mounted inside assemblyRoot so all vectors stay in exact local CAD coordinates.
 */
export function createBoltAxisGuides(fastenerInstances) {
  const root = new THREE.Group();
  root.name = 'bolt-axis-guides';

  const cylGeo = new THREE.CylinderGeometry(0.28, 0.28, 1.0, 6);
  cylGeo.rotateX(Math.PI / 2); // Align cylinder height along local Z

  const items = [];
  for (const inst of fastenerInstances) {
    const holder = new THREE.Group();
    holder.name = `guide-${inst.id}`;
    holder.visible = false;

    const ax = inst.axis_local; // e.g. [0, 0, -1] for top-down, [0, 0, +1] for bottom-up
    const stroke = inst.stroke_mm;
    const [cx, cy, cz] = inst.center_local;
    const startX = -ax[0] * stroke;
    const startY = -ax[1] * stroke;
    const startZ = -ax[2] * stroke;

    // 1. Dashed insertion axis line
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      startX, startY, startZ,
    ], 3));
    const lineMat = new THREE.LineDashedMaterial({
      color: PALETTE.orange,
      dashSize: 2.2,
      gapSize: 1.4,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const line = new THREE.LineSegments(lineGeo, lineMat);
    line.computeLineDistances();
    line.renderOrder = 14;
    holder.add(line);

    // 2. Thin 0.28 mm high-visibility guide cylinder (scales dynamically with remaining stroke)
    const cylMat = new THREE.MeshBasicMaterial({
      color: PALETTE.orange,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const cyl = new THREE.Mesh(cylGeo, cylMat);
    cyl.renderOrder = 13;
    holder.add(cyl);

    // 3. Hole target ring at seated plane
    const rOuter = Math.max(2.1, inst.diameter_mm * 0.85);
    const rInner = Math.max(1.25, rOuter - 0.85);
    const ringGeo = new THREE.RingGeometry(rInner, rOuter, 20);
    const ringMat = new THREE.MeshBasicMaterial({
      color: PALETTE.orange,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(0, 0, ax[2] <= 0 ? 0.8 : -0.8);
    ring.renderOrder = 16;
    holder.add(ring);

    holder.position.set(cx, cy, cz);
    root.add(holder);
    items.push({ inst, holder, lineMat, cyl, cylMat, ring, ringMat });
  }

  function update(fastenersState, groupExplodeZ, stepIndexByGroup, hiddenLayers) {
    let visibleCount = 0;
    const progressByPart = fastenersState?.progressByPart || {};
    const guideOpacityByPart = fastenersState?.guideOpacityByPart || {};

    for (const item of items) {
      const { inst, holder, lineMat, cyl, cylMat, ring, ringMat } = item;
      const op = guideOpacityByPart[inst.part_id] || 0;
      if (op <= 0.01 || (hiddenLayers && hiddenLayers.has(inst.layer))) {
        holder.visible = false;
        continue;
      }
      holder.visible = true;
      visibleCount++;

      const gIdx = stepIndexByGroup.get(inst.group) ?? 0;
      const gz = groupExplodeZ[gIdx] || 0;
      holder.position.set(inst.center_local[0], inst.center_local[1], inst.center_local[2] + gz);

      const prog = progressByPart[inst.part_id] ?? 1;
      const remain = Math.max(0, 1 - prog);
      const len = Math.max(0.01, inst.stroke_mm * remain);
      const ax = inst.axis_local;

      cyl.visible = remain > 0.04;
      cyl.scale.set(1, 1, len);
      cyl.position.set(-ax[0] * len * 0.5, -ax[1] * len * 0.5, -ax[2] * len * 0.5);
      cylMat.opacity = 0.42 * op * Math.min(1, remain * 1.6);

      lineMat.opacity = 0.82 * op * (remain > 0.04 ? 1 : 0.25);

      const locked = prog >= 0.94;
      ringMat.color.setHex(locked ? PALETTE.blue : PALETTE.orange);
      ringMat.opacity = (locked ? 0.95 : 0.85) * op;
      const pulse = locked ? 1.18 : 1.0 + 0.12 * Math.sin(prog * Math.PI * 3);
      ring.scale.setScalar(pulse);
    }
    return visibleCount;
  }

  return { root, items, update };
}

export function createBoundingBoxDrawer(bbox) {
  const min = bbox.min;
  const max = bbox.max;
  const c = [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
  ];
  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [0, 4], [1, 5], [2, 6], [3, 7],
    [4, 5], [5, 6], [6, 7], [7, 4],
  ];
  const positions = new Float32Array(pairs.length * 2 * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: PALETTE.orange,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = 'bbox-drawer';
  lines.renderOrder = 15;
  lines.visible = false;

  const tmp = new THREE.Vector3();
  function update(drawProgress, opacity) {
    if (opacity <= 0.005 || drawProgress <= 0.001) {
      lines.visible = false;
      return;
    }
    lines.visible = true;
    mat.opacity = opacity;
    const posAttr = geo.attributes.position;
    for (let i = 0; i < pairs.length; i++) {
      const startSlot = (i / pairs.length) * 0.65;
      const localP = Math.max(0, Math.min(1, (drawProgress - startSlot) / 0.35));
      const a = c[pairs[i][0]];
      const b = c[pairs[i][1]];
      tmp.lerpVectors(a, b, localP);
      posAttr.setXYZ(i * 2, a.x, a.y, a.z);
      posAttr.setXYZ(i * 2 + 1, tmp.x, tmp.y, tmp.z);
    }
    posAttr.needsUpdate = true;
  }

  return { lines, update };
}

export function applyMaterialStates(materialRecords, state) {
  const {
    xray = 0,
    coreFocus = 0,
    ghostOpacity = 1,
    highlightGroup = null,
    highlightPulse = 0,
    closeupKeyId = null,
    closeupCapOpacity = 1,
    closeupSwitchAlert = null, // 'warn' | 'ok' | null
    closeupBlink = 0,
    activeFastenerParts = null, // Set<string> | null
    highlightParts = null, // Set<string> | null (from BOM/legend hover/click)
    highlightKeycapWidth = null, // number | null
    ghostParts = null, // Set<string> | null (hidden-layer BOM ghost preview)
    dimUnselected = false,
  } = state;

  const cOrange = new THREE.Color(PALETTE.orange);
  const cBlue = new THREE.Color(PALETTE.blue);
  const cWork = new THREE.Color();

  const hasSelection = Boolean(
    (highlightParts && highlightParts.size > 0) || typeof highlightKeycapWidth === 'number',
  );

  for (const rec of materialRecords) {
    const isCoreGroup = rec.groupCode === 'G2-CORE' || rec.groupCode === 'G3-PLATE' || rec.groupCode === 'G4-SW';
    const isExterior = rec.groupCode === 'G1-BASE' || rec.groupCode === 'G5-COVER' || rec.groupCode === 'G6-KEYCAP';
    const isGhostPreview = Boolean(ghostParts && ghostParts.has(rec.partId));
    const isSelected = Boolean(
      (highlightParts && highlightParts.has(rec.partId)) ||
      (typeof highlightKeycapWidth === 'number' && rec.partId === 'keycaps' && rec.keycapW === highlightKeycapWidth),
    );
    const isFastenerActive = Boolean(activeFastenerParts && activeFastenerParts.has(rec.partId));

    // Base color blending: mono -> coreColor -> xrayTint
    const colorMix = Math.min(1, coreFocus + (rec.alwaysColor ? 0.88 : 0) + (isSelected ? 0.85 : 0));
    cWork.copy(rec.monoColor).lerp(rec.coreColor, colorMix);
    if (xray > 0.001) {
      cWork.lerp(rec.xrayColor, xray * 0.82);
    }

    // Highlight pulse for active manual STEP
    if (highlightGroup && rec.groupCode === highlightGroup && highlightPulse > 0.001) {
      cWork.lerp(cOrange, highlightPulse * 0.42);
    }

    // Active fastener insertion accent
    if (isFastenerActive) {
      cWork.lerp(cOrange, 0.34);
    }

    // BOM / Legend hover or click highlight
    if (isSelected) {
      cWork.lerp(cOrange, isGhostPreview ? 0.72 : 0.48);
    }

    // Single-switch closeup emphasis (Bug D fix: preserve Milky Yellow Pro stem color!)
    if (rec.switchKeyId && rec.switchKeyId === closeupKeyId && closeupSwitchAlert) {
      if (closeupSwitchAlert === 'warn') {
        const w = rec.partId === 'switch-stem' ? 0.25 + 0.25 * closeupBlink : 0.35 + 0.45 * closeupBlink;
        cWork.lerp(cOrange, w);
      } else if (closeupSwitchAlert === 'ok') {
        cWork.lerp(cBlue, rec.partId === 'switch-stem' ? 0.18 : 0.55);
      }
    }

    rec.surface.color.copy(cWork);

    // Opacity calculation
    let targetOpacity = rec.isCover ? 0.52 : 1.0;
    if (xray > 0.001) {
      const xrayAlpha = rec.isElectronic ? 0.42 : rec.isFastener ? 0.52 : 0.12;
      targetOpacity = targetOpacity * (1 - xray) + xrayAlpha * xray;
    }
    if (coreFocus > 0.001 && isExterior) {
      const extAlpha = rec.isCover ? Math.min(ghostOpacity, 0.18) : ghostOpacity;
      targetOpacity = targetOpacity * (1 - coreFocus) + extAlpha * coreFocus;
    }
    if (rec.keycapKeyId && rec.keycapKeyId === closeupKeyId && closeupCapOpacity < 0.99) {
      targetOpacity = Math.min(targetOpacity, closeupCapOpacity);
    }
    if (hasSelection && dimUnselected && !isSelected) {
      targetOpacity = Math.min(targetOpacity, 0.22);
    }
    if (isGhostPreview) {
      targetOpacity = 0.26;
    }

    const transparent = targetOpacity < 0.985;
    if (rec.surface.transparent !== transparent) {
      rec.surface.transparent = transparent;
      rec.surface.needsUpdate = true;
    }
    rec.surface.opacity = targetOpacity;
    rec.surface.depthWrite = !transparent || (isCoreGroup && targetOpacity > 0.85);

    // Edge opacity & color
    if (rec.edge) {
      let edgeAlpha = 0.42;
      if (xray > 0.001) {
        edgeAlpha = edgeAlpha * (1 - xray) + 0.52 * xray;
      }
      if (coreFocus > 0.001 && isExterior) {
        edgeAlpha = edgeAlpha * (1 - coreFocus) + 0.14 * coreFocus;
      }
      if (rec.keycapKeyId && rec.keycapKeyId === closeupKeyId && closeupCapOpacity < 0.25) {
        edgeAlpha = 0.06;
      }
      if (hasSelection && dimUnselected && !isSelected) {
        edgeAlpha = Math.min(edgeAlpha, 0.12);
      }
      if (rec.switchKeyId && rec.switchKeyId === closeupKeyId && closeupSwitchAlert) {
        rec.edge.color.setHex(closeupSwitchAlert === 'warn' ? PALETTE.orange : PALETTE.blue);
        edgeAlpha = 0.95;
      } else if (isSelected || isFastenerActive || isGhostPreview) {
        rec.edge.color.setHex(PALETTE.orange);
        edgeAlpha = isGhostPreview ? 0.72 : 0.92;
      } else {
        rec.edge.color.setHex(PALETTE.ink);
      }
      rec.edge.opacity = edgeAlpha;
    }
  }
}
