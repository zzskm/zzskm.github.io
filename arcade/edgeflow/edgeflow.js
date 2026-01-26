const { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } = React;
const h = React.createElement;

const COLS = 7;
const ROWS = 7;
const TYPES = 4;
const MIN_GROUP = 3;
const BOMB_THRESHOLD = 4;
const BOMB_RADIUS = 2;
const REMOVE_MS = 220;
const MOVE_MS = 160;
const MOVE_DELAY_MS = 0;
const LOCK_PAD = 24;
const SPAWN_MS = 140;
const HINT_MS = 700;
const REFILL_BONUS_MS = 400;
const POP_STAGGER_MS = 40;
const START_PLAYABLE_RATIO = 0.34;
const START_PLAYABLE_CELLS = Math.ceil(COLS * ROWS * START_PLAYABLE_RATIO);
const START_SHUFFLES = 18;

const TIME_LIMIT_MS = 30000;
const BLOCK_SCORE = 10;
const BOMB_CREATE_BONUS = 20;
const BOMB_DETONATE_BONUS = 10;

const FLOW_CHANGE_THRESHOLD = 1;

const DIRS = ["UP", "DOWN", "LEFT", "RIGHT"];

const now = () => Date.now();

function makeIdGen() {
  let n = 1;
  return () => n++;
}

function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function newTile(idGen, value, bomb = false) {
  return { id: idGen(), value, bomb };
}

function randomValue() {
  return ((Math.random() * TYPES) | 0) + 1;
}

function seedGrid(idGen) {
  const g = emptyGrid();
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let forbidA = 0;
      let forbidB = 0;
      if (x >= 2) {
        const v1 = g[y][x - 1]?.value ?? 0;
        const v2 = g[y][x - 2]?.value ?? 0;
        if (v1 === v2 && v1 !== 0) forbidA = v1;
      }
      if (y >= 2) {
        const v1 = g[y - 1][x]?.value ?? 0;
        const v2 = g[y - 2][x]?.value ?? 0;
        if (v1 === v2 && v1 !== 0) forbidB = v1;
      }

      let v;
      let guard = TYPES * 3;
      do {
        v = randomValue();
        guard -= 1;
        if (guard <= 0) break;
      } while (v === forbidA || v === forbidB);

      g[y][x] = newTile(idGen, v, false);
    }
  }
  return g;
}

function cloneGrid(g) {
  return g.map(row => row.slice());
}

function inBounds(x, y) {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

function groupAt(grid, sx, sy) {
  const start = grid[sy][sx];
  if (!start || start.bomb) return [];
  const t = start.value;

  const q = [[sx, sy]];
  const seen = new Set([`${sx},${sy}`]);
  const out = [];

  while (q.length) {
    const [x, y] = q.shift();
    const cell = grid[y][x];
    if (!cell || cell.bomb || cell.value !== t) continue;

    out.push({ x, y, id: cell.id });

    const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of nb) {
      if (!inBounds(nx, ny)) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      const c = grid[ny][nx];
      if (c && !c.bomb && c.value === t) {
        seen.add(k);
        q.push([nx, ny]);
      }
    }
  }

  return out;
}

function popDelayMs(origin, x, y) {
  if (!origin) return 0;
  return (Math.abs(x - origin.x) + Math.abs(y - origin.y)) * POP_STAGGER_MS;
}

function maxPopDelay(origin, positions) {
  if (!origin || !positions.length) return 0;
  let max = 0;
  for (const pos of positions) {
    const delay = popDelayMs(origin, pos.x, pos.y);
    if (delay > max) max = delay;
  }
  return max;
}

function collectTiles(grid) {
  const tiles = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y][x];
      if (c) tiles.push({ id: c.id, value: c.value, bomb: c.bomb, x, y });
    }
  }
  return tiles;
}

function computeGravity(grid, current) {
  const votes = { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 };
  let anyEmpty = false;

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (grid[y][x]) continue;
      anyEmpty = true;

      const distUp = y;
      const distDown = (ROWS - 1) - y;
      const distLeft = x;
      const distRight = (COLS - 1) - x;

      const min = Math.min(distUp, distDown, distLeft, distRight);
      if (distUp === min) votes.UP += 1;
      if (distDown === min) votes.DOWN += 1;
      if (distLeft === min) votes.LEFT += 1;
      if (distRight === min) votes.RIGHT += 1;
    }
  }

  if (!anyEmpty) return current;

  let best = current;
  let bestVotes = votes[current] ?? 0;
  for (const dir of DIRS) {
    if (votes[dir] > bestVotes) {
      best = dir;
      bestVotes = votes[dir];
    }
  }

  const curVotes = votes[current] ?? 0;
  if (best === current) return current;
  if (bestVotes - curVotes < FLOW_CHANGE_THRESHOLD) return current;
  return best;
}

