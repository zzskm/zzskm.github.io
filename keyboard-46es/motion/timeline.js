const clamp01 = (v) => Math.max(0, Math.min(1, v));
const seg = (t, t0, t1) => (t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp01((t - t0) / (t1 - t0)));
const lerp = (a, b, u) => a + (b - a) * u;

export const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeInOutQuint = (u) => (u < 0.5 ? 16 * u * u * u * u * u : 1 - Math.pow(-2 * u + 2, 5) / 2);
export const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);

const PHASES = [
  { start: 0, end: 11.0, index: 1, code: '01 · DIM + BUILD' },
  { start: 11.0, end: 16.0, index: 2, code: '02 · X-RAY SCAN' },
  { start: 16.0, end: 20.0, index: 3, code: '03 · CORE FOCUS' },
  { start: 20.0, end: 26.0, index: 4, code: '04 · SEAT SIM' },
  { start: 26.0, end: 32.0, index: 5, code: '05 · BOM GRID' },
  { start: 32.0, end: 36.0, index: 6, code: '06 · CAD REPORT' },
];

const ALL_FASTENER_PARTS = [
  'inserts',
  'case-screws',
  'm2-bracket',
  'm2-nuts-bracket',
  'm2-plate',
  'm2-5',
  'm2-nuts-plate',
  'm3-upper',
  'magnets',
];

function makeFastenerState(defaultProg = 1) {
  const progressByPart = {};
  const guideOpacityByPart = {};
  for (const pid of ALL_FASTENER_PARTS) {
    progressByPart[pid] = defaultProg;
    guideOpacityByPart[pid] = 0;
  }
  return {
    progressByPart,
    guideOpacityByPart,
    activePartIds: [],
    activeTag: null,
  };
}

export const MANUAL_STEP_DURATIONS_MS = [1100, 900, 1200, 650, 900, 650];

