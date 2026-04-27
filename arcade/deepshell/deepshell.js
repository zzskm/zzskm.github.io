'use strict';
const { useState, useMemo, useRef } = React;
const h = React.createElement;

/* ── CONSTANTS ──────────────────────────── */
const COLS      = 8;
const GRID_ROWS = 8;
const UG_ROWS   = 4;
const TYPES     = 4;
const MIN_GROUP = 3;
const MAX_TURNS = 20;
const CHOICE_AT = 5;
const POP_MS    = 240;

/* ── ID GENERATOR ───────────────────────── */
function makeId() { let n = 1; return () => n++; }

/* ── BOUNDS ──────────────────────────────── */
function inBounds(r, c) {
  return r >= 0 && r < GRID_ROWS && c >= 0 && c < COLS;
}

function cloneGrid(g) { return g.map(row => row.slice()); }

/* ── TILE FACTORIES ──────────────────────── */
function makeTile(nextId) {
  return { id: nextId(), t: Math.random() * TYPES | 0, bomb: false };
}

function makeBomb(nextId) {
  return { id: nextId(), t: 0, bomb: true };
}

/* ── GRID GENERATION ─────────────────────── */
function seedGrid(nextId) {
  const g = Array.from({ length: GRID_ROWS }, () => Array(COLS).fill(null));
  for (let r = GRID_ROWS - 4; r < GRID_ROWS; r++)
    for (let c = 0; c < COLS; c++)
      g[r][c] = makeTile(nextId);
  return g;
}

/* ── UNDERGROUND GENERATION ──────────────── */
function makeUgTile(nextId, type) {
  if (type === 'stone') return { id: nextId(), type: 'stone', hp: 3, maxHp: 3 };
  const hp = Math.random() < 0.4 ? 2 : 1;
  return { id: nextId(), type: 'dirt', hp, maxHp: hp };
}

function generateUgRow(nextId, absDepth) {
  return Array.from({ length: COLS }, () => {
    if (absDepth === 0) return { id: nextId(), type: 'dirt', hp: 1, maxHp: 1 };
    if (absDepth === 1) {
      const hp = Math.random() < 0.35 ? 2 : 1;
      return { id: nextId(), type: 'dirt', hp, maxHp: hp };
    }
    const stonePct = Math.min(0.1 + (absDepth - 2) * 0.08, 0.52);
    if (Math.random() < stonePct) return makeUgTile(nextId, 'stone');
    return makeUgTile(nextId, 'dirt');
  });
}

function seedUnderground(nextId) {
  return Array.from({ length: UG_ROWS }, (_, i) => generateUgRow(nextId, i));
}

/* ── MATCH ───────────────────────────────── */
function floodFill(grid, sr, sc) {
  const start = grid[sr][sc];
  if (!start || start.bomb) return [[sr, sc]];
  const t = start.t;
  const seen = new Set();
  const q = [[sr, sc]];
  const out = [];
  while (q.length) {
    const [r, c] = q.shift();
    const k = r * 100 + c;
    if (seen.has(k)) continue;
    if (!inBounds(r, c)) continue;
    const tile = grid[r][c];
    if (!tile || tile.bomb || tile.t !== t) continue;
    seen.add(k);
    out.push([r, c]);
    q.push([r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]);
  }
  return out;
}

function hasAnyMatch(grid) {
  const checked = new Set();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = grid[r][c];
      if (!tile) continue;
      if (tile.bomb) return true;
      const k = r * 100 + c;
      if (checked.has(k)) continue;
      const group = floodFill(grid, r, c);
      for (const [gr, gc] of group) checked.add(gr * 100 + gc);
      if (group.length >= MIN_GROUP) return true;
    }
  }
  return false;
}

/* ── PHYSICS ─────────────────────────────── */
function applyGravity(grid) {
  const g = cloneGrid(grid);
  for (let c = 0; c < COLS; c++) {
    let w = GRID_ROWS - 1;
    for (let r = GRID_ROWS - 1; r >= 0; r--) {
      if (g[r][c]) { g[w][c] = g[r][c]; if (w !== r) g[r][c] = null; w--; }
    }
  }
  return g;
}

