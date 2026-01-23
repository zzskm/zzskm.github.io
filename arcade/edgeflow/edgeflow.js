const { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } = React;
const h = React.createElement;

const COLS = 7;
const ROWS = 7;
const TYPES = 5;
const MIN_GROUP = 3;
const BOMB_THRESHOLD = 4;
const BOMB_RADIUS = 2;
const REMOVE_MS = 120;
const MOVE_MS = 160;
const MOVE_DELAY_MS = 40;
const LOCK_PAD = 40;
const SPAWN_MS = 160;
const HINT_MS = 700;
const REFILL_BONUS_MS = 400;

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

function initState(idGen) {
  const seeded = seedGrid(idGen);
  const playable = ensurePlayable(seeded);
  return {
    grid: playable,
    gravity: "DOWN",
    score: 0,
    timeLeftMs: TIME_LIMIT_MS,
    gameStarted: false,
    gameOver: false,
    paused: false,
    locked: false,
    logText: "SYSTEM IDLE // PRESS START TO INITIATE",
  };
}

function reducer(state, action) {
  switch (action.type) {
    case "RESET":
      return {
        ...initState(action.idGen),
        gameStarted: true,
        logText: "FLOW VECTOR UPDATED",
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
  const [spawningIds, setSpawningIds] = useState(new Set());
  const [shuffling, setShuffling] = useState(false);
  const [shiftAnimating, setShiftAnimating] = useState(false);

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
    idGenRef.current = makeIdGen();
    dispatch({ type: "RESET", idGen: idGenRef.current });
    setHoverGroup([]);
    setRemovingIds(new Set());
    setSpawningIds(new Set());
    setShuffling(false);
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
    setLog("SIMULATION TERMINATED");
  }, [timeLeftMs, gameStarted, gameOver]);

  const resolveAfterRemoval = async (nextGrid) => {
    // Cancel any in-flight resolution to avoid frame/timeout races (especially visible on DOWN).
    cancelResolution();
    const rid = resolutionIdRef.current;

    const nextGravity = computeGravity(nextGrid, gravity);
    const gravityChanged = nextGravity !== gravity;

    if (gravityChanged) {
      dispatch({ type: "SET_GRAVITY", gravity: nextGravity });
      setLog("FLOW VECTOR UPDATED");
    }

    // Commit the post-removal grid first so the "holes" frame is actually painted.
    dispatch({ type: "SET_GRID", grid: nextGrid });

    // Force a paint boundary: without this, React/browsers may coalesce updates and skip the shift transition.
    await nextFrame();
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
      setLog("EDGE DOMINANCE");
    } else if (spawned.spawnIds.size > 0) {
      setSpawningIds(spawned.spawnIds);
      window.setTimeout(() => {
        if (resolutionIdRef.current === rid) {
          setSpawningIds(new Set());
        }
      }, SPAWN_MS);
      if (!gravityChanged) setLog("DENSITY GRADIENT FORMED");
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
    setLog("BOUNDARY SHIFT");
    if (removeIds.size > 0) {
      setRemovingIds(removeIds);
      if (removalTimerRef.current) clearTimeout(removalTimerRef.current);
      removalTimerRef.current = setTimeout(() => {
        setRemovingIds(new Set());
        resolveAfterRemoval(next);
      }, REMOVE_MS);
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
    const group = findHintGroup();
    if (!group.length) {
      setLog("NO SIGNAL");
      return;
    }
    setHoverGroup(group);
    setLog("FLOW SIGNAL");
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => {
      setHoverGroup([]);
    }, HINT_MS);
  };

  const onCellClick = (x, y) => {
    if (!gameStarted || locked || paused || gameOver) return;
    const target = grid[y][x];
    if (!target) return;

    if (target.bomb) {
      detonateBomb(x, y);
      return;
    }

    const g = groupAt(grid, x, y);
    if (g.length < MIN_GROUP) {
      setLog("EDGE PRESSURE DETECTED");
      return;
    }

    const makeBomb = g.length >= BOMB_THRESHOLD;
    const next = cloneGrid(grid);
    let removedCount = 0;
    const removeIds = new Set();

    for (const p of g) {
      if (makeBomb && p.x === x && p.y === y) continue;
      const tile = next[p.y][p.x];
      if (tile) {
        removeIds.add(tile.id);
        next[p.y][p.x] = null;
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
    setLog("FIELD REALIGNING");
    if (removeIds.size > 0) {
      setRemovingIds(removeIds);
      if (removalTimerRef.current) clearTimeout(removalTimerRef.current);
      removalTimerRef.current = setTimeout(() => {
        setRemovingIds(new Set());
        resolveAfterRemoval(next);
      }, REMOVE_MS);
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
    ? "SYSTEM IDLE // PRESS START TO INITIATE"
    : gameOver
      ? "SIMULATION TERMINATED"
      : paused
        ? "FLOW STALLED"
        : logText;

  const stateText = gameOver
    ? "UNSTABLE STATE"
    : !gameStarted
      ? "IDLE"
      : paused
        ? "FLOW STALLED"
        : locked
          ? "FIELD REALIGNING"
          : "ACTIVE";

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

  return h(
    "div",
    { className: "wrap" },
    h(
      "div",
      { className: "top" },
      h(
        "div",
        { className: "titleBlock" },
        h("div", { className: "tag" }, "SYSTEM ACTIVE"),
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
          h("div", { className: "targetNum" }, "FIELD DYNAMICS"),
          h("div", { className: "targetMini" }, `GRID ${COLS}x${ROWS} / NODES ${TYPES} / MIN ${MIN_GROUP}`)
        ),
        h(
          "div",
          { className: "stats" },
          h(
            "div",
            { className: "stat" },
            h("div", { className: "k" }, "STATE"),
            h("div", { className: "v" }, stateText)
          ),
          h(
            "div",
            { className: "stat" },
            h("div", { className: "k" }, "FLOW VECTOR"),
            h("div", { className: "v" }, flowText)
          ),
          h(
            "div",
            { className: "stat scoreStat" },
            h("div", { className: "k" }, "FIELD INDEX"),
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
            h("div", { className: "timeBarLabel" }, "SIM TIME"),
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
                  key: tile.id,
                  className: cls,
                  "data-id": tile.id,
                  style: {
                    "--tx": `${tx}px`,
                    "--ty": `${ty}px`,
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
