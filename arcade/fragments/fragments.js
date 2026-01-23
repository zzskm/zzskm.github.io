const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

/* =========================
   CONFIG
========================= */
const COLS = 12;
const ROWS = 15;
const TYPES = 4;
const MIN_GROUP = 3;
const START_LINES = 4;
const BOMB_CHANCE = 0.025;
const BRICK_SCALE = 0.9;
const LEVEL_BASE = 16;
const LEVEL_GROWTH = 7;
const LEVEL_GROWTH_FACTOR = 1.18;

const INTERVAL_START_MS = 3000;
const INTERVAL_MIN_MS = 1200;
const INTERVAL_DECAY = 0.992; // per added line
const REVEAL_START_MS = 150;
const REVEAL_MIN_MS = 80;
const REVEAL_DECAY = 0.92;

// Animation timings (ms)
const POP_MS = 170;      // remove pop/fade
const LOCK_PAD_MS = 40;  // small pad to avoid input during layout
const NEXT_ROW_PAD = 8;

const now = () => Date.now();

/* =========================
   MODEL (tiles have stable ids)
========================= */
function makeIdGen() {
  let n = 1;
  return () => n++;
}

function newTile(idGen, t, bomb = false) {
  return { id: idGen(), t, bomb };
}

function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function seedGrid(idGen, allowBombs) {
  const g = emptyGrid();
  // Start with a few lines to ease into the game
  const startLines = START_LINES;
  for (let y = ROWS - startLines; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const t = (Math.random() * TYPES) | 0;
      const bomb = allowBombs && Math.random() < BOMB_CHANCE;
      g[y][x] = newTile(idGen, t, bomb);
    }
  }
  return g;
}

function makeNextLineTiles(allowBombs) {
  const arr = new Array(COLS);
  for (let i = 0; i < COLS; i++) {
    const t = (Math.random() * TYPES) | 0;
    const bomb = allowBombs && Math.random() < BOMB_CHANCE;
    arr[i] = { t, bomb };
  }
  return arr;
}

function cloneGrid(g) {
  return g.map(row => row.slice());
}

function inBounds(x, y) {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

/* =========================
   GROUP FIND (BFS)
========================= */
function groupAt(grid, sx, sy) {
  const start = grid[sy][sx];
  if (!start) return [];
  const t = start.t;

  const q = [[sx, sy]];
  const seen = new Set([`${sx},${sy}`]);
  const out = [];

  while (q.length) {
    const [x, y] = q.shift();
    const cell = grid[y][x];
    if (!cell || cell.t !== t) continue;

    out.push({ x, y, id: cell.id });

    const nb = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
    for (const [nx, ny] of nb) {
      if (!inBounds(nx, ny)) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      const c = grid[ny][nx];
      if (c && c.t === t) {
        seen.add(k);
        q.push([nx, ny]);
      }
    }
  }
  return out;
}

/* =========================
   PHYSICS: gravity + center-out column compaction
========================= */
function applyGravity(grid) {
  const g = cloneGrid(grid);

  for (let x = 0; x < COLS; x++) {
    const stack = [];
    for (let y = ROWS - 1; y >= 0; y--) {
      if (g[y][x]) stack.push(g[y][x]);
    }
    let writeY = ROWS - 1;
    for (const tile of stack) {
      g[writeY][x] = tile;
      writeY--;
    }
    for (; writeY >= 0; writeY--) g[writeY][x] = null;
  }
  return g;
}

function isColEmpty(grid, x) {
  for (let y = 0; y < ROWS; y++) if (grid[y][x]) return false;
  return true;
}

/**
 * Center-out compaction (requested):
 * - empty columns are pushed to the outside edges
 * - non-empty columns are pulled toward center
 * - preserve relative order within left half and right half
 */
function centerOutCompressCols(grid) {
  const nonEmpty = [];
  for (let x = 0; x < COLS; x++) if (!isColEmpty(grid, x)) nonEmpty.push(x);
  if (nonEmpty.length === 0 || nonEmpty.length === COLS) return grid;

  const centerRight = Math.floor(COLS / 2); // 12 -> 6
  const centerLeft = centerRight - 1;       // 12 -> 5

  const leftCols = [];
  const rightCols = [];
  for (const x of nonEmpty) {
    if (x <= centerLeft) leftCols.push(x);
    else rightCols.push(x);
  }

  const out = emptyGrid();

  // left half: pull toward center (write from centerLeft downwards)
  let writeX = centerLeft;
  for (let i = leftCols.length - 1; i >= 0; i--) {
    const srcX = leftCols[i];
    for (let y = 0; y < ROWS; y++) out[y][writeX] = grid[y][srcX];
    writeX--;
  }

  // right half: pull toward center (write from centerRight upwards)
  writeX = centerRight;
  for (let i = 0; i < rightCols.length; i++) {
    const srcX = rightCols[i];
    for (let y = 0; y < ROWS; y++) out[y][writeX] = grid[y][srcX];
    writeX++;
  }

  return out;
}

/* =========================
   LINE PUSH (shift up, add bottom line)
========================= */
function pushLine(grid, idGen, nextLineTiles) {
  // Game over if top row already has any tile before shifting.
  for (let x = 0; x < COLS; x++) {
    if (grid[0][x]) return { grid, gameOver: true };
  }

  const g = emptyGrid();
  for (let y = 0; y < ROWS - 1; y++) {
    for (let x = 0; x < COLS; x++) {
      g[y][x] = grid[y + 1][x];
    }
  }
  // add new tiles at bottom
  for (let x = 0; x < COLS; x++) {
    const { t, bomb } = nextLineTiles[x];
    g[ROWS - 1][x] = newTile(idGen, t, bomb);
  }
  return { grid: g, gameOver: false };
}

/* =========================
   RENDER HELPERS
========================= */
function collectTiles(grid) {
  const tiles = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y][x];
      if (c) tiles.push({ id: c.id, t: c.t, bomb: c.bomb, x, y });
    }
  }
  return tiles;
}

