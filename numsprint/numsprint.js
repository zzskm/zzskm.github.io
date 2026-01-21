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
const AUTO_HINT_DELAY_MS = 2300;

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

const levelStart = (level) => (level - 1) * LEVEL_SIZE + 1;
const levelEnd = (level) => level * LEVEL_SIZE;

const buildLevelCells = (level) => {
  const start = levelStart(level);
  const nums = Array.from({ length: COUNT }, (_, i) => start + i);
  shuffle(nums);
  return nums.map((n, i) => ({
    id: `${level}-${i}-${n}`,
    value: n,
    hit: false,
    state: "",
  }));
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

function App() {
  const [cells, setCells] = useState(() => buildLevelCells(1));
  const [level, setLevel] = useState(1);
  const [target, setTarget] = useState(() => levelStart(1));
  const [locked, setLocked] = useState(false);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [timeLeftMs, setTimeLeftMs] = useState(TIME_LIMIT_MS);
  const [hintUntil, setHintUntil] = useState(0);
  const [hintReadyAt, setHintReadyAt] = useState(0);
  const [rerolling, setRerolling] = useState(false);

  const timeRef = useRef(now());
  const lastProgressRef = useRef(now());
  const rerollTimerRef = useRef(null);
  const audioEnabledRef = useRef(false);
  const autoStartRef = useRef(false);
  const lastStartSfxRef = useRef(0);

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

  // Mobile Safari 등에서 최초 1회 SFX가 누락되는 문제를 완화하기 위한 오디오 unlock
  const unlockAudio = () => {
    const ctx = getAudioCtx();
    if (!ctx) return;
    audioEnabledRef.current = true;

    // resume는 제스처 컨텍스트에서 호출되는 것이 중요 (await로 끊지 않음)
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    // 일부 브라우저는 무음 tick이 한 번 필요
    try {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.00001;
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
    } catch (e) {
      // ignore
    }
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
      const step = 0.035;
      for (let i = 0; i < tickCount; i += 1) {
        playTone(ctx, 660 + i * 40, 0.03, "square", i * step, baseGain * 0.6);
      }
      return;
    }

    if (kind === "over") {
      playTone(ctx, 196, 0.14, "sawtooth", 0, baseGain * 0.5);
      playTone(ctx, 147, 0.18, "sawtooth", 0.12, baseGain * 0.35);
      return;
    }

    if (kind === "start") {
      // Kick(저역) + 촘촘한 상승 아르페지오 + 하이라이트
      playTone(ctx, 196, 0.10, "sine", 0.00, baseGain * 1.2);

      const notes = [740, 932, 1110, 1245, 1480, 1760];
      const step = 0.035;
      for (let i = 0; i < notes.length; i += 1) {
        playTone(ctx, notes[i], 0.06, "triangle", 0.03 + i * step, baseGain * (0.95 - i * 0.08));
        if (i % 2 === 0) {
          playTone(ctx, notes[i] * 2, 0.03, "square", 0.03 + i * step, baseGain * 0.25);
        }
      }

      playTone(ctx, 1976, 0.07, "square", 0.03 + notes.length * step, baseGain * 0.55);
      return;
    }
  };

  const playStartSfx = () => {
    const t = now();
    if (t - lastStartSfxRef.current < 160) return;
    lastStartSfxRef.current = t;
    playSfx("start");
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

    // 최초 1회 SFX 누락 방지: await로 제스처 컨텍스트 끊지 않음
    unlockAudio();
    playStartSfx();

    setLocked(false);
    setLevel(1);
    setTarget(levelStart(1));
    setCells(buildLevelCells(1));
    setRerolling(false);
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

  useEffect(() => {
    const handleFirstInteraction = () => {
      if (autoStartRef.current) return;
      autoStartRef.current = true;
      unlockAudio();
      playStartSfx();
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

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") closeHelp();
      if (gameOver) return;

      if (e.key.toLowerCase() === "h") {
        if (now() >= hintReadyAt) {
          const until = now() + HINT_MS;
          setHintUntil(until);
          setHintReadyAt(now() + HINT_COOLDOWN_MS);
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
    playSfx("reroll");

    if (rerollTimerRef.current) clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = setTimeout(() => {
      setCells(buildLevelCells(level));
      setLocked(false);
      setRerolling(false);

      setTimeLeftMs((v) => clamp(v + REROLL_BONUS_MS, 0, TIME_LIMIT_MS));
    }, REROLL_DELAY_MS);
  };

  const handleHit = (cell) => {
    if (locked || gameOver || rerolling) return;

    if (cell.value === target) {
      playSfx("hit");
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
        toast(`LEVEL ${level + 1}`);
        setLocked(true);

        setTimeout(() => {
          const nl = level + 1;
          setLevel(nl);
          setTarget(levelStart(nl));
          setCells(buildLevelCells(nl));
          setLocked(false);

          setTimeLeftMs((v) => clamp(v + TIME_BONUS_MS, 0, TIME_LIMIT_MS));
        }, 200);
      } else {
        setTarget(next);
        setTimeLeftMs((v) => clamp(v + TIME_BONUS_MS, 0, TIME_LIMIT_MS));
      }
    } else {
      playSfx("miss");
      markCellTemp(cell.id, "bad");
      setScore((s) => Math.max(0, s - 6));
      setTimeLeftMs((v) => clamp(v - TIME_PENALTY_MS, 0, TIME_LIMIT_MS));
    }
  };

  const visibleHint = useMemo(() => now() < hintUntil, [hintUntil, target]);

  // auto swap drift: swap two random not-hit cells when no progress
  useEffect(() => {
    if (gameOver) return;

    const iv = setInterval(() => {
      if (locked || rerolling) return;

      const since = now() - lastProgressRef.current;
      if (since < AUTO_HINT_DELAY_MS) return;

      setCells((prev) => {
        const eligible = [];
        const nextValue = target;
        const nextPlusOne = target + 1;

        for (let i = 0; i < prev.length; i += 1) {
          const cell = prev[i];

          // hit 제외 + next / next+1 swap 금지
          if (cell.hit) continue;
          if (cell.value === nextValue) continue;
          if (cell.value === nextPlusOne) continue;

          eligible.push(i);
        }

        if (eligible.length < 2) return prev;

        const a = eligible[randInt(0, eligible.length - 1)];
        let b = eligible[randInt(0, eligible.length - 1)];
        if (a === b) b = eligible[(eligible.indexOf(a) + 1) % eligible.length];

        const nextArr = [...prev];
        const tmp = nextArr[a];
        nextArr[a] = nextArr[b];
        nextArr[b] = tmp;

        return nextArr;
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

  // UI (no JSX)
  return h(
    "div",
    { className: "app" },
    h(
      "div",
      { className: "top" },
      h(
        "div",
        { className: "titleRow" },
        h(
          "div",
          { className: "titleBlock" },
          h("h1", null, "NumSprint"),
          h("span", { className: "tag" }, "v1"),
          h("span", { className: "sub" }, "Tap numbers in order")
        ),
        h(
          "div",
          { className: "controls" },
          h(
            "button",
            { className: "btn", onClick: showHelp },
            "Help"
          ),
          h(
            "button",
            { className: "btn danger", onClick: reset },
            "Reset"
          ),
          h(
            "button",
            {
              className: "btn primary",
              onClick: requestReroll,
              disabled: locked || gameOver || rerolling,
            },
            "Reroll"
          )
        )
      ),
      h(
        "div",
        { className: "status" },
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
            { className: "stat scoreStat" },
            h("div", { className: "k" }, "SCORE"),
            h("div", { className: "v" }, String(score))
          )
        ),
        h(
          "div",
          { className: "stateLine" },
          h("span", { className: statePillClass }, locked ? "LOCK" : "LIVE"),
          h("span", { className: "pill" }, `LEVEL ${level}`)
        )
      ),
      h(
        "div",
        { className: "timeBar" },
        h(
          "div",
          { className: "timeBarRow" },
          h("div", { className: "timeLabel" }, "TIME"),
          h("div", { className: "timeLabel" }, timeText)
        ),
        h(
          "div",
          { className: "timeBarTrack" },
          h("div", {
            className: "timeBarFill",
            style: { width: `${progress * 100}%` },
          })
        )
      )
    ),
    h(
      "div",
      { className: "main" },
      h(
        "div",
        { className: "hudRow" },
        h(
          "div",
          { className: "hud" },
          h(
            "div",
            { className: "mini" },
            "Next: ",
            h("b", null, String(target))
          ),
          h(
            "div",
            { className: "mini" },
            "Hint: ",
            h("b", null, now() >= hintReadyAt ? "READY" : "COOLDOWN")
          )
        ),
        h(
          "div",
          { className: "hud" },
          h(
            "button",
            {
              className: "btn",
              onClick: () => {
                if (gameOver) return;
                if (now() >= hintReadyAt) {
                  const until = now() + HINT_MS;
                  setHintUntil(until);
                  setHintReadyAt(now() + HINT_COOLDOWN_MS);
                }
              },
              disabled: now() < hintReadyAt,
            },
            "Hint (H)"
          )
        )
      ),
      h(
        "div",
        { className: "boardWrap" },
        h(
          "div",
          { className: "board" },
          cells.map((cell) => {
            const isHint = visibleHint && cell.value === target;
            const cls = ["cell", cell.state, isHint ? "hint" : ""].filter(Boolean).join(" ");
            return h(
              "div",
              {
                key: cell.id,
                className: cls,
                onPointerDown: () => handleHit(cell),
                role: "button",
                tabIndex: 0,
              },
              String(cell.value),
              h("span", { className: "subnum" }, String(cell.value - levelStart(level) + 1))
            );
          })
        )
      ),
      h(
        "div",
        { className: "footer" },
        h("div", null, "R: reroll, H: hint"),
        h("div", null, gameOver ? "Try again" : "Keep going")
      )
    ),
    h("div", { className: "toast", ref: toastRef }),
    h(
      "div",
      { className: "modalBack", onPointerDown: closeHelp },
      h(
        "div",
        { className: "modal", onPointerDown: (e) => e.stopPropagation() },
        h(
          "div",
          { className: "modalHead" },
          h("h2", null, "How to play"),
          h(
            "button",
            { className: "btn", onClick: closeHelp },
            "Close"
          )
        ),
        h(
          "div",
          { className: "modalBody" },
          h(
            "p",
            null,
            "Tap numbers in ascending order as fast as possible within ",
            h("code", null, "30s"),
            "."
          ),
          h(
            "p",
            null,
            "If you get stuck, use ",
            h("code", null, "Hint (H)"),
            " to highlight the next number."
          ),
          h(
            "p",
            null,
            h("code", null, "Reroll (R)"),
            " reshuffles current level."
          ),
          h("p", null, "Cells may swap if you make no progress for a while. Keep moving.")
        ),
        h(
          "div",
          { className: "modalFoot" },
          h(
            "button",
            { className: "btn primary", onClick: closeHelp },
            "Got it"
          )
        )
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
