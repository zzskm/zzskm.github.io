const dom = Object.freeze({
  stage: document.getElementById("stage"),
  creditValue: document.getElementById("creditValue"),
  betValue: document.getElementById("betValue"),
  lastWinValue: document.getElementById("lastWinValue"),
  runDepthValue: document.getElementById("runDepthValue"),
  runNetValue: document.getElementById("runNetValue"),
  runBestValue: document.getElementById("runBestValue"),
  runHitValue: document.getElementById("runHitValue"),
  runYieldValue: document.getElementById("runYieldValue"),
  runStreakValue: document.getElementById("runStreakValue"),
  statusSub: document.getElementById("statusSub"),
  paytableBody: document.getElementById("paytableBody"),
  startOverlay: document.getElementById("startOverlay"),
  startGameBtn: document.getElementById("startGameBtn"),
  betDownBtn: document.getElementById("betDownBtn"),
  betUpBtn: document.getElementById("betUpBtn"),
  spinBtn: document.getElementById("spinBtn"),
  autoBtn: document.getElementById("autoBtn"),
  resetBtn: document.getElementById("resetBtn"),
});

const ctx = dom.stage.getContext("2d");
const mobileQuery = window.matchMedia("(max-width: 760px)");
let isMobile = mobileQuery.matches;
mobileQuery.addEventListener("change", (ev) => {
  isMobile = ev.matches;
  recomputeLayout();
  drawFrame(true);
});

const symbols = Array.isArray(window.DROP_PIT_SYMBOLS) ? window.DROP_PIT_SYMBOLS : [];
if (!symbols.length) throw new Error("DROP_PIT_SYMBOLS not found. Load symbols.js first.");

const ICON_W = 24;
const REELS = 3;
const PHYS_SCALE = 3;
const CELL = ICON_W * PHYS_SCALE;
const VISIBLE_TOP_FRAC = 0.5;
const VISIBLE_BOTTOM_FRAC = 0.5;

const BET_LEVELS = Object.freeze([5, 10, 20, 50]);
const START_CREDIT = 300;
const AUTO_SPIN_BATCH = 20;
const HIT_PAUSE_MS = 150;
const DIAG_BATCH_SPINS = 25;
const INITIAL_STATS = Object.freeze({
  spins: 0,
  winSpins: 0,
  twoHits: 0,
  threeHits: 0,
  missSpins: 0,
  nearMissSpins: 0,
  outcomeMiss: 0,
  outcomeTwo: 0,
  outcomeThree: 0,
  expectedMulSum: 0,
});
const MOTOR_PROFILE = Object.freeze({
  noiseStartGain: 0.02,
  toneStartGain: 0.0026,
  noiseBaseGain: 0.005,
  noiseMaxGain: 0.026,
  toneBaseGain: 0.0008,
  toneMaxGain: 0.0022,
});

const SYSTEM_STATE = Object.freeze({
  BOOT: "boot",
  PLAYING: "playing",
});

const WIN_FX_PROFILE = Object.freeze({
  two: Object.freeze({
    durationMs: 540,
    dimOthers: 0.14,
    lineAmp: 0.68,
    symbolAmp: 0.12,
    globalAmp: 0.11,
    shakeAmp: 0.8,
    pulseHz: 9.5,
    pulseCount: 2.3,
  }),
  three: Object.freeze({
    durationMs: 1200,
    dimOthers: 0.18,
    lineAmp: 1.02,
    symbolAmp: 0.23,
    globalAmp: 0.17,
    shakeAmp: 1.35,
    pulseHz: 9.6,
    pulseCount: 3.4,
  }),
  big: Object.freeze({
    durationMs: 1060,
    dimOthers: 0.22,
    lineAmp: 1.2,
    symbolAmp: 0.28,
    globalAmp: 0.25,
    shakeAmp: 1.9,
    pulseHz: 12.2,
    pulseCount: 4.0,
  }),
});

const NEAR_MISS_FX = Object.freeze({
  durationMs: 560,
  dimOthers: 0.1,
  lineAmp: 0.62,
  symbolAmp: 0.14,
  globalAmp: 0.12,
  shakeAmp: 1.05,
  pulseHz: 15.4,
});

const REEL_FLASH_PROFILE = Object.freeze({
  durationMs: 180,
  baseAmp: 1,
});

const NEAR_MISS_TEASE_PROFILE = Object.freeze({
  extraTurnsMin: 0.55,
  extraTurnsMax: 1.0,
  buildCruiseExtendMs: 90,
  buildBrakeStretch: 1.14,
  buildDecelScale: 0.93,
  buildMinBrakeScale: 0.84,
});

const NEAR_MISS_PARTICLE_PROFILE = Object.freeze({
  buildCount: 18,
  trailCount: 4,
  resolveCount: 34,
  speedMin: 88,
  speedMax: 280,
  ttlMin: 210,
  ttlMax: 640,
});

const PARTICLE_PROFILE = Object.freeze({
  two: Object.freeze({ perReel: 12, speedMin: 72, speedMax: 170, ttlMin: 260, ttlMax: 460 }),
  three: Object.freeze({ perReel: 18, speedMin: 86, speedMax: 210, ttlMin: 300, ttlMax: 540 }),
  big: Object.freeze({ perReel: 24, speedMin: 96, speedMax: 240, ttlMin: 340, ttlMax: 640 }),
});

const TICK_PROFILE = Object.freeze({
  noiseBaseGain: 0.004,
  noiseMaxGain: 0.011,
  toneBaseGain: 0.0016,
  toneMaxGain: 0.0048,
  freqBase: 160,
  freqMax: 280,
  noiseHzBase: 760,
  noiseHzRange: 320,
});

const layout = {
  dpr: 1,
  cssW: dom.stage.clientWidth || 760,
  cssH: dom.stage.clientHeight || 360,
  drawScale: PHYS_SCALE,
  drawCell: CELL,
  reelPad: 6,
  reelW: CELL + 12,
  reelH: Math.round(CELL * (1 + VISIBLE_TOP_FRAC + VISIBLE_BOTTOM_FRAC)),
  gap: 10,
  machineW: 0,
  offsetX: 0,
  offsetY: 30,
  centerLineY: 0,
};

const PAYOUT_TABLE = Object.freeze({
  cherry: Object.freeze({ two: 0.2, three: 10 }),
  lemon: Object.freeze({ two: 0.25, three: 14 }),
  bell: Object.freeze({ two: 0.35, three: 20 }),
  bar: Object.freeze({ two: 0.45, three: 28 }),
  clover: Object.freeze({ two: 0.65, three: 38 }),
  diamond: Object.freeze({ two: 0.9, three: 52 }),
  seven: Object.freeze({ two: 1.8, three: 82 }),
});

const OUTCOME_BASE_TABLE = Object.freeze([
  Object.freeze({ type: "three", symbol: "seven", weight: 1 }),
  Object.freeze({ type: "three", symbol: "diamond", weight: 2 }),
  Object.freeze({ type: "three", symbol: "clover", weight: 4 }),
  Object.freeze({ type: "three", symbol: "bar", weight: 6 }),
  Object.freeze({ type: "three", symbol: "bell", weight: 8 }),
  Object.freeze({ type: "three", symbol: "lemon", weight: 12 }),
  Object.freeze({ type: "three", symbol: "cherry", weight: 18 }),
  Object.freeze({ type: "two", symbol: "seven", weight: 8 }),
  Object.freeze({ type: "two", symbol: "diamond", weight: 14 }),
  Object.freeze({ type: "two", symbol: "clover", weight: 20 }),
  Object.freeze({ type: "two", symbol: "bar", weight: 28 }),
  Object.freeze({ type: "two", symbol: "bell", weight: 36 }),
  Object.freeze({ type: "two", symbol: "lemon", weight: 46 }),
  Object.freeze({ type: "two", symbol: "cherry", weight: 56 }),
  Object.freeze({ type: "miss", weight: 580 }),
]);

const PREMIUM_SYMBOLS = new Set(["seven", "diamond"]);
const SAFE_SYMBOLS = new Set(["cherry", "lemon", "bell", "bar"]);
const RTP_TARGET_MIN = 0.82;
const RTP_TARGET_MAX = 0.9;
const SYMBOL_ID_BY_NAME = Object.freeze(
  symbols.reduce((acc, s, idx) => {
    acc[s.name] = idx;
    return acc;
  }, {}),
);

const PHASE = Object.freeze({
  IDLE: "idle",
  SPINUP: "spinup",
  CRUISE: "cruise",
  BRAKE: "brake",
  SETTLE: "settle",
});