/* ── UNDERGROUND MECHANICS ───────────────── */
function strikeUg(ug, cols, dmgBonus) {
  const u = ug.map(row => row.map(t => t ? { ...t } : null));
  for (const col of cols) {
    for (let r = 0; r < u.length; r++) {
      if (u[r][col]) {
        u[r][col].hp -= 1 + dmgBonus;
        if (u[r][col].hp <= 0) u[r][col] = null;
        break;
      }
    }
  }
  return u;
}

function clearUg(ug, depth, nextId) {
  let u = ug.map(row => row.map(t => t ? { ...t } : null));
  let d = depth;
  while (u.length > 0 && u[0].every(t => t === null)) {
    u.shift();
    d++;
    u.push(generateUgRow(nextId, d + UG_ROWS - 1));
  }
  return { u, d };
}

/* ── APP ─────────────────────────────────── */
function App() {
  const nextIdRef = useRef(makeId());

  function buildInitState() {
    const nextId = nextIdRef.current;
    return {
      grid:       seedGrid(nextId),
      ug:         seedUnderground(nextId),
      depth:      0,
      turns:      MAX_TURNS,
      phase:      'playing',
      choiceUsed: false,
      dmgBonus:   0,
      hoverGroup: [],
      popIds:     new Set(),
      locked:     false,
      reason:     '',
    };
  }

  const [st, setSt] = useState(buildInitState);

  const hoverSet = useMemo(() => {
    const s = new Set();
    for (const [r, c] of st.hoverGroup) s.add(r * 100 + c);
    return s;
  }, [st.hoverGroup]);

  /* ── HOVER ── */
  const handleHover = (r, c) => {
    if (st.locked || st.phase !== 'playing') return;
    const tile = st.grid[r][c];
    if (!tile) { setSt(s => ({ ...s, hoverGroup: [] })); return; }
    if (tile.bomb) {
      const cells = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (inBounds(nr, nc)) cells.push([nr, nc]);
        }
      setSt(s => ({ ...s, hoverGroup: cells }));
    } else {
      const group = floodFill(st.grid, r, c);
      setSt(s => ({ ...s, hoverGroup: group.length >= MIN_GROUP ? group : [] }));
    }
  };

  const handleLeave = () => setSt(s => ({ ...s, hoverGroup: [] }));

  /* ── CLICK ── */
  const handleClick = (r, c) => {
    const { grid, ug, depth, turns, phase, locked, dmgBonus, choiceUsed } = st;
    if (locked || phase !== 'playing') return;
    const tile = grid[r][c];
    if (!tile) return;

    let cells;
    if (tile.bomb) {
      cells = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (inBounds(nr, nc) && grid[nr][nc]) cells.push([nr, nc]);
        }
    } else {
      cells = floodFill(grid, r, c);
      if (cells.length < MIN_GROUP) return;
    }

    const popIds = new Set(cells.map(([cr, cc]) => grid[cr][cc].id));
    setSt(s => ({ ...s, locked: true, hoverGroup: [], popIds }));

    // Compute next state (closure captures values at click time)
    const nextGrid = cloneGrid(grid);
    for (const [cr, cc] of cells) nextGrid[cr][cc] = null;
    const afterGravity = applyGravity(nextGrid);

    const struckCols = [...new Set(
      cells.filter(([cr]) => cr === GRID_ROWS - 1).map(([, cc]) => cc)
    )];
    const struckUg = struckCols.length
      ? strikeUg(ug, struckCols, dmgBonus)
      : ug.map(row => row.slice());
    const { u: clearedUg, d: newDepth } = clearUg(struckUg, depth, nextIdRef.current);
    const nextTurns = turns - 1;

    window.setTimeout(() => {
      const noMatch = !hasAnyMatch(afterGravity);
      if (nextTurns <= 0 || noMatch) {
        setSt(s => ({
          ...s,
          grid:   afterGravity,
          ug:     clearedUg,
          depth:  newDepth,
          turns:  nextTurns,
          phase:  'gameover',
          reason: nextTurns <= 0 ? '턴 소진' : '매치 없음',
          popIds: new Set(),
          locked: false,
        }));
        return;
      }
      const triggerChoice = !choiceUsed && newDepth >= CHOICE_AT;
      setSt(s => ({
        ...s,
        grid:   afterGravity,
        ug:     clearedUg,
        depth:  newDepth,
        turns:  nextTurns,
        phase:  triggerChoice ? 'choice' : 'playing',
        popIds: new Set(),
        locked: false,
      }));
    }, POP_MS);
  };

  /* ── CHOICE ── */
  const handleChoice = (opt) => {
    const { grid, ug, depth, dmgBonus } = st;
    const nextId = nextIdRef.current;
    let nextGrid = cloneGrid(grid);
    let nextUg   = ug.map(row => row.map(t => t ? { ...t } : null));
    let nextDmg  = dmgBonus;

    if (opt === 'A') {
      nextDmg++;
    } else if (opt === 'B') {
      for (let r = 0; r < nextUg.length; r++)
        for (let c = 0; c < COLS; c++)
          if (nextUg[r][c] && nextUg[r][c].type === 'stone') {
            nextUg[r][c].hp--;
            if (nextUg[r][c].hp <= 0) nextUg[r][c] = null;
          }
    } else {
      const empty = [];
      for (let r = 0; r < GRID_ROWS; r++)
        for (let c = 0; c < COLS; c++)
          if (!nextGrid[r][c]) empty.push([r, c]);
      if (empty.length) {
        const [br, bc] = empty[Math.random() * empty.length | 0];
        nextGrid[br][bc] = makeBomb(nextId);
      }
    }

    const { u, d } = opt === 'B'
      ? clearUg(nextUg, depth, nextId)
      : { u: nextUg, d: depth };

    setSt(s => ({
      ...s, grid: nextGrid, ug: u, depth: d,
      dmgBonus: nextDmg, choiceUsed: true, phase: 'playing',
    }));
  };

  /* ── RESTART ── */
  const handleRestart = () => {
    nextIdRef.current = makeId();
    setSt(buildInitState());
  };

  /* ── RENDER ── */
  return h('div', { className: 'wrap' },
    h(Header, { turns: st.turns, depth: st.depth, dmgBonus: st.dmgBonus }),
    h('div', { className: 'boardWrap' },
      h(GameGrid, {
        grid:      st.grid,
        hoverSet,
        popIds:    st.popIds,
        onHover:   handleHover,
        onLeave:   handleLeave,
        onClick:   handleClick,
        disabled:  st.locked || st.phase !== 'playing',
      }),
      h(SurfaceBar),
      h(Underground, { ug: st.ug }),
    ),
    st.phase === 'choice'   && h(ChoiceOverlay,   { onChoice: handleChoice }),
    st.phase === 'gameover' && h(GameOverOverlay, { depth: st.depth, reason: st.reason, onRestart: handleRestart }),
  );
}

