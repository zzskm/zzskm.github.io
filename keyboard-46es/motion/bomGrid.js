import * as THREE from '../vendor/three.module.js';
import { PALETTE } from './materials.js';

function clipGeometryToBox(geometry, boxMin, boxMax, pad = 0.6) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = src.attributes.position;
  const triCount = Math.floor(pos.count / 3);
  const kept = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const x0 = pos.getX(i0), y0 = pos.getY(i0), z0 = pos.getZ(i0);
    const x1 = pos.getX(i0 + 1), y1 = pos.getY(i0 + 1), z1 = pos.getZ(i0 + 1);
    const x2 = pos.getX(i0 + 2), y2 = pos.getY(i0 + 2), z2 = pos.getZ(i0 + 2);
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const cz = (z0 + z1 + z2) / 3;
    if (
      cx >= boxMin[0] - pad && cx <= boxMax[0] + pad &&
      cy >= boxMin[1] - pad && cy <= boxMax[1] + pad &&
      cz >= boxMin[2] - pad && cz <= boxMax[2] + pad
    ) {
      kept.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
    }
  }
  if (!kept.length) return geometry.clone();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(kept, 3));
  out.computeVertexNormals();
  return out;
}

function cloneSampleForThumbnail(item, sampleObjects, partsById) {
  const sampleKey = item.sample;
  const src = sampleObjects.get(sampleKey);
  if (!src) return new THREE.Group();

  const partMeta = partsById.get(sampleKey);
  // Deterministic body_meta clipping when thumbnailBody is declared (never relies on unstable instances[0])
  let clipBox = null;
  if (item.thumbnailBody && partMeta?.body_meta?.[item.thumbnailBody]) {
    clipBox = partMeta.body_meta[item.thumbnailBody].bbox;
  } else if (
    partMeta &&
    partMeta.pieces &&
    partMeta.pieces[0] &&
    partMeta.pieces[0].instances &&
    partMeta.pieces[0].instances.length > 1
  ) {
    clipBox = [partMeta.pieces[0].instances[0][0], partMeta.pieces[0].instances[0][1]];
  }

  const root = new THREE.Group();
  src.updateMatrixWorld(true);

  let foundSingleFastener = false;
  if (item.thumbnailBody) {
    src.traverse((obj) => {
      if (obj.isMesh && obj.userData?.pickInfo?.bodyName === item.thumbnailBody) {
        foundSingleFastener = true;
      }
    });
  }

  src.traverse((obj) => {
    if (!obj.isMesh) return;
    if (foundSingleFastener && obj.userData?.pickInfo?.bodyName !== item.thumbnailBody) {
      return;
    }
    let geo = obj.geometry;
    if (!foundSingleFastener && clipBox) {
      geo = clipGeometryToBox(geo, clipBox[0], clipBox[1], 0.8);
    } else {
      geo = geo.clone();
    }
    const baseColor =
      sampleKey === 'housing' ? new THREE.Color(0xdcd6cb)
      : sampleKey === 'switches' ? (obj.material?.color?.clone() || new THREE.Color(0xe0d6bc))
      : sampleKey === 'controller' || sampleKey === 'diodes' ? (obj.material?.color?.clone() || new THREE.Color(0x2e7d6c))
      : sampleKey.startsWith('keycap:') ? new THREE.Color(0xebe6dc)
      : sampleKey.startsWith('COVER_') ? new THREE.Color(0xa6c4df)
      : sampleKey === 'magnets' ? new THREE.Color(0xd8e0e8)
      : sampleKey === 'm3-upper' ? new THREE.Color(0x2a3038)
      : sampleKey === 'm2-plate' ? new THREE.Color(0xb8c2cc)
      : new THREE.Color(0x6e757d);
    const isTransparent = sampleKey.startsWith('COVER_');
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: isTransparent ? 0.3 : 0.62,
      metalness: sampleKey === 'magnets' || sampleKey === 'm3-upper' || sampleKey === 'm2-plate' ? 0.45 : 0.06,
      flatShading: true,
      transparent: isTransparent,
      opacity: isTransparent ? 0.66 : 1.0,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(obj.position);
    m.quaternion.copy(obj.quaternion);
    m.scale.copy(obj.scale);
    root.add(m);

    const edgeGeo = new THREE.EdgesGeometry(geo, 30);
    const edgeMat = new THREE.LineBasicMaterial({
      color: PALETTE.ink,
      transparent: true,
      opacity: 0.48,
    });
    const edge = new THREE.LineSegments(edgeGeo, edgeMat);
    edge.position.copy(obj.position);
    edge.quaternion.copy(obj.quaternion);
    edge.scale.copy(obj.scale);
    root.add(edge);
  });

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const wrapper = new THREE.Group();
  root.position.sub(center);
  wrapper.add(root);
  return wrapper;
}