export function evaluateTimeline(tRaw, metrics, isCompact = false) {
  const dur = metrics.durationSec || 36.0;
  const t = Math.max(0, Math.min(dur, tRaw));
  const phase = PHASES.find((p) => t < p.end) || PHASES[PHASES.length - 1];

  const baseExplode = metrics.groups.map((g) => g.explodeZ);
  const nGroups = baseExplode.length; // 6
  const groupExplodeZ = new Array(nGroups).fill(0);
  const groupVisibility = new Array(nGroups).fill(true);
  const fasteners = makeFastenerState(1);

  // Camera defaults (continuous across all 36.0s, zero hard cuts)
  let azimuthDeg = -34;
  let elevationDeg = 35.264;
  let zoom = 1.0;
  let targetOffset = [0, 0, 0];
  let screenShiftX = 0;
  let screenShiftY = 0;

  // Visual material weights
  let mono = 1;
  let xray = 0;
  let coreFocus = 0;
  let ghostOpacity = 1;
  let phaseCode = phase.code;

  // Segment feature states
  let bboxDraw = 0;
  let bboxOpacity = 0;
  let dimCountUp = 0;
  let layerTagsOpacity = 0;

  let scanActive = false;
  let scanProgress = 0;
  let scanOpacity = 0;
  let scanZ = metrics.bbox.min.z - 2;

  let leadersProgress = 0;
  let leadersOpacity = 0;

  let closeupActive = false;
  let closeupGapMm = 0;
  let closeupStatus = 'idle'; // 'idle' | 'warn' | 'ok'
  let closeupBlink = 0;
  let closeupCapOpacity = 1;

  let bomProgress = 0;
  let bomOpacity = 0;
  let reportProgress = 0;
  let reportOpacity = 0;

  // ----------------------------------------------------------------- 0.00–11.00s: Dims + 6-Step Non-Overlapping Build + 0.60s Hold
  if (t <= 11.0) {
    // 0.00–1.75s BBox + exact count-up (Bug A fix: reaches 1.00 at 1.75s so 1.8s = exact 320.0 mm)
    bboxDraw = easeOutCubic(seg(t, 0.05, 1.70));
    const bboxIn = easeOutCubic(seg(t, 0.02, 0.25));
    const bboxOut = 1 - easeInOutCubic(seg(t, 2.00, 2.50));
    bboxOpacity = bboxIn * bboxOut;
    dimCountUp = easeOutCubic(seg(t, 0.08, 1.75));

    if (t < 2.0) {
      phaseCode = '01 · DIM + TILT';
    } else if (t < 4.05) {
      // 2.00–3.80s 6-layer explode + 3.80–4.05s hold
      phaseCode = '01 · EXPLODE (6 LAYERS)';
      const explodeUp = easeInOutCubic(seg(t, 2.00, 3.80));
      for (let i = 0; i < nGroups; i++) {
        groupExplodeZ[i] = baseExplode[i] * explodeUp;
      }
      for (const pid of ALL_FASTENER_PARTS) {
        fasteners.progressByPart[pid] = 1 - explodeUp;
      }
      layerTagsOpacity = easeOutCubic(seg(t, 2.35, 3.05));
    } else if (t < 10.40) {
      // Non-overlapping 6-step sequential seating + physical fastener insertion
      const bodyWindows = [
        [4.05, 4.45], // STEP 1 G1-BASE
        [5.15, 5.55], // STEP 2 G2-CORE
        [5.95, 6.45], // STEP 3 G3-PLATE (Hero)
        [8.20, 8.95], // STEP 4 G4-SW
        [8.95, 9.35], // STEP 5 G5-COVER
        [9.75, 10.40], // STEP 6 G6-KEYCAP
      ];
      for (let i = 0; i < nGroups; i++) {
        const down = easeInOutCubic(seg(t, bodyWindows[i][0], bodyWindows[i][1]));
        groupExplodeZ[i] = baseExplode[i] * (1 - down);
      }

      // Non-overlapping fastener insertion windows
      const fWindows = [
        { pid: 'inserts', t0: 4.45, t1: 4.80, tag: 'STEP 1 · M3 INS Ø5×4 (6) → MOUNT SO1..SO6' },
        { pid: 'case-screws', t0: 4.80, t1: 5.15, tag: 'STEP 1 · M2×5 CASE (6) → H01..H06' },
        { pid: 'm2-bracket', t0: 5.55, t1: 5.95, tag: 'STEP 2 · M2×6 (2) + M2 NUT (2) → BRACKET' },
        { pid: 'm2-nuts-bracket', t0: 5.55, t1: 5.95, tag: null },
        { pid: 'm2-plate', t0: 6.45, t1: 7.20, tag: 'STEP 3 · M2×6 (4) + M2×5 (1) + M2 NUT (5) → SPINE' },
        { pid: 'm2-5', t0: 6.45, t1: 7.20, tag: null },
        { pid: 'm2-nuts-plate', t0: 6.45, t1: 7.20, tag: null },
        { pid: 'm3-upper', t0: 7.20, t1: 8.20, tag: 'STEP 3 · M3×10 (6) → PLATE CB → SO1..SO6 INS' },
        { pid: 'magnets', t0: 9.35, t1: 9.75, tag: 'STEP 5 · MAG Ø3×2 (10) → COVER & PLATE' },
      ];

      for (const fw of fWindows) {
        if (t < fw.t0) {
          fasteners.progressByPart[fw.pid] = 0;
          fasteners.guideOpacityByPart[fw.pid] = 0;
        } else if (t <= fw.t1) {
          const p = easeInOutCubic(seg(t, fw.t0, fw.t1));
          fasteners.progressByPart[fw.pid] = p;
          fasteners.guideOpacityByPart[fw.pid] = 1.0;
          fasteners.activePartIds.push(fw.pid);
          if (fw.tag) fasteners.activeTag = fw.tag;
        } else {
          fasteners.progressByPart[fw.pid] = 1;
          // Brief 0.25s blue lock ring fade-out after seating
          const holdFade = 1 - seg(t, fw.t1, fw.t1 + 0.25);
          fasteners.guideOpacityByPart[fw.pid] = holdFade;
        }
      }

      if (t < 5.15) phaseCode = '01 · STEP 1 · G1-BASE';
      else if (t < 5.95) phaseCode = '01 · STEP 2 · G2-CORE';
      else if (t < 8.20) phaseCode = '01 · STEP 3 · G3-PLATE + BOLTS';
      else if (t < 8.95) phaseCode = '01 · STEP 4 · G4-SW';
      else if (t < 9.75) phaseCode = '01 · STEP 5 · G5-COVER + MAG';
      else phaseCode = '01 · STEP 6 · G6-KEYCAP';

      layerTagsOpacity = 1 - easeOutCubic(seg(t, 4.10, 4.75));
    } else {
      // 10.40–11.00s: 0.60s clean full-assembly hold
      phaseCode = '01 · ASSEMBLED HOLD';
    }

    // Camera choreography across 0–11s:
    // Pull back during explode, subtly zoom in during G3-PLATE hero bolts (6.2–8.3s), then return cleanly by 10.6s
    const camExplode = easeInOutCubic(seg(t, 2.00, 3.80)) * (1 - easeInOutCubic(seg(t, 8.95, 10.60)));
    const heroBoltK = easeInOutCubic(seg(t, 6.20, 7.10)) * (1 - easeInOutCubic(seg(t, 8.05, 8.85)));
    zoom = lerp(1.0, 0.76, camExplode) + 0.28 * heroBoltK;
    elevationDeg = lerp(35.264, 38.5, heroBoltK);
    azimuthDeg = lerp(-34, -30, heroBoltK);
    targetOffset = [0, 0, lerp(0, 16, camExplode * (1 - heroBoltK * 0.7))];
  }

  // ----------------------------------------------------------------- 11.00–16.00s: X-Ray wireframe & vertical scan
  if (t > 11.0 && t <= 16.0) {
    const enter = easeInOutCubic(seg(t, 11.0, 11.85));
    const exit = easeInOutCubic(seg(t, 15.25, 16.0));
    xray = enter * (1 - exit);
    mono = 1 - enter;
    coreFocus = exit;
    ghostOpacity = lerp(1.0, 0.2, exit);

    azimuthDeg = lerp(-34, -26, enter);
    zoom = lerp(1.0, 1.06, enter);

    if (t >= 11.65) {
      scanActive = true;
      scanProgress = easeInOutCubic(seg(t, 11.85, 15.25));
      scanOpacity = easeOutCubic(seg(t, 11.65, 12.0)) * (1 - exit);
      const scanTop = Math.min(metrics.bbox.max.z + 1.5, metrics.bbox.min.z + 33.0);
      scanZ = lerp(metrics.bbox.min.z + 6.5, scanTop, scanProgress);
    }
  }

  // ----------------------------------------------------------------- 16.00–20.00s: Core focus + 20% exterior ghost + leaders
  if (t > 16.0 && t <= 20.0) {
    mono = 0;
    xray = 0;
    coreFocus = 1;
    ghostOpacity = 0.2;

    const move = easeInOutCubic(seg(t, 16.0, 17.3));
    azimuthDeg = lerp(-26, -38, move);
    elevationDeg = lerp(35.264, 40.0, move);
    zoom = lerp(1.06, 1.16, move);

    leadersProgress = easeOutCubic(seg(t, 16.6, 18.6));
    leadersOpacity = easeOutCubic(seg(t, 16.5, 17.0)) * (1 - easeOutCubic(seg(t, 19.4, 20.0)));
  }

  // ----------------------------------------------------------------- 20.00–26.00s: Single-switch seat simulation (Key #40)
  if (t > 20.0 && t <= 26.0) {
    const zoomIn = easeInOutQuint(seg(t, 20.0, 21.5));
    const zoomOut = easeInOutQuint(seg(t, 24.3, 26.0));
    const focusK = zoomIn * (1 - zoomOut);

    const keyOffset = [
      metrics.closeupWorldCenter.x - metrics.center.x,
      metrics.closeupWorldCenter.y - metrics.center.y,
      metrics.closeupWorldCenter.z - metrics.center.z,
    ];

    targetOffset = [
      keyOffset[0] * focusK,
      keyOffset[1] * focusK,
      keyOffset[2] * focusK,
    ];

    if (t < 24.3) {
      azimuthDeg = lerp(-38, -26, zoomIn);
      elevationDeg = lerp(40.0, 25.0, zoomIn);
      zoom = lerp(1.16, isCompact ? 3.5 : 4.6, zoomIn);
      mono = 0;
      coreFocus = 1;
      ghostOpacity = 0.2;
    } else {
      azimuthDeg = lerp(-26, -34, zoomOut);
      elevationDeg = lerp(25.0, 35.264, zoomOut);
      zoom = lerp(isCompact ? 3.5 : 4.6, 1.0, zoomOut);
      mono = zoomOut;
      coreFocus = 1 - zoomOut;
      ghostOpacity = lerp(0.2, 1.0, zoomOut);
    }

    closeupActive = t >= 20.5 && t <= 25.0;
    closeupCapOpacity = lerp(0.2, 0.05, easeOutCubic(seg(t, 20.2, 21.0))) * (1 - zoomOut) + zoomOut;

    const liftIn = easeOutCubic(seg(t, 20.0, 20.75));
    const pressDown = easeOutCubic(seg(t, 22.8, 23.75));
    closeupGapMm = 1.8 * liftIn * (1 - pressDown);

    if (t >= 20.75 && t < 23.55) {
      closeupStatus = 'warn';
      closeupBlink = 0.5 + 0.5 * Math.sin((t - 20.75) * Math.PI * 6.5);
    } else if (t >= 23.55 && t <= 25.1) {
      closeupStatus = 'ok';
      closeupBlink = 1;
    }
  }

  // ----------------------------------------------------------------- 26.00–32.00s: BOM 16-card interactive grid
  if (t > 26.0 && t <= 32.0) {
    const enter = easeInOutCubic(seg(t, 26.0, 27.4));
    const exit = easeInOutCubic(seg(t, 31.2, 32.0));
    const k = enter * (1 - exit);

    if (isCompact) {
      screenShiftX = 0;
      screenShiftY = lerp(0, 0.19, k);
      zoom = lerp(1.0, 0.72, k);
    } else {
      screenShiftX = lerp(0, 0.23, k);
      screenShiftY = lerp(0, -0.02, k);
      zoom = lerp(1.0, 0.72, k);
    }
    azimuthDeg = lerp(-34, -30, k);
    elevationDeg = 35.264;

    bomProgress = seg(t, 26.4, 30.0);
    bomOpacity = easeOutCubic(seg(t, 26.3, 26.9)) * (1 - exit);
  }

  // ----------------------------------------------------------------- 32.00–36.00s: Final CAD Report + 6-group legend
  if (t > 32.0) {
    const enter = easeInOutCubic(seg(t, 32.0, 33.1));
    zoom = lerp(1.0, 0.90, enter);
    screenShiftY = lerp(0, isCompact ? 0.16 : 0.10, enter);
    azimuthDeg = -34;
    elevationDeg = 35.264;

    reportOpacity = easeOutCubic(seg(t, 32.15, 32.85));
    reportProgress = easeOutCubic(seg(t, 32.25, 34.8));
  }

  return {
    t,
    mode: 'timeline',
    phaseIndex: phase.index,
    phaseCode,
    camera: { azimuthDeg, elevationDeg, zoom, targetOffset, screenShiftX, screenShiftY },
    groupExplodeZ,
    groupVisibility,
    fasteners,
    materials: {
      mono,
      xray,
      coreFocus,
      ghostOpacity,
      activeFastenerParts: fasteners.activePartIds.length ? new Set(fasteners.activePartIds) : null,
      closeupKeyId: metrics.closeupKeyId,
      closeupCapOpacity,
      closeupSwitchAlert: closeupActive ? (closeupStatus === 'idle' ? null : closeupStatus) : null,
      closeupBlink,
    },
    bbox: { draw: bboxDraw, opacity: bboxOpacity, dimCountUp, layerTagsOpacity },
    scan: { active: scanActive, progress: scanProgress, opacity: scanOpacity, zWorld: scanZ },
    leaders: { progress: leadersProgress, opacity: leadersOpacity },
    closeup: {
      active: closeupActive,
      gapMm: closeupGapMm,
      status: closeupStatus,
      blink: closeupBlink,
      keyId: metrics.closeupKeyId,
    },
    bom: { progress: bomProgress, opacity: bomOpacity },
    report: { progress: reportProgress, opacity: reportOpacity },
  };
}