/* ── HEADER ───────────────────────────────── */
function Header({ turns, depth, dmgBonus }) {
  return h('div', { className: 'top' },
    h('div', { className: 'titleBlock' },
      h('span', { className: 'tag' }, 'DRILL'),
      h('h1', null, 'DEEP // SHELL'),
      h('p', { className: 'sub' }, 'Purge the surface. Strike the subsurface.'),
    ),
    h('div', { className: 'hud' },
      h('div', { className: 'stat' },
        h('span', { className: 'stat-label' }, 'TURNS'),
        h('span', { className: `stat-val${turns <= 5 ? ' warn' : ''}` }, turns),
      ),
      h('div', { className: 'stat' },
        h('span', { className: 'stat-label' }, 'DEPTH'),
        h('span', { className: 'stat-val' }, depth),
      ),
      dmgBonus > 0 && h('div', { className: 'stat' },
        h('span', { className: 'stat-label' }, 'DMG+'),
        h('span', { className: 'stat-val accent' }, `+${dmgBonus}`),
      ),
    ),
  );
}

/* ── GAME GRID ────────────────────────────── */
function GameGrid({ grid, hoverSet, popIds, onHover, onLeave, onClick, disabled }) {
  const cells = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = grid[r][c];
      const isHover = hoverSet.has(r * 100 + c);
      const isPop   = tile && popIds.has(tile.id);
      const cls = ['cell'];
      if (tile) {
        cls.push('brick');
        if (tile.bomb) cls.push('bomb'); else cls.push(`t${tile.t}`);
        if (isHover) cls.push('hi');
        if (isPop)   cls.push('pop');
      } else {
        cls.push('empty');
      }
      cells.push(h('div', {
        key: tile ? tile.id : `e${r}-${c}`,
        className: cls.join(' '),
        onMouseEnter: !disabled && tile ? () => onHover(r, c) : undefined,
        onClick:      !disabled && tile ? () => onClick(r, c) : undefined,
      }));
    }
  }
  return h('div', {
    className: 'cell-grid',
    style: { gridTemplateColumns: `repeat(${COLS}, 1fr)` },
    onMouseLeave: onLeave,
  }, ...cells);
}

