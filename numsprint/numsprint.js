const { useEffect, useMemo, useRef, useState } = React;
const COUNT = 36;
const COLS = 6;
const TIME_LIMIT_MS = 60_000;

const FEEDBACK_MS = 240;
const REROLL_DELAY_MS = 720;

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
};

const levelStart = (level) => (level - 1) * COUNT + 1;
const levelEnd = (level) => level * COUNT;

const buildLevelCells = (level) => {
  const start = levelStart(level);
  const nums = Array.from({ length: COUNT }, (_, i) => start + i);
  shuffle(nums);

  const cells = nums.map((n, i) => ({
    id: `${level}-${i}-${n}`,
    value: n,
    hit: false,
    state: "",
  }));

  return cells;
};

// audio
let audioCtxSingleton = null;
const getAudioCtx = () => {
  if (audioCtxSingleton) return audioCtxSingleton;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtxSingleton = new Ctx();
  return audioCtxSingleton;
};

const playTone = (ctx, freq, dur, type, when = 0, gain = 0.06) => {
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;

  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
};

const App = () => {
  const [level, setLevel] = useState(1);
  const [target, setTarget] = useState(levelStart(1));
  const [cells, setCells] = useState(() => buildLevelCells(1));
  const [locked, setLocked] = useState(false);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [timeLeftMs, setTimeLeftMs] = useState(TIME_LIMIT_MS);
  const [hintUntil, setHintUntil] = useState(0);
  const [hintReadyAt, setHintReadyAt] = useState(0);
  const [rerolling, setRerolling] = useState(false);
  const [rerollTargetLevel, setRerollTargetLevel] = useState(null);

  const timeRef = useRef(now());
  const lastProgressRef = useRef(now());
  const rerollTimerRef = useRef(null);
  const audioEnabledRef = useRef(false);
  const firstInteractionRef = useRef(false);

  const enableAudio = async () => {
    const ctx = getAudioCtx();
    if (!ctx) return;
    audioEnabledRef.current = true;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (_) {}
    }
  };

  const playSfx = (kind) => {
    if (!audioEnabledRef.current) return;
    const ctx = getAudioCtx();
    if (!ctx) return;

    const baseGain = 0.06;

    if (kind === "start") {
      playTone(ctx, 740, 0.05, "square", 0, baseGain * 0.7);
      playTone(ctx, 988, 0.05, "square", 0.05, baseGain * 0.6);
      playTone(ctx, 1245, 0.05, "square", 0.1, baseGain * 0.55);
      playTone(ctx, 1480, 0.05, "square", 0.15, baseGain * 0.5);
    } else if (kind === "good") {
      playTone(ctx, 880, 0.06, "triangle", 0, baseGain * 0.75);
      playTone(ctx, 1320, 0.06, "triangle", 0.04, baseGain * 0.55);
    } else if (kind === "bad") {
      playTone(ctx, 200, 0.12, "sawtooth", 0, baseGain * 0.35);
    } else if (kind === "levelup") {
      playTone(ctx, 660, 0.06, "square", 0, baseGain * 0.6);
      playTone(ctx, 880, 0.06, "square", 0.05, baseGain * 0.55);
      playTone(ctx, 1180, 0.06, "square", 0.1, baseGain * 0.5);
    } else if (kind === "reroll") {
      playTone(ctx, 520, 0.08, "triangle", 0, baseGain * 0.55);
      playTone(ctx, 390, 0.12, "triangle", 0.06, baseGain * 0.45);
    } else if (kind === "over") {
      playTone(ctx, 260, 0.14, "sawtooth", 0, baseGain * 0.35);
      playTone(ctx, 180, 0.16, "sawtooth", 0.12, baseGain * 0.25);
    }
  };

  const toastRef = useRef(null);
  const toast = (msg) => {
    const el = toastRef.current;
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 900);
  };

  const markCellTemp = (id, state) => {
    setCells((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        return { ...c, state };
      })
    );
    setTimeout(() => {
      setCells((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c;
          return { ...c, state: "" };
        })
      );
    }, FEEDBACK_MS);
  };

  const reset = async () => {
    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = null;

    await enableAudio();
    playSfx("start");

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

  const showHelp = () => {
    const back = document.querySelector(".modalBack");
    if (!back) return;
    back.classList.add("show");
  };

  const closeHelp = () => {
    const back = document.querySelector(".modalBack");
    if (!back) return;
    back.classList.remove("show");
  };

  // initial audio unlock on first interaction
  useEffect(() => {
    const handleFirstInteraction = async () => {
      if (firstInteractionRef.current) return;
      firstInteractionRef.current = true;
      await enableAudio();
      playSfx("start");
    };

    window.addEventListener("pointerdown", handleFirstInteraction, { once: true });
    window.addEventListener("keydown", handleFirstInteraction, { once: true });

    return () => {
      window.removeEventListener("pointerdown", handleFirstInteraction);
      window.removeEventListener("keydown", handleFirstInteraction);
    };
  }, []);

  const progress = useMemo(() => {
    const elapsed = TIME_LIMIT_MS - timeLeftMs;
    return clamp(elapsed / TIME_LIMIT_MS, 0, 1);
  }, [timeLeftMs]);

  const stateText = useMemo(() => {
    if (gameOver) return "GAME OVER";
    if (locked) return "LOCKED";
    if (rerolling) return "REROLL…";
    return "RUN";
  }, [gameOver, locked, rerolling]);

  // timer
  useEffect(() => {
    if (gameOver) return;

    let raf = 0;
    const tick = () => {
      const t = now();
      const dt = t - timeRef.current;
      timeRef.current = t;

      setTimeLeftMs((v) => {
        const nv = v - dt;
        if (nv <= 0) {
          // end
          setGameOver(true);
          setLocked(true);
          playSfx("over");
          return 0;
        }
        return nv;
      });

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(() => {
      timeRef.current = now();
      tick();
    });

    return () => cancelAnimationFrame(raf);
  }, [gameOver]);

  // keyboard: H hint, R reroll
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") closeHelp();
      if (gameOver) return;
      if (e.key.toLowerCase() === "h") {
        if (now() >= hintReadyAt) {
          const until = now() + 1700;
          setHintUntil(until);
          setHintReadyAt(now() + 3500);
        }
      }
      if (e.key.toLowerCase() === "r") {
        if (!rerolling && !locked) {
          requestReroll();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gameOver, hintReadyAt, rerolling, locked]);

  const requestReroll = () => {
    setRerolling(true);
    setLocked(true);
    setRerollTargetLevel(level);
    playSfx("reroll");

    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = setTimeout(() => {
      setCells(buildLevelCells(level));
      setLocked(false);
      setRerolling(false);
      setRerollTargetLevel(null);
    }, REROLL_DELAY_MS);
  };

  const handleHit = (cell) => {
    if (locked || gameOver || rerolling) return;

    if (cell.value === target) {
      // correct
      playSfx("good");
      markCellTemp(cell.id, "good");
      setCells((prev) =>
        prev.map((c) => {
          if (c.id !== cell.id) return c;
          return { ...c, hit: true, state: "good" };
        })
      );

      setScore((s) => s + 10);
      lastProgressRef.current = now();

      const next = target + 1;
      if (next > levelEnd(level)) {
        // level complete
        playSfx("levelup");
        toast(`LEVEL ${level + 1}`);
        setLocked(true);

        setTimeout(() => {
          const nl = level + 1;
          setLevel(nl);
          setTarget(levelStart(nl));
          setCells(buildLevelCells(nl));
          setLocked(false);
        }, 240);
      } else {
        setTarget(next);
      }
    } else {
      // wrong
      playSfx("bad");
      markCellTemp(cell.id, "bad");
      setScore((s) => Math.max(0, s - 6));
    }
  };

  const visibleHint = useMemo(() => now() < hintUntil, [hintUntil, target]);

  // auto swap drift: swap two random not-hit cells when no progress
  useEffect(() => {
    if (gameOver) return;

    const iv = setInterval(() => {
      if (locked || rerolling) return;

      const since = now() - lastProgressRef.current;
      if (since < 1600) return;

      setCells((prev) => {
        const eligible = [];
        for (let i = 0; i < prev.length; i += 1) {
          const cell = prev[i];
          if (!cell.hit && cell.value !== target) eligible.push(i);
        }
        if (eligible.length < 2) return prev;

        const a = eligible[randInt(0, eligible.length - 1)];
        let b = eligible[randInt(0, eligible.length - 1)];
        if (a === b) b = eligible[(eligible.indexOf(a) + 1) % eligible.length];

        const next = [...prev];
        const tmp = next[a];
        next[a] = next[b];
        next[b] = tmp;

        return next;
      });
    }, 520);

    return () => clearInterval(iv);
  }, [gameOver, locked, rerolling, target]);

  const statePillClass = useMemo(() => {
    if (gameOver) return "pill warn";
    if (locked || rerolling) return "pill warn";
    return "pill ok";
  }, [gameOver, locked, rerolling]);

  const timeText = useMemo(() => {
    const s = Math.ceil(timeLeftMs / 1000);
    return `${s}s`;
  }, [timeLeftMs]);

  return (
    <div className="app">
      <div className="top">
        <div className="titleRow">
          <div className="titleBlock">
            <h1>NumSprint</h1>
            <span className="tag">v1</span>
            <span className="sub">Tap numbers in order</span>
          </div>
          <div className="controls">
            <button className="btn" onClick={showHelp}>
              Help
            </button>
            <button className="btn danger" onClick={reset}>
              Reset
            </button>
            <button className="btn primary" onClick={requestReroll} disabled={locked || gameOver || rerolling}>
              Reroll
            </button>
          </div>
        </div>

        <div className="status">
          <div className="stats">
            <div className="stat">
              <div className="k">STATE</div>
              <div className="v">{stateText}</div>
            </div>
            <div className="stat scoreStat">
              <div className="k">SCORE</div>
              <div className="v">{score}</div>
            </div>
          </div>

          <div className="stateLine">
            <span className={statePillClass}>{locked ? "LOCK" : "LIVE"}</span>
            <span className="pill">{`LEVEL ${level}`}</span>
          </div>
        </div>

        <div className="timeBar">
          <div className="timeBarRow">
            <div className="timeLabel">TIME</div>
            <div className="timeLabel">{timeText}</div>
          </div>
          <div className="timeBarTrack">
            <div className="timeBarFill" style={{ width: `${progress * 100}%` }}></div>
          </div>
        </div>
      </div>

      <div className="main">
        <div className="hudRow">
          <div className="hud">
            <div className="mini">
              Next: <b>{target}</b>
            </div>
            <div className="mini">
              Hint: <b>{now() >= hintReadyAt ? "READY" : "COOLDOWN"}</b>
            </div>
          </div>
          <div className="hud">
            <button
              className="btn"
              onClick={() => {
                if (gameOver) return;
                if (now() >= hintReadyAt) {
                  const until = now() + 1700;
                  setHintUntil(until);
                  setHintReadyAt(now() + 3500);
                }
              }}
              disabled={now() < hintReadyAt}
            >
              Hint (H)
            </button>
          </div>
        </div>

        <div className="boardWrap">
          <div className="board">
            {cells.map((cell) => {
              const isHint = visibleHint && cell.value === target;
              const cls = ["cell", cell.state, isHint ? "hint" : "", cell.value > target ? "" : ""].filter(Boolean).join(" ");
              return (
                <div
                  key={cell.id}
                  className={cls}
                  onPointerDown={() => handleHit(cell)}
                  role="button"
                  tabIndex={0}
                >
                  {cell.value}
                  <span className="subnum">{cell.value - levelStart(level) + 1}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="footer">
          <div>R: reroll, H: hint</div>
          <div>
            {rerolling ? `Rerolling L${rerollTargetLevel ?? ""}…` : gameOver ? "Try again" : "Keep going"}
          </div>
        </div>
      </div>

      <div className="toast" ref={toastRef}></div>

      <div className="modalBack" onPointerDown={closeHelp}>
        <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
          <div className="modalHead">
            <h2>How to play</h2>
            <button className="btn" onClick={closeHelp}>
              Close
            </button>
          </div>
          <div className="modalBody">
            <p>
              Tap numbers in ascending order as fast as possible within <code>60s</code>.
            </p>
            <p>
              If you get stuck, use <code>Hint (H)</code> to highlight the next number.
            </p>
            <p>
              <code>Reroll (R)</code> reshuffles current level.
            </p>
            <p>
              Cells may swap if you make no progress for a while. Keep moving.
            </p>
          </div>
          <div className="modalFoot">
            <button className="btn primary" onClick={closeHelp}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