export function evaluateManualStep(stepNum, elapsedMs, metrics, manualExplodeWeight = 0) {
  const idx = Math.max(0, Math.min(metrics.groups.length - 1, stepNum - 1));
  const totalMs = MANUAL_STEP_DURATIONS_MS[idx] || 900;
  const k = clamp01(elapsedMs / totalMs);
  const step = metrics.groups[idx] || metrics.groups[0];
  const nGroups = metrics.groups.length;
  const groupVisibility = Array.from({ length: nGroups }, (_, i) => i < stepNum);
  const fasteners = makeFastenerState(1);

  // Per-step differentiated body landing & fastener choreography
  let bodyK = k;
  const stepFastenerStages = {
    1: [
      { pids: ['inserts'], k0: 0.36, k1: 0.68, tag: 'STEP 1 · M3 INS Ø5×4 (6) → MOUNT SO1..SO6' },
      { pids: ['case-screws'], k0: 0.68, k1: 1.0, tag: 'STEP 1 · M2×5 CASE (6) → H01..H06' },
    ],
    2: [
      { pids: ['m2-bracket', 'm2-nuts-bracket'], k0: 0.44, k1: 1.0, tag: 'STEP 2 · M2×6 (2) + M2 NUT (2) → BRACKET' },
    ],
    3: [
      { pids: ['m2-plate', 'm2-5', 'm2-nuts-plate'], k0: 0.30, k1: 0.64, tag: 'STEP 3 · M2×6 (4) + M2×5 (1) + M2 NUT (5) → SPINE' },
      { pids: ['m3-upper'], k0: 0.64, k1: 1.0, tag: 'STEP 3 · M3×10 (6) → PLATE CB → SO1..SO6 INS' },
    ],
    4: [],
    5: [
      { pids: ['magnets'], k0: 0.44, k1: 1.0, tag: 'STEP 5 · MAG Ø3×2 (10) → COVER & PLATE' },
    ],
    6: [],
  };

  const stages = stepFastenerStages[stepNum] || [];
  if (stages.length > 0) {
    const bodyEnd = stages[0].k0;
    bodyK = clamp01(k / bodyEnd);
    for (const st of stages) {
      for (const pid of st.pids) {
        if (k < st.k0) {
          fasteners.progressByPart[pid] = 0;
          fasteners.guideOpacityByPart[pid] = 0.35;
        } else if (k <= st.k1) {
          const fp = easeInOutCubic(seg(k, st.k0, st.k1));
          fasteners.progressByPart[pid] = fp;
          fasteners.guideOpacityByPart[pid] = 1.0;
          fasteners.activePartIds.push(pid);
          fasteners.activeTag = st.tag;
        } else {
          fasteners.progressByPart[pid] = 1;
          fasteners.guideOpacityByPart[pid] = k < 0.99 ? 0.85 : 0.35;
        }
      }
    }
    if (k >= 0.99 && stages.length) {
      fasteners.activeTag = stages[stages.length - 1].tag;
    }
  }

  const drop = (1 - easeOutCubic(bodyK)) * 22.0;
  const pulse = Math.sin(bodyK * Math.PI);
  const groupExplodeZ = metrics.groups.map((g, i) => {
    const baseExp = i < stepNum ? g.explodeZ * manualExplodeWeight : 0;
    return baseExp + (i === idx ? drop : 0);
  });

  return {
    t: null,
    mode: 'manual',
    stepNum,
    stepDurationMs: totalMs,
    phaseIndex: stepNum,
    phaseCode: `STEP ${stepNum} · ${step.code} (${step.count} pcs)`,
    camera: {
      azimuthDeg: -34,
      elevationDeg: 35.264,
      zoom: 0.96,
      targetOffset: [0, 0, 0],
      screenShiftX: 0,
      screenShiftY: 0,
    },
    groupExplodeZ,
    groupVisibility,
    fasteners,
    materials: {
      mono: 0.32,
      xray: 0,
      coreFocus: 0.68,
      ghostOpacity: 1.0,
      highlightGroup: step.code,
      highlightPulse: pulse,
      activeFastenerParts: fasteners.activePartIds.length ? new Set(fasteners.activePartIds) : null,
      closeupKeyId: null,
      closeupCapOpacity: 1,
      closeupSwitchAlert: null,
      closeupBlink: 0,
    },
    bbox: { draw: 0, opacity: 0, dimCountUp: 0, layerTagsOpacity: manualExplodeWeight > 0.25 ? manualExplodeWeight : 0 },
    scan: { active: false, progress: 0, opacity: 0, zWorld: 0 },
    leaders: { progress: 0, opacity: 0 },
    closeup: { active: false, gapMm: 0, status: 'idle', blink: 0, keyId: metrics.closeupKeyId },
    bom: { progress: 0, opacity: 0 },
    report: { progress: 0, opacity: 0 },
  };
}