/* ── SURFACE BAR ──────────────────────────── */
function SurfaceBar() {
  return h('div', { className: 'surface-bar' },
    h('span', { className: 'surface-label' }, '▼  SURFACE  ▼'),
  );
}

/* ── UNDERGROUND ──────────────────────────── */
function Underground({ ug }) {
  const cells = [];
  for (let r = 0; r < ug.length; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = ug[r][c];
      const cls = ['ug-cell'];
      if (tile) {
        cls.push(tile.type);
        if (tile.hp < tile.maxHp) cls.push('dmg');
      } else {
        cls.push('empty');
      }
      cells.push(h('div', {
        key: tile ? tile.id : `ug${r}-${c}`,
        className: cls.join(' '),
      },
        tile && h('div', { className: 'pips' },
          ...Array.from({ length: tile.maxHp }, (_, i) =>
            h('span', { key: i, className: `pip ${i < tile.hp ? 'full' : 'spent'}` })
          )
        )
      ));
    }
  }
  return h('div', {
    className: 'ug-grid',
    style: { gridTemplateColumns: `repeat(${COLS}, 1fr)` },
  }, ...cells);
}

/* ── CHOICE OVERLAY ───────────────────────── */
const CHOICES = [
  { opt: 'A', title: 'OVERDRIVE', desc: '모든 지하 타격 +1 damage' },
  { opt: 'B', title: 'FRACTURE',  desc: '돌 타일 HP -1 즉시 적용' },
  { opt: 'C', title: 'CHARGE',    desc: '랜덤 위치에 폭탄 배치'   },
];

function ChoiceOverlay({ onChoice }) {
  return h('div', { className: 'overlay' },
    h('div', { className: 'overlay-panel' },
      h('div', { className: 'overlay-title' }, 'DEPTH BONUS'),
      h('p', { className: 'overlay-sub' }, '하나를 선택하라'),
      h('div', { className: 'choice-list' },
        ...CHOICES.map(({ opt, title, desc }) =>
          h('button', {
            key: opt,
            className: 'choice-card',
            onClick: () => onChoice(opt),
          },
            h('span', { className: 'choice-key' },   opt),
            h('span', { className: 'choice-title' }, title),
            h('span', { className: 'choice-desc' },  desc),
          )
        )
      ),
    ),
  );
}

/* ── GAMEOVER OVERLAY ─────────────────────── */
function GameOverOverlay({ depth, reason, onRestart }) {
  return h('div', { className: 'overlay' },
    h('div', { className: 'overlay-panel' },
      h('div', { className: 'overlay-title' }, 'TERMINATED'),
      h('p', { className: 'overlay-sub' }, reason),
      h('div', { className: 'result-row' },
        h('span', null, 'DEPTH REACHED'),
        h('span', { className: 'result-val' }, depth),
      ),
      h('button', { className: 'action-btn', onClick: onRestart }, 'RESTART'),
    ),
  );
}

/* ── MOUNT ────────────────────────────────── */
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
