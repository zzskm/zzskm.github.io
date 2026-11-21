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
  'G5-TOP': 0xf3efe6,
};

export function createPartMaterials(partId, groupCode, baseHex, isCover = false) {
  const monoColor = new THREE.Color(MONO_TONE_BY_GROUP[groupCode] ?? PALETTE.monoMid);
  const coreColor = new THREE.Color(baseHex || '#87959f');
  const xrayColor = new THREE.Color(PALETTE.xrayTint);

  const surface = new THREE.MeshStandardMaterial({
    color: monoColor.clone(),
    roughness: isCover ? 0.35 : 0.78,
    metalness: partId === 'inserts' || partId === 'magnets' ? 0.35 : 0.06,
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
    groupCode,
    partId,
  };
}

export function createEdgesOverlay(geometry, edgeMaterial, thresholdDeg = 32) {
  const edgeGeo = new THREE.EdgesGeometry(geometry, thresholdDeg);
  const lines = new THREE.LineSegments(edgeGeo, edgeMaterial);
  lines.renderOrder = 2;
  return lines;
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

  function update(scanZ, activeOpacity, bandMm = 3.2) {
    if (activeOpacity <= 0.005 || count === 0) {
      mesh.visible = false;
      return { fastenersOk: 0, pinsOk: 0, padsOk: 0, detected: 0 };
    }
    mesh.visible = true;
    mat.opacity = 0.94 * activeOpacity;

    let fastenersOk = 0;
    let pinsOk = 0;
    let padsOk = 0;
    let detected = 0;

    for (let i = 0; i < count; i++) {
      const t = targets[i];
      const dz = t.worldPos.z - scanZ;
      let scale = 0.0001;
      if (dz <= -bandMm) {
        // Verified / passed by scan plane -> Blue
        scale = t.kind === 'pin' ? 0.72 : t.kind === 'pad' ? 0.65 : 0.95;
        tmpColor.copy(cBlue);
        if (t.kind === 'fastener') fastenersOk++;
        else if (t.kind === 'pin') pinsOk++;
        else if (t.kind === 'pad') padsOk++;
      } else if (dz <= bandMm) {
        // Active scan band -> Orange pulse
        const u = 1.0 - Math.abs(dz) / bandMm;
        scale = (t.kind === 'pin' ? 0.95 : 1.25) * (0.9 + 0.45 * u);
        tmpColor.copy(cOrange);
        detected++;
        if (dz < 0) {
          if (t.kind === 'fastener') fastenersOk++;
          else if (t.kind === 'pin') pinsOk++;
          else if (t.kind === 'pad') padsOk++;
        }
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
    return { fastenersOk, pinsOk, padsOk, detected };
  }

  return { mesh, update };
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
    [0, 1], [1, 2], [2, 3], [3, 0], // bottom rectangle
    [0, 4], [1, 5], [2, 6], [3, 7], // vertical pillars
    [4, 5], [5, 6], [6, 7], [7, 4], // top rectangle
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
    mono = 1,
    xray = 0,
    coreFocus = 0,
    ghostOpacity = 1,
    highlightGroup = null,
    highlightPulse = 0,
    closeupKeyId = null,
    closeupCapOpacity = 1,
    closeupSwitchAlert = null, // 'warn' | 'ok' | null
    closeupBlink = 0,
  } = state;

  const cOrange = new THREE.Color(PALETTE.orange);
  const cBlue = new THREE.Color(PALETTE.blue);
  const cWork = new THREE.Color();

  for (const rec of materialRecords) {
    const isCoreGroup = rec.groupCode === 'G2-CORE' || rec.groupCode === 'G3-PLATE' || rec.groupCode === 'G4-SW';
    const isExterior = rec.groupCode === 'G1-BASE' || rec.groupCode === 'G5-TOP';

    // Base color blending: mono -> coreColor -> xrayTint
    cWork.copy(rec.monoColor).lerp(rec.coreColor, Math.min(1, coreFocus + (rec.alwaysColor ? 0.85 : 0)));
    if (xray > 0.001) {
      cWork.lerp(rec.xrayColor, xray * 0.82);
    }

    // Highlight pulse for active manual STEP
    if (highlightGroup && rec.groupCode === highlightGroup && highlightPulse > 0.001) {
      cWork.lerp(cOrange, highlightPulse * 0.45);
    }

    // Single-switch closeup emphasis
    if (rec.switchKeyId && rec.switchKeyId === closeupKeyId && closeupSwitchAlert) {
      if (closeupSwitchAlert === 'warn') {
        cWork.lerp(cOrange, 0.35 + 0.45 * closeupBlink);
      } else if (closeupSwitchAlert === 'ok') {
        cWork.lerp(cBlue, 0.55);
      }
    }

    rec.surface.color.copy(cWork);

    // Opacity calculation
    let targetOpacity = rec.isCover ? 0.52 : 1.0;
    if (xray > 0.001) {
      const xrayAlpha = rec.isElectronic ? 0.42 : 0.12;
      targetOpacity = targetOpacity * (1 - xray) + xrayAlpha * xray;
    }
    if (coreFocus > 0.001 && isExterior) {
      const extAlpha = rec.isCover ? Math.min(ghostOpacity, 0.18) : ghostOpacity;
      targetOpacity = targetOpacity * (1 - coreFocus) + extAlpha * coreFocus;
    }
    if (rec.keycapKeyId && rec.keycapKeyId === closeupKeyId && closeupCapOpacity < 0.99) {
      targetOpacity = Math.min(targetOpacity, closeupCapOpacity);
    }

    const transparent = targetOpacity < 0.985;
    if (rec.surface.transparent !== transparent) {
      rec.surface.transparent = transparent;
      rec.surface.needsUpdate = true;
    }
    rec.surface.opacity = targetOpacity;
    rec.surface.depthWrite = !transparent || (isCoreGroup && targetOpacity > 0.85);

    // Edge opacity
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
      if (rec.switchKeyId && rec.switchKeyId === closeupKeyId && closeupSwitchAlert) {
        rec.edge.color.setHex(closeupSwitchAlert === 'warn' ? PALETTE.orange : PALETTE.blue);
        edgeAlpha = 0.95;
      } else {
        rec.edge.color.setHex(PALETTE.ink);
      }
      rec.edge.opacity = edgeAlpha;
    }
  }
}