export function buildBomGrid(renderer, data, sceneAssets, domRefs, callbacks = {}) {
  const { sampleObjects, metrics } = sceneAssets;
  const { container, gridEl, totalBadgeEl, legendEl } = domRefs;
  const { onHover = () => {}, onSelect = () => {}, onGroupHover = () => {} } = callbacks;
  const partsById = new Map(data.parts.map((p) => [p.id, p]));

  const W = 256;
  const H = 180;
  const target = new THREE.WebGLRenderTarget(W, H, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
  });

  const thumbScene = new THREE.Scene();
  thumbScene.background = new THREE.Color(0xf7f3eb);
  const amb = new THREE.HemisphereLight(0xffffff, 0xd8d1c4, 1.35);
  const key = new THREE.DirectionalLight(0xfffdf8, 1.15);
  key.position.set(120, -140, 220);
  const rim = new THREE.DirectionalLight(0xe4edf8, 0.45);
  rim.position.set(-140, 120, 90);
  thumbScene.add(amb, key, rim);

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  cam.up.set(0, 0, 1);

  const az = THREE.MathUtils.degToRad(-36);
  const el = THREE.MathUtils.degToRad(34);
  const camDir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    -Math.cos(az) * Math.cos(el),
    Math.sin(el),
  ).normalize();

  const canvas2d = document.createElement('canvas');
  canvas2d.width = W;
  canvas2d.height = H;
  const ctx2d = canvas2d.getContext('2d');
  const pixels = new Uint8Array(W * H * 4);
  const imageData = ctx2d.createImageData(W, H);

  const srgbLut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const lin = i / 255;
    const enc = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
    srgbLut[i] = Math.min(255, Math.max(0, Math.round(enc * 255)));
  }

  const prevTarget = renderer.getRenderTarget();
  const prevPixelRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);

  // Build 6-group legend inside .bom-head
  if (legendEl) {
    legendEl.innerHTML = '';
    for (const g of metrics.groups) {
      const chip = document.createElement('span');
      chip.className = 'bom-leg-chip';
      chip.dataset.group = g.code;
      chip.innerHTML = `<i style="background:${g.color}"></i>${g.code.split('-')[0]}`;
      chip.title = `${g.code} · ${g.label} (${g.count} pcs)`;
      chip.addEventListener('mouseenter', () => onGroupHover(g));
      chip.addEventListener('mouseleave', () => onGroupHover(null));
      legendEl.appendChild(chip);
    }
  }

  const cards = [];
  const cardById = new Map();
  let selectedId = null;
  gridEl.innerHTML = '';

  for (const item of metrics.bom) {
    const obj = cloneSampleForThumbnail(item, sampleObjects, partsById);
    thumbScene.add(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const diag = Math.max(size.length(), 4);
    const aspect = W / H;
    const halfH = diag * 0.56;
    const halfW = halfH * aspect;

    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.position.copy(camDir).multiplyScalar(diag * 3 + 40);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();

    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(thumbScene, cam);
    renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);

    const rowBytes = W * 4;
    const dst = imageData.data;
    for (let y = 0; y < H; y++) {
      const srcOffset = (H - 1 - y) * rowBytes;
      const dstOffset = y * rowBytes;
      for (let x = 0; x < rowBytes; x += 4) {
        dst[dstOffset + x] = srgbLut[pixels[srcOffset + x]];
        dst[dstOffset + x + 1] = srgbLut[pixels[srcOffset + x + 1]];
        dst[dstOffset + x + 2] = srgbLut[pixels[srcOffset + x + 2]];
        dst[dstOffset + x + 3] = pixels[srcOffset + x + 3];
      }
    }
    ctx2d.putImageData(imageData, 0, 0);
    const dataUrl = canvas2d.toDataURL('image/png');

    thumbScene.remove(obj);
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'bom-card';
    card.dataset.bomId = item.id;
    card.dataset.group = item.group;
    card.dataset.count = String(item.count);
    card.setAttribute('aria-pressed', 'false');
    card.title = `${item.code} · ${item.spec} · ${item.group} (×${item.count})`;
    card.innerHTML =
      `<div class="bom-thumb"><img src="${dataUrl}" width="${W}" height="${H}" alt="${item.code}">` +
      `<span class="bom-hidden-tag" hidden>HIDDEN</span></div>` +
      `<div class="bom-meta"><span class="bom-pip" style="background:${item.groupColor}"></span>` +
      `<span class="bom-code">${item.code}</span><span class="bom-spec">${item.spec}</span>` +
      `<span class="bom-qty">×${item.count}</span></div>`;

    card.addEventListener('mouseenter', () => onHover(item));
    card.addEventListener('mouseleave', () => onHover(null));
    card.addEventListener('click', () => {
      selectedId = selectedId === item.id ? null : item.id;
      syncSelection();
      onSelect(selectedId ? item : null);
    });

    gridEl.appendChild(card);
    cards.push({ card, item });
    cardById.set(item.id, { card, item });
  }

  renderer.setRenderTarget(prevTarget);
  renderer.setPixelRatio(prevPixelRatio);
  target.dispose();

  totalBadgeEl.textContent = `${metrics.totalParts} pcs`;
  container.dataset.bomCount = String(cards.length);
  container.dataset.bomSum = String(metrics.totalParts);

  function syncSelection() {
    for (const { card, item } of cards) {
      const active = selectedId === item.id;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function syncHiddenLayers(hiddenLayers) {
    for (const { card, item } of cards) {
      const allHidden = item.layerIds.length > 0 && item.layerIds.every((lid) => hiddenLayers.has(lid));
      card.classList.toggle('is-hidden-layer', allHidden);
      const badge = card.querySelector('.bom-hidden-tag');
      if (badge) badge.hidden = !allHidden;
    }
  }

  function setSelectedId(id) {
    selectedId = id && cardById.has(id) ? id : null;
    syncSelection();
  }

  function update(progress, opacity) {
    if (opacity <= 0.01) {
      if (!container.hidden) container.hidden = true;
      return;
    }
    if (container.hidden) container.hidden = false;
    container.style.opacity = opacity.toFixed(3);

    const n = cards.length;
    for (let i = 0; i < n; i++) {
      const start = (i / n) * 0.68;
      const local = Math.max(0, Math.min(1, (progress - start) / 0.24));
      const eased = 1 - Math.pow(1 - local, 3);
      cards[i].card.style.opacity = eased.toFixed(3);
      cards[i].card.style.transform = `translateY(${((1 - eased) * 14).toFixed(1)}px)`;
    }
  }

  return { cards, cardById, update, syncHiddenLayers, setSelectedId };
}