function applyGravity(grid, dir) {
  const g = emptyGrid();
  let moved = false;

  const vertical = dir === "UP" || dir === "DOWN";
  const towardStart = dir === "UP" || dir === "LEFT";

  const maxAxis = vertical ? ROWS : COLS;
  const fixedMax = vertical ? COLS : ROWS;

  for (let fixed = 0; fixed < fixedMax; fixed++) {
    let write = towardStart ? 0 : (maxAxis - 1);
    let read = towardStart ? 0 : (maxAxis - 1);
    const step = towardStart ? 1 : -1;

    while (read >= 0 && read < maxAxis) {
      const x = vertical ? fixed : read;
      const y = vertical ? read : fixed;
      const cell = grid[y][x];
      if (cell) {
        const wx = vertical ? fixed : write;
        const wy = vertical ? write : fixed;
        if (write !== read) moved = true;
        g[wy][wx] = cell;
        write += step;
      }
      read += step;
    }
  }

  return { grid: g, moved };
}

function fillEmpties(grid, idGen) {
  const g = cloneGrid(grid);
  const spawnIds = new Set();
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!g[y][x]) {
        const tile = newTile(idGen, randomValue(), false);
        g[y][x] = tile;
        spawnIds.add(tile.id);
      }
    }
  }
  return { grid: g, spawnIds };
}

function hasAvailableMoves(grid) {
  const seen = new Set();

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = grid[y][x];
      if (!cell) continue;
      if (cell.bomb) return true;

      const key = `${x},${y}`;
      if (seen.has(key)) continue;

      const group = groupAt(grid, x, y);
      for (const p of group) seen.add(`${p.x},${p.y}`);
      if (group.length >= MIN_GROUP) return true;
    }
  }

  return false;
}

function countPlayableCells(grid) {
  const seen = new Set();
  let count = 0;

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = grid[y][x];
      if (!cell || cell.bomb) continue;
      const key = `${x},${y}`;
      if (seen.has(key)) continue;

      const group = groupAt(grid, x, y);
      for (const p of group) seen.add(`${p.x},${p.y}`);
      if (group.length >= MIN_GROUP) count += group.length;
    }
  }

  return count;
}

function shuffleGrid(grid) {
  const g = cloneGrid(grid);
  const tiles = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = g[y][x];
      if (cell) tiles.push(cell);
    }
  }
  const values = tiles.map(t => ({ value: t.value, bomb: t.bomb }));
  for (let i = values.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [values[i], values[j]] = [values[j], values[i]];
  }
  for (let i = 0; i < tiles.length; i++) {
    tiles[i].value = values[i].value;
    tiles[i].bomb = values[i].bomb;
  }
  return g;
}

function ensurePlayable(grid, maxShuffles = 12) {
  let g = grid;
  let guard = maxShuffles;
  while (guard > 0 && !hasAvailableMoves(g)) {
    g = shuffleGrid(g);
    guard -= 1;
  }
  return g;
}

function ensurePlayableArea(grid, minCells, maxShuffles = START_SHUFFLES) {
  let g = ensurePlayable(grid, maxShuffles);
  let guard = maxShuffles;

  while (guard > 0) {
    if (hasAvailableMoves(g) && countPlayableCells(g) >= minCells) return g;
    g = shuffleGrid(g);
    guard -= 1;
  }

  if (!hasAvailableMoves(g)) {
    g = ensurePlayable(g, maxShuffles);
  }
  return g;
}

function initState(idGen) {
  const seeded = seedGrid(idGen);
  const playable = ensurePlayableArea(seeded, START_PLAYABLE_CELLS);
  return {
    grid: playable,
    gravity: "DOWN",
    score: 0,
    timeLeftMs: TIME_LIMIT_MS,
    gameStarted: false,
    gameOver: false,
    paused: false,
    locked: false,
    logText: "READY — CLEAR 3+ TO PULL FLOW",
  };
}

function reducer(state, action) {
  switch (action.type) {
    case "RESET":
      return {
        ...initState(action.idGen),
        gameStarted: true,
        logText: "FLOW ONLINE — CLEAR 3+",
      };
    case "PATCH":
      return { ...state, ...action.patch };
    case "SET_GRID":
      return { ...state, grid: action.grid };
    case "SET_GRAVITY":
      return { ...state, gravity: action.gravity };
    case "SET_TIME":
      return { ...state, timeLeftMs: action.timeLeftMs };
    case "ADD_SCORE":
      return { ...state, score: state.score + action.delta };
    default:
      return state;
  }
}

