const { useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

const GRID = 4;
const LEVEL_SIZE = GRID * GRID;
const FEEDBACK_MS = 240;
const REROLL_DELAY_MS = 150;
const TIME_LIMIT_MS = 30000;
const TIME_BONUS_MS = 200;
const TIME_PENALTY_MS = 1500;
const REROLL_BONUS_MS = 1500;
const HINT_MS = 1200;
const HINT_COOLDOWN_MS = 2500;
const AUTO_HINT_DELAY_MS = 2000;

const now = () => Date.now();
const levelStart = (level) => (level - 1) * LEVEL_SIZE + 1;
const levelEnd = (level) => level * LEVEL_SIZE;

function shuffle(values) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function buildLevelCells(level) {
  const start = levelStart(level);
  const values = shuffle(Array.from({ length: LEVEL_SIZE }, (_, i) => start + i));
  return values.map((value, id) => ({
    id,
    value,
    hit: false,
    missUntil: 0,
  }));
}

function App() {
  const [cells, setCells] = useState(() => buildLevelCells(1));
  const [level, setLevel] = useState(1);
  const [target, setTarget] = useState(() => levelStart(1));
  const [locked, setLocked] = useState(false);
  const [rerolling, setRerolling] = useState(false);
  const [rerollTargetLevel, setRerollTargetLevel] = useState(null);
  const [tick, setTick] = useState(() => now());
  const [timeLeftMs, setTimeLeftMs] = useState(TIME_LIMIT_MS);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [score, setScore] = useState(0);
  const [hintUntil, setHintUntil] = useState(0);
  const [hintReadyAt, setHintReadyAt] = useState(0);
  const rerollTimerRef = useRef(null);  const timeRef = useRef(now());
  const audioRef = useRef(null);
  const audioEnabledRef = useRef(false);
  const lastStartSfxRef = useRef(0);
  const lastProgressRef = useRef(now());

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
      return ctx
        .resume()
        .then(() => warmUp())
        .catch(() => null);
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
    const baseGain = 0.04;
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
    if (kind === "reroll") {
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
      const g = baseGain * 1.15;
      playTone(ctx, 196, 0.26, "triangle", 0, g);
      playTone(ctx, 174, 0.3, "triangle", 0.12, g * 0.9);
      playTone(ctx, 146, 0.34, "triangle", 0.24, g * 0.85);
      playTone(ctx, 110, 0.48, "square", 0.18, g * 0.55);
      playTone(ctx, 98, 0.52, "square", 0.3, g * 0.45);
      return;
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
    const leadGain = 0.035;
    const bassGain = 0.024;
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
  useEffect(() => {
    if (!gameStarted || gameOver) return;
    const id = setInterval(() => {
      const t = now();
      const delta = t - timeRef.current;
      timeRef.current = t;
      setTick(t);
      setTimeLeftMs((prev) => Math.max(0, prev - delta));
    }, 80);
    return () => clearInterval(id);
  }, [gameStarted, gameOver]);

  useEffect(() => {
    return () => {
      if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!gameStarted || timeLeftMs > 0 || gameOver) return;
    setGameOver(true);
    setLocked(true);
    setRerolling(false);
    setRerollTargetLevel(null);
    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = null;
    playSfx("gameover");
  }, [gameStarted, timeLeftMs, gameOver]);

  const reset = () => {
    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = null;
    setGameStarted(true);
    unlockAudio().then((ctx) => {
      if (ctx) playStartSfx();
    });
    setLocked(false);
    setLevel(1);
    setTarget(levelStart(1));
    setCells(buildLevelCells(1));
    setRerolling(false);
    setRerollTargetLevel(null);
    setScore(0);
    setGameOver(false);
    setTimeLeftMs(TIME_LIMIT_MS);
    setHintUntil(0);
    setHintReadyAt(0);
    lastProgressRef.current = now();
    timeRef.current = now();
  };

  const startGame = () => {
    if (gameStarted) return;
    reset();
  };

  const scheduleReroll = (nextLevel) => {
    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    setLocked(true);
    setRerolling(true);
    setRerollTargetLevel(nextLevel);
    adjustTime(REROLL_BONUS_MS);
    playSfx("reroll");
    rerollTimerRef.current = setTimeout(() => {
      setCells(buildLevelCells(nextLevel));
      setTarget(levelStart(nextLevel));
      setLevel(nextLevel);
      setLocked(false);
      setRerolling(false);
      setRerollTargetLevel(null);
    }, REROLL_DELAY_MS);
  };

  const markCell = (id, kind) => {
    const t = now();
    setCells((prev) =>
      prev.map((c) =>
        c.id !== id
          ? c
          : {
            ...c,
            hit: kind === "hit" ? true : c.hit,
            missUntil: kind === "miss" ? t + FEEDBACK_MS : 0,
          }
      )
    );
  };

  const adjustTime = (deltaMs) => {
    setTimeLeftMs((prev) => Math.max(0, Math.min(TIME_LIMIT_MS, prev + deltaMs)));
  };

  const triggerHint = (t = now()) => {
    if (t < hintReadyAt) return false;
    setHintUntil(t + HINT_MS);
    setHintReadyAt(t + HINT_COOLDOWN_MS);
    return true;
  };

  const swapIntervalMs = Math.max(350, 1600 - level * 110);

  useEffect(() => {
    lastProgressRef.current = now();
  }, [target]);

  useEffect(() => {
    if (!gameStarted || locked || rerolling || gameOver) return;
    if (tick - lastProgressRef.current < AUTO_HINT_DELAY_MS) return;
    if (tick < hintReadyAt) return;
    if (triggerHint(tick)) lastProgressRef.current = tick;
  }, [gameOver, gameStarted, hintReadyAt, locked, rerolling, tick]);

  useEffect(() => {
    if (!gameStarted || locked || rerolling || gameOver) return;
    const id = setInterval(() => {
      setCells((prev) => {
        const eligible = [];
        for (let i = 0; i < prev.length; i += 1) {
          const cell = prev[i];
          if (!cell.hit && cell.value !== target && cell.value !== target + 1) eligible.push(i);
        }
        if (eligible.length < 2) return prev;
        const firstIndex = eligible[(Math.random() * eligible.length) | 0];
        let secondIndex = firstIndex;
        while (secondIndex === firstIndex) {
          secondIndex = eligible[(Math.random() * eligible.length) | 0];
        }
        const firstValue = prev[firstIndex].value;
        const secondValue = prev[secondIndex].value;
        return prev.map((cell, idx) => {
          if (idx === firstIndex) return { ...cell, value: secondValue };
          if (idx === secondIndex) return { ...cell, value: firstValue };
          return cell;
        });
      });
    }, swapIntervalMs);
    return () => clearInterval(id);
  }, [gameOver, gameStarted, locked, rerolling, swapIntervalMs, target]);

  const onCellClick = (cell) => {
    if (!gameStarted || locked || gameOver || cell.hit) return;
    unlockAudio();
    if (cell.value !== target) {
      markCell(cell.id, "miss");
      adjustTime(-TIME_PENALTY_MS);
      playSfx("miss");
      return;
    }

    markCell(cell.id, "hit");
    adjustTime(TIME_BONUS_MS);
    setScore((prev) => prev + cell.value);
    playSfx("hit");
    lastProgressRef.current = now();

    if (target >= levelEnd(level)) {
      scheduleReroll(level + 1);
      return;
    }

    setTarget(target + 1);
  };

  const rangeStart = levelStart(level);
  const rangeEnd = levelEnd(level);
  const statusText = gameOver ? "GAME OVER" : !gameStarted ? "PRESS START" : rerolling ? "REROLLING" : "READY";
  const subText = `Pick numbers from ${rangeStart} to ${rangeEnd} in order. Finish to advance.`;
  const timeText = (timeLeftMs / 1000).toFixed(1);
  const scoreText = String(score);
  const timePercent = Math.max(0, Math.min(1, timeLeftMs / TIME_LIMIT_MS));
  const controlsLocked = !gameStarted || locked || gameOver;
  const visualLocked = !gameStarted || gameOver || (locked && !rerolling);
  const lockTitle = gameOver ? "GAME OVER" : !gameStarted ? "PRESS START" : rerolling ? "REROLLING" : "LOCKED";
  const hintActive = hintUntil > tick;
  const hintDisabled = controlsLocked || tick < hintReadyAt;
  const rollStep = (tick / 50) | 0;
  const rollLevel = rerollTargetLevel ?? level;
  const rollStart = levelStart(rollLevel);
  const getRerollValue = (cellId) => {
    const seed = (rollStep + cellId * 13) >>> 0;
    const scramble = (seed * 1664525 + 1013904223) >>> 0;
    return rollStart + (scramble % LEVEL_SIZE);
  };
  const gridClassName = ["grid", rerolling ? "rerolling" : ""].join(" ").trim();
  const showStart = !gameStarted;

  const gridCells = useMemo(
    () =>
      cells.map((cell) => {
        const hit = cell.hit;
        const miss = cell.missUntil > tick;
        const displayValue = rerolling ? getRerollValue(cell.id) : cell.value;
        const hint = hintActive && cell.value === target && !cell.hit && !rerolling;
        const rerollStyle = rerolling
          ? {
            "--reroll-delay": `${(cell.id * 37) % 120}ms`,
            "--reroll-speed": `${360 + ((cell.id * 29) % 180)}ms`,
          }
          : undefined;
        const cls = [
          "cell",
          visualLocked ? "locked" : "",
          hit ? "hit" : "",
          miss ? "miss" : "",
          hint ? "hint" : "",
        ]
          .join(" ")
          .trim();

        return h(
          "button",
          {
            key: cell.id,
            type: "button",
            className: cls,
            onClick: () => onCellClick(cell),
            disabled: controlsLocked,
            "aria-label": `Number ${displayValue}`,
            title: controlsLocked ? lockTitle : `N:${displayValue}`,
          },
          h(
            "span",
            {
              className: "num",
              "data-digits": String(displayValue).length,
              style: rerollStyle,
            },
            displayValue
          )
        );
      }),
    [cells, controlsLocked, hintActive, rerolling, rerollTargetLevel, target, level, tick]
  );

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
        h("h1", null, "NUMSPRINT"),
        h("p", { className: "sub" }, subText)
      ),
      h(
        "div",
        { className: "btns" },
        h("button", { className: "controlBtn primary", onClick: reset, disabled: !gameStarted }, "RESTART"),
        h(
          "button",
          {
            className: "controlBtn secondary",
            onClick: triggerHint,
            disabled: hintDisabled,
            title: hintDisabled ? "HINT COOLDOWN" : "SHOW HINT",
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
          h("div", { className: "targetLabel" }, "TARGET"),
          h("div", { className: "targetNum" }, target),
          h("div", { className: "targetMini" }, `LEVEL ${level}`)
        ),
        h(
          "div",
          { className: "stats" },
          h(
            "div",
            { className: "stat" },
            h("div", { className: "k" }, "STATE"),
            h("div", { className: "v" }, statusText)
          ),
          h(
            "div",
            { className: "stat scoreStat" },
            h("div", { className: "k" }, "SCORE"),
            h("div", { className: "v" }, scoreText)
          ),
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
        { className: "gridOuter" },
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
        h("div", { className: gridClassName, role: "grid", "aria-label": "number grid" }, gridCells)
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
