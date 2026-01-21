const { useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

const GRID = 4;
const COUNT = GRID * GRID;
const LEVEL_SIZE = COUNT;
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
  const t = now();
  const start = levelStart(level);
  const values = shuffle(Array.from({ length: LEVEL_SIZE }, (_, i) => start + i));
  return values.map((value, id) => ({
    id,
    value,
    touchedAt: t,
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
  const [score, setScore] = useState(0);
  const [hintUntil, setHintUntil] = useState(0);
  const [hintReadyAt, setHintReadyAt] = useState(0);
  const rerollTimerRef = useRef(null);
  const gameOverRef = useRef(false);
  const timeRef = useRef(now());
  const audioRef = useRef(null);
  const audioEnabledRef = useRef(false);
  const autoStartRef = useRef(false);
  const lastStartSfxRef = useRef(0);
  const lastProgressRef = useRef(now());

  const getAudioCtx = () => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioRef.current) audioRef.current = new AudioCtx();
    return audioRef.current;
  };

  // Make enableAudio async and await resume() so start SFX plays reliably.
  const enableAudio = async () => {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
    } catch (err) {
      // ignore resume errors
    }
    audioEnabledRef.current = true;
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
      const tickCount = Math.max(3, Math.round(REROLL_DELAY_MS / 60));
      const spacing = 0.04;
      for (let i = 0; i < tickCount; i += 1) {
        playTone(ctx, 520 + i * 90, 0.04, "square", i * spacing, baseGain * 0.6);
      }
      return;
    }
    if (kind === "gameover") {
      playTone(ctx, 440, 0.12, "square", 0, baseGain * 0.7);
      playTone(ctx, 330, 0.12, "square", 0.12, baseGain * 0.6);
      playTone(ctx, 220, 0.14, "square", 0.24, baseGain * 0.5);
      return;
    }
    if (kind === "start") {
      playTone(ctx, 740, 0.05, "square", 0, baseGain * 0.7);
      playTone(ctx, 988, 0.05, "square", 0.05, baseGain * 0.6);
      playTone(ctx, 1245, 0.05, "square", 0.1, baseGain * 0.55);
      playTone(ctx, 1480, 0.05, "square", 0.15, baseGain * 0.5);
    }
  };

  const playStartSfx = () => {
    const t = now();
    if (t - lastStartSfxRef.current < 160) return;
    lastStartSfxRef.current = t;
    playSfx("start");
  };

  useEffect(() => {
    // make handler async so we await enableAudio before playing
    const handleFirstInteraction = async () => {
      if (autoStartRef.current) return;
      autoStartRef.current = true;
      await enableAudio();
      playStartSfx();
    };
    window.addEventListener("pointerdown", handleFirstInteraction, { once: true });
    window.addEventListener("keydown", handleFirstInteraction, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handleFirstInteraction);
      window.removeEventListener("keydown", handleFirstInteraction);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const t = now();
      const delta = t - timeRef.current;
      timeRef.current = t;
      setTick(t);
      if (!gameOverRef.current) {
        setTimeLeftMs((prev) => Math.max(0, prev - delta));
      }
    }, 80);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    gameOverRef.current = gameOver;
  }, [gameOver]);

  useEffect(() => {
    return () => {
      if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (timeLeftMs > 0 || gameOver) return;
    setGameOver(true);
    setLocked(true);
    setRerolling(false);
    setRerollTargetLevel(null);
    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = null;
    playSfx("gameover");
  }, [timeLeftMs, gameOver]);

  // make reset async so it awaits enableAudio before playing start sfx
  const reset = async () => {
    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = null;
    await enableAudio();
    playStartSfx();
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

  const triggerHint = (triggeredAt = now()) => {
    if (locked || rerolling || gameOver) return false;
    if (triggeredAt < hintReadyAt) return false;
    setHintUntil(triggeredAt + HINT_MS);
    setHintReadyAt(triggeredAt + HINT_COOLDOWN_MS);
    return true;
  };

  const swapIntervalMs = Math.max(350, 1600 - level * 110);

  useEffect(() => {
    lastProgressRef.current = now();
  }, [target]);

  useEffect(() => {
    if (locked || rerolling || gameOver) return;
    if (tick - lastProgressRef.current < AUTO_HINT_DELAY_MS) return;
    if (tick < hintReadyAt) return;
    if (triggerHint(tick)) lastProgressRef.current = tick;
  }, [gameOver, hintReadyAt, locked, rerolling, tick]);

  useEffect(() => {
    if (locked || rerolling || gameOver) return;
    const id = setInterval(() => {
      setCells((prev) => {
        const eligible = [];
        for (let i = 0; i < prev.length; i += 1) {
          const cell = prev[i];
          if (!cell.hit && cell.value !== target) eligible.push(i);
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
  }, [gameOver, locked, rerolling, swapIntervalMs, target]);

  const onCellClick = (cell) => {
    if (locked || gameOver || cell.hit) return;
    enableAudio();
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
  const statusText = gameOver ? "GAME OVER" : rerolling ? "REROLLING" : "READY";
  const subText = `Pick numbers from ${rangeStart} to ${rangeEnd} in order. Finish to advance.`;
  const timeText = (timeLeftMs / 1000).toFixed(1);
  const scoreText = String(score);
  const timePercent = Math.max(0, Math.min(1, timeLeftMs / TIME_LIMIT_MS));
  const controlsLocked = locked || gameOver;
  const visualLocked = gameOver || (locked && !rerolling);
  const lockTitle = rerolling ? "REROLLING" : gameOver ? "GAME OVER" : "LOCKED";
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
        h("button", { className: "controlBtn primary", onClick: reset }, "RESTART"),
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
        h("div", { className: gridClassName, role: "grid", "aria-label": "number grid" }, gridCells)
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));