function mod(n, m) {
  return ((n % m) + m) % m;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function easeOutQuad(t) {
  return 1 - ((1 - t) * (1 - t));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutSine(t) {
  return 0.5 - (0.5 * Math.cos(Math.PI * t));
}

function smootherStep(t) {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * ((x * 6) - 15) + 10);
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const prerenderCache = new Map();
const PARTICLE_COLOR_POOL = Array.from(
  { length: 256 },
  (_, i) => `rgba(255,236,166,${(i / 255).toFixed(3)})`,
);

const reelOverlayCache = {
  stable: [],
};

const floaterFontCache = {
  two: "",
  three: "",
  big: "",
  bigTop: "",
};

const hudShadow = {
  credit: NaN,
  bet: NaN,
  lastWin: NaN,
};

const runLogShadow = {
  depth: NaN,
  net: NaN,
  best: NaN,
  hit: "",
  yield: "",
  streak: "",
  netTone: "",
  streakTone: "",
};

let frameDirty = true;

function markFrameDirty() {
  frameDirty = true;
}

function getPrerendered(scale) {
  const key = Math.max(1, scale | 0);
  let cached = prerenderCache.get(key);
  if (cached) return cached;

  const cell = ICON_W * key;
  cached = symbols.map((icon) => {
    const c = document.createElement("canvas");
    c.width = cell;
    c.height = cell;
    const cctx = c.getContext("2d");
    cctx.fillStyle = "#f2f3ee";
    cctx.fillRect(0, 0, c.width, c.height);
    window.renderDropPitIconToCanvas(cctx, icon, key, 0);
    return c;
  });

  prerenderCache.set(key, cached);
  return cached;
}

function fitScale({
  cssW,
  maxScale,
  padRatio,
  padMin,
  gapRatio,
  gapMin,
  fitMargin,
}) {
  for (let scale = maxScale; scale >= 2; scale--) {
    const cell = ICON_W * scale;
    const pad = Math.max(padMin, Math.round(cell * padRatio));
    const gap = Math.max(gapMin, Math.round(cell * gapRatio));
    const machineW = ((cell + (pad * 2)) * REELS) + (gap * (REELS - 1));
    if (machineW <= (cssW - fitMargin)) return scale;
  }
  return 2;
}

function createReelOverlayGradients(x, y, centerY, bottomY, sideW) {
  const gTop = ctx.createLinearGradient(0, y, 0, centerY);
  gTop.addColorStop(0, "rgba(255,255,255,0.20)");
  gTop.addColorStop(0.58, "rgba(255,255,255,0.05)");
  gTop.addColorStop(1, "rgba(0,0,0,0.08)");

  const gBottom = ctx.createLinearGradient(0, bottomY, 0, y + layout.reelH);
  gBottom.addColorStop(0, "rgba(255,255,255,0.02)");
  gBottom.addColorStop(0.6, "rgba(0,0,0,0.12)");
  gBottom.addColorStop(1, "rgba(0,0,0,0.20)");

  const gLeft = ctx.createLinearGradient(x, 0, x + sideW, 0);
  gLeft.addColorStop(0, "rgba(0,0,0,0.16)");
  gLeft.addColorStop(1, "rgba(0,0,0,0)");

  const gRight = ctx.createLinearGradient(x + layout.reelW - sideW, 0, x + layout.reelW, 0);
  gRight.addColorStop(0, "rgba(0,0,0,0)");
  gRight.addColorStop(1, "rgba(0,0,0,0.18)");

  const glass = ctx.createLinearGradient(x, centerY, x + layout.reelW, centerY + layout.drawCell);
  glass.addColorStop(0, "rgba(255,255,255,0.10)");
  glass.addColorStop(0.55, "rgba(255,255,255,0.02)");
  glass.addColorStop(1, "rgba(0,0,0,0.05)");

  return { gTop, gBottom, gLeft, gRight, glass, sideW };
}

function rebuildReelOverlayCache() {
  reelOverlayCache.stable.length = 0;
  const y = layout.offsetY;
  const topH = VISIBLE_TOP_FRAC * layout.drawCell;
  const centerY = y + topH;
  const bottomY = centerY + layout.drawCell;
  const sideW = Math.max(5, Math.round(layout.drawCell * 0.11));

  for (let reelIndex = 0; reelIndex < REELS; reelIndex++) {
    const x = layout.offsetX + reelIndex * (layout.reelW + layout.gap);
    reelOverlayCache.stable.push(createReelOverlayGradients(x, y, centerY, bottomY, sideW));
  }
}

function rebuildFloaterFontCache() {
  const base = 11 + (layout.drawScale * 2.2);
  const two = Math.round(base * 1.16);
  const three = Math.round(base * 1.68);
  const big = Math.round(base * 2.3);
  floaterFontCache.two = `700 ${two}px 'Share Tech Mono', monospace`;
  floaterFontCache.three = `700 ${three}px 'Share Tech Mono', monospace`;
  floaterFontCache.big = `700 ${big}px 'Share Tech Mono', monospace`;
  floaterFontCache.bigTop = `700 ${Math.round(big * 0.52)}px 'Share Tech Mono', monospace`;
}

function recomputeLayout() {
  const cssW = Math.max(300, Math.floor(dom.stage.clientWidth || 760));
  const mobile = isMobile;
  const maxScale = mobile ? 6 : 4;
  const padRatio = mobile ? 0.04 : 0.083;
  const padMin = mobile ? 3 : 4;
  const gapRatio = mobile ? 0.08 : 0.14;
  const gapMin = mobile ? 4 : 8;
  const fitMargin = mobile ? 4 : 8;
  let scale = fitScale({
    cssW,
    maxScale,
    padRatio,
    padMin,
    gapRatio,
    gapMin,
    fitMargin,
  });

  scale = clamp(scale, 2, maxScale);
  layout.drawScale = scale;
  layout.drawCell = ICON_W * scale;
  layout.reelPad = Math.max(padMin, Math.round(layout.drawCell * padRatio));
  layout.reelW = layout.drawCell + (layout.reelPad * 2);
  layout.gap = Math.max(gapMin, Math.round(layout.drawCell * gapRatio));
  layout.reelH = Math.round(layout.drawCell * (1 + VISIBLE_TOP_FRAC + VISIBLE_BOTTOM_FRAC));
  layout.machineW = (layout.reelW * REELS) + (layout.gap * (REELS - 1));
  layout.offsetX = Math.floor((cssW - layout.machineW) / 2);
  layout.offsetY = mobile ? 16 : 28;
  layout.centerLineY = layout.offsetY + Math.floor((VISIBLE_TOP_FRAC * layout.drawCell) + (layout.drawCell * 0.5));
  layout.cssW = cssW;
  layout.cssH = Math.max(196, layout.offsetY + layout.reelH + (mobile ? 8 : 18));

  layout.dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  dom.stage.width = Math.round(layout.cssW * layout.dpr);
  dom.stage.height = Math.round(layout.cssH * layout.dpr);

  ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  rebuildReelOverlayCache();
  rebuildFloaterFontCache();
  markFrameDirty();
}

const audio = (typeof window.createDropPitAudio === "function")
  ? window.createDropPitAudio({
    CELL,
    PHASE,
    motorProfile: MOTOR_PROFILE,
    tickProfile: TICK_PROFILE,
  })
  : null;

if (!audio) throw new Error("createDropPitAudio not found. Load droppit.audio.js first.");

const unlockAudioFromGesture = () => audio.unlockAudioFromGesture();
const stopMotor = () => audio.sfxSpinStop();
const sfxReelTick = (input) => audio.sfxReelTick(input);
const sfxBetAdjust = (delta) => audio.sfxBetAdjust(delta);
const sfxSpinStart = () => audio.sfxSpinStart();
const sfxBrake = (reelIndex) => audio.sfxBrake(reelIndex);
const sfxSettle = () => audio.sfxSettle();
const sfxWin = (amount, tier = "two") => audio.sfxWin(amount, tier);
const sfxNearMissBuild = () => audio.sfxNearMissBuild();
const sfxNearMissResolve = () => audio.sfxNearMissResolve();
const sfxUiDeny = () => audio.sfxUiDeny();
const sfxDryDrop = () => audio.sfxDryDrop();
const sfxAutoToggle = (on) => audio.sfxAutoToggle(on);

function calcNextTickSpacing(reel) {
  const n = clamp(reel.speed / (CELL * 18), 0, 1);
  const phaseMul = reel.phase === PHASE.CRUISE ? 1.16 : reel.phase === PHASE.BRAKE ? 1.03 : reel.phase === PHASE.SETTLE ? 1.34 : 1.1;
  const jitter = 0.96 + (Math.random() * 0.12);
  return CELL * clamp((0.84 - (n * 0.38)) * phaseMul * jitter, 0.34, 0.98);
}

function stepReelTickSfx(reel) {
  if (reel.phase === PHASE.IDLE) {
    reel.tickCarry = 0;
    reel.tickPrevPos = reel.pos;
    reel.tickFrameCounter = 0;
    return;
  }

  const delta = Math.abs(reel.pos - reel.tickPrevPos);
  reel.tickPrevPos = reel.pos;
  if (delta <= 0.01) return;

  if ((reel.tickFrameCounter % 14) === 0) {
    reel.tickJitterTarget = (Math.random() * 2) - 1;
  }
  reel.tickFrameCounter += 1;
  reel.tickJitter += (reel.tickJitterTarget - reel.tickJitter) * 0.05;

  reel.tickCarry += delta;
  let ticks = 0;
  while (reel.tickCarry >= reel.nextTickSpacing && ticks < 2) {
    const speedNorm = clamp(reel.speed / (CELL * 18), 0, 1);
    sfxReelTick({
      laneIndex: reel.i,
      speedNorm,
      phase: reel.phase,
      jitter: reel.tickJitter,
    });
    reel.tickCarry -= reel.nextTickSpacing;
    reel.nextTickSpacing = calcNextTickSpacing(reel);
    ticks += 1;
  }
}

function makeStrip(minLen = 28) {
  const out = [];
  while (out.length < minLen) {
    const bag = symbols.map((_, i) => i);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    out.push(...bag);
  }
  return out;
}

function createReel(i) {
  return {
    i,
    strip: makeStrip(),
    pos: 0,
    speed: 0,
    idealSpeed: 0,
    phase: PHASE.IDLE,
    phaseMs: 0,
    topSpeed: 0,
    spinupMs: 0,
    cruiseMs: 0,
    cruiseMinMs: 260,
    cruiseMaxMs: 1300,
    cruiseLeaveAfterMs: 120,
    leaveAtMs: -1,
    brakeMs: 0,
    decel: 0,
    minBrakeSpeed: CELL * 0.3,
    cellsAhead: 10,
    spinupPulseAmp: 0,
    spinupPulseHz: 8,
    spinupKickAmp: 0,
    spinupKickHz: 5,
    spinupKickPhase: 0,
    waveAmp: 0,
    waveHz: 6,
    wavePhase: 0,
    wave2Amp: 0,
    wave2Hz: 9,
    wave2Phase: 0,
    waveGateHz: 1,
    waveGatePhase: 0,
    waveDriftAmp: 0,
    waveDriftHz: 1.4,
    waveDriftPhase: 0,
    brakeShape: 1.15,
    brakeTail: 1.05,
    settleMs: 120,
    settleEntryWindow: CELL * 0.24,
    settleOvershootPx: CELL * 0.1,
    settleApproachBaseMs: 34,
    settleOvershootMs: 70,
    settleHoldMs: 16,
    settleReturnMs: 146,
    settleApproachMs: 88,
    settleStartPos: 0,
    settlePeakPos: 0,
    settleDurationMs: 160,
    targetPos: 0,
    targetSymbolId: 0,
    stopRank: 0,
    teaseReel: false,
    teaseExtraTurns: 0,
    nearMissBoostApplied: false,
    brakeStartSpeed: 0,
    tickCarry: 0,
    nextTickSpacing: CELL * 0.52,
    tickPrevPos: 0,
    tickJitter: 0,
    tickJitterTarget: 0,
    tickFrameCounter: 0,
  };
}

const reels = Array.from({ length: REELS }, (_, i) => createReel(i));

const game = {
  system: SYSTEM_STATE.BOOT,
  signalBusy: false,
  credit: START_CREDIT,
  betIndex: 1,
  spinBet: BET_LEVELS[1],
  spins: 0,
  totalBet: 0,
  totalWin: 0,
  lastWin: 0,
  displayLastWin: 0,
  winCountActive: false,
  winCountFrom: 0,
  winCountTo: 0,
  winCountStartedAt: 0,
  winCountDurMs: 0,
  running: false,
  pendingResolve: false,
  resolveDueAt: 0,
  hitPauseMs: HIT_PAUSE_MS,
  autoLeft: 0,
  nextAutoAt: 0,
  seed: 0,
  missStreak: 0,
  winStreak: 0,
  bestWin: 0,
  plannedOutcome: null,
  debugOutcomeMismatch: 0,
  stats: { ...INITIAL_STATS },
  fx: {
    active: false,
    tier: "none",
    startedAt: 0,
    durationMs: 0,
    hitReels: [],
    dimOthers: 0,
    lineAmp: 0,
    symbolAmp: 0,
    globalAmp: 0,
    shakeAmp: 0,
    pulseHz: 0,
    pulseCount: 0,
  },
  nearMissState: {
    active: false,
    buildTriggered: false,
    startedAt: 0,
    matchedReels: [],
    symbolId: -1,
    trailCarryMs: 0,
  },
  nearMissFx: {
    active: false,
    startedAt: 0,
    durationMs: NEAR_MISS_FX.durationMs,
    matchedReels: [],
    missReel: -1,
  },
  reelFlashes: Array.from(
    { length: REELS },
    () => ({
      active: false,
      startedAt: 0,
      durationMs: REEL_FLASH_PROFILE.durationMs,
      amp: REEL_FLASH_PROFILE.baseAmp,
    }),
  ),
  particles: [],
  floaters: [],
};

function getReelBaseCell(reel) {
  return Math.floor(reel.pos / CELL);
}

function centerSymbolIndex(reel) {
  const stripLen = reel.strip.length;
  const base = mod(getReelBaseCell(reel), stripLen);
  return reel.strip[(base + 1) % stripLen];
}

function setStatus(text, tone = "neutral") {
  if (!dom.statusSub) return;
  dom.statusSub.textContent = text;
  dom.statusSub.classList.remove("win", "warn");
  if (tone === "win") dom.statusSub.classList.add("win");
  if (tone === "warn") dom.statusSub.classList.add("warn");
}

function isSystemLive() {
  return game.system === SYSTEM_STATE.PLAYING;
}

function enterBootState() {
  game.system = SYSTEM_STATE.BOOT;
  game.signalBusy = false;
  if (dom.startOverlay) dom.startOverlay.classList.remove("hidden");
  setStatus("AWAITING SIGNAL.");
  updateButtons();
  markFrameDirty();
}

async function triggerGameStartSignal() {
  if (game.signalBusy || game.system === SYSTEM_STATE.PLAYING) return;
  game.signalBusy = true;
  updateButtons();
  setStatus("BOOTING...");

  const audioReady = await unlockAudioFromGesture();
  if (!audioReady) {
    game.signalBusy = false;
    updateButtons();
    setStatus("SIGNAL REJECTED.", "warn");
    return;
  }

  await audio.sfxStartSignal();
  game.system = SYSTEM_STATE.PLAYING;
  game.signalBusy = false;
  if (dom.startOverlay) dom.startOverlay.classList.add("hidden");
  setStatus("SYSTEM LIVE.");
  updateButtons();
  markFrameDirty();
}

function currentBet() {
  return BET_LEVELS[game.betIndex];
}

function formatMultiplier(v) {
  if (Number.isInteger(v)) return `${v}x`;
  return `${v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}x`;
}

function formatRtp() {
  if (game.totalBet <= 0) return "0.00%";
  return `${((game.totalWin / game.totalBet) * 100).toFixed(2)}%`;
}

function formatSignedInt(n) {
  if (n > 0) return `+${n}`;
  return `${n}`;
}

function formatHitRate() {
  const spins = Math.max(1, game.stats.spins);
  const hit = (game.stats.winSpins / spins) * 100;
  return `${hit.toFixed(1)}%`;
}

function getStreakMeta() {
  if (game.winStreak > 0) return { text: `HIT x${game.winStreak}`, tone: "win" };
  if (game.missStreak > 0) return { text: `DRY x${game.missStreak}`, tone: "warn" };
  return { text: "IDLE", tone: "neutral" };
}

function applyRunValueTone(el, tone) {
  if (!el) return;
  el.classList.remove("runWin", "runWarn", "runNeutral");
  if (tone === "win") el.classList.add("runWin");
  else if (tone === "warn") el.classList.add("runWarn");
  else el.classList.add("runNeutral");
}

function updateRunLog() {
  const depth = game.spins;
  const net = game.credit - START_CREDIT;
  const best = game.bestWin;
  const hit = formatHitRate();
  const yieldPct = formatRtp();
  const streak = getStreakMeta();
  const netTone = net > 0 ? "win" : net < 0 ? "warn" : "neutral";

  if (runLogShadow.depth !== depth) {
    dom.runDepthValue.textContent = `${depth}`;
    runLogShadow.depth = depth;
  }
  if (runLogShadow.net !== net) {
    dom.runNetValue.textContent = formatSignedInt(net);
    runLogShadow.net = net;
  }
  if (runLogShadow.best !== best) {
    dom.runBestValue.textContent = `${best}`;
    runLogShadow.best = best;
  }
  if (runLogShadow.hit !== hit) {
    dom.runHitValue.textContent = hit;
    runLogShadow.hit = hit;
  }
  if (runLogShadow.yield !== yieldPct) {
    dom.runYieldValue.textContent = yieldPct;
    runLogShadow.yield = yieldPct;
  }
  if (runLogShadow.streak !== streak.text) {
    dom.runStreakValue.textContent = streak.text;
    runLogShadow.streak = streak.text;
  }
  if (runLogShadow.netTone !== netTone) {
    applyRunValueTone(dom.runNetValue, netTone);
    runLogShadow.netTone = netTone;
  }
  if (runLogShadow.streakTone !== streak.tone) {
    applyRunValueTone(dom.runStreakValue, streak.tone);
    runLogShadow.streakTone = streak.tone;
  }
}

function updateHud() {
  const credit = game.credit;
  const bet = currentBet();
  const lastWin = Math.round(game.displayLastWin);

  if (hudShadow.credit !== credit) {
    dom.creditValue.textContent = `${credit}`;
    hudShadow.credit = credit;
  }
  if (hudShadow.bet !== bet) {
    dom.betValue.textContent = `${bet}`;
    hudShadow.bet = bet;
  }
  if (hudShadow.lastWin !== lastWin) {
    dom.lastWinValue.textContent = `${lastWin}`;
    hudShadow.lastWin = lastWin;
  }
  updateRunLog();
}

function clearReelFlashes() {
  for (let i = 0; i < game.reelFlashes.length; i++) {
    const f = game.reelFlashes[i];
    f.active = false;
    f.startedAt = 0;
    f.amp = REEL_FLASH_PROFILE.baseAmp;
  }
}

function clearNearMissState() {
  game.nearMissState.active = false;
  game.nearMissState.buildTriggered = false;
  game.nearMissState.startedAt = 0;
  game.nearMissState.matchedReels = [];
  game.nearMissState.symbolId = -1;
  game.nearMissState.trailCarryMs = 0;
}

function clearNearMissFx() {
  game.nearMissFx.active = false;
  game.nearMissFx.startedAt = 0;
  game.nearMissFx.durationMs = NEAR_MISS_FX.durationMs;
  game.nearMissFx.matchedReels = [];
  game.nearMissFx.missReel = -1;
}

function recordSpinDiagnostics(result, planned) {
  const s = game.stats;
  s.spins += 1;
  s.expectedMulSum += planned?.expectedMul || 0;

  const outcomeType = planned?.type || "miss";
  if (outcomeType === "three") s.outcomeThree += 1;
  else if (outcomeType === "two") s.outcomeTwo += 1;
  else s.outcomeMiss += 1;

  if (result.win > 0) {
    s.winSpins += 1;
    if (result.matchCount >= 3) s.threeHits += 1;
    else if (result.matchCount === 2) s.twoHits += 1;
  } else {
    s.missSpins += 1;
    if (planned?.nearMiss) s.nearMissSpins += 1;
  }

  if ((s.spins % DIAG_BATCH_SPINS) === 0) {
    const hitRate = ((s.winSpins / Math.max(1, s.spins)) * 100).toFixed(1);
    const nearMissRate = ((s.nearMissSpins / Math.max(1, s.missSpins)) * 100).toFixed(1);
    const twoRate = ((s.twoHits / Math.max(1, s.spins)) * 100).toFixed(1);
    const threeRate = ((s.threeHits / Math.max(1, s.spins)) * 100).toFixed(1);
    const expRtp = ((s.expectedMulSum / Math.max(1, s.spins)) * 100).toFixed(1);
    console.info(`[diag] spins=${s.spins} hit=${hitRate}% two=${twoRate}% three=${threeRate}% nearMissAmongMiss=${nearMissRate}% expectedRTP=${expRtp}% mismatch=${game.debugOutcomeMismatch}`);
  }
}

function startLastWinCount(target, tier, nowMs) {
  game.winCountFrom = 0;
  game.winCountTo = target;
  game.displayLastWin = 0;
  game.winCountStartedAt = nowMs;
  game.winCountDurMs = tier === "big" ? 780 : tier === "three" ? 600 : 420;
  game.winCountActive = target > 0;
}

function stepLastWinCount(nowMs) {
  if (!game.winCountActive) return false;
  const t = clamp((nowMs - game.winCountStartedAt) / Math.max(1, game.winCountDurMs), 0, 1);
  game.displayLastWin = lerp(game.winCountFrom, game.winCountTo, easeOutCubic(t));
  if (t >= 1) {
    game.displayLastWin = game.winCountTo;
    game.winCountActive = false;
  }
  return true;
}

function reelCenterX(reelIndex) {
  return layout.offsetX + (reelIndex * (layout.reelW + layout.gap)) + (layout.reelW * 0.5);
}

function pushNearMissParticle(originX, originY, intensityScale = 1) {
  const angle = ((Math.random() * 1.5) - 2.32);
  const speed = lerp(
    NEAR_MISS_PARTICLE_PROFILE.speedMin,
    NEAR_MISS_PARTICLE_PROFILE.speedMax,
    Math.random(),
  ) * intensityScale;
  const ttl = lerp(
    NEAR_MISS_PARTICLE_PROFILE.ttlMin,
    NEAR_MISS_PARTICLE_PROFILE.ttlMax,
    Math.random(),
  );
  game.particles.push({
    x: originX + ((Math.random() * 16) - 8),
    y: originY + ((Math.random() * 10) - 5),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed * 0.9,
    ttl,
    age: 0,
    size: (layout.drawScale >= 4 ? 2 : 1) + (Math.random() * 2.2),
    twinkle: 0.15 + (Math.random() * 0.85),
    sparkle: clamp(0.9 + (Math.random() * 0.55), 0, 1.6),
  });
}

function trimParticleCap() {
  const cap = isMobile ? 190 : 320;
  if (game.particles.length <= cap) return;
  game.particles.splice(0, game.particles.length - cap);
}

function spawnNearMissParticles(reelIndices, mode = "build") {
  if (!Array.isArray(reelIndices) || !reelIndices.length) return;
  const uniqueReels = Array.from(new Set(reelIndices.filter((idx) => idx >= 0 && idx < REELS)));
  if (!uniqueReels.length) return;

  const base = mode === "resolve"
    ? NEAR_MISS_PARTICLE_PROFILE.resolveCount
    : mode === "trail"
      ? NEAR_MISS_PARTICLE_PROFILE.trailCount
      : NEAR_MISS_PARTICLE_PROFILE.buildCount;
  const mobileScale = isMobile ? 0.66 : 1;
  const perReel = Math.max(2, Math.round(base * mobileScale / uniqueReels.length));
  const intensity = mode === "resolve" ? 1.08 : mode === "trail" ? 0.74 : 0.9;

  for (const reelIndex of uniqueReels) {
    const originX = reelCenterX(reelIndex);
    const originY = layout.centerLineY;
    for (let i = 0; i < perReel; i++) pushNearMissParticle(originX, originY, intensity);
  }
  trimParticleCap();
  markFrameDirty();
}

function spawnPaylineParticles(result) {
  const p = PARTICLE_PROFILE[result.tier] || PARTICLE_PROFILE.two;
  const mobile = isMobile;
  const cap = mobile ? 140 : 260;
  const sparkle = result.tier === "big" ? 1 : result.tier === "three" ? 0.85 : 0.72;
  const hitReels = result.hitReels && result.hitReels.length ? result.hitReels : [1];

  for (const reelIndex of hitReels) {
    const originX = reelCenterX(reelIndex);
    const originY = layout.centerLineY;
    const count = mobile ? Math.max(8, Math.round(p.perReel * 0.65)) : p.perReel;
    for (let i = 0; i < count; i++) {
      const angle = ((Math.random() * 1.3) - 2.23);
      const speed = p.speedMin + (Math.random() * (p.speedMax - p.speedMin));
      const ttl = p.ttlMin + (Math.random() * (p.ttlMax - p.ttlMin));
      game.particles.push({
        x: originX + ((Math.random() * 14) - 7),
        y: originY + ((Math.random() * 8) - 4),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.92,
        ttl,
        age: 0,
        size: (layout.drawScale >= 4 ? 2 : 1) + (Math.random() * 1.8),
        twinkle: 0.3 + (Math.random() * 0.7),
        sparkle,
      });
    }
  }

  if (game.particles.length > cap) {
    game.particles.splice(0, game.particles.length - cap);
  }
}

function spawnPaylineFloater(result) {
  const midX = layout.offsetX + (layout.machineW * 0.5);
  const baseY = layout.centerLineY - Math.round(layout.drawCell * 0.06);
  const floaterDur = result.tier === "big" ? 1060 : result.tier === "three" ? 860 : 700;
  const rise = result.tier === "big" ? 58 : result.tier === "three" ? 48 : 38;
  const amp = result.tier === "big" ? 7.2 : result.tier === "three" ? 5.2 : 3.8;
  const lines = (result.tier === "big" && result.matchName)
    ? [result.matchName.toUpperCase(), `+${result.win}`]
    : [`+${result.win}`];

  game.floaters.push({
    lines,
    x: midX,
    y: baseY,
    age: 0,
    ttl: floaterDur,
    rise,
    amp,
    tier: result.tier,
  });
}

function spawnMatchEffects(result) {
  if (!result || result.win <= 0) return;
  spawnPaylineParticles(result);
  spawnPaylineFloater(result);
}

function stepMatchEffects(dtMs) {
  if (game.particles.length) {
    const dt = dtMs / 1000;
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const p = game.particles[i];
      p.age += dtMs;
      if (p.age >= p.ttl) {
        game.particles[i] = game.particles[game.particles.length - 1];
        game.particles.pop();
        continue;
      }
      p.vy += 280 * dt;
      p.vx *= 0.985;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  if (game.floaters.length) {
    const dt = dtMs / 1000;
    for (let i = game.floaters.length - 1; i >= 0; i--) {
      const f = game.floaters[i];
      f.age += dtMs;
      if (f.age >= f.ttl) {
        game.floaters[i] = game.floaters[game.floaters.length - 1];
        game.floaters.pop();
        continue;
      }
      f.y -= (f.rise * dt);
    }
  }
}

function drawMatchEffects() {
  if (!game.particles.length && !game.floaters.length) return;

  if (game.particles.length) {
    for (const p of game.particles) {
      const t = clamp(p.age / Math.max(1, p.ttl), 0, 1);
      const alpha = (1 - t) * p.sparkle * (0.6 + (0.4 * Math.sin((t * 40) + p.twinkle)));
      const glow = Math.max(0.08, alpha);
      const alphaIdx = Math.round(clamp(glow, 0, 1) * 255);
      ctx.fillStyle = PARTICLE_COLOR_POOL[alphaIdx];
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  if (game.floaters.length) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const f of game.floaters) {
      const t = clamp(f.age / Math.max(1, f.ttl), 0, 1);
      const a = clamp(1 - Math.pow(t, 0.9), 0, 1);
      const wobble = Math.sin((f.age / 1000) * 12) * f.amp;
      const x = f.x + wobble;
      const lines = Array.isArray(f.lines) && f.lines.length ? f.lines : ["+0"];

      if (lines.length === 1) {
        const mainFont = f.tier === "big"
          ? floaterFontCache.big
          : f.tier === "three"
            ? floaterFontCache.three
            : floaterFontCache.two;
        const size = f.tier === "big"
          ? Math.round((11 + (layout.drawScale * 2.2)) * 2.3)
          : f.tier === "three"
            ? Math.round((11 + (layout.drawScale * 2.2)) * 1.68)
            : Math.round((11 + (layout.drawScale * 2.2)) * 1.16);
        ctx.font = mainFont;
        ctx.strokeStyle = `rgba(40,30,14,${Math.min(0.72, a).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.2, size * 0.065);
        ctx.fillStyle = `rgba(255,241,178,${a.toFixed(3)})`;
        ctx.strokeText(lines[0], x, f.y);
        ctx.fillText(lines[0], x, f.y);
      } else {
        const size = Math.round((11 + (layout.drawScale * 2.2)) * 2.3);
        const topSize = Math.round(size * 0.52);
        const topY = f.y - (size * 0.58);
        const bottomY = f.y + (size * 0.14);

        ctx.font = floaterFontCache.bigTop;
        ctx.strokeStyle = `rgba(40,30,14,${Math.min(0.58, a).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, topSize * 0.08);
        ctx.fillStyle = `rgba(255,241,178,${(a * 0.92).toFixed(3)})`;
        ctx.strokeText(lines[0], x, topY);
        ctx.fillText(lines[0], x, topY);

        ctx.font = floaterFontCache.big;
        ctx.strokeStyle = `rgba(40,30,14,${Math.min(0.72, a).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.2, size * 0.065);
        ctx.fillStyle = `rgba(255,241,178,${a.toFixed(3)})`;
        ctx.strokeText(lines[1], x, bottomY);
        ctx.fillText(lines[1], x, bottomY);
      }
    }
    ctx.restore();
  }
}

function startWinFx(result, nowMs) {
  if (!result || result.win <= 0 || !result.hitReels || !result.hitReels.length) {
    game.fx.active = false;
    return;
  }
  clearNearMissFx();
  const p = WIN_FX_PROFILE[result.tier] || WIN_FX_PROFILE.two;
  Object.assign(game.fx, p, {
    active: true,
    tier: result.tier,
    startedAt: nowMs,
    hitReels: result.hitReels.slice(),
  });
}

function stepWinFx(nowMs) {
  if (!game.fx.active) return;
  if ((nowMs - game.fx.startedAt) >= game.fx.durationMs) game.fx.active = false;
}

function applyNearMissTeaseBoost() {
  const teaseReelIndex = game.plannedOutcome?.teaseReel;
  if (!Number.isInteger(teaseReelIndex) || teaseReelIndex < 0 || teaseReelIndex >= REELS) return;
  const reel = reels[teaseReelIndex];
  if (!reel || reel.phase === PHASE.IDLE || reel.nearMissBoostApplied) return;

  const extendMs = NEAR_MISS_TEASE_PROFILE.buildCruiseExtendMs;
  if (reel.phase === PHASE.CRUISE) {
    reel.cruiseMs = Math.max(reel.cruiseMs + extendMs, reel.phaseMs + (extendMs * 0.82));
    reel.cruiseMaxMs += extendMs + 120;
    if (reel.leaveAtMs >= 0) {
      reel.leaveAtMs += extendMs;
    } else {
      reel.leaveAtMs = Math.min(reel.cruiseMaxMs, reel.phaseMs + extendMs);
    }
  }

  reel.brakeMs *= NEAR_MISS_TEASE_PROFILE.buildBrakeStretch;
  reel.decel *= NEAR_MISS_TEASE_PROFILE.buildDecelScale;
  reel.minBrakeSpeed *= NEAR_MISS_TEASE_PROFILE.buildMinBrakeScale;
  reel.cellsAhead += 3;
  reel.nearMissBoostApplied = true;

  if (reel.phase === PHASE.BRAKE) reel.targetPos = computeOutcomeBrakeTargetPos(reel);
}

function startNearMissBuildFx(matchedReels, symbolId, nowMs) {
  game.nearMissState.active = true;
  game.nearMissState.buildTriggered = true;
  game.nearMissState.startedAt = nowMs;
  game.nearMissState.matchedReels = matchedReels.slice(0, 2);
  game.nearMissState.symbolId = symbolId;
  game.nearMissState.trailCarryMs = 0;

  applyNearMissTeaseBoost();
  const teaseReelIndex = game.plannedOutcome?.teaseReel;
  const burstReels = Number.isInteger(teaseReelIndex)
    ? [...new Set([...game.nearMissState.matchedReels, teaseReelIndex])]
    : game.nearMissState.matchedReels;
  spawnNearMissParticles(burstReels, "build");
}

function startNearMissResolveFx(matchedReels, missReel, nowMs) {
  game.nearMissFx.active = true;
  game.nearMissFx.startedAt = nowMs;
  game.nearMissFx.durationMs = NEAR_MISS_FX.durationMs;
  game.nearMissFx.matchedReels = matchedReels.slice();
  game.nearMissFx.missReel = missReel;
  triggerReelFlash(missReel, 1.5);
  spawnNearMissParticles([...matchedReels, missReel], "resolve");
}

function stepNearMissTrail(dtMs) {
  if (!game.nearMissState.active || !game.running) return;
  const teaseReelIndex = game.plannedOutcome?.teaseReel;
  if (!Number.isInteger(teaseReelIndex) || teaseReelIndex < 0 || teaseReelIndex >= REELS) return;
  const reel = reels[teaseReelIndex];
  if (!reel || reel.phase === PHASE.IDLE) return;

  game.nearMissState.trailCarryMs += dtMs;
  const intervalMs = isMobile ? 74 : 56;
  while (game.nearMissState.trailCarryMs >= intervalMs) {
    game.nearMissState.trailCarryMs -= intervalMs;
    spawnNearMissParticles([teaseReelIndex], "trail");
  }
}

function stepNearMissFx(nowMs) {
  if (!game.nearMissFx.active) return;
  if ((nowMs - game.nearMissFx.startedAt) >= game.nearMissFx.durationMs) clearNearMissFx();
}

function getNearMissBuildFxState(nowMs) {
  if (!game.nearMissState.active || !game.running) return null;
  const elapsedMs = Math.max(0, nowMs - game.nearMissState.startedAt);
  const pulse = 0.5 + (0.5 * Math.sin((elapsedMs / 1000) * Math.PI * 2 * 6.8));
  const ramp = 0.76 + (0.24 * Math.min(1, elapsedMs / 460));
  return {
    fxType: "nearMissBuild",
    hitReels: game.nearMissState.matchedReels,
    dimOthers: 0.11 * ramp,
    lineFlash: 0.34 * ramp * (0.45 + (0.55 * pulse)),
    symbolGlow: 0.24 * ramp * (0.42 + (0.58 * pulse)),
    symbolPunch: 0.055 * pulse,
    globalFlash: 0.05 * ramp * pulse,
    shakePx: 0.46 * ramp * (0.5 + (0.5 * pulse)),
    missReel: -1,
    tier: "nearMiss",
  };
}

function getNearMissResolveFxState(nowMs) {
  if (!game.nearMissFx.active) return null;
  const elapsedMs = Math.max(0, nowMs - game.nearMissFx.startedAt);
  const t = clamp(elapsedMs / Math.max(1, game.nearMissFx.durationMs), 0, 1);
  const env = 1 - Math.pow(t, 0.72);
  const pulse = 0.5 + (0.5 * Math.sin((elapsedMs / 1000) * Math.PI * 2 * NEAR_MISS_FX.pulseHz));
  return {
    fxType: "nearMissResolve",
    hitReels: game.nearMissFx.matchedReels,
    dimOthers: NEAR_MISS_FX.dimOthers * env,
    lineFlash: NEAR_MISS_FX.lineAmp * env * (0.38 + (0.62 * pulse)),
    symbolGlow: NEAR_MISS_FX.symbolAmp * env * (0.38 + (0.62 * pulse)),
    symbolPunch: 0.05 * env * pulse,
    globalFlash: NEAR_MISS_FX.globalAmp * env * (0.35 + (0.65 * pulse)),
    shakePx: NEAR_MISS_FX.shakeAmp * env * (0.42 + (0.58 * pulse)),
    missReel: game.nearMissFx.missReel,
    tier: "nearMiss",
  };
}

function getWinFxState() {
  if (!game.fx.active) return null;
  const elapsedMs = Math.max(0, performance.now() - game.fx.startedAt);
  const t = clamp(elapsedMs / Math.max(1, game.fx.durationMs), 0, 1);
  const env = 1 - Math.pow(t, 0.82);
  const pulse = 0.5 + (0.5 * Math.sin((elapsedMs / 1000) * Math.PI * 2 * game.fx.pulseHz));
  const beat = Math.max(0, Math.sin(Math.PI * game.fx.pulseCount * t));
  let lineFlash = game.fx.lineAmp * env * (0.45 + (0.55 * pulse));
  let symbolGlow = game.fx.symbolAmp * env * (0.38 + (0.62 * pulse));
  let symbolPunch = game.fx.symbolAmp * env * beat;
  let globalFlash = game.fx.globalAmp * env * (0.42 + (0.58 * pulse));
  let shakePx = game.fx.shakeAmp * env * (0.5 + (0.5 * pulse));

  if (game.fx.tier === "three") {
    const strobe = Math.sin((elapsedMs / 1000) * Math.PI * 2 * 7.2);
    const gate = strobe > 0 ? 1 : 0.28;
    lineFlash *= 0.54 + (0.46 * gate);
    symbolGlow *= 0.62 + (0.38 * gate);
  } else if (game.fx.tier === "big") {
    symbolPunch *= 1.35;
    lineFlash *= 1.08;
    globalFlash *= 1.12;
    shakePx *= 1.08;
  }

  return {
    fxType: "win",
    tier: game.fx.tier,
    hitReels: game.fx.hitReels,
    dimOthers: game.fx.dimOthers * env,
    lineFlash,
    symbolGlow,
    symbolPunch,
    globalFlash,
    shakePx,
    missReel: -1,
  };
}

function updateButtons() {
  const live = isSystemLive();
  const canBetAdjust = live && !game.running && game.autoLeft <= 0;
  const canSpin = live && !game.running && game.credit >= currentBet() && game.autoLeft <= 0;
  const autoActive = game.autoLeft > 0;
  dom.betDownBtn.disabled = !canBetAdjust || game.betIndex <= 0;
  dom.betUpBtn.disabled = !canBetAdjust || game.betIndex >= (BET_LEVELS.length - 1);
  dom.spinBtn.disabled = !canSpin;
  dom.autoBtn.disabled = !live || (!autoActive && game.credit < currentBet());
  dom.autoBtn.setAttribute("aria-pressed", autoActive ? "true" : "false");
  dom.autoBtn.textContent = "AUTO";
  dom.resetBtn.disabled = !live || game.running;
}

function mountPaytable() {
  const frag = document.createDocumentFragment();

  for (const icon of symbols) {
    const row = document.createElement("tr");
    const payout = PAYOUT_TABLE[icon.name] || { two: 0, three: 0 };

    const nameCell = document.createElement("td");
    nameCell.className = "symbolCell";
    const iconCanvas = document.createElement("canvas");
    iconCanvas.width = 24;
    iconCanvas.height = 24;
    iconCanvas.className = "iconChip";
    const ic = iconCanvas.getContext("2d");
    ic.fillStyle = "#f2f3ee";
    ic.fillRect(0, 0, 24, 24);
    window.renderDropPitIconToCanvas(ic, icon, 1, 0);
    const label = document.createElement("span");
    label.textContent = icon.name.toUpperCase();
    nameCell.appendChild(iconCanvas);
    nameCell.appendChild(label);

    const twoCell = document.createElement("td");
    twoCell.textContent = formatMultiplier(payout.two);
    const threeCell = document.createElement("td");
    threeCell.textContent = formatMultiplier(payout.three);

    row.appendChild(nameCell);
    row.appendChild(twoCell);
    row.appendChild(threeCell);
    frag.appendChild(row);
  }

  dom.paytableBody.innerHTML = "";
  dom.paytableBody.appendChild(frag);
}

function resetReelToIdle(reel) {
  reel.phase = PHASE.IDLE;
  reel.phaseMs = 0;
  reel.speed = 0;
  reel.idealSpeed = 0;
  reel.leaveAtMs = -1;
  reel.nearMissBoostApplied = false;
  reel.tickCarry = 0;
  reel.nextTickSpacing = CELL * 0.52;
  reel.tickPrevPos = reel.pos;
  reel.tickJitter = 0;
  reel.tickJitterTarget = 0;
  reel.tickFrameCounter = 0;
}

function setReelPosForwardOnly(reel, nextPos, dt) {
  const prevPos = reel.pos;
  if (nextPos < prevPos) {
    reel.pos = prevPos;
    reel.speed = 0;
    return;
  }
  reel.pos = nextPos;
  reel.speed = (reel.pos - prevPos) / Math.max(0.0001, dt);
}

function computeLegacyBrakeTargetPos(reel) {
  const startCell = Math.ceil(reel.pos / CELL);
  const reqDist = (reel.speed * reel.speed) / (2 * Math.max(CELL * 1.2, reel.decel));
  const reqCells = Math.ceil(Math.max(CELL * 3, reqDist) / CELL);
  const extraCells = Math.max(2, Math.round(reel.cellsAhead * 0.3));
  const cells = clamp(reqCells + extraCells, 6, 12);
  let target = (startCell + cells) * CELL;
  if ((target - reel.pos) < (CELL * 2)) target += CELL * 2;
  return target;
}

function findSymbolStopPosAhead(reel, symbolId, minAheadCells = 6, preferredAheadCells = 11) {
  const stripLen = reel.strip.length;
  if (!stripLen) return null;
  const currentBase = Math.floor(reel.pos / CELL);
  const minAhead = Math.max(2, minAheadCells | 0);
  const maxAhead = minAhead + (stripLen * 3);
  const candidates = [];

  for (let step = minAhead; step <= maxAhead; step++) {
    const base = mod(currentBase + step, stripLen);
    const center = reel.strip[(base + 1) % stripLen];
    if (center !== symbolId) continue;
    candidates.push({
      step,
      pos: (currentBase + step) * CELL,
    });
    if (candidates.length >= 8) break;
  }

  if (!candidates.length) return null;
  const preferred = Math.max(minAhead, preferredAheadCells | 0);
  let best = candidates[0];
  let bestScore = Math.abs(best.step - preferred);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const score = Math.abs(c.step - preferred);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best.pos;
}

function computeOutcomeBrakeTargetPos(reel) {
  let minAheadCells = clamp(Math.round(reel.cellsAhead * 0.72), 6, 15);
  let preferredAheadCells = clamp(reel.cellsAhead + 2 + (reel.stopRank * 2), 9, 20);
  if (reel.teaseReel) {
    const stripLen = Math.max(1, reel.strip.length);
    const baseExtra = Math.round(stripLen * Math.max(0, reel.teaseExtraTurns || 0));
    const buildBoost = reel.nearMissBoostApplied ? Math.round(stripLen * 0.24) : 0;
    const extraCells = baseExtra + buildBoost;
    minAheadCells += extraCells;
    preferredAheadCells += extraCells + Math.round(stripLen * 0.08);
  }
  const target = findSymbolStopPosAhead(reel, reel.targetSymbolId, minAheadCells, preferredAheadCells);
  if (Number.isFinite(target)) return target;
  return computeLegacyBrakeTargetPos(reel);
}

function evalSettleOvershootPosition(reel, elapsedMs) {
  const t = Math.max(0, elapsedMs);
  const a = Math.max(1, reel.settleApproachMs);
  const b = Math.max(1, reel.settleOvershootMs);
  const h = Math.max(0, reel.settleHoldMs);
  const c = Math.max(1, reel.settleReturnMs);
  const start = reel.settleStartPos;
  const target = reel.targetPos;
  const peak = reel.settlePeakPos;

  if (t <= a) {
    return lerp(start, target, easeOutQuad(t / a));
  }

  if (t <= (a + b)) {
    return lerp(target, peak, easeInOutSine((t - a) / b));
  }

  if (t <= (a + b + h)) {
    const holdT = h <= 0 ? 1 : ((t - a - b) / h);
    const micro = reel.settleOvershootPx * 0.03 * Math.sin(Math.PI * holdT);
    return peak - micro;
  }

  if (t <= (a + b + h + c)) {
    return lerp(peak, target, smootherStep((t - a - b - h) / c));
  }

  return target;
}

function weightedPick(table, rng) {
  let total = 0;
  for (const it of table) total += Math.max(0, it.weight || 0);
  if (total <= 0) return table[0] || { type: "miss", weight: 1 };

  let x = rng() * total;
  for (const it of table) {
    x -= Math.max(0, it.weight || 0);
    if (x <= 0) return it;
  }
  return table[table.length - 1];
}

function payoutMultiplierForEntry(entry) {
  if (!entry || !entry.type) return 0;
  if (entry.type === "three") return PAYOUT_TABLE[entry.symbol]?.three || 0;
  if (entry.type === "two") return PAYOUT_TABLE[entry.symbol]?.two || 0;
  return 0;
}

function expectedMultiplier(table) {
  let totalW = 0;
  let totalP = 0;
  for (const e of table) {
    const w = Math.max(0, e.weight || 0);
    totalW += w;
    totalP += w * payoutMultiplierForEntry(e);
  }
  if (totalW <= 0) return 0;
  return totalP / totalW;
}

// mutates the copied table weights in-place to push expected RTP toward the target band.
function normalizeTableRtp(mutableTable, minTarget, maxTarget) {
  const miss = mutableTable.find((e) => e.type === "miss");
  if (!miss) return expectedMultiplier(mutableTable);

  const before = expectedMultiplier(mutableTable);
  if (before > maxTarget) {
    const over = (before - maxTarget) / Math.max(0.001, maxTarget);
    miss.weight *= 1 + Math.min(1.4, over * 2.4);
  } else if (before < minTarget) {
    const under = (minTarget - before) / Math.max(0.001, minTarget);
    miss.weight *= Math.max(0.45, 1 - Math.min(0.46, under * 1.3));
  }
  return expectedMultiplier(mutableTable);
}

function shuffleReels(rng) {
  const order = [0, 1, 2];
  for (let i = order.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function drawOutcome(rng, {
  betIndex,
  credit,
  bet,
  missStreak,
}) {
  const rescueMode = credit < (bet * 3) || missStreak >= 5;
  const table = OUTCOME_BASE_TABLE.map((base) => {
    let w = base.weight;
    if (base.symbol && PREMIUM_SYMBOLS.has(base.symbol)) w *= 1 + (betIndex * 0.17);
    if (rescueMode && base.type === "two") w *= 1.85;
    if (rescueMode && base.type === "three" && SAFE_SYMBOLS.has(base.symbol)) w *= 1.2;
    if (rescueMode && base.type === "miss") w *= 0.88;
    return { ...base, weight: Math.max(0.01, w) };
  });
  const expectedMul = normalizeTableRtp(table, RTP_TARGET_MIN, RTP_TARGET_MAX);

  const picked = weightedPick(table, rng);
  return {
    ...picked,
    rescueMode,
    expectedMul,
  };
}

function pickRandomSymbolId(rng) {
  return (rng() * symbols.length) | 0;
}

function pickDifferentSymbolId(baseId, rng) {
  if (symbols.length <= 1) return baseId;
  let id = baseId;
  let guard = 0;
  while (id === baseId && guard < 16) {
    id = pickRandomSymbolId(rng);
    guard += 1;
  }
  return id;
}

function pickThreeDistinctSymbolIds(rng) {
  if (symbols.length < 3) return [pickRandomSymbolId(rng), pickRandomSymbolId(rng), pickRandomSymbolId(rng)];
  const ids = symbols.map((_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return [ids[0], ids[1], ids[2]];
}

function resolveTargetSymbols(outcome, rng, missStreak) {
  const symbolId = outcome.symbol ? SYMBOL_ID_BY_NAME[outcome.symbol] : undefined;
  const fallback = pickRandomSymbolId(rng);
  const baseSymbolId = Number.isInteger(symbolId) ? symbolId : fallback;

  if (outcome.type === "three") {
    return {
      targetSymbolIds: [baseSymbolId, baseSymbolId, baseSymbolId],
      nearMiss: false,
      stopOrder: [0, 1, 2],
      teaseReel: -1,
    };
  }

  if (outcome.type === "two") {
    const roll = rng();
    const pair = roll < 0.55 ? [0, 1] : roll < 0.9 ? [1, 2] : [0, 2];
    const missId = pickDifferentSymbolId(baseSymbolId, rng);
    const targets = [missId, missId, missId];
    targets[pair[0]] = baseSymbolId;
    targets[pair[1]] = baseSymbolId;
    return {
      targetSymbolIds: targets,
      nearMiss: false,
      stopOrder: [0, 1, 2],
      teaseReel: pair.includes(2) ? 2 : -1,
    };
  }

  const nearMissBaseChance = 0.24 + Math.min(0.14, missStreak * 0.02);
  const nearMiss = rng() < nearMissBaseChance;
  if (nearMiss) {
    const teaseSymbol = rng() < 0.36
      ? (SYMBOL_ID_BY_NAME.seven ?? baseSymbolId)
      : rng() < 0.58
        ? (SYMBOL_ID_BY_NAME.diamond ?? baseSymbolId)
        : baseSymbolId;
    return {
      targetSymbolIds: [teaseSymbol, teaseSymbol, pickDifferentSymbolId(teaseSymbol, rng)],
      nearMiss: true,
      stopOrder: [0, 1, 2],
      teaseReel: 2,
    };
  }

  return {
    targetSymbolIds: pickThreeDistinctSymbolIds(rng),
    nearMiss: false,
    stopOrder: shuffleReels(rng),
    teaseReel: -1,
  };
}

function buildStopRankMap(stopOrder) {
  const stopRank = Array.from({ length: REELS }, () => 0);
  for (let rank = 0; rank < REELS; rank++) stopRank[stopOrder[rank]] = rank;
  return stopRank;
}

function buildReelPhysics(i, rank, rng, { nearMiss, teaseReel, outcomeType }) {
  const laneBias = 1 + (i * 0.04);
  const jitter = 1 + (((rng() * 2) - 1) * 0.11);
  const topSpeed = (CELL * (12 + (rng() * 7.4))) * laneBias * jitter;
  const spinupMs = 120 + (rng() * 150);
  let cruiseMs = (420 + (rng() * 240)) + (rank * (76 + (rng() * 92)));
  const cruiseLeaveAfterMs = 24 + (rng() * 170);
  let brakeMs = (620 + (rank * (98 + (rng() * 82))) + (rng() * 220));
  let minBrakeSpeed = CELL * (0.18 + (rng() * 0.16));
  let cellsAhead = 9 + (rank * 2) + ((rng() * 4) | 0);
  let teaseExtraTurns = 0;

  if (nearMiss && i === teaseReel) {
    teaseExtraTurns = lerp(
      NEAR_MISS_TEASE_PROFILE.extraTurnsMin,
      NEAR_MISS_TEASE_PROFILE.extraTurnsMax,
      rng(),
    );
    cruiseMs += 80 + (rng() * 80);
    brakeMs += 120 + (rng() * 90);
    minBrakeSpeed *= 0.82;
    cellsAhead += 2;
  } else if (outcomeType !== "miss" && i === 2) {
    cruiseMs += 86 + (rng() * 64);
    brakeMs += 72 + (rng() * 58);
  }
  const cruiseMinMs = Math.max(200, cruiseMs - (90 + (rng() * 130)));
  const cruiseMaxMs = cruiseMs + 200 + (rng() * 280);
  const brakeSec = Math.max(0.25, brakeMs / 1000);
  const decel = (topSpeed / brakeSec) * (0.88 + (rng() * 0.22));

  const spinupPulseAmp = CELL * (0.025 + (rng() * 0.08));
  const spinupPulseHz = 8 + (rng() * 8);
  const spinupKickAmp = CELL * (0.01 + (rng() * 0.05));
  const spinupKickHz = 4 + (rng() * 6);
  const spinupKickPhase = rng() * Math.PI * 2;

  const waveAmp = CELL * (0.018 + (rng() * 0.08));
  const waveHz = 5.6 + (rng() * 4.4);
  const wavePhase = rng() * Math.PI * 2;
  const wave2Amp = CELL * (0.01 + (rng() * 0.06));
  const wave2Hz = 9 + (rng() * 6.4);
  const wave2Phase = rng() * Math.PI * 2;
  const waveGateHz = 0.8 + (rng() * 1.6);
  const waveGatePhase = rng() * Math.PI * 2;
  const waveDriftAmp = CELL * (0.01 + (rng() * 0.04));
  const waveDriftHz = 1 + (rng() * 1.4);
  const waveDriftPhase = rng() * Math.PI * 2;

  const settleEntryWindow = CELL * (0.25 + (rng() * 0.18));
  const settleOvershootPx = CELL * (0.085 + (rng() * 0.055));
  const settleApproachBaseMs = 22 + (rng() * 24);
  const settleOvershootMs = 52 + (rng() * 24);
  const settleHoldMs = 8 + (rng() * 12);
  const settleReturnMs = 108 + (rng() * 48);

  return {
    topSpeed,
    spinupMs,
    cruiseMs,
    cruiseMinMs,
    cruiseMaxMs,
    cruiseLeaveAfterMs,
    brakeMs,
    decel,
    minBrakeSpeed,
    cellsAhead,
    spinupPulseAmp,
    spinupPulseHz,
    spinupKickAmp,
    spinupKickHz,
    spinupKickPhase,
    waveAmp,
    waveHz,
    wavePhase,
    wave2Amp,
    wave2Hz,
    wave2Phase,
    waveGateHz,
    waveGatePhase,
    waveDriftAmp,
    waveDriftHz,
    waveDriftPhase,
    brakeShape: 0.82 + (rng() * 0.55),
    brakeTail: 0.9 + (rng() * 0.22),
    settleEntryWindow,
    settleOvershootPx,
    settleApproachBaseMs,
    settleOvershootMs,
    settleHoldMs,
    settleReturnMs,
    settleMs: 96 + (rng() * 32),
    teaseExtraTurns,
  };
}

function buildSpinPlan(seed, spinCtx) {
  const rng = mulberry32(seed);
  const outcome = drawOutcome(rng, spinCtx);
  const resolved = resolveTargetSymbols(outcome, rng, spinCtx.missStreak);
  const stopOrder = resolved.stopOrder.slice();
  const stopRank = buildStopRankMap(stopOrder);

  const reelsPlan = Array.from({ length: REELS }, (_, i) => ({
    ...buildReelPhysics(i, stopRank[i], rng, {
      nearMiss: resolved.nearMiss,
      teaseReel: resolved.teaseReel,
      outcomeType: outcome.type,
    }),
    targetSymbolId: resolved.targetSymbolIds[i],
    stopRank: stopRank[i],
    teaseReel: resolved.teaseReel === i,
  }));

  return {
    reels: reelsPlan,
    outcome: {
      type: outcome.type,
      symbol: outcome.symbol || "",
      nearMiss: resolved.nearMiss,
      targetSymbolIds: resolved.targetSymbolIds.slice(),
      stopOrder: stopOrder.slice(),
      rescueMode: outcome.rescueMode,
      expectedMul: outcome.expectedMul || 0,
      teaseReel: resolved.teaseReel,
    },
  };
}

const PLAN_KEYS = Object.freeze([
  "topSpeed",
  "spinupMs",
  "cruiseMs",
  "cruiseMinMs",
  "cruiseMaxMs",
  "cruiseLeaveAfterMs",
  "brakeMs",
  "decel",
  "minBrakeSpeed",
  "cellsAhead",
  "spinupPulseAmp",
  "spinupPulseHz",
  "spinupKickAmp",
  "spinupKickHz",
  "spinupKickPhase",
  "waveAmp",
  "waveHz",
  "wavePhase",
  "wave2Amp",
  "wave2Hz",
  "wave2Phase",
  "waveGateHz",
  "waveGatePhase",
  "waveDriftAmp",
  "waveDriftHz",
  "waveDriftPhase",
  "brakeShape",
  "brakeTail",
  "settleEntryWindow",
  "settleOvershootPx",
  "settleApproachBaseMs",
  "settleOvershootMs",
  "settleHoldMs",
  "settleReturnMs",
  "settleMs",
  "teaseExtraTurns",
  "targetSymbolId",
  "stopRank",
]);

function applyPlanToReel(reel, p) {
  for (const key of PLAN_KEYS) reel[key] = p[key];
  reel.teaseReel = !!p.teaseReel;
  reel.nearMissBoostApplied = false;

  reel.phase = PHASE.SPINUP;
  reel.phaseMs = 0;
  reel.speed = 0;
  reel.idealSpeed = 0;
  reel.leaveAtMs = -1;
  reel.targetPos = reel.pos;
  reel.brakeStartSpeed = 0;
  reel.settleStartPos = reel.pos;
  reel.settlePeakPos = reel.pos;
  reel.settleApproachMs = reel.settleApproachBaseMs;
  reel.settleDurationMs = reel.settleMs;
  reel.tickCarry = 0;
  reel.nextTickSpacing = calcNextTickSpacing(reel);
  reel.tickPrevPos = reel.pos;
  reel.tickJitter = 0;
  reel.tickJitterTarget = 0;
  reel.tickFrameCounter = 0;
}

function enterBrake(reel) {
  reel.phase = PHASE.BRAKE;
  reel.phaseMs = 0;
  reel.leaveAtMs = -1;
  if (reel.teaseReel) {
    reel.brakeMs *= reel.nearMissBoostApplied ? 1.08 : 1.18;
    reel.decel *= 0.9;
    reel.minBrakeSpeed *= 0.82;
  }
  reel.brakeStartSpeed = Math.max(reel.minBrakeSpeed, reel.speed);
  reel.targetPos = computeOutcomeBrakeTargetPos(reel);
  sfxBrake(reel.i);
}

function enterSettle(reel) {
  reel.phase = PHASE.SETTLE;
  reel.phaseMs = 0;
  reel.pos = Math.min(reel.pos, reel.targetPos);
  reel.settleStartPos = reel.pos;
  const remain = Math.max(0, reel.targetPos - reel.settleStartPos);
  const entrySpeedNorm = clamp(reel.speed / (CELL * 5.8), 0, 1);
  const overshootBoost = lerp(1.18, 0.88, entrySpeedNorm);
  const visibleMinPx = CELL * 0.085;
  const overshootPx = clamp(
    Math.max(visibleMinPx, reel.settleOvershootPx * overshootBoost),
    CELL * 0.07,
    CELL * 0.17,
  );
  const approachTravelMs = (remain / Math.max(CELL * 3.4, reel.brakeStartSpeed * 0.34)) * 1000;
  reel.settleApproachMs = clamp(reel.settleApproachBaseMs + approachTravelMs, 24, 130);
  reel.settlePeakPos = reel.targetPos + overshootPx;
  reel.settleOvershootMs = Math.max(54, reel.settleOvershootMs);
  reel.settleHoldMs = Math.max(6, reel.settleHoldMs);
  reel.settleReturnMs = Math.max(110, reel.settleReturnMs);
  reel.settleDurationMs = clamp(
    Math.max(reel.settleMs, reel.settleApproachMs + reel.settleOvershootMs + reel.settleHoldMs + reel.settleReturnMs),
    180,
    620,
  );
  reel.speed = 0;
  reel.idealSpeed = 0;
}

function triggerReelFlash(reelIndex, amp = 1) {
  const f = game.reelFlashes[reelIndex];
  if (!f) return;
  f.active = true;
  f.startedAt = performance.now();
  f.durationMs = REEL_FLASH_PROFILE.durationMs;
  f.amp = clamp(amp, 0.55, 1.7);
}

function collectNearMissMatchedReels(symbolId) {
  const matched = [];
  for (let i = 0; i < REELS; i++) {
    if (reels[i].phase !== PHASE.IDLE) continue;
    if (centerSymbolIndex(reels[i]) === symbolId) matched.push(i);
  }
  return matched;
}

function maybeTriggerNearMissBuildFx() {
  const planned = game.plannedOutcome;
  if (!planned || !planned.nearMiss || game.nearMissState.buildTriggered) return;
  const symbolId = planned.targetSymbolIds?.[0];
  if (!Number.isInteger(symbolId)) return;
  const matched = collectNearMissMatchedReels(symbolId);
  if (matched.length < 2) return;
  startNearMissBuildFx(matched, symbolId, performance.now());
  sfxNearMissBuild();
}

function finalizeReelStop(reel) {
  reel.pos = Math.round(reel.targetPos / CELL) * CELL;
  sfxSettle();
  resetReelToIdle(reel);
  triggerReelFlash(reel.i, reel.teaseReel ? 1.28 : 1);
  maybeTriggerNearMissBuildFx();
}

function updateReel(reel, dt, dtMs) {
  if (reel.phase === PHASE.IDLE) return;

  if (reel.phase === PHASE.SPINUP) {
    reel.phaseMs += dtMs;
    const t = Math.min(1, reel.phaseMs / Math.max(1, reel.spinupMs));
    const sec = reel.phaseMs / 1000;
    const shaped = easeOutCubic(t);
    const pulse = Math.sin(sec * reel.spinupPulseHz) * reel.spinupPulseAmp * (1 - t);
    const kick = Math.sin((sec * reel.spinupKickHz) + reel.spinupKickPhase) * reel.spinupKickAmp * (1 - (t * t));
    const speed = Math.max(0, (reel.topSpeed * shaped) + pulse + kick);
    reel.idealSpeed = speed;
    setReelPosForwardOnly(reel, reel.pos + (speed * dt), dt);

    if (t >= 1) {
      reel.phase = PHASE.CRUISE;
      reel.phaseMs = 0;
    }
    return;
  }

  if (reel.phase === PHASE.CRUISE) {
    reel.phaseMs += dtMs;
    const sec = reel.phaseMs / 1000;
    const gate = 0.58 + (0.42 * Math.sin((sec * reel.waveGateHz) + reel.waveGatePhase));
    const waveA = Math.sin((sec * reel.waveHz) + reel.wavePhase) * reel.waveAmp * gate;
    const waveB = Math.sin((sec * reel.wave2Hz) + reel.wave2Phase) * reel.wave2Amp;
    const drift = Math.sin((sec * reel.waveDriftHz) + reel.waveDriftPhase) * reel.waveDriftAmp;
    const speed = clamp(reel.topSpeed + waveA + waveB + drift, reel.topSpeed * 0.62, reel.topSpeed * 1.34);
    reel.idealSpeed = reel.topSpeed;
    setReelPosForwardOnly(reel, reel.pos + (speed * dt), dt);

    const reachedStopSignal = reel.phaseMs >= reel.cruiseMs;
    const forceStop = reel.phaseMs >= reel.cruiseMaxMs;

    if (reachedStopSignal && reel.leaveAtMs < 0) {
      const wantedLeave = Math.max(reel.cruiseMinMs, reel.phaseMs + reel.cruiseLeaveAfterMs);
      reel.leaveAtMs = Math.min(reel.cruiseMaxMs, wantedLeave);
    }

    if (forceStop && reel.leaveAtMs < 0) reel.leaveAtMs = reel.phaseMs;
    if (reel.leaveAtMs >= 0 && reel.phaseMs >= reel.leaveAtMs) enterBrake(reel);
    return;
  }

  if (reel.phase === PHASE.BRAKE) {
    reel.phaseMs += dtMs;
    const remain = reel.targetPos - reel.pos;
    if (remain <= Math.max(0.2, reel.settleEntryWindow)) {
      enterSettle(reel);
      return;
    }

    const t = clamp(reel.phaseMs / Math.max(1, reel.brakeMs), 0, 1.6);
    const t01 = clamp(t, 0, 1);
    const shapedT = Math.pow(t01, reel.brakeShape);
    const decelScale = lerp(0.10, 0.36, shapedT);
    const floorSpeed = lerp(CELL * 0.08, CELL * 0.02, Math.min(1, shapedT * shapedT));
    const idealFromDistance = Math.sqrt(Math.max(0, 2 * reel.decel * remain));
    const maxBrakeMs = Math.max(1400, reel.brakeMs * 1.7);

    const prevSpeed = Math.max(reel.speed, floorSpeed);
    let nextSpeed = prevSpeed - (reel.decel * decelScale * dt);
    nextSpeed = Math.max(floorSpeed, nextSpeed);
    nextSpeed = Math.min(nextSpeed, idealFromDistance * 1.06);
    nextSpeed = Math.min(nextSpeed, remain / Math.max(0.0001, dt));
    nextSpeed = Math.max(0, nextSpeed);

    const remainMs = Math.max(120, maxBrakeMs - reel.phaseMs);
    const speedToFinish = remain / (remainMs / 1000);
    const rescueSpeed = Math.min(speedToFinish * (0.88 + (0.08 * reel.brakeTail)), prevSpeed * (1.02 + (0.06 * reel.brakeTail)));
    nextSpeed = Math.max(nextSpeed, rescueSpeed);

    reel.idealSpeed = Math.min(reel.brakeStartSpeed, idealFromDistance);
    setReelPosForwardOnly(reel, reel.pos + (nextSpeed * dt), dt);

    if (reel.pos >= (reel.targetPos - Math.max(0.2, reel.settleEntryWindow)) || reel.phaseMs >= maxBrakeMs) {
      enterSettle(reel);
    }
    return;
  }

  if (reel.phase === PHASE.SETTLE) {
    reel.phaseMs += dtMs;
    const durationMs = Math.max(24, reel.settleDurationMs || reel.settleMs);
    const prevPos = reel.pos;
    reel.pos = evalSettleOvershootPosition(reel, reel.phaseMs);
    reel.speed = (reel.pos - prevPos) / Math.max(0.0001, dt);
    reel.idealSpeed = Math.abs(reel.targetPos - reel.pos) / Math.max(0.016, (durationMs - reel.phaseMs) / 1000);

    if (reel.phaseMs >= durationMs || Math.abs(reel.targetPos - reel.pos) <= 0.05) {
      finalizeReelStop(reel);
    }
    return;
  }
}

function makePaylineResult(overrides = {}) {
  return {
    win: 0,
    label: "NO HIT",
    tone: "neutral",
    matchCount: 0,
    matchName: "",
    hitReels: [],
    tier: "none",
    ...overrides,
  };
}

function evaluatePaylineResult(centerSymbolIds, bet) {
  const names = centerSymbolIds.map((id) => symbols[id].name);
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);

  for (const [name, count] of counts) {
    if (count !== 3) continue;
    const m = PAYOUT_TABLE[name]?.three || 0;
    const win = Math.round(bet * m);
    return makePaylineResult({
      win,
      label: `${name.toUpperCase()} x3  (${formatMultiplier(m)})`,
      tone: "win",
      matchCount: 3,
      matchName: name,
      hitReels: [0, 1, 2],
      tier: win >= (bet * 20) ? "big" : "three",
    });
  }

  for (const [name, count] of counts) {
    if (count !== 2) continue;
    const m = PAYOUT_TABLE[name]?.two || 0;
    const win = Math.round(bet * m);
    if (win <= 0) return makePaylineResult();
    return makePaylineResult({
      win,
      label: `${name.toUpperCase()} x2  (${formatMultiplier(m)})`,
      tone: "win",
      matchCount: 2,
      matchName: name,
      hitReels: names.map((n, i) => (n === name ? i : -1)).filter((i) => i >= 0),
      tier: win >= (bet * 20) ? "big" : "two",
    });
  }

  return makePaylineResult();
}

function getReelFlashStrength(reelIndex, nowMs) {
  const f = game.reelFlashes[reelIndex];
  if (!f || !f.active) return 0;
  const t = clamp((nowMs - f.startedAt) / Math.max(1, f.durationMs), 0, 1);
  if (t >= 1) {
    f.active = false;
    return 0;
  }
  const env = 1 - Math.pow(t, 0.72);
  const pulse = 0.62 + (0.38 * Math.sin((t * Math.PI * 3.4) + 0.3));
  return clamp(env * pulse * f.amp, 0, 1.4);
}

function computeReelGeometry(reel, reelIndex) {
  const x = layout.offsetX + reelIndex * (layout.reelW + layout.gap);
  const y = layout.offsetY;
  const stripLen = reel.strip.length;
  const baseCell = getReelBaseCell(reel);
  const offsetRatio = (reel.pos - (baseCell * CELL)) / CELL;
  const base = mod(baseCell, stripLen);
  const startY = y - ((1 - VISIBLE_TOP_FRAC) * layout.drawCell);
  const topH = VISIBLE_TOP_FRAC * layout.drawCell;
  const centerY = y + topH;
  const bottomY = centerY + layout.drawCell;
  return {
    x,
    y,
    stripLen,
    base,
    offsetRatio,
    startY,
    topH,
    centerY,
    bottomY,
  };
}

function drawReelSymbols(reel, g, iconSet) {
  ctx.fillStyle = "#ecece2";
  ctx.fillRect(g.x, g.y, layout.reelW, layout.reelH);

  for (let row = -1; row <= 4; row++) {
    const idx = reel.strip[(g.base + row + g.stripLen) % g.stripLen];
    const iconCanvas = iconSet[idx];
    const dy = g.startY + ((row - g.offsetRatio) * layout.drawCell);
    ctx.drawImage(iconCanvas, g.x + layout.reelPad, dy);
  }
}

function drawReelWinFx(reel, reelIndex, g, iconSet, fxState) {
  if (!fxState || !fxState.hitReels || !fxState.hitReels.length) return;
  const isHit = fxState.hitReels.includes(reelIndex);
  if (!isHit && fxState.dimOthers > 0) {
    ctx.fillStyle = `rgba(22,22,18,${fxState.dimOthers.toFixed(3)})`;
    ctx.fillRect(g.x, g.y, layout.reelW, layout.reelH);
    return;
  }
  if (!isHit) return;

  const centerIdx = reel.strip[(g.base + 1 + g.stripLen) % g.stripLen];
  const centerIcon = iconSet[centerIdx];
  const bigWinPunch = fxState.fxType === "win" && fxState.tier === "big";
  const punchScale = 1 + ((bigWinPunch ? 0.38 : 0.11) * fxState.symbolPunch);
  const punchW = layout.drawCell * punchScale;
  const punchH = layout.drawCell * punchScale;
  const punchX = g.x + layout.reelPad - ((punchW - layout.drawCell) * 0.5);
  const punchY = g.centerY - ((punchH - layout.drawCell) * 0.5);
  ctx.drawImage(centerIcon, punchX, punchY, punchW, punchH);

  const glow = ctx.createLinearGradient(g.x, g.centerY, g.x, g.centerY + layout.drawCell);
  const glowA = clamp(0.1 + fxState.symbolGlow, 0, 0.5);
  glow.addColorStop(0, `rgba(255,248,214,${glowA.toFixed(3)})`);
  glow.addColorStop(0.62, `rgba(255,233,162,${(glowA * 0.78).toFixed(3)})`);
  glow.addColorStop(1, `rgba(90,64,24,${(glowA * 0.5).toFixed(3)})`);
  ctx.fillStyle = glow;
  ctx.fillRect(g.x + 1, g.centerY + 1, layout.reelW - 2, layout.drawCell - 2);

  ctx.strokeStyle = `rgba(255,244,196,${clamp(0.2 + (fxState.symbolGlow * 1.7), 0, 0.84).toFixed(3)})`;
  ctx.lineWidth = Math.max(1.3, layout.drawCell * 0.024);
  ctx.strokeRect(g.x + 2, g.centerY + 2, layout.reelW - 4, layout.drawCell - 4);
}

function drawReelFlash(reelIndex, g, nowMs) {
  const reelFlash = getReelFlashStrength(reelIndex, nowMs);
  if (reelFlash <= 0.01) return;
  const flashA = clamp(0.12 + (0.34 * reelFlash), 0, 0.56);
  const flash = ctx.createLinearGradient(g.x, g.centerY, g.x, g.centerY + layout.drawCell);
  flash.addColorStop(0, `rgba(255,251,230,${flashA.toFixed(3)})`);
  flash.addColorStop(0.72, `rgba(255,236,168,${(flashA * 0.58).toFixed(3)})`);
  flash.addColorStop(1, `rgba(120,82,24,${(flashA * 0.24).toFixed(3)})`);
  ctx.fillStyle = flash;
  ctx.fillRect(g.x + 1, g.centerY + 1, layout.reelW - 2, layout.drawCell - 2);

  ctx.strokeStyle = `rgba(255,244,196,${clamp(0.18 + (reelFlash * 0.5), 0, 0.74).toFixed(3)})`;
  ctx.lineWidth = Math.max(1.1, layout.drawCell * 0.018);
  ctx.strokeRect(g.x + 2, g.centerY + 2, layout.reelW - 4, layout.drawCell - 4);
}

function drawReelOverlays(g, reelIndex, fxState) {
  const canUseStableCache = !fxState || fxState.shakePx <= 0.01;
  const overlays = canUseStableCache
    ? reelOverlayCache.stable[reelIndex]
    : createReelOverlayGradients(g.x, g.y, g.centerY, g.bottomY, Math.max(5, Math.round(layout.drawCell * 0.11)));

  if (!overlays) return;
  ctx.fillStyle = overlays.gTop;
  ctx.fillRect(g.x, g.y, layout.reelW, g.topH);

  ctx.fillStyle = overlays.gBottom;
  ctx.fillRect(g.x, g.bottomY, layout.reelW, (g.y + layout.reelH) - g.bottomY);

  ctx.fillStyle = overlays.gLeft;
  ctx.fillRect(g.x, g.y, overlays.sideW, layout.reelH);

  ctx.fillStyle = overlays.gRight;
  ctx.fillRect(g.x + layout.reelW - overlays.sideW, g.y, overlays.sideW, layout.reelH);

  ctx.fillStyle = overlays.glass;
  ctx.fillRect(g.x + 1, g.centerY + 1, layout.reelW - 2, layout.drawCell - 2);
}

function drawReelSettleGlow(reel, g) {
  if (reel.phase !== PHASE.SETTLE) return;
  const overDist = Math.max(1, reel.settlePeakPos - reel.targetPos);
  const settleEnergy = clamp(Math.abs(reel.pos - reel.targetPos) / overDist, 0, 1);
  const pulse = 0.55 + (0.45 * Math.sin((reel.phaseMs / 1000) * 18));
  const fx = clamp((0.2 + (0.56 * settleEnergy)) * pulse, 0.08, 0.9);

  const settleGlow = ctx.createLinearGradient(g.x, g.centerY, g.x, g.centerY + layout.drawCell);
  settleGlow.addColorStop(0, `rgba(255,248,214,${(0.1 + (0.34 * fx)).toFixed(3)})`);
  settleGlow.addColorStop(0.55, `rgba(255,232,168,${(0.08 + (0.26 * fx)).toFixed(3)})`);
  settleGlow.addColorStop(1, `rgba(88,62,26,${(0.05 + (0.16 * fx)).toFixed(3)})`);
  ctx.fillStyle = settleGlow;
  ctx.fillRect(g.x + 1, g.centerY + 1, layout.reelW - 2, layout.drawCell - 2);

  ctx.strokeStyle = `rgba(255,243,198,${(0.38 + (0.56 * fx)).toFixed(3)})`;
  ctx.lineWidth = Math.max(1.2, layout.drawCell * 0.02);
  ctx.strokeRect(g.x + 2, g.centerY + 2, layout.reelW - 4, layout.drawCell - 4);
}

function drawReel(reel, reelIndex, iconSet, fxState, nowMs) {
  const g = computeReelGeometry(reel, reelIndex);

  ctx.save();
  if (fxState && fxState.fxType === "nearMissResolve" && fxState.missReel === reelIndex) {
    const shake = Math.sin((nowMs / 1000) * 45 + reelIndex) * Math.max(0, fxState.shakePx * 0.58);
    ctx.translate(shake, 0);
  }
  ctx.beginPath();
  ctx.rect(g.x, g.y, layout.reelW, layout.reelH);
  ctx.clip();

  drawReelSymbols(reel, g, iconSet);
  drawReelWinFx(reel, reelIndex, g, iconSet, fxState);
  drawReelFlash(reelIndex, g, nowMs);
  drawReelOverlays(g, reelIndex, fxState);
  drawReelSettleGlow(reel, g);

  ctx.restore();
  ctx.strokeStyle = "#8a8a80";
  ctx.lineWidth = Math.max(1.4, layout.drawCell * 0.025);
  ctx.strokeRect(g.x + 0.5, g.y + 0.5, layout.reelW - 1, layout.reelH - 1);
}

function drawFrame(force = false) {
  if (!force && !frameDirty) return;
  frameDirty = false;

  ctx.fillStyle = "#d7d7d1";
  ctx.fillRect(0, 0, layout.cssW, layout.cssH);

  const nowMs = performance.now();
  const winFxState = getWinFxState();
  const nearMissResolveState = winFxState ? null : getNearMissResolveFxState(nowMs);
  const nearMissBuildState = (winFxState || nearMissResolveState) ? null : getNearMissBuildFxState(nowMs);
  const fxState = winFxState || nearMissResolveState || nearMissBuildState;
  ctx.save();
  if (fxState && fxState.shakePx > 0) {
    const t = nowMs / 1000;
    ctx.translate(
      Math.sin(t * 46) * fxState.shakePx,
      Math.cos((t * 52) + 0.9) * fxState.shakePx * 0.45,
    );
  }

  const iconSet = getPrerendered(layout.drawScale);
  for (let i = 0; i < REELS; i++) drawReel(reels[i], i, iconSet, fxState, nowMs);

  const lineFlash = fxState ? fxState.lineFlash : 0;
  const lineAlpha = clamp(0.86 + (lineFlash * 0.2), 0.86, 1);
  ctx.strokeStyle = `rgba(47,47,40,${lineAlpha.toFixed(3)})`;
  ctx.lineWidth = Math.max(2.2, layout.drawCell * (0.04 + (lineFlash * 0.018)));
  ctx.beginPath();
  ctx.moveTo(layout.offsetX - 8, layout.centerLineY);
  ctx.lineTo(layout.offsetX + layout.machineW + 8, layout.centerLineY);
  ctx.stroke();
  if (lineFlash > 0.08) {
    ctx.strokeStyle = `rgba(255,241,178,${clamp(lineFlash * 0.8, 0, 0.88).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.4, layout.drawCell * 0.023);
    ctx.beginPath();
    ctx.moveTo(layout.offsetX - 6, layout.centerLineY);
    ctx.lineTo(layout.offsetX + layout.machineW + 6, layout.centerLineY);
    ctx.stroke();
  }
  ctx.restore();

  if (fxState && fxState.globalFlash > 0) {
    ctx.fillStyle = `rgba(255,238,172,${clamp(fxState.globalFlash * 0.5, 0, 0.2).toFixed(3)})`;
    ctx.fillRect(0, 0, layout.cssW, layout.cssH);
  }

  drawMatchEffects();
}

function startSpinAnimation() {
  game.seed = (Date.now() ^ (game.spins * 2654435761)) >>> 0;
  const planBundle = buildSpinPlan(game.seed, {
    betIndex: game.betIndex,
    credit: game.credit,
    bet: game.spinBet,
    missStreak: game.missStreak,
  });
  game.plannedOutcome = planBundle.outcome;
  for (let i = 0; i < REELS; i++) applyPlanToReel(reels[i], planBundle.reels[i]);
  game.running = true;
}

function requestSpin(auto = false) {
  if (!isSystemLive()) {
    setStatus("AWAITING SIGNAL.", "warn");
    return false;
  }
  if (game.running) return false;
  const bet = currentBet();
  if (game.credit < bet) {
    setStatus("NOT ENOUGH CREDIT FOR DROP.", "warn");
    sfxUiDeny();
    return false;
  }

  game.spinBet = bet;
  game.credit -= bet;
  game.spins += 1;
  game.totalBet += bet;
  game.lastWin = 0;
  game.displayLastWin = 0;
  game.winCountActive = false;
  game.floaters.length = 0;
  game.particles.length = 0;
  clearReelFlashes();
  clearNearMissState();
  clearNearMissFx();
  game.resolveDueAt = 0;
  game.fx.active = false;
  game.pendingResolve = true;
  sfxSpinStart();
  setStatus(auto ? `AUTO DRILL (${AUTO_SPIN_BATCH - game.autoLeft}/${AUTO_SPIN_BATCH})...` : "DESCENDING...");
  startSpinAnimation();
  updateHud();
  updateButtons();
  return true;
}

function resolveSpin() {
  const line = reels.map(centerSymbolIndex);
  const planned = game.plannedOutcome;
  if (planned && Array.isArray(planned.targetSymbolIds)) {
    const mismatch = planned.targetSymbolIds.some((id, i) => id !== line[i]);
    if (mismatch) {
      game.debugOutcomeMismatch += 1;
      console.warn("[spin] outcome mismatch", {
        seed: game.seed,
        planned: planned.targetSymbolIds,
        actual: line,
        mismatchCount: game.debugOutcomeMismatch,
      });
    }
  }

  const result = evaluatePaylineResult(line, game.spinBet);
  game.lastWin = result.win;
  game.credit += result.win;
  game.totalWin += result.win;
  if (result.win > 0) {
    clearNearMissState();
    clearNearMissFx();
    game.missStreak = 0;
    game.winStreak += 1;
    game.bestWin = Math.max(game.bestWin, result.win);
    const nowMs = performance.now();
    startWinFx(result, nowMs);
    startLastWinCount(result.win, result.tier, nowMs);
    spawnMatchEffects(result);
    sfxWin(result.win, result.tier);
    const mark = result.matchCount >= 3 ? "TRIPLE MATCH" : "MATCH";
    setStatus(`${mark} +${result.win}  // ${result.label}`, "win");
  } else {
    game.winStreak = 0;
    game.missStreak += 1;
    game.fx.active = false;
    game.displayLastWin = 0;
    game.winCountActive = false;
    if (planned && planned.nearMiss) {
      const nowMs = performance.now();
      const matchedReels = game.nearMissState.matchedReels.length
        ? game.nearMissState.matchedReels.slice()
        : [0, 1];
      const missReel = Number.isInteger(planned.teaseReel) ? planned.teaseReel : 2;
      startNearMissResolveFx(matchedReels, missReel, nowMs);
      sfxNearMissResolve();
      const symbol = (symbols[planned.targetSymbolIds[0]]?.name || "RELIC").toUpperCase();
      setStatus(`NEAR MISS // ${symbol} JUST SLIPPED`, "warn");
    } else if (game.missStreak >= 5) {
      clearNearMissFx();
      sfxDryDrop();
      setStatus(`DRY STREAK x${game.missStreak}. PRESSURE BUILDING.`, "warn");
    } else {
      clearNearMissFx();
      sfxDryDrop();
      setStatus("DRY DROP. RUN IT AGAIN.");
    }
    clearNearMissState();
  }
  recordSpinDiagnostics(result, planned);
  game.plannedOutcome = null;
}

function consumeAutoSpin(nowMs) {
  if (game.autoLeft <= 0 || game.running || game.pendingResolve) return;
  game.autoLeft -= 1;
  const ok = requestSpin(true);
  if (!ok) {
    game.autoLeft = 0;
    game.nextAutoAt = 0;
    updateButtons();
    return;
  }
  game.nextAutoAt = nowMs + 280;
}

function startAutoBatch() {
  if (!isSystemLive()) {
    setStatus("AWAITING SIGNAL.", "warn");
    return;
  }
  if (game.autoLeft > 0) return;
  game.autoLeft = AUTO_SPIN_BATCH;
  sfxAutoToggle(true);
  setStatus(`AUTO DRILL x${AUTO_SPIN_BATCH} ARMED.`);
  updateButtons();
}

function stopAutoBatch() {
  game.autoLeft = 0;
  game.nextAutoAt = 0;
  sfxAutoToggle(false);
  setStatus("AUTO DRILL HALTED.");
  updateButtons();
}

function resetSession() {
  if (game.running) {
    setStatus("REELS STILL DESCENDING.", "warn");
    return;
  }
  game.credit = START_CREDIT;
  game.spinBet = currentBet();
  game.spins = 0;
  game.totalBet = 0;
  game.totalWin = 0;
  game.lastWin = 0;
  game.displayLastWin = 0;
  game.winCountActive = false;
  clearReelFlashes();
  clearNearMissState();
  clearNearMissFx();
  game.floaters.length = 0;
  game.particles.length = 0;
  game.autoLeft = 0;
  game.nextAutoAt = 0;
  game.missStreak = 0;
  game.winStreak = 0;
  game.bestWin = 0;
  game.plannedOutcome = null;
  game.debugOutcomeMismatch = 0;
  Object.assign(game.stats, INITIAL_STATS);
  game.pendingResolve = false;
  game.resolveDueAt = 0;
  game.running = false;
  game.fx.active = false;
  hudShadow.credit = NaN;
  hudShadow.bet = NaN;
  hudShadow.lastWin = NaN;
  runLogShadow.depth = NaN;
  runLogShadow.net = NaN;
  runLogShadow.best = NaN;
  runLogShadow.hit = "";
  runLogShadow.yield = "";
  runLogShadow.streak = "";
  runLogShadow.netTone = "";
  runLogShadow.streakTone = "";
  stopMotor();

  for (const reel of reels) {
    reel.strip = makeStrip();
    reel.pos = ((Math.random() * reel.strip.length) | 0) * CELL;
    resetReelToIdle(reel);
  }

  setStatus(isSystemLive() ? "PIT RESET. ARM SPIN." : "AWAITING SIGNAL.");
  updateHud();
  updateButtons();
  markFrameDirty();
  drawFrame(true);
}

dom.betDownBtn.addEventListener("click", async () => {
  if (!isSystemLive()) {
    setStatus("AWAITING SIGNAL.", "warn");
    return;
  }
  await unlockAudioFromGesture();
  if (game.running || game.autoLeft > 0 || game.betIndex <= 0) return;
  game.betIndex -= 1;
  sfxBetAdjust(-1);
  updateHud();
  updateButtons();
});

dom.betUpBtn.addEventListener("click", async () => {
  if (!isSystemLive()) {
    setStatus("AWAITING SIGNAL.", "warn");
    return;
  }
  await unlockAudioFromGesture();
  if (game.running || game.autoLeft > 0 || game.betIndex >= (BET_LEVELS.length - 1)) return;
  game.betIndex += 1;
  sfxBetAdjust(1);
  updateHud();
  updateButtons();
});

dom.spinBtn.addEventListener("click", async () => {
  if (!isSystemLive()) {
    await triggerGameStartSignal();
    return;
  }
  const audioReady = await unlockAudioFromGesture();
  if (!audioReady) setStatus("AUDIO LOCKED. TAP TO UNSEAL SOUND.", "warn");
  requestSpin(false);
});

dom.autoBtn.addEventListener("click", async () => {
  if (!isSystemLive()) {
    setStatus("AWAITING SIGNAL.", "warn");
    return;
  }
  const audioReady = await unlockAudioFromGesture();
  if (!audioReady) setStatus("AUDIO LOCKED. TAP TO UNSEAL SOUND.", "warn");
  if (game.autoLeft > 0) {
    stopAutoBatch();
    return;
  }
  startAutoBatch();
});

dom.resetBtn.addEventListener("click", resetSession);
if (dom.startGameBtn) dom.startGameBtn.addEventListener("click", () => { void triggerGameStartSignal(); });

window.addEventListener("keydown", async (ev) => {
  if (ev.repeat) return;
  if (!isSystemLive() && (ev.code === "Space" || ev.code === "Enter")) {
    ev.preventDefault();
    await triggerGameStartSignal();
    return;
  }
  if (ev.code === "Space") {
    ev.preventDefault();
    const audioReady = await unlockAudioFromGesture();
    if (!audioReady) setStatus("AUDIO LOCKED. TAP TO UNSEAL SOUND.", "warn");
    requestSpin(false);
    return;
  }
  if (ev.code === "KeyA") {
    const audioReady = await unlockAudioFromGesture();
    if (!audioReady) setStatus("AUDIO LOCKED. TAP TO UNSEAL SOUND.", "warn");
    startAutoBatch();
    return;
  }
  if (ev.code === "KeyS") {
    stopAutoBatch();
  }
});

let lastFrame = performance.now();
function tick(now) {
  const dt = clamp((now - lastFrame) / 1000, 0.001, 0.033);
  const dtMs = dt * 1000;
  lastFrame = now;
  stepWinFx(now);
  stepNearMissFx(now);
  stepNearMissTrail(dtMs);
  stepMatchEffects(dtMs);
  if (stepLastWinCount(now)) updateHud();

  let moving = false;
  let speedSum = 0;
  let hasCruiseLike = false;
  let hasBrake = false;
  let hasSettle = false;
  for (const reel of reels) {
    updateReel(reel, dt, dtMs);
    stepReelTickSfx(reel);
    speedSum += Math.max(0, reel.speed);
    if (reel.phase === PHASE.SPINUP || reel.phase === PHASE.CRUISE) hasCruiseLike = true;
    else if (reel.phase === PHASE.BRAKE) hasBrake = true;
    else if (reel.phase === PHASE.SETTLE) hasSettle = true;
    if (reel.phase !== PHASE.IDLE) moving = true;
  }

  const wasRunning = game.running;
  game.running = moving;
  if (game.running) {
    const motorPhase = hasCruiseLike
      ? PHASE.CRUISE
      : hasBrake
        ? PHASE.BRAKE
        : hasSettle
          ? PHASE.SETTLE
          : PHASE.IDLE;
    audio.updateMotor({ avgSpeed: speedSum / REELS, phase: motorPhase });
  }

  if (wasRunning && !moving && game.pendingResolve) {
    stopMotor();
    if (game.resolveDueAt <= 0) {
      game.resolveDueAt = now + game.hitPauseMs;
      setStatus("LOCKING PAYLINE...");
    }
  }

  if (!game.running && game.pendingResolve && game.resolveDueAt > 0 && now >= game.resolveDueAt) {
    game.pendingResolve = false;
    game.resolveDueAt = 0;
    resolveSpin();
    updateHud();
    updateButtons();
    if (game.autoLeft > 0) game.nextAutoAt = now + 360;
  }

  if (!game.running && !game.pendingResolve && game.autoLeft > 0 && now >= game.nextAutoAt) {
    consumeAutoSpin(now);
  }

  const hasVisualActivity = game.running
    || game.pendingResolve
    || game.fx.active
    || game.nearMissFx.active
    || game.nearMissState.active
    || game.particles.length > 0
    || game.floaters.length > 0
    || game.winCountActive;
  if (hasVisualActivity) markFrameDirty();

  drawFrame();
  requestAnimationFrame(tick);
}

window.addEventListener("resize", () => {
  recomputeLayout();
  drawFrame(true);
});

mountPaytable();
recomputeLayout();
resetSession();
enterBootState();
requestAnimationFrame(tick);

