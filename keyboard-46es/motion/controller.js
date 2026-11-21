import * as THREE from '../vendor/three.module.js';
import {
  PALETTE,
  createScanPlane,
  createScanIndicators,
  createBoltAxisGuides,
  createBoundingBoxDrawer,
  applyMaterialStates,
} from './materials.js';
import { buildAssemblyScene } from './sceneBuilder.js';
import { createCameraRig } from './cameraRig.js';
import { evaluateTimeline, evaluateManualStep, easeOutCubic } from './timeline.js';
import { buildBomGrid } from './bomGrid.js';
import { createOverlayHud } from './overlayHud.js';

const $ = (id) => document.getElementById(id);

function activateFallback(reason) {
  const loading = $('motion-loading');
  const canvasHost = $('motion-canvas');
  const overlay = $('motion-overlay');
  const fallback = $('motion-fallback');
  const refs = $('reference-docs');
  const playBtn = $('btn-play');
  const scrubber = $('timeline-scrubber');

  if (loading) loading.hidden = true;
  if (canvasHost) canvasHost.hidden = true;
  if (overlay) overlay.style.display = 'none';
  if (fallback) fallback.hidden = false;
  if (refs) refs.open = true;
  if (playBtn) playBtn.disabled = true;
  if (scrubber) scrubber.disabled = true;
  document.documentElement.dataset.motionFallback = '1';
  if (reason) console.warn('46es motion fallback:', reason);
}

