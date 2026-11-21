import * as THREE from '../vendor/three.module.js';
import {
  PALETTE,
  createScanPlane,
  createScanIndicators,
  createBoundingBoxDrawer,
  applyMaterialStates,
} from './materials.js';
import { buildAssemblyScene } from './sceneBuilder.js';
import { createCameraRig } from './cameraRig.js';
import { evaluateTimeline, evaluateManualStep } from './timeline.js';
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
  const scrubber = $('timeline-scrubber');
  const stepBtns = Array.from(document.querySelectorAll('.step-btn'));

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

  // Clean hardware-manual lighting (bright warm drafting key + soft cool fill)
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

  const rimLight = new THREE.DirectionalLight(0xdce8f8, 0.28);
  rimLight.position.set(-220, 180, 140);
  scene.add(hemiLight, keyLight, rimLight);

  scene.add(assets.groundGroup);
  scene.add(assets.assemblyRoot);

  const bboxDrawer = createBoundingBoxDrawer(assets.metrics.bbox);
  scene.add(bboxDrawer.lines);

  const scanPlane = createScanPlane(assets.metrics.bbox);
  scene.add(scanPlane.group);

  const scanIndicators = createScanIndicators(assets.scanTargets);
  scene.add(scanIndicators.mesh);

  const camRig = createCameraRig(assets.metrics, stageFrame);

  const bomGrid = buildBomGrid(renderer, data, assets, {
    container: $('hud-bom'),
    gridEl: $('bom-grid'),
    totalBadgeEl: $('bom-total-badge'),
  });

  const hud = createOverlayHud(
    {
      svgEl: $('motion-overlay'),
      phaseCodeEl: $('hud-phase-code'),
      telemetryEl: $('hud-telemetry'),
      timeBigEl: $('hud-time-big'),
      ctrlTimeEl: $('ctrl-time'),
      reportEl: $('hud-report'),
      repPartsEl: $('rep-parts'),
      repStepsEl: $('rep-steps'),
      repGroupsEl: $('rep-groups'),
      repTimeEl: $('rep-time'),
      repShortEl: $('rep-short'),
      repGapEl: $('rep-gap'),
    },
    assets.metrics,
  );

  // Playback & interaction state (starts paused at 0.0s per D7)
  let playing = false;
  let currentT = 0.0;
  let manualStep = null; // 1..5 or null
  let manualAnimStart = 0;
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function isCompactViewport() {
    return stageFrame.clientWidth <= 900;
  }

  function updateSize() {
    const w = Math.max(320, stageFrame.clientWidth || window.innerWidth);
    const h = Math.max(220, stageFrame.clientHeight || window.innerHeight);
    renderer.setSize(w, h, false);
    camRig.resize(w, h);
    renderNow(performance.now());
  }

  function syncButtons() {
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    stepBtns.forEach((btn) => {
      const n = Number(btn.dataset.step);
      btn.setAttribute('aria-pressed', manualStep === n ? 'true' : 'false');
    });
    if (manualStep === null) {
      scrubber.value = currentT.toFixed(2);
    }
  }

  function applyFrameState(state) {
    // 1. Group visibility & local-Z explode/reassemble
    for (let i = 0; i < assets.groupList.length; i++) {
      const grp = assets.groupList[i];
      grp.visible = state.groupVisibility[i];
      grp.position.set(0, 0, state.groupExplodeZ[i]);
    }

    // 2. Single-switch local-Z gap (only switch #40 lifts along assemblyRoot local Z)
    if (assets.closeupSwitchGroup) {
      assets.closeupSwitchGroup.position.set(0, 0, state.closeup.gapMm);
    }

    // 3. Materials & edges
    applyMaterialStates(assets.materialRecords, state.materials);

    // 4. Orange 3D bounding box
    bboxDrawer.update(state.bbox.draw, state.bbox.opacity);

    // 5. X-Ray scan plane & instanced fastener/pin/pad indicators
    if (state.scan.active && state.scan.opacity > 0.005) {
      scanPlane.group.visible = true;
      scanPlane.group.position.z = state.scan.zWorld;
      scanPlane.planeMat.uniforms.uOpacity.value = state.scan.opacity;
      scanPlane.borderMat.opacity = 0.9 * state.scan.opacity;
    } else {
      scanPlane.group.visible = false;
    }
    const scanStats = scanIndicators.update(state.scan.zWorld, state.scan.active ? state.scan.opacity : 0);

    // 6. Orthographic isometric camera
    camRig.applyState(state.camera);

    // 7. Left BOM 16-card 3D grid
    bomGrid.update(state.bom.progress, state.bom.opacity);

    // 8. 3D->2D SVG overlays & 6-cell report
    hud.update(state, camRig.camera, assets.groupList, scanStats);

    renderer.render(scene, camRig.camera);
  }

  function renderNow(nowMs) {
    let state;
    if (manualStep !== null) {
      const animK = reducedMotion ? 1.0 : Math.min(1, (nowMs - manualAnimStart) / 650);
      state = evaluateManualStep(manualStep, animK, assets.metrics);
    } else {
      state = evaluateTimeline(currentT, assets.metrics, isCompactViewport());
    }
    applyFrameState(state);
    return state;
  }

  function seek(tSec) {
    manualStep = null;
    currentT = Math.max(0, Math.min(assets.metrics.durationSec, Number(tSec) || 0));
    syncButtons();
    renderNow(performance.now());
  }

  function selectStep(stepNum) {
    playing = false;
    if (manualStep === stepNum) {
      manualStep = null;
    } else {
      manualStep = stepNum;
      manualAnimStart = performance.now();
    }
    syncButtons();
    renderNow(performance.now());
  }

  function togglePlay() {
    if (manualStep !== null) {
      manualStep = null;
    }
    if (!playing && currentT >= assets.metrics.durationSec - 0.05) {
      currentT = 0;
    }
    playing = !playing;
    lastTick = performance.now();
    syncButtons();
    renderNow(lastTick);
  }

  playBtn.addEventListener('click', togglePlay);
  scrubber.addEventListener('input', () => {
    playing = false;
    seek(parseFloat(scrubber.value));
  });
  stepBtns.forEach((btn) => {
    btn.addEventListener('click', () => selectStep(Number(btn.dataset.step)));
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
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
    } else if (ev.key >= '1' && ev.key <= '5') {
      selectStep(Number(ev.key));
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateSize).observe(stageFrame);
  } else {
    window.addEventListener('resize', updateSize);
  }

  // Expose live zero-hardcoded metrics & deterministic seek API for automated checks
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
    pads: assets.metrics.pads,
    groups: assets.metrics.groups,
    bom: assets.metrics.bom.map(({ id, code, count }) => ({ id, code, count })),
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
    getState: () => ({ playing, currentT, manualStep }),
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
    if (playing && manualStep === null) {
      currentT += dt;
      if (currentT >= assets.metrics.durationSec) {
        currentT = assets.metrics.durationSec;
        playing = false;
        syncButtons();
      } else {
        scrubber.value = currentT.toFixed(2);
      }
      renderNow(now);
    } else if (manualStep !== null && !reducedMotion && now - manualAnimStart <= 720) {
      renderNow(now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main();