function App() {
  const idGenRef = useRef(null);
  if (!idGenRef.current) idGenRef.current = makeIdGen();

  const [state, dispatch] = useReducer(reducer, null, () => initState(idGenRef.current));
  const {
    grid,
    gravity,
    score,
    timeLeftMs,
    gameStarted,
    gameOver,
    paused,
    locked,
    logText,
  } = state;

  const [hoverGroup, setHoverGroup] = useState([]);
  const [removingIds, setRemovingIds] = useState(new Set());
  const [removeOrigin, setRemoveOrigin] = useState(null);
  const [spawningIds, setSpawningIds] = useState(new Set());
  const [shuffling, setShuffling] = useState(false);
  const [shiftAnimating, setShiftAnimating] = useState(false);
  const [resetId, setResetId] = useState(0);

  const wrapRef = useRef(null);
  const boardRef = useRef(null);
  const tileLayerRef = useRef(null);
  const [geom, setGeom] = useState({ cell: 28, gap: 5 });

  const timeRef = useRef(now());
  const timeLeftRef = useRef(TIME_LIMIT_MS);
  const removalTimerRef = useRef(null);
  const shiftTimerRef = useRef(null);
  const spawnTimerRef = useRef(null);
  const shuffleTimerRef = useRef(null);
  const audioRef = useRef(null);
  const audioEnabledRef = useRef(false);
  const lastSfxAtRef = useRef(0);
  const lastStartSfxRef = useRef(0);

  // Cancels any in-flight resolution (shift/spawn), preventing race conditions across frames.
  const resolutionIdRef = useRef(0);

  const cancelResolution = () => {
    resolutionIdRef.current += 1;
    clearTimers();
  };

  const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise(r => window.setTimeout(r, ms));

  const waitShiftTransitionEndOrTimeout = async (rid) => {
    // Prefer transitionend (bubbles from tiles) with a timeout fallback.
    const el = tileLayerRef.current;
    const timeoutMs = Math.max(0, MOVE_MS + 80);

    if (!el) {
      await sleep(timeoutMs);
      return;
    }

    await Promise.race([
      new Promise(resolve => {
        const onEnd = (e) => {
          if (e?.propertyName && e.propertyName !== "transform") return;
          el.removeEventListener("transitionend", onEnd);
          resolve();
        };
        el.addEventListener("transitionend", onEnd, { passive: true });
      }),
      sleep(timeoutMs),
    ]);

    if (resolutionIdRef.current !== rid) return;
  };
  
const getTileScale = () => {
  const b = boardRef.current;
  if (!b) return 0.98;
  const v = parseFloat(window.getComputedStyle(b).getPropertyValue("--tile-scale"));
  return Number.isFinite(v) && v > 0 ? v : 0.98;
};

const animateShiftWAAPI = async (prevGrid, nextGrid, rid, dir) => {
  const layer = tileLayerRef.current;
  if (!layer) return;

  const step = geom.cell + geom.gap;
  const scale = getTileScale();

  const prevPos = new Map();
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = prevGrid[y][x];
      if (c) prevPos.set(c.id, { tx: x * step, ty: y * step });
    }
  }

  const nextPos = new Map();
  let movedCount = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = nextGrid[y][x];
      if (!c) continue;
      const tx = x * step;
      const ty = y * step;
      nextPos.set(c.id, { tx, ty });
      const p = prevPos.get(c.id);
      if (p && (p.tx !== tx || p.ty !== ty)) movedCount += 1;
    }
  }

  if (movedCount === 0) return;

  // Let React commit "next" positions first, then animate from previous -> next.
  await nextFrame();
  if (resolutionIdRef.current !== rid) return;

  const animations = [];
  for (const [id, to] of nextPos.entries()) {
    const from = prevPos.get(id);
    if (!from) continue;
    if (from.tx === to.tx && from.ty === to.ty) continue;

    const el = layer.querySelector(`.tile[data-id="${id}"]`);
    if (!el) continue;

    const fromT = `translate(${from.tx}px, ${from.ty}px) scale(${scale})`;
    const toT = `translate(${to.tx}px, ${to.ty}px) scale(${scale})`;

    const anim = el.animate(
      [{ transform: fromT }, { transform: toT }],
      { duration: MOVE_MS, easing: "ease-out", fill: "both" }
    );

    animations.push(
      anim.finished
        .catch(() => {})
        .then(() => {
          // Remove WAAPI override; underlying CSS vars already reflect the "to" position.
          try { anim.cancel(); } catch (_) {}
        })
    );
  }

  await Promise.allSettled(animations);
};

  const hintTimerRef = useRef(null);

  const getAudioCtx = () => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioRef.current) audioRef.current = new AudioCtx();
    return audioRef.current;
  };

  const unlockAudio = () => {
    const ctx = getAudioCtx();
    if (!ctx) return Promise.resolve(null);
    const warmUp = () => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
      audioEnabledRef.current = true;
      return ctx;
    };
    if (ctx.state === "suspended") {
      return ctx.resume().then(() => warmUp()).catch(() => null);
    }
    return Promise.resolve(warmUp());
  };

  const playTone = (ctx, freq, duration, type, offset, gain) => {
    const start = ctx.currentTime + offset;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    amp.gain.setValueAtTime(gain, start);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration);
  };

  const playSfx = (kind) => {
    if (!audioEnabledRef.current) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t = now();
    if (t - lastSfxAtRef.current < 40) return;
    lastSfxAtRef.current = t;
    const baseGain = 0.035;
    if (kind === "hit") {
      playTone(ctx, 880, 0.05, "square", 0, baseGain);
      playTone(ctx, 1320, 0.05, "square", 0.06, baseGain * 0.8);
      return;
    }
    if (kind === "miss") {
      playTone(ctx, 220, 0.09, "square", 0, baseGain * 0.9);
      playTone(ctx, 180, 0.09, "square", 0.09, baseGain * 0.7);
      return;
    }
    if (kind === "bomb_spawn") {
      playTone(ctx, 620, 0.05, "square", 0, baseGain * 0.8);
      playTone(ctx, 840, 0.06, "square", 0.05, baseGain * 0.65);
      return;
    }
    if (kind === "bomb_detonate") {
      const g = baseGain * 1.15;
      playTone(ctx, 420, 0.06, "triangle", 0, g);
      playTone(ctx, 210, 0.1, "square", 0.04, g * 0.95);
      playTone(ctx, 130, 0.14, "square", 0.1, g * 0.8);
      playTone(ctx, 92, 0.18, "square", 0.14, g * 0.7);
      return;
    }
    if (kind === "shuffle") {
      const rise = [0, 4, 7, 12, 19];
      const base = 520;
      const spacing = 0.03;
      rise.forEach((step, i) => {
        const freq = base * Math.pow(2, step / 12);
        playTone(ctx, freq, 0.05, "square", i * spacing, baseGain * 0.55);
      });
      playTone(ctx, base * 2, 0.06, "square", rise.length * spacing + 0.02, baseGain * 0.45);
      return;
    }
    if (kind === "gameover") {
      const g = baseGain * 1.15;
      playTone(ctx, 196, 0.26, "triangle", 0, g);
      playTone(ctx, 174, 0.3, "triangle", 0.12, g * 0.9);
      playTone(ctx, 146, 0.34, "triangle", 0.24, g * 0.85);
      playTone(ctx, 110, 0.48, "square", 0.18, g * 0.55);
      playTone(ctx, 98, 0.52, "square", 0.3, g * 0.45);
    }
  };

  const playStartSfx = () => {
    const t = now();
    if (t - lastStartSfxRef.current < 400) return;
    lastStartSfxRef.current = t;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const tempo = 168;
    const step = 60 / tempo / 4;
    const leadGain = 0.032;
    const bassGain = 0.022;
    const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
    const lead = [
      { m: 64, s: 0, d: 1 },
      { m: 67, s: 1, d: 1 },
      { m: 69, s: 2, d: 1 },
      { m: 71, s: 3, d: 1 },
      { m: 74, s: 4, d: 2 },
      { m: 71, s: 6, d: 2 },
      { m: 69, s: 8, d: 2 },
      { m: 67, s: 10, d: 2 },
      { m: 64, s: 12, d: 4 },
    ];
    const bass = [
      { m: 40, s: 0, d: 4 },
      { m: 47, s: 8, d: 4 },
      { m: 40, s: 16, d: 4 },
    ];

    lead.forEach((note) => {
      const freq = midiToFreq(note.m);
      const duration = step * note.d * 0.92;
      const offset = step * note.s;
      playTone(ctx, freq, duration, "square", offset, leadGain);
      playTone(ctx, freq * 1.004, duration * 0.88, "square", offset + 0.002, leadGain * 0.45);
    });

    bass.forEach((note) => {
      const freq = midiToFreq(note.m);
      const duration = step * note.d * 0.95;
      playTone(ctx, freq, duration, "triangle", step * note.s, bassGain);
    });
  };

  const setLog = (msg) => {
    dispatch({ type: "PATCH", patch: { logText: msg } });
  };

  const addTimeBonus = (deltaMs) => {
    if (!gameStarted || gameOver) return;
    const next = Math.min(TIME_LIMIT_MS, timeLeftRef.current + deltaMs);
    if (next === timeLeftRef.current) return;
    timeLeftRef.current = next;
    dispatch({ type: "SET_TIME", timeLeftMs: next });
  };

  const clearTimers = () => {
    if (removalTimerRef.current) {
      clearTimeout(removalTimerRef.current);
      removalTimerRef.current = null;
    }
    if (shiftTimerRef.current) {
      clearTimeout(shiftTimerRef.current);
      shiftTimerRef.current = null;
    }
    if (spawnTimerRef.current) {
      clearTimeout(spawnTimerRef.current);
      spawnTimerRef.current = null;
    }
    if (shuffleTimerRef.current) {
      clearTimeout(shuffleTimerRef.current);
      shuffleTimerRef.current = null;
    }
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  };

  const reset = () => {
    clearTimers();
    cancelResolution();
    idGenRef.current = makeIdGen();
    dispatch({ type: "RESET", idGen: idGenRef.current });
    unlockAudio().then((ctx) => {
      if (ctx) playStartSfx();
    });
    setHoverGroup([]);
    setRemovingIds(new Set());
    setRemoveOrigin(null);
    setSpawningIds(new Set());
    setShuffling(false);
    setShiftAnimating(false);
    setResetId((v) => v + 1);
    timeRef.current = now();
    timeLeftRef.current = TIME_LIMIT_MS;
  };

  const startGame = () => {
    if (gameStarted) return;
    reset();
  };

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const compute = () => {
      const style = window.getComputedStyle(boardRef.current || el);
      const gapPx = parseFloat(style.getPropertyValue("--gap")) || 5;

      const w = el.clientWidth;
      const boardSize = w / Math.SQRT2;
      const cellW = (boardSize - gapPx * (COLS - 1)) / COLS;
      const cell = Math.max(12, Math.floor(cellW));

      setGeom(prev => (prev.cell === cell && prev.gap === gapPx ? prev : { cell, gap: gapPx }));
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!gameStarted || paused || gameOver) return;
    const id = setInterval(() => {
      const t = now();
      const delta = t - timeRef.current;
      timeRef.current = t;
      const next = Math.max(0, timeLeftRef.current - delta);
      timeLeftRef.current = next;
      dispatch({ type: "SET_TIME", timeLeftMs: next });
    }, 80);
    return () => clearInterval(id);
  }, [gameStarted, paused, gameOver]);

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    timeLeftRef.current = timeLeftMs;
  }, [timeLeftMs]);

  useEffect(() => {
    if (!gameStarted || gameOver) return;
    if (timeLeftMs > 0) return;
    dispatch({ type: "PATCH", patch: { gameOver: true, locked: true, paused: false } });
    setLog("TIME EXPIRED");
    playSfx("gameover");
  }, [timeLeftMs, gameStarted, gameOver]);

  const resolveAfterRemoval = async (nextGrid) => {
    // Cancel any in-flight resolution to avoid frame/timeout races (especially visible on DOWN).
    cancelResolution();
    const rid = resolutionIdRef.current;

    const nextGravity = computeGravity(nextGrid, gravity);
    const gravityChanged = nextGravity !== gravity;

    if (gravityChanged) {
      dispatch({ type: "SET_GRAVITY", gravity: nextGravity });
      setLog("FLOW VECTOR SHIFTED");
    }

    // Commit the post-removal grid first so the "holes" frame is actually painted.
    dispatch({ type: "SET_GRID", grid: nextGrid });

    // Force a paint boundary: let the "holes" frame render before shifting.
    await nextFrame();
    if (resolutionIdRef.current !== rid) return;

    const { grid: shifted, moved } = applyGravity(nextGrid, nextGravity);

    if (moved) {
      setShiftAnimating(true);

      // Keep a small delay so the "holes" frame is perceptible before the shift.
      if (MOVE_DELAY_MS > 0) await sleep(MOVE_DELAY_MS);
      if (resolutionIdRef.current !== rid) { setShiftAnimating(false); return; }

      dispatch({ type: "SET_GRID", grid: shifted });

      // Use WAAPI for the shift to avoid down-direction coalescing issues.
      await animateShiftWAAPI(nextGrid, shifted, rid, nextGravity);
      if (resolutionIdRef.current !== rid) { setShiftAnimating(false); return; }

      setShiftAnimating(false);
    }

    const spawned = fillEmpties(shifted, idGenRef.current);
    let finalGrid = spawned.grid;
    if (spawned.spawnIds.size > 0) {
      addTimeBonus(REFILL_BONUS_MS);
    }

    if (!hasAvailableMoves(finalGrid)) {
      finalGrid = shuffleGrid(finalGrid);
      setSpawningIds(new Set());
      setLog("NO CLUSTER — FIELD SHUFFLED");
      playSfx("shuffle");
    } else if (spawned.spawnIds.size > 0) {
      setSpawningIds(spawned.spawnIds);
      window.setTimeout(() => {
        if (resolutionIdRef.current === rid) {
          setSpawningIds(new Set());
        }
      }, SPAWN_MS);
      if (!gravityChanged) setLog("NODES REFILLED");
    }

    dispatch({ type: "SET_GRID", grid: finalGrid });

    window.setTimeout(() => {
      if (resolutionIdRef.current === rid) {
        dispatch({ type: "PATCH", patch: { locked: false } });
      }
    }, LOCK_PAD);
  };

  const detonateBomb = (cx, cy) => {
    const queue = [{ x: cx, y: cy }];
    const queued = new Set([`${cx},${cy}`]);
    const removeKeys = new Set();
    const removeIds = new Set();
    const removedPositions = [];
    let removedCount = 0;

    while (queue.length) {
      const { x, y } = queue.shift();
      for (let dy = -BOMB_RADIUS; dy <= BOMB_RADIUS; dy++) {
        const maxDx = BOMB_RADIUS - Math.abs(dy);
        for (let dx = -maxDx; dx <= maxDx; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          const cell = grid[ny][nx];
          if (!cell) continue;
          const key = `${nx},${ny}`;
          if (!removeKeys.has(key)) {
            removeKeys.add(key);
            removeIds.add(cell.id);
            removedPositions.push({ x: nx, y: ny });
            removedCount += 1;
          }
          if (cell.bomb) {
            const bkey = `${nx},${ny}`;
            if (!queued.has(bkey)) {
              queued.add(bkey);
              queue.push({ x: nx, y: ny });
            }
          }
        }
      }
    }

    if (removedCount === 0) return;

    const next = cloneGrid(grid);
    for (const key of removeKeys) {
      const [sx, sy] = key.split(",").map(Number);
      next[sy][sx] = null;
    }

    dispatch({ type: "PATCH", patch: { locked: true } });
    setHoverGroup([]);
    dispatch({ type: "ADD_SCORE", delta: (removedCount * BLOCK_SCORE) + BOMB_DETONATE_BONUS });
    setLog("BOMB DETONATED");
    playSfx("bomb_detonate");
    if (removeIds.size > 0) {
      setRemovingIds(removeIds);
      const origin = { x: cx, y: cy };
      setRemoveOrigin(origin);
      const maxDelay = maxPopDelay(origin, removedPositions);
      const totalDelay = REMOVE_MS + maxDelay;
      if (removalTimerRef.current) clearTimeout(removalTimerRef.current);
      removalTimerRef.current = setTimeout(() => {
        setRemovingIds(new Set());
        setRemoveOrigin(null);
        resolveAfterRemoval(next);
      }, totalDelay);
    } else {
      resolveAfterRemoval(next);
    }
  };

  const onCellEnter = (x, y) => {
    if (!gameStarted || locked || paused || gameOver) return;
    if (!grid[y][x]) { setHoverGroup([]); return; }
    const g = groupAt(grid, x, y);
    setHoverGroup(g.length >= MIN_GROUP ? g : []);
  };
  const onCellLeave = () => setHoverGroup([]);

  const findHintGroup = () => {
    const seen = new Set();
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const cell = grid[y][x];
        if (!cell) continue;
        if (cell.bomb) return [{ x, y, id: cell.id }];
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        const group = groupAt(grid, x, y);
        for (const p of group) seen.add(`${p.x},${p.y}`);
        if (group.length >= MIN_GROUP) return group;
      }
    }
    return [];
  };

  const onHintClick = () => {
    if (!gameStarted || locked || paused || gameOver) return;
    unlockAudio();
    const group = findHintGroup();
    if (!group.length) {
      setLog("NO CLUSTER FOUND");
      return;
    }
    setHoverGroup(group);
    setLog("CLUSTER HIGHLIGHTED");
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => {
      setHoverGroup([]);
    }, HINT_MS);
  };

  const onCellClick = (x, y) => {
    if (!gameStarted || locked || paused || gameOver) return;
    unlockAudio();
    const target = grid[y][x];
    if (!target) return;

    if (target.bomb) {
      detonateBomb(x, y);
      return;
    }

    const g = groupAt(grid, x, y);
    if (g.length < MIN_GROUP) {
      setLog("CONNECT 3+ NODES");
      playSfx("miss");
      return;
    }

    const makeBomb = g.length >= BOMB_THRESHOLD;
    const next = cloneGrid(grid);
    let removedCount = 0;
    const removeIds = new Set();
    const removedPositions = [];
    const keep = makeBomb ? { x, y } : null;

    for (const p of g) {
      if (keep && p.x === keep.x && p.y === keep.y) continue;
      const tile = next[p.y][p.x];
      if (tile) {
        removeIds.add(tile.id);
        next[p.y][p.x] = null;
        removedPositions.push({ x: p.x, y: p.y });
        removedCount += 1;
      }
    }

    if (makeBomb) {
      const tile = next[y][x];
      if (tile) {
        tile.value = TYPES + 1;
        tile.bomb = true;
      } else {
        next[y][x] = newTile(idGenRef.current, TYPES + 1, true);
      }
      dispatch({ type: "ADD_SCORE", delta: (removedCount * BLOCK_SCORE) + BOMB_CREATE_BONUS });
    } else {
      dispatch({ type: "ADD_SCORE", delta: removedCount * BLOCK_SCORE });
    }

    dispatch({ type: "PATCH", patch: { locked: true } });
    setHoverGroup([]);
    setLog(makeBomb ? "BOMB ARMED — REALIGNING" : "REALIGNING FLOW");
    if (makeBomb) {
      playSfx("bomb_spawn");
    } else {
      playSfx("hit");
    }
    if (removeIds.size > 0) {
      setRemovingIds(removeIds);
      const origin = { x, y };
      setRemoveOrigin(origin);
      const maxDelay = maxPopDelay(origin, removedPositions);
      const totalDelay = REMOVE_MS + maxDelay;
      if (removalTimerRef.current) clearTimeout(removalTimerRef.current);
      removalTimerRef.current = setTimeout(() => {
        setRemovingIds(new Set());
        setRemoveOrigin(null);
        resolveAfterRemoval(next);
      }, totalDelay);
    } else {
      resolveAfterRemoval(next);
    }
  };

  const tiles = useMemo(() => collectTiles(grid), [grid]);
  const hoverSet = useMemo(() => {
    const s = new Set();
    for (const p of hoverGroup) s.add(`${p.x},${p.y}`);
    return s;
  }, [hoverGroup]);
  const cells = useMemo(
    () => Array.from({ length: ROWS * COLS }, (_, i) => ({ x: i % COLS, y: (i / COLS) | 0 })),
    []
  );

  const subText = !gameStarted
    ? "PRESS START TO PLAY"
    : gameOver
      ? "TIME UP — RESET TO RESTART"
      : paused
        ? "PAUSED"
        : logText;

  const flowArrow = gravity === "UP" ? "^" : gravity === "DOWN" ? "v" : gravity === "LEFT" ? "<" : ">";
  const flowText = `${gravity} ${flowArrow}`;

  const timeText = (timeLeftMs / 1000).toFixed(1);
  const timePercent = Math.max(0, Math.min(1, timeLeftMs / TIME_LIMIT_MS));

  const boardPx = useMemo(() => {
    const w = COLS * geom.cell + (COLS - 1) * geom.gap;
    const h = ROWS * geom.cell + (ROWS - 1) * geom.gap;
    return { w, h };
  }, [geom]);
  const boardStyle = useMemo(() => ({
    "--gap": `${geom.gap}px`,
    "--cell": `${geom.cell}px`,
    "--board-scale": "0.94",
    "--tile-scale": "0.98",
    width: `${boardPx.w}px`,
    height: `${boardPx.h}px`,
  }), [geom, boardPx]);

  const outerStyle = useMemo(() => ({
    width: `${Math.ceil(boardPx.w * Math.SQRT2)}px`,
    height: `${Math.ceil(boardPx.h * Math.SQRT2)}px`,
  }), [boardPx]);

  const showStart = !gameStarted;
  const showGameOver = gameOver;

  return h(
    "div",
    { className: "wrap" },
    h(
      "div",
      { className: "top" },
      h(
        "div",
        { className: "titleBlock" },
        h("div", { className: "tag" }, "EDGEFLOW CONSOLE"),
        h("h1", null, "EDGEFLOW"),
        h("p", { className: "sub" }, subText)
      ),
      h(
        "div",
        { className: "btns" },
        h(
          "button",
          { className: "controlBtn primary", onClick: reset, disabled: !gameStarted },
          "RESET"
        ),
        h(
          "button",
          {
            className: "controlBtn secondary",
            onClick: onHintClick,
            disabled: !gameStarted || gameOver || locked,
          },
          "HINT"
        )
      )
    ),
    h(
      "div",
      { className: "panel" },
      h(
        "div",
        { className: "status" },
        h(
          "div",
          { className: "targetCard" },
          h("div", { className: "targetLabel" }, "PROTOCOL"),
          h("div", { className: "targetNum" }, "EDGEFLOW RULES"),
          h(
            "div",
            { className: "targetMini" },
            h("span", null, `CLEAR 3+ TO PULL FLOW`),
            h("span", null, `4+ ARMS BOMB / FLOW DRIFTS TO OPEN EDGE`)
          )
        ),
        h(
          "div",
          { className: "stats" },
          h(
            "div",
            { className: "stat" },
            h("div", { className: "k" }, "FLOW"),
            h("div", { className: "v" }, flowText)
          ),
          h(
            "div",
            { className: "stat scoreStat" },
            h("div", { className: "k" }, "SCORE"),
            h("div", { className: "v" }, String(score))
          )
        ),
        h(
          "div",
          {
            className: "timeBar",
            role: "progressbar",
            "aria-label": "Time remaining",
            "aria-valuemin": 0,
            "aria-valuemax": TIME_LIMIT_MS,
            "aria-valuenow": Math.round(timeLeftMs),
          },
          h(
            "div",
            { className: "timeBarHead" },
            h("div", { className: "timeBarLabel" }, "TIME LEFT"),
            h("div", { className: "timeBarValue" }, `${timeText}s`)
          ),
          h(
            "div",
            { className: "timeBarTrack" },
            h("div", { className: "timeBarFill", style: { width: `${timePercent * 100}%` } })
          )
        )
      ),
      h(
        "div",
        { className: "boardWrap", ref: wrapRef },
        h(
          "div",
          { className: "gridOuter", style: outerStyle },
          showStart
            ? h(
                "div",
                { className: "startOverlay" },
                h(
                  "button",
                  {
                    className: "controlBtn primary startBtn",
                    type: "button",
                    onClick: startGame,
                  },
                  "SIM START"
                )
              )
            : null,
          showGameOver
            ? h(
                "div",
                { className: "gameOverOverlay" },
                h(
                  "div",
                  { className: "gameOverCard" },
                  h("div", { className: "gameOverTitle" }, "TIME UP"),
                  h("div", { className: "gameOverSub" }, "RESET TO RESTART"),
                  h(
                    "button",
                    {
                      className: "controlBtn primary",
                      type: "button",
                      onClick: reset,
                    },
                    "RESET"
                  )
                )
              )
            : null,
          h(
            "div",
            { className: `board${shuffling ? " shuffling" : ""}`, ref: boardRef, style: boardStyle },
            h(
              "div",
              { className: `tileLayer${shiftAnimating ? " shifting" : ""}`, "aria-hidden": "true", ref: tileLayerRef },
              tiles.map(tile => {
                const hint = hoverSet.has(`${tile.x},${tile.y}`);
                const removing = removingIds.has(tile.id);
                const spawning = spawningIds.has(tile.id);
                const popDelay = removing && removeOrigin ? popDelayMs(removeOrigin, tile.x, tile.y) : 0;

                const tx = tile.x * (geom.cell + geom.gap);
                const ty = tile.y * (geom.cell + geom.gap);
                const cls = [
                  "tile",
                  `t${Math.max(0, Math.min(TYPES - 1, tile.value - 1))}`,
                  tile.bomb ? "bomb" : "",
                  hint ? "hint" : "",
                  removing ? "removing" : "",
                  spawning ? "spawning" : "",
                ].filter(Boolean).join(" ");

                return h("div", {
                  key: `${resetId}-${tile.id}`,
                  className: cls,
                  "data-id": tile.id,
                  style: {
                    "--tx": `${tx}px`,
                    "--ty": `${ty}px`,
                    "--pop-delay": `${popDelay}ms`,
                    ...(spawning ? (() => {
                      const dist = (geom.cell + geom.gap) * 1.35;
                      switch (gravity) {
                        case "DOWN": return { "--spx": "0px", "--spy": `${-dist}px` };
                        case "UP":   return { "--spx": "0px", "--spy": `${dist}px` };
                        case "LEFT": return { "--spx": `${dist}px`, "--spy": "0px" };
                        case "RIGHT":return { "--spx": `${-dist}px`, "--spy": "0px" };
                        default:     return { "--spx": "0px", "--spy": "0px" };
                      }
                    })() : null),
                  }});
              })
            ),
            h(
              "div",
              { className: "inputLayer" },
              cells.map(({ x, y }) => {
                const hasTile = !!grid[y][x];
                const hint = hasTile && hoverSet.has(`${x},${y}`);
                const cls = [
                  "cell",
                  "cellBtn",
                  hint ? "hint" : "",
                ].filter(Boolean).join(" ");

                return h(
                  "button",
                  {
                    key: `${x},${y}`,
                    className: cls,
                    disabled: !hasTile || locked || paused || gameOver || !gameStarted,
                    onMouseEnter: () => onCellEnter(x, y),
                    onMouseLeave: onCellLeave,
                    onFocus: () => onCellEnter(x, y),
                    onBlur: onCellLeave,
                    onClick: () => onCellClick(x, y),
                    "aria-label": hasTile ? "node" : "void",
                  },
                  ""
                );
              })
            )
          )
        )
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
