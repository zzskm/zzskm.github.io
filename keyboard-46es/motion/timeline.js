const clamp01 = (v) => Math.max(0, Math.min(1, v));
const seg = (t, t0, t1) => (t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp01((t - t0) / (t1 - t0)));
const lerp = (a, b, u) => a + (b - a) * u;

export const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeInOutQuint = (u) => (u < 0.5 ? 16 * u * u * u * u * u : 1 - Math.pow(-2 * u + 2, 5) / 2);
export const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);

const PHASES = [
  { start: 0, end: 7, index: 1, code: '01 · DIM + EXPLODE' },
  { start: 7, end: 13, index: 2, code: '02 · X-RAY SCAN' },
  { start: 13, end: 17, index: 3, code: '03 · CORE FOCUS' },
  { start: 17, end: 23, index: 4, code: '04 · GAP CHECK' },
  { start: 23, end: 29, index: 5, code: '05 · BOM GRID' },
  { start: 29, end: 32, index: 6, code: '06 · BUILD REPORT' },
];

export function evaluateTimeline(tRaw, metrics, isCompact = false) {
  const t = Math.max(0, Math.min(metrics.durationSec, tRaw));
  const phase = PHASES.find((p) => t < p.end) || PHASES[PHASES.length - 1];

  const baseExplode = metrics.groups.map((g) => g.explodeZ);
  const groupExplodeZ = [0, 0, 0, 0, 0];
  const groupVisibility = [true, true, true, true, true];

  // Camera defaults (continuous across all 32s, zero hard cuts)
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

  // ----------------------------------------------------------------- 0–7s: Outer dims + 5-layer explode/assemble
  if (t <= 7.0) {
    bboxDraw = easeOutCubic(seg(t, 0.05, 1.85));
    const bboxIn = easeOutCubic(seg(t, 0.02, 0.25));
    const bboxOut = 1 - easeInOutCubic(seg(t, 2.0, 2.55));
    bboxOpacity = bboxIn * bboxOut;
    dimCountUp = easeOutCubic(seg(t, 0.1, 1.9));

    const explodeUp = easeInOutCubic(seg(t, 2.0, 4.0));
    if (t < 4.2) {
      for (let i = 0; i < 5; i++) {
        groupExplodeZ[i] = baseExplode[i] * explodeUp;
      }
      layerTagsOpacity = easeOutCubic(seg(t, 2.4, 3.1));
    } else {
      // Bottom-to-top staggered seating (G1 -> G2 -> G3 -> G4 -> G5)
      const seatWindows = [
        [4.2, 5.05],
        [4.65, 5.55],
        [5.1, 6.0],
        [5.55, 6.45],
        [6.0, 6.9],
      ];
      for (let i = 0; i < 5; i++) {
        const down = easeInOutCubic(seg(t, seatWindows[i][0], seatWindows[i][1]));
        groupExplodeZ[i] = baseExplode[i] * (1 - down);
      }
      layerTagsOpacity = 1 - easeOutCubic(seg(t, 5.8, 6.6));
    }

    const camOut = easeInOutCubic(seg(t, 2.0, 4.0));
    const camIn = easeInOutCubic(seg(t, 4.4, 6.9));
    const camK = camOut * (1 - camIn);
    zoom = lerp(1.0, 0.78, camK);
    targetOffset = [0, 0, lerp(0, 14, camK)];
  }

  // ----------------------------------------------------------------- 7–13s: X-Ray wireframe & vertical scan
  if (t > 7.0 && t <= 13.0) {
    const enter = easeInOutCubic(seg(t, 7.0, 8.0));
    const exit = easeInOutCubic(seg(t, 12.2, 13.0));
    xray = enter * (1 - exit);
    mono = 1 - enter;
    coreFocus = exit;
    ghostOpacity = lerp(1.0, 0.2, exit);

    azimuthDeg = lerp(-34, -26, enter);
    zoom = lerp(1.0, 1.06, enter);

    if (t >= 7.8) {
      scanActive = true;
      scanProgress = easeInOutCubic(seg(t, 8.0, 12.2));
      scanOpacity = easeOutCubic(seg(t, 7.8, 8.15)) * (1 - exit);
      const scanTop = Math.min(metrics.bbox.max.z + 1.0, metrics.bbox.min.z + 32.5);
      scanZ = lerp(metrics.bbox.min.z + 8.0, scanTop, scanProgress);
    }
  }

  // ----------------------------------------------------------------- 13–17s: Core focus + 20% exterior ghost + leaders
  if (t > 13.0 && t <= 17.0) {
    mono = 0;
    xray = 0;
    coreFocus = 1;
    ghostOpacity = 0.2;

    const move = easeInOutCubic(seg(t, 13.0, 14.3));
    azimuthDeg = lerp(-26, -38, move);
    elevationDeg = lerp(35.264, 40.0, move);
    zoom = lerp(1.06, 1.16, move);

    leadersProgress = easeOutCubic(seg(t, 13.6, 15.6));
    leadersOpacity = easeOutCubic(seg(t, 13.5, 14.0)) * (1 - easeOutCubic(seg(t, 16.4, 17.0)));
  }

  // ----------------------------------------------------------------- 17–23s: Single-switch gap close-up (seamless from ghost)
  if (t > 17.0 && t <= 23.0) {
    const zoomIn = easeInOutQuint(seg(t, 17.0, 18.5));
    const zoomOut = easeInOutQuint(seg(t, 21.3, 23.0));
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
    // Seamless angle interpolation: 17s starts at (-38, 40, 1.16), zooms to (-26, 25, 4.6), returns to (-34, 35.264, 1.0)
    if (t < 21.3) {
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

    closeupActive = t >= 17.5 && t <= 22.0;
    closeupCapOpacity = lerp(0.2, 0.05, easeOutCubic(seg(t, 17.2, 18.0))) * (1 - zoomOut) + zoomOut;

    // Switch #40 lifts smoothly to +1.8mm gap, warns with orange blink, then presses vertically down to 0.0mm
    const liftIn = easeOutCubic(seg(t, 17.0, 17.75));
    const pressDown = easeOutCubic(seg(t, 19.8, 20.75));
    closeupGapMm = 1.8 * liftIn * (1 - pressDown);

    if (t >= 17.75 && t < 20.55) {
      closeupStatus = 'warn';
      closeupBlink = 0.5 + 0.5 * Math.sin((t - 17.75) * Math.PI * 6.5);
    } else if (t >= 20.55 && t <= 22.1) {
      closeupStatus = 'ok';
      closeupBlink = 1;
    }
  }

  // ----------------------------------------------------------------- 23–29s: BOM 16-card 3D isometric grid
  if (t > 23.0 && t <= 29.0) {
    const enter = easeInOutCubic(seg(t, 23.0, 24.4));
    const exit = easeInOutCubic(seg(t, 28.2, 29.0));
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

    bomProgress = seg(t, 23.4, 27.2);
    bomOpacity = easeOutCubic(seg(t, 23.3, 23.9)) * (1 - exit);
  }

  // ----------------------------------------------------------------- 29–32s: Final isometric return + 6-cell report
  if (t > 29.0) {
    const enter = easeInOutCubic(seg(t, 29.0, 30.1));
    zoom = lerp(1.0, 0.94, enter);
    screenShiftY = lerp(0, isCompact ? 0.14 : 0.08, enter);
    azimuthDeg = -34;
    elevationDeg = 35.264;

    reportOpacity = easeOutCubic(seg(t, 29.15, 29.85));
    reportProgress = easeOutCubic(seg(t, 29.25, 31.4));
  }

  return {
    t,
    mode: 'timeline',
    phaseIndex: phase.index,
    phaseCode: phase.code,
    camera: { azimuthDeg, elevationDeg, zoom, targetOffset, screenShiftX, screenShiftY },
    groupExplodeZ,
    groupVisibility,
    materials: {
      mono,
      xray,
      coreFocus,
      ghostOpacity,
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

export function evaluateManualStep(stepNum, animK, metrics) {
  const k = clamp01(animK);
  const drop = (1 - easeOutCubic(k)) * 24.0;
  const pulse = Math.sin(k * Math.PI);
  const groupVisibility = [0, 1, 2, 3, 4].map((i) => i < stepNum);
  const groupExplodeZ = [0, 1, 2, 3, 4].map((i) => (i === stepNum - 1 ? drop : 0));
  const step = metrics.groups[stepNum - 1] || metrics.groups[0];

  return {
    t: null,
    mode: 'manual',
    stepNum,
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
    materials: {
      mono: 0.35,
      xray: 0,
      coreFocus: 0.65,
      ghostOpacity: 1.0,
      highlightGroup: step.code,
      highlightPulse: pulse,
      closeupKeyId: null,
      closeupCapOpacity: 1,
      closeupSwitchAlert: null,
      closeupBlink: 0,
    },
    bbox: { draw: 0, opacity: 0, dimCountUp: 0, layerTagsOpacity: 0 },
    scan: { active: false, progress: 0, opacity: 0, zWorld: 0 },
    leaders: { progress: 0, opacity: 0 },
    closeup: { active: false, gapMm: 0, status: 'idle', blink: 0, keyId: metrics.closeupKeyId },
    bom: { progress: 0, opacity: 0 },
    report: { progress: 0, opacity: 0 },
  };
}