async function main() {
  const stageFrame = $('stage-frame');
  const canvasHost = $('motion-canvas');
  const loadingEl = $('motion-loading');
  const statusTextEl = $('motion-status-text');
  const playBtn = $('btn-play');
  const speedBtn = $('btn-speed');
  const specBtn = $('btn-spec');
  const scrubber = $('timeline-scrubber');
  const stepBtns = Array.from(document.querySelectorAll('.step-btn'));
  const layerBtns = Array.from(document.querySelectorAll('.layer-btn[data-layer]:not([data-layer="all"])'));
  const allLayersBtn = $('btn-layers-all');
  const presetBtns = Array.from(document.querySelectorAll('.view-btn[data-preset]'));
  const turntableBtn = $('btn-turntable');
  const explodeBtn = $('btn-explode');
  const xrayBtn = $('btn-xray');
  const resetViewBtn = $('btn-reset-view');
  const tickBtns = Array.from(document.querySelectorAll('.phase-tick[data-seek]'));
  const mobLayersBtn = $('btn-mob-layers');
  const mobViewBtn = $('btn-mob-view');
  const layerTogglesWrap = $('layer-toggles');
  const viewTogglesWrap = $('view-toggles');

  if (!stageFrame || !canvasHost) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
  } catch (err) {
    activateFallback(err);
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(PALETTE.bg, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasHost.appendChild(renderer.domElement);

  renderer.domElement.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    activateFallback('webglcontextlost');
  });

  let data;
  let assets;
  try {
    const resp = await fetch('assembly.json');
    if (!resp.ok) throw new Error(`assembly.json HTTP ${resp.status}`);
    data = await resp.json();
    if (statusTextEl) statusTextEl.textContent = 'LOADING 3D MESHES';
    assets = await buildAssemblyScene(data, (pct) => {
      if (statusTextEl) statusTextEl.textContent = `LOADING ${Math.round(pct * 100)}%`;
    });
  } catch (err) {
    activateFallback(err);
    return;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);

  // Studio drafting lighting + adaptive underside fill light
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0xe2dbd0, 1.15);
  const keyLight = new THREE.DirectionalLight(0xfffdf8, 0.92);
  keyLight.position.set(160, -220, 340);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -220;
  keyLight.shadow.camera.right = 220;
  keyLight.shadow.camera.top = 140;
  keyLight.shadow.camera.bottom = -140;
  keyLight.shadow.camera.near = 50;
  keyLight.shadow.camera.far = 900;
  keyLight.shadow.bias = -0.0004;

  const rimLight = new THREE.DirectionalLight(0xdce8f8, 0.30);
  rimLight.position.set(-220, 180, 140);

  const underLight = new THREE.DirectionalLight(0xf6f1e8, 0.14);
  underLight.position.set(60, -80, -320);

  scene.add(hemiLight, keyLight, rimLight, underLight);
  scene.add(assets.groundGroup);
  scene.add(assets.assemblyRoot);

  const bboxDrawer = createBoundingBoxDrawer(assets.metrics.bbox);
  scene.add(bboxDrawer.lines);

  const scanPlane = createScanPlane(assets.metrics.bbox);
  scene.add(scanPlane.group);

  const scanIndicators = createScanIndicators(assets.scanTargets);
  scene.add(scanIndicators.mesh);

  const boltGuides = createBoltAxisGuides(assets.fastenerInstances);
  assets.assemblyRoot.add(boltGuides.root);

  const camRig = createCameraRig(assets.metrics, stageFrame);

  // Interactive & playback state
  let playing = false;
  let currentT = 0.0;
  let lastTimelineT = 0.0;
  let playbackSpeed = 1.0;
  const SPEEDS = [0.5, 1.0, 1.5];

  let manualStep = null; // 1..6 or null
  let manualAnimStart = 0;
  let manualAnimToken = 0;

  let turntable = false;
  let manualExplode = false;
  let manualXray = false;
  let explodeWeight = 0;
  let xrayWeight = 0;
  let overrideEaseFrom = null; // { startMs, durMs, exp0, exp1, xray0, xray1 }

  const hiddenLayers = new Set();
  let soloLayerId = null;

  let hoveredBomItem = null;
  let selectedBomItem = null;
  let hoveredLegendGroup = null;
  let lastBoltGuideCount = 0;

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const allLayerIds = (data.visibility_layers || []).map((l) => l.id);

  const bomGrid = buildBomGrid(
    renderer,
    data,
    assets,
    {
      container: $('hud-bom'),
      gridEl: $('bom-grid'),
      totalBadgeEl: $('bom-total-badge'),
      legendEl: $('bom-legend'),
    },
    {
      onHover: (item) => {
        hoveredBomItem = item;
        renderNow(performance.now());
      },
      onSelect: (item) => {
        selectedBomItem = item;
        renderNow(performance.now());
      },
      onGroupHover: (grp) => {
        hoveredLegendGroup = grp;
        renderNow(performance.now());
      },
    },
  );

  const hud = createOverlayHud(
    {
      svgEl: $('motion-overlay'),
      phaseCodeEl: $('hud-phase-code'),
      telemetryEl: $('hud-telemetry'),
      camChipEl: $('hud-cam-chip'),
      boltTagEl: $('hud-bolt-tag'),
      pickEl: $('hud-pick'),
      legendEl: $('hud-legend'),
      timeBigEl: $('hud-time-big'),
      ctrlTimeEl: $('ctrl-time'),
      reportPanelEl: $('hud-report-panel'),
      reportLegendEl: $('report-legend'),
      repEnvEl: $('rep-env'),
      repEnvSubEl: $('rep-env-sub'),
      repPrintEl: $('rep-print'),
      repPrintSubEl: $('rep-print-sub'),
      repFastEl: $('rep-fast'),
      repFastSubEl: $('rep-fast-sub'),
      repKeysEl: $('rep-keys'),
      repKeysSubEl: $('rep-keys-sub'),
      repMatrixEl: $('rep-matrix'),
      repMatrixSubEl: $('rep-matrix-sub'),
      repFitEl: $('rep-fit'),
      repFitSubEl: $('rep-fit-sub'),
    },
    assets.metrics,
    {
      onLegendGroupHover: (grp) => {
        hoveredLegendGroup = grp;
        renderNow(performance.now());
      },
    },
  );

  function isCompactViewport() {
    return stageFrame.clientWidth <= 900;
  }

  function startOverrideEase(targetExp, targetXray, durMs = 350, nowMs = performance.now()) {
    if (reducedMotion || durMs <= 0) {
      explodeWeight = targetExp;
      xrayWeight = targetXray;
      overrideEaseFrom = null;
      return;
    }
    overrideEaseFrom = {
      startMs: nowMs,
      durMs,
      exp0: explodeWeight,
      exp1: targetExp,
      xray0: xrayWeight,
      xray1: targetXray,
    };
  }

  function stepOverrideEase(nowMs) {
    if (!overrideEaseFrom) return;
    const u = Math.max(0, Math.min(1, (nowMs - overrideEaseFrom.startMs) / overrideEaseFrom.durMs));
    const e = easeOutCubic(u);
    explodeWeight = overrideEaseFrom.exp0 + (overrideEaseFrom.exp1 - overrideEaseFrom.exp0) * e;
    xrayWeight = overrideEaseFrom.xray0 + (overrideEaseFrom.xray1 - overrideEaseFrom.xray0) * e;
    if (u >= 1) overrideEaseFrom = null;
  }

  function syncButtons() {
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    if (speedBtn) speedBtn.textContent = `${playbackSpeed}×`;
    stepBtns.forEach((btn) => {
      const n = Number(btn.dataset.step);
      btn.setAttribute('aria-pressed', manualStep === n ? 'true' : 'false');
    });
    const allVisible = hiddenLayers.size === 0;
    if (allLayersBtn) allLayersBtn.setAttribute('aria-pressed', allVisible ? 'true' : 'false');
    layerBtns.forEach((btn) => {
      const lid = btn.dataset.layer;
      const on = !hiddenLayers.has(lid);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-solo', soloLayerId === lid);
    });
    const activePreset = camRig.getActivePreset();
    presetBtns.forEach((btn) => {
      btn.setAttribute('aria-pressed', activePreset === btn.dataset.preset ? 'true' : 'false');
    });
    if (turntableBtn) turntableBtn.setAttribute('aria-pressed', turntable ? 'true' : 'false');
    if (explodeBtn) explodeBtn.setAttribute('aria-pressed', manualExplode ? 'true' : 'false');
    if (xrayBtn) xrayBtn.setAttribute('aria-pressed', manualXray ? 'true' : 'false');
    if (manualStep === null) {
      scrubber.value = currentT.toFixed(2);
    }
    bomGrid.syncHiddenLayers(hiddenLayers);
  }

  function applyFrameState(state, nowMs) {
    // Active BOM / Legend selection & hidden-layer ghost preview
    const activeBom = hoveredBomItem || selectedBomItem;
    let highlightParts = null;
    let highlightKeycapWidth = null;
    let ghostParts = null;
    let dimUnselected = false;

    if (activeBom) {
      dimUnselected = true;
      if (typeof activeBom.keycap_w_u === 'number') {
        highlightKeycapWidth = activeBom.keycap_w_u;
        if (hiddenLayers.has('keycaps')) {
          ghostParts = new Set(['keycaps']);
        }
      } else {
        highlightParts = new Set(activeBom.parts);
        const hiddenInBom = activeBom.parts.filter((pid) => hiddenLayers.has(assets.partLayerById.get(pid)));
        if (hiddenInBom.length) ghostParts = new Set(hiddenInBom);
      }
    } else if (hoveredLegendGroup) {
      dimUnselected = true;
      highlightParts = new Set(hoveredLegendGroup.parts);
    }

    // Manual EXP / XRAY override blending (with 26-36s overlay auto-collapse)
    const suppressOverlays = (manualExplode || manualXray) && state.mode === 'timeline';
    if (suppressOverlays) {
      state.bom.opacity = 0;
      state.report.opacity = 0;
    }

    const effExplodeZ = state.groupExplodeZ.slice();
    if (explodeWeight > 0.001 && state.mode === 'timeline') {
      for (let i = 0; i < assets.metrics.groups.length; i++) {
        const targetZ = assets.metrics.groups[i].explodeZ;
        effExplodeZ[i] = effExplodeZ[i] + (targetZ - effExplodeZ[i]) * explodeWeight;
      }
      if (explodeWeight > 0.25) {
        state.bbox.layerTagsOpacity = Math.max(state.bbox.layerTagsOpacity, explodeWeight);
      }
    }

    const effMaterials = {
      ...state.materials,
      xray: Math.max(state.materials.xray, xrayWeight),
      highlightParts,
      highlightKeycapWidth,
      ghostParts,
      dimUnselected,
    };

    // 1. Group visibility & local-Z explode/reassemble
    for (let i = 0; i < assets.groupList.length; i++) {
      const grp = assets.groupList[i];
      grp.visible = state.groupVisibility[i];
      grp.position.set(0, 0, effExplodeZ[i]);
    }

    // 2. Per-part layer visibility (Layer OFF overrides all, except BOM ghost preview)
    for (const [pid, node] of assets.partNodes.entries()) {
      const lid = assets.partLayerById.get(pid);
      const isHidden = lid && hiddenLayers.has(lid);
      const isGhost = ghostParts && ghostParts.has(pid);
      node.visible = !isHidden || Boolean(isGhost);
    }

    // 3. Individual 42 fastener physical insertion offsets along exact local CAD axis
    const progByPart = state.fasteners?.progressByPart || {};
    for (const { node, inst } of assets.fastenerNodes.values()) {
      const prog = progByPart[inst.part_id] ?? 1;
      const remain = Math.max(0, 1 - prog);
      const ax = inst.axis_local;
      const dist = inst.stroke_mm * remain;
      node.position.set(-ax[0] * dist, -ax[1] * dist, -ax[2] * dist);
    }

    // 4. Local-axis bolt guides (dashed line + 0.28 mm cylinder + blue lock ring)
    lastBoltGuideCount = boltGuides.update(
      state.fasteners,
      effExplodeZ,
      assets.stepIndexByGroup,
      hiddenLayers,
    );

    // 5. Single-switch local-Z gap (Key #40)
    if (assets.closeupSwitchGroup) {
      assets.closeupSwitchGroup.position.set(0, 0, state.closeup.gapMm);
    }

    // 6. Materials & edges
    applyMaterialStates(assets.materialRecords, effMaterials);

    // 7. Orange 3D bounding box
    bboxDrawer.update(state.bbox.draw, state.bbox.opacity);

    // 8. X-Ray scan plane & instanced markers (respecting hiddenLayers)
    const showScan = state.scan.active && state.scan.opacity > 0.005;
    if (showScan) {
      scanPlane.group.visible = true;
      scanPlane.group.position.z = state.scan.zWorld;
      scanPlane.planeMat.uniforms.uOpacity.value = state.scan.opacity;
      scanPlane.borderMat.opacity = 0.9 * state.scan.opacity;
    } else {
      scanPlane.group.visible = false;
    }
    const scanStats = scanIndicators.update(
      state.scan.zWorld,
      showScan ? state.scan.opacity : 0,
      hiddenLayers,
      2.0,
    );

    // 9. 2-Mode Camera resolution + adaptive underside lighting & ground shutoff
    const camPose = camRig.resolvePose(state.camera, nowMs);
    camRig.applyPose(camPose);
    camRig.applyAdaptiveUnderside(camPose.elevationDeg, underLight, assets.groundGroup, assets.groundMaterials);
    hud.updateCamChip(camRig.getMode(), camRig.getActivePreset(), turntable);

    // 10. Left BOM 16-card interactive 3D grid
    bomGrid.update(state.bom.progress, state.bom.opacity);

    // 11. 3D->2D SVG overlays, context legend & 6-cell live CAD report
    hud.update(state, camRig.camera, assets.groupList, scanStats);

    renderer.render(scene, camRig.camera);
  }

  function renderNow(nowMs = performance.now()) {
    stepOverrideEase(nowMs);
    let state;
    if (manualStep !== null) {
      const elapsed = reducedMotion ? 9999 : nowMs - manualAnimStart;
      state = evaluateManualStep(manualStep, elapsed, assets.metrics, explodeWeight);
    } else {
      state = evaluateTimeline(currentT, assets.metrics, isCompactViewport());
    }
    applyFrameState(state, nowMs);
    return state;
  }

  function updateSize() {
    const w = Math.max(320, stageFrame.clientWidth || window.innerWidth);
    const h = Math.max(220, stageFrame.clientHeight || window.innerHeight);
    renderer.setSize(w, h, false);
    camRig.resize(w, h);
    renderNow(performance.now());
  }

  // ------------------------------------------------------------------ Actions
  function seek(tSec) {
    manualStep = null;
    currentT = Math.max(0, Math.min(assets.metrics.durationSec, Number(tSec) || 0));
    lastTimelineT = currentT;
    syncButtons();
    renderNow(performance.now());
  }

  function selectStep(stepNum) {
    playing = false;
    turntable = false;
    manualAnimToken++;
    if (manualStep === stepNum) {
      manualStep = null;
    } else {
      lastTimelineT = currentT;
      manualStep = stepNum;
      manualAnimStart = performance.now();
    }
    syncButtons();
    renderNow(performance.now());
  }

  function togglePlay() {
    const now = performance.now();
    if (!playing) {
      // R2: resume from lastTimelineT, exit manualStep, smoothly release EXP/XRAY & blend camera to live timeline
      if (manualStep !== null) {
        manualStep = null;
        currentT = lastTimelineT;
      }
      if (currentT >= assets.metrics.durationSec - 0.05) {
        currentT = 0;
        lastTimelineT = 0;
      }
      turntable = false;
      if (manualExplode || manualXray) {
        manualExplode = false;
        manualXray = false;
        startOverrideEase(0, 0, 350, now);
      }
      camRig.blendToTimeline(reducedMotion ? 0 : 450, now);
      playing = true;
    } else {
      playing = false;
    }
    lastTick = now;
    syncButtons();
    renderNow(now);
  }

  function setLayer(layerId, visible) {
    if (!allLayerIds.includes(layerId)) return;
    soloLayerId = null;
    if (visible) hiddenLayers.delete(layerId);
    else hiddenLayers.add(layerId);
    syncButtons();
    renderNow(performance.now());
  }

  function toggleLayer(layerId) {
    setLayer(layerId, hiddenLayers.has(layerId));
  }

  function soloLayer(layerId) {
    if (!allLayerIds.includes(layerId)) return;
    if (soloLayerId === layerId) {
      soloLayerId = null;
      hiddenLayers.clear();
    } else {
      soloLayerId = layerId;
      hiddenLayers.clear();
      for (const lid of allLayerIds) {
        if (lid !== layerId) hiddenLayers.add(lid);
      }
    }
    syncButtons();
    renderNow(performance.now());
  }

  function resetLayers() {
    soloLayerId = null;
    hiddenLayers.clear();
    syncButtons();
    renderNow(performance.now());
  }

  function setPreset(name, animateMs = 320) {
    playing = false;
    turntable = false;
    camRig.setPreset(name, reducedMotion ? 0 : animateMs, performance.now());
    syncButtons();
    renderNow(performance.now());
  }

  function setExplode(on) {
    manualExplode = Boolean(on);
    startOverrideEase(manualExplode ? 1 : 0, manualXray ? 1 : 0, 350, performance.now());
    syncButtons();
    renderNow(performance.now());
  }

  function setXray(on) {
    manualXray = Boolean(on);
    startOverrideEase(manualExplode ? 1 : 0, manualXray ? 1 : 0, 350, performance.now());
    syncButtons();
    renderNow(performance.now());
  }

  function setTurntable(on) {
    turntable = Boolean(on);
    if (turntable) {
      playing = false;
      camRig.enterUserOverride();
    }
    syncButtons();
    renderNow(performance.now());
  }

  function resetView() {
    const now = performance.now();
    turntable = false;
    manualExplode = false;
    manualXray = false;
    selectedBomItem = null;
    hoveredBomItem = null;
    bomGrid.setSelectedId(null);
    soloLayerId = null;
    hiddenLayers.clear();
    startOverrideEase(0, 0, 260, now);
    camRig.blendToTimeline(reducedMotion ? 0 : 450, now);
    syncButtons();
    renderNow(now);
  }

  // ------------------------------------------------------------------ UI Event Bindings
  playBtn.addEventListener('click', togglePlay);
  if (speedBtn) {
    speedBtn.addEventListener('click', () => {
      const nextIdx = (SPEEDS.indexOf(playbackSpeed) + 1) % SPEEDS.length;
      playbackSpeed = SPEEDS[nextIdx];
      syncButtons();
    });
  }
  if (specBtn) {
    specBtn.addEventListener('click', () => {
      const refs = $('reference-docs');
      if (refs) {
        refs.open = true;
        refs.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      }
    });
  }
  scrubber.addEventListener('input', () => {
    playing = false;
    seek(parseFloat(scrubber.value));
  });
  tickBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      playing = false;
      seek(parseFloat(btn.dataset.seek));
    });
  });
  stepBtns.forEach((btn) => {
    btn.addEventListener('click', () => selectStep(Number(btn.dataset.step)));
  });

  if (allLayersBtn) {
    allLayersBtn.addEventListener('click', resetLayers);
  }
  layerBtns.forEach((btn) => {
    const lid = btn.dataset.layer;
    btn.addEventListener('click', (ev) => {
      if (ev.shiftKey) soloLayer(lid);
      else toggleLayer(lid);
    });
    btn.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      soloLayer(lid);
    });
  });

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => setPreset(btn.dataset.preset));
  });
  if (turntableBtn) turntableBtn.addEventListener('click', () => setTurntable(!turntable));
  if (explodeBtn) explodeBtn.addEventListener('click', () => setExplode(!manualExplode));
  if (xrayBtn) xrayBtn.addEventListener('click', () => setXray(!manualXray));
  if (resetViewBtn) resetViewBtn.addEventListener('click', resetView);

  // Mobile collapsible drawers (<=900px)
  function toggleMobileDrawer(which) {
    const isLayers = which === 'layers';
    const targetWrap = isLayers ? layerTogglesWrap : viewTogglesWrap;
    const otherWrap = isLayers ? viewTogglesWrap : layerTogglesWrap;
    const targetBtn = isLayers ? mobLayersBtn : mobViewBtn;
    const otherBtn = isLayers ? mobViewBtn : mobLayersBtn;
    if (!targetWrap || !targetBtn) return;
    const willOpen = !targetWrap.classList.contains('drawer-open');
    targetWrap.classList.toggle('drawer-open', willOpen);
    targetBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (otherWrap && otherBtn && willOpen) {
      otherWrap.classList.remove('drawer-open');
      otherBtn.setAttribute('aria-expanded', 'false');
    }
  }
  if (mobLayersBtn) mobLayersBtn.addEventListener('click', () => toggleMobileDrawer('layers'));
  if (mobViewBtn) mobViewBtn.addEventListener('click', () => toggleMobileDrawer('view'));

  // ------------------------------------------------------------------ 3D Canvas Pointer Orbit / Pan / Wheel Zoom + Hover Pick
  const canvasEl = renderer.domElement;
  const activePointers = new Map();
  let dragMode = null; // 'orbit' | 'pan' | 'pinch'
  let lastPtrX = 0;
  let lastPtrY = 0;
  let lastPinchDist = 0;
  let lastPinchMidX = 0;
  let lastPinchMidY = 0;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoverPending = false;
  let hoverClientX = 0;
  let hoverClientY = 0;

  function runHoverPick() {
    hoverPending = false;
    if (dragMode || activePointers.size > 0) {
      hud.updatePickChip(null);
      return;
    }
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    ndc.x = ((hoverClientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((hoverClientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camRig.camera);
    const visiblePickables = assets.pickableMeshes.filter((m) => {
      if (!m.visible) return false;
      const lid = m.userData?.pickInfo?.layer;
      if (lid && hiddenLayers.has(lid)) return false;
      let p = m.parent;
      while (p) {
        if (!p.visible) return false;
        p = p.parent;
      }
      return true;
    });
    const hits = raycaster.intersectObjects(visiblePickables, false);
    if (hits.length > 0 && hits[0].object?.userData?.pickInfo) {
      hud.updatePickChip(hits[0].object.userData.pickInfo);
    } else {
      hud.updatePickChip(null);
    }
  }

  canvasEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

  canvasEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.button !== 2) return;
    canvasEl.setPointerCapture(ev.pointerId);
    activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    hud.updatePickChip(null);

    playing = false;
    turntable = false;
    camRig.enterUserOverride();
    syncButtons();

    if (activePointers.size === 1) {
      dragMode = ev.button === 2 || ev.shiftKey ? 'pan' : 'orbit';
      lastPtrX = ev.clientX;
      lastPtrY = ev.clientY;
    } else if (activePointers.size === 2) {
      dragMode = 'pinch';
      const pts = Array.from(activePointers.values());
      lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      lastPinchMidX = (pts[0].x + pts[1].x) / 2;
      lastPinchMidY = (pts[0].y + pts[1].y) / 2;
    }
  });

  canvasEl.addEventListener('pointermove', (ev) => {
    if (activePointers.has(ev.pointerId)) {
      activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (dragMode === 'orbit' && activePointers.size === 1) {
        const dx = ev.clientX - lastPtrX;
        const dy = ev.clientY - lastPtrY;
        lastPtrX = ev.clientX;
        lastPtrY = ev.clientY;
        camRig.orbitBy(-dx * 0.42, dy * 0.36);
        renderNow(performance.now());
      } else if (dragMode === 'pan' && activePointers.size === 1) {
        const dx = ev.clientX - lastPtrX;
        const dy = ev.clientY - lastPtrY;
        lastPtrX = ev.clientX;
        lastPtrY = ev.clientY;
        camRig.panByPixels(dx, dy, canvasEl.clientWidth, canvasEl.clientHeight);
        renderNow(performance.now());
      } else if (dragMode === 'pinch' && activePointers.size >= 2) {
        const pts = Array.from(activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        if (lastPinchDist > 4 && dist > 4) {
          camRig.zoomBy(dist / lastPinchDist);
        }
        camRig.panByPixels(midX - lastPinchMidX, midY - lastPinchMidY, canvasEl.clientWidth, canvasEl.clientHeight);
        lastPinchDist = dist;
        lastPinchMidX = midX;
        lastPinchMidY = midY;
        renderNow(performance.now());
      }
      return;
    }

    // Hover-only 1-line CAD inspector (rAF-throttled)
    if (ev.pointerType === 'mouse') {
      hoverClientX = ev.clientX;
      hoverClientY = ev.clientY;
      if (!hoverPending) {
        hoverPending = true;
        requestAnimationFrame(runHoverPick);
      }
    }
  });

  function endPointer(ev) {
    activePointers.delete(ev.pointerId);
    if (activePointers.size === 0) {
      dragMode = null;
    } else if (activePointers.size === 1) {
      const [only] = activePointers.values();
      dragMode = 'orbit';
      lastPtrX = only.x;
      lastPtrY = only.y;
    }
  }
  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
  canvasEl.addEventListener('pointerleave', () => hud.updatePickChip(null));

  // D3: Canvas wheel zooms 3D immediately; control bar & reference docs keep normal page scroll
  canvasEl.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      playing = false;
      turntable = false;
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      camRig.zoomBy(factor);
      syncButtons();
      renderNow(performance.now());
    },
    { passive: false },
  );

  canvasEl.addEventListener('dblclick', () => {
    camRig.blendToTimeline(reducedMotion ? 0 : 450, performance.now());
    syncButtons();
    renderNow(performance.now());
  });

  // Focus-safe keyboard shortcuts
  window.addEventListener('keydown', (ev) => {
    const tag = ev.target?.tagName;
    if (tag && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'A'].includes(tag)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    if (ev.code === 'Space') {
      ev.preventDefault();
      togglePlay();
    } else if (ev.code === 'ArrowRight') {
      ev.preventDefault();
      playing = false;
      seek(currentT + 0.5);
    } else if (ev.code === 'ArrowLeft') {
      ev.preventDefault();
      playing = false;
      seek(currentT - 0.5);
    } else if (ev.key >= '1' && ev.key <= '6') {
      selectStep(Number(ev.key));
    } else if (ev.key === '0') {
      resetLayers();
    } else if (ev.key === 'c' || ev.key === 'C') {
      toggleLayer('case');
    } else if (ev.key === 'e' || ev.key === 'E') {
      setExplode(!manualExplode);
    } else if (ev.key === 'x' || ev.key === 'X') {
      setXray(!manualXray);
    } else if (ev.key === 'r' || ev.key === 'R') {
      resetView();
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateSize).observe(stageFrame);
  } else {
    window.addEventListener('resize', updateSize);
  }

  // Expose SSOT live metrics & deterministic test API
  const publicMetrics = {
    widthMm: assets.metrics.widthMm,
    depthMm: assets.metrics.depthMm,
    heightMm: assets.metrics.heightMm,
    tiltDeg: assets.metrics.tiltDeg,
    switches: assets.metrics.switches,
    keycaps: assets.metrics.keycaps,
    keycapsByWidth: assets.metrics.keycapsByWidth,
    diodes: assets.metrics.diodes,
    wires: assets.metrics.wires,
    pins: assets.metrics.pins,
    fasteners: assets.metrics.fasteners,
    fastenerBreakdown: assets.metrics.fastenerBreakdown,
    pads: assets.metrics.pads,
    scanPointsTotal: assets.metrics.scanPointsTotal,
    printStats: assets.metrics.printStats,
    matrixStats: assets.metrics.matrixStats,
    cadVerification: assets.metrics.cadVerification,
    groups: assets.metrics.groups.map(({ id, code, label, count }) => ({ id, code, label, count })),
    layers: assets.metrics.layers.map(({ id, label, count }) => ({ id, label, count })),
    bom: assets.metrics.bom.map(({ id, code, spec, group, count }) => ({ id, code, spec, group, count })),
    totalParts: assets.metrics.totalParts,
    stepsCount: assets.metrics.stepsCount,
    durationSec: assets.metrics.durationSec,
    closeupKeyId: assets.metrics.closeupKeyId,
  };
  window.__motionMetrics = publicMetrics;
  window.__motionControl = {
    seek,
    selectStep,
    togglePlay,
    setLayer,
    toggleLayer,
    soloLayer,
    resetLayers,
    setPreset,
    orbitBy: (dAz, dEl) => {
      playing = false;
      camRig.orbitBy(dAz, dEl);
      syncButtons();
      renderNow(performance.now());
    },
    zoomBy: (f) => {
      playing = false;
      camRig.zoomBy(f);
      syncButtons();
      renderNow(performance.now());
    },
    setExplode,
    setXray,
    setTurntable,
    resetView,
    hoverBom: (bomId) => {
      hoveredBomItem = bomId ? bomGrid.cardById.get(bomId)?.item || null : null;
      renderNow(performance.now());
    },
    selectBom: (bomId) => {
      selectedBomItem = bomId ? bomGrid.cardById.get(bomId)?.item || null : null;
      bomGrid.setSelectedId(selectedBomItem?.id || null);
      renderNow(performance.now());
    },
    getState: () => ({
      playing,
      currentT,
      lastTimelineT,
      playbackSpeed,
      manualStep,
      manualExplode,
      manualXray,
      turntable,
      hiddenLayers: Array.from(hiddenLayers),
      cameraMode: camRig.getMode(),
      activePreset: camRig.getActivePreset(),
      cameraPose: camRig.getPose(),
      groundVisible: assets.groundGroup.visible,
      activeBoltGuides: lastBoltGuideCount,
      fastenerSample: assets.fastenerInstances[0] || null,
    }),
  };

  // Initial render at t = 0.0s (paused)
  updateSize();
  syncButtons();
  if (loadingEl) loadingEl.hidden = true;
  document.documentElement.dataset.motionReady = '1';

  let lastTick = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    let needsRender = false;

    if (playing && manualStep === null) {
      currentT += dt * playbackSpeed;
      if (currentT >= assets.metrics.durationSec) {
        currentT = assets.metrics.durationSec;
        lastTimelineT = currentT;
        playing = false;
        syncButtons();
      } else {
        lastTimelineT = currentT;
        scrubber.value = currentT.toFixed(2);
      }
      needsRender = true;
    } else if (manualStep !== null && !reducedMotion && now - manualAnimStart <= 1300) {
      needsRender = true;
    }

    if (turntable) {
      camRig.orbitBy(dt * 24, 0);
      needsRender = true;
    }

    if (camRig.isAnimating() || overrideEaseFrom) {
      needsRender = true;
    }

    if (needsRender) {
      renderNow(now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main();