function keyXY(x, y) { return `${x},${y}`; }

function levelFromRemoved(removed) {
  let level = 1;
  let need = LEVEL_BASE;
  let consumed = 0;
  while (removed >= consumed + need) {
    consumed += need;
    level += 1;
    need = Math.round(need * LEVEL_GROWTH_FACTOR + LEVEL_GROWTH);
  }
  return { level, progress: removed - consumed, next: need };
}

/* =========================
   APP
========================= */
function App() {
  const idGenRef = useRef(null);
  if (!idGenRef.current) idGenRef.current = makeIdGen();

  const [removed, setRemoved] = useState(0);
  const levelInfo = useMemo(() => levelFromRemoved(removed), [removed]);
  const level = levelInfo.level;
  const allowBombs = level > 1;

  const [grid, setGrid] = useState(() => seedGrid(idGenRef.current, false));
  const [nextLine, setNextLine] = useState(() => makeNextLineTiles(false));
  const [score, setScore] = useState(0);
  const [intervalMs, setIntervalMs] = useState(INTERVAL_START_MS);
  const [nextReveal, setNextReveal] = useState(0);

  const [locked, setLocked] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);

  const [hoverGroup, setHoverGroup] = useState([]); // {x,y,id}
  const [removingIds, setRemovingIds] = useState(() => new Set());
  const [spawnIds, setSpawnIds] = useState(() => new Set());
  const [missAt, setMissAt] = useState(0);
  const [missPos, setMissPos] = useState(null);

  // geometry for absolute-positioned tiles
  const wrapRef = useRef(null);
  const outerRef = useRef(null);
  const boardRef = useRef(null);
  const [geom, setGeom] = useState({ cell: 24, gap: 4 });

  // timer loop
  const lastTickRef = useRef(now());
  const accRef = useRef(0);
  const rafRef = useRef(null);
  const audioRef = useRef(null);
  const audioEnabledRef = useRef(false);
  const lastSfxAtRef = useRef(0);
  const lastStartSfxRef = useRef(0);

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
    const throttle = (kind === "levelup" || kind === "gameover") ? 0 : 40;
    if (t - lastSfxAtRef.current < throttle) return;
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
    if (kind === "bomb") {
      playTone(ctx, 520, 0.06, "triangle", 0, baseGain * 0.9);
      playTone(ctx, 260, 0.08, "square", 0.04, baseGain * 0.8);
      playTone(ctx, 130, 0.12, "square", 0.1, baseGain * 0.6);
      return;
    }
    if (kind === "line") {
      playTone(ctx, 740, 0.04, "square", 0, baseGain * 0.7);
      playTone(ctx, 980, 0.05, "square", 0.05, baseGain * 0.6);
      return;
    }
    if (kind === "levelup") {
      const rise = [0, 4, 7, 12, 19];
      const base = 520;
      const spacing = 0.035;
      rise.forEach((step, i) => {
        const freq = base * Math.pow(2, step / 12);
        playTone(ctx, freq, 0.05, "square", i * spacing, baseGain * 0.55);
      });
      playTone(ctx, base * 2, 0.06, "square", rise.length * spacing + 0.02, baseGain * 0.45);
      return;
    }
    if (kind === "gameover") {
      playTone(ctx, 196, 0.26, "triangle", 0, baseGain * 1.1);
      playTone(ctx, 174, 0.3, "triangle", 0.12, baseGain * 0.9);
      playTone(ctx, 146, 0.34, "triangle", 0.24, baseGain * 0.85);
      playTone(ctx, 110, 0.48, "square", 0.18, baseGain * 0.55);
      playTone(ctx, 98, 0.52, "square", 0.3, baseGain * 0.45);
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
    const leadGain = 0.03;
    const bassGain = 0.02;
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
      { m: 67, s: 16, d: 1 },
      { m: 69, s: 17, d: 1 },
      { m: 70, s: 18, d: 1 },
      { m: 71, s: 19, d: 1 },
      { m: 74, s: 20, d: 2 },
      { m: 71, s: 22, d: 2 },
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

  const tiles = useMemo(() => collectTiles(grid), [grid]);
  const revealMs = useMemo(
    () => Math.max(REVEAL_MIN_MS, Math.floor(REVEAL_START_MS * Math.pow(REVEAL_DECAY, Math.max(0, level - 1)))),
    [level]
  );
  const prevLevelRef = useRef(level);

  useEffect(() => {
    if (level > prevLevelRef.current) {
      unlockAudio().then(() => playSfx("levelup"));
      prevLevelRef.current = level;
    }
  }, [level]);

  const hoverSet = useMemo(() => {
    const s = new Set();
    for (const p of hoverGroup) s.add(keyXY(p.x, p.y));
    return s;
  }, [hoverGroup]);

  // Measure board geometry (responsive)
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const compute = () => {
      const style = window.getComputedStyle(boardRef.current || el);
      const gapPx = parseFloat(style.getPropertyValue("--gap")) || 6;

      const w = el.clientWidth;
      const cellW = (w - gapPx * (COLS - 1)) / COLS;
      const cell = Math.max(10, Math.floor(cellW));

      setGeom(prev => (prev.cell === cell && prev.gap === gapPx ? prev : { cell, gap: gapPx }));
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const reset = () => {
    setGameStarted(true);
    unlockAudio().then((ctx) => {
      if (ctx) playStartSfx();
    });
    const idGen = idGenRef.current = makeIdGen();
    setRemoved(0);
    setGrid(seedGrid(idGen, false));
    setNextLine(makeNextLineTiles(false));
    setScore(0);
    setIntervalMs(INTERVAL_START_MS);
    setNextReveal(0);
    setLocked(false);
    setGameOver(false);
    setHoverGroup([]);
    setRemovingIds(new Set());
    setSpawnIds(new Set());
    setMissAt(0);
    setMissPos(null);
    accRef.current = 0;
    lastTickRef.current = now();
  };

  const startGame = () => {
    if (gameStarted) return;
    reset();
  };

  const onCellEnter = (x, y) => {
    if (!gameStarted || locked || gameOver) return;
    if (!grid[y][x]) { setHoverGroup([]); return; }
    const g = groupAt(grid, x, y);
    setHoverGroup(g.length >= MIN_GROUP ? g : []);
  };
  const onCellLeave = () => setHoverGroup([]);

  const onCellClick = (x, y) => {
    if (!gameStarted || locked || gameOver) return;
    unlockAudio();
    const target = grid[y][x];
    if (!target) return;

    if (target.bomb) {
      const removing = new Set();
      const next = cloneGrid(grid);
      let removedCount = 0;
      for (let yy = 0; yy < ROWS; yy++) {
        for (let xx = 0; xx < COLS; xx++) {
          const tile = next[yy][xx];
          if (tile && tile.t === target.t) {
            removing.add(tile.id);
            next[yy][xx] = null;
            removedCount++;
          }
        }
      }
      if (removedCount === 0) return;
      setLocked(true);
      setHoverGroup([]);
      setRemovingIds(removing);
      setScore(s => s + removedCount * removedCount);
      setRemoved(r => r + removedCount);
      playSfx("bomb");
      const after = centerOutCompressCols(applyGravity(next));
      window.setTimeout(() => {
        setGrid(after);
        setRemovingIds(new Set());
        window.setTimeout(() => setLocked(false), LOCK_PAD_MS);
      }, POP_MS);
      return;
    }

    const g = groupAt(grid, x, y);
    if (g.length < MIN_GROUP) {
      setMissAt(now());
      setMissPos({ x, y });
      playSfx("miss");
      return;
    }

    setLocked(true);
    setHoverGroup([]);

    const removing = new Set(g.map(p => p.id));
    setRemovingIds(removing);

    const next = cloneGrid(grid);
    for (const p of g) next[p.y][p.x] = null;
    const after = centerOutCompressCols(applyGravity(next));

    setScore(s => s + g.length * g.length);
    setRemoved(r => r + g.length);
    playSfx("hit");

    window.setTimeout(() => {
      setGrid(after);
      setRemovingIds(new Set());
      window.setTimeout(() => setLocked(false), LOCK_PAD_MS);
    }, POP_MS);
  };

  useEffect(() => {
    setNextReveal(0);
  }, [nextLine]);

  useEffect(() => {
    if (!gameStarted || locked || gameOver) return;
    if (nextReveal >= COLS) return;
    const t = window.setTimeout(() => {
      setNextReveal(n => (n < COLS ? n + 1 : n));
    }, revealMs);
    return () => window.clearTimeout(t);
  }, [nextReveal, locked, gameOver, gameStarted, nextLine, revealMs]);

  // Line push loop
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (!gameStarted) return;

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const nowMs = now();
      const dt = nowMs - lastTickRef.current;
      lastTickRef.current = nowMs;

      if (locked || gameOver) return;

      accRef.current += dt;
      if (accRef.current >= intervalMs) {
        accRef.current = 0;

        const idGen = idGenRef.current;
        const res = pushLine(grid, idGen, nextLine);

        if (res.gameOver) {
          setGameOver(true);
          setLocked(true);
          playSfx("gameover");
          return;
        }

        // Mark spawned ids for pop-in
        const spawned = new Set();
        for (let x = 0; x < COLS; x++) {
          const tile = res.grid[ROWS - 1][x];
          if (tile) spawned.add(tile.id);
        }
        setSpawnIds(spawned);
        window.setTimeout(() => setSpawnIds(new Set()), 220);

        setGrid(res.grid);
        setNextLine(makeNextLineTiles(allowBombs));
        setIntervalMs(ms => Math.max(INTERVAL_MIN_MS, Math.floor(ms * INTERVAL_DECAY)));
        playSfx("line");
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, locked, gameOver, intervalMs, nextLine, allowBombs, gameStarted]);

  const missActive = (now() - missAt) < 220;

  const title = "FRAGMENTS // PURGE";
  const subText = !gameStarted
    ? "SYSTEM IDLE // PRESS START TO INITIATE"
    : gameOver
      ? "CORE INSTABILITY // SIGNAL LOST"
      : missActive
        ? "NO VALID CLUSTER // INPUT IGNORED"
        : locked
          ? "SYSTEM HOLD // MEMORY LOCKED"
          : `IDENTIFY CLUSTERS \u2265${MIN_GROUP} // PURGE FRAGMENTS`;

  const stateText = gameOver ? "FAILED" : (!gameStarted ? "IDLE" : (locked ? "HOLD" : "ACTIVE"));

  const flat = useMemo(() => {
    const arr = [];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) arr.push({ x, y });
    return arr;
  }, []);

  const boardPx = useMemo(() => {
    const w = COLS * geom.cell + (COLS - 1) * geom.gap;
    const h = ROWS * geom.cell + (ROWS - 1) * geom.gap;
    return { w, h };
  }, [geom]);
  const boardStyle = useMemo(() => ({
    "--gap": `${geom.gap}px`,
    "--cell": `${geom.cell}px`,
  }), [geom]);

  const outerStyle = useMemo(() => ({
    width: `${boardPx.w}px`,
    height: `${boardPx.h}px`,
  }), [boardPx]);

  const nextRowStyle = useMemo(() => ({
    width: `${boardPx.w + NEXT_ROW_PAD * 2}px`,
    "--gap": `${geom.gap}px`,
    "--cell": `${geom.cell}px`,
    "--row-pad": `${NEXT_ROW_PAD}px`,
    "--scale": String(BRICK_SCALE),
  }), [boardPx, geom]);
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
        h("h1", null, title),
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
            onClick: () => setLocked(v => !v),
            disabled: gameOver || !gameStarted,
          },
          locked ? "RESUME" : "PAUSE"
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
          h("div", { className: "targetNum" }, "PURGE MODE"),
          h("div", { className: "targetMini" }, `GRID ${COLS}x${ROWS} / RISK ${TYPES} / MIN ${MIN_GROUP}`)
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
            h("div", { className: "k" }, "LEVEL"),
            h("div", { className: "v" }, String(level))
          ),
          h(
            "div",
            { className: "stat scoreStat" },
            h("div", { className: "k" }, "SCORE"),
            h("div", { className: "v" }, String(score))
          ),
        )
      ),

      h(
        "div",
        { className: "boardWrap", ref: wrapRef },
        h(
          "div",
          { className: "gridOuter", ref: outerRef, style: outerStyle },
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
                  "GAME START"
                )
              )
            : null,
          h(
            "div",
            { className: "board", ref: boardRef, style: boardStyle },

            h(
              "div",
              { className: "tileLayer", "aria-hidden": "true" },
              tiles.map(tile => {
                const hint = hoverSet.has(keyXY(tile.x, tile.y));
                const removing = removingIds.has(tile.id);
                const spawning = spawnIds.has(tile.id);
                const isMiss = missActive && missPos && missPos.x === tile.x && missPos.y === tile.y;

                const tx = tile.x * (geom.cell + geom.gap);
                const ty = tile.y * (geom.cell + geom.gap);

                const cls = [
                  "tile",
                  "brick",
                  `t${tile.t}`,
                  tile.bomb ? "bomb" : "",
                  hint ? "hint" : "",
                  removing ? "removing" : "",
                  spawning ? "spawning" : "",
                  isMiss ? "miss" : "",
                ].filter(Boolean).join(" ");

                return h("div", {
                  key: tile.id,
                  className: cls,
                  style: {
                    width: `${geom.cell}px`,
                    height: `${geom.cell}px`,
                    "--tx": `${tx}px`,
                    "--ty": `${ty}px`,
                    "--scale": String(BRICK_SCALE),
                  }
                });
              })
            ),

            h(
              "div",
              { className: "inputLayer" },
              flat.map(({ x, y }) => {
                const hasTile = !!grid[y][x];
                const hint = hasTile && hoverSet.has(keyXY(x, y));
                const isMiss = missActive && missPos && missPos.x === x && missPos.y === y;
                const cls = [
                  "cell",
                  "cellBtn",
                  hint ? "hint" : "",
                  isMiss ? "miss" : "",
                ].filter(Boolean).join(" ");

                return h(
                  "button",
                  {
                    key: `${x},${y}`,
                    className: cls,
                    disabled: !hasTile || locked || gameOver || !gameStarted,
                    onMouseEnter: () => onCellEnter(x, y),
                    onMouseLeave: onCellLeave,
                    onFocus: () => onCellEnter(x, y),
                    onBlur: onCellLeave,
                    onClick: () => onCellClick(x, y),
                    "aria-label": hasTile ? "brick" : "empty",
                  },
                  ""
                );
              })
            )
          )
        ),
        h(
          "div",
          { className: "nextRowFrame", style: nextRowStyle },
          h(
            "div",
            { className: "nextRow" },
            nextLine.map((tile, i) => {
              const revealed = i < nextReveal;
              const isBomb = tile.bomb && revealed;
              const cls = [
                "nextCell",
                revealed ? "brick" : "",
                revealed ? `t${tile.t}` : "",
                revealed ? "revealed" : "",
                isBomb ? "bomb" : "",
              ].filter(Boolean).join(" ");
              return h("div", { key: i, className: cls });
            })
          )
        )
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
