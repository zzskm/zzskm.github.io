const { useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

const GRID = 4;
const COUNT = GRID * GRID;
const LEVEL_SIZE = COUNT;
const FEEDBACK_MS = 220;
const REROLL_DELAY_MS = 140;
const TIME_LIMIT_MS = 30000;
const TIME_BONUS_MS = 180;
const TIME_PENALTY_MS = 1400;
const REROLL_BONUS_MS = 1400;
const HINT_MS = 1100;
const HINT_COOLDOWN_MS = 2400;
const AUTO_DRIFT_DELAY_MS = 2200;

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const levelStart = level => (level - 1) * LEVEL_SIZE + 1;
const levelEnd   = level => level * LEVEL_SIZE;

const buildLevelCells = (level) => {
  const start = levelStart(level);
  const nums = Array.from({length: COUNT}, (_, i) => start + i);
  shuffle(nums);
  return nums.map((n, i) => ({
    id: `${level}-${i}-${n}`,
    value: n,
    hit: false,
    state: ""
  }));
};

// ──────────────────────────────────────────────── Audio
let audioCtx = null;
const getAudioCtx = () => {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  return audioCtx;
};

const playTone = (freq, dur, type = "square", when = 0, gain = 0.05) => {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
};

const playStartSfx = () => {
  const ctx = getAudioCtx();
  if (!ctx) return;

  // 저역 킥
  playTone(180, 0.09, "sine", 0.00, 0.12);

  // 상승 아르페지오 (더 촘촘 + 밝게)
  const notes = [659, 784, 880, 988, 1175, 1319, 1568];
  const step = 0.028;
  notes.forEach((f, i) => {
    playTone(f, 0.05, "triangle", 0.04 + i * step, 0.07 - i*0.006);
    if (i % 2 === 0) playTone(f * 1.5, 0.03, "square", 0.04 + i * step, 0.035);
  });

  // 마무리 하이라이트
  playTone(1760, 0.06, "square", 0.04 + notes.length * step, 0.08);
};

const unlockAudio = () => {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  // silent tick (iOS 등 최초 unlock 보장)
  playTone(200, 0.005, "sine", 0, 0.001);
};

function App() {
  const [cells, setCells] = useState(() => buildLevelCells(1));
  const [level, setLevel] = useState(1);
  const [target, setTarget] = useState(levelStart(1));
  const [locked, setLocked] = useState(false);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [timeLeftMs, setTimeLeftMs] = useState(TIME_LIMIT_MS);
  const [hintUntil, setHintUntil] = useState(0);
  const [hintReadyAt, setHintReadyAt] = useState(0);
  const [rerolling, setRerolling] = useState(false);

  const timeRef = useRef(now());
  const lastProgressRef = useRef(now());
  const audioUnlockedRef = useRef(false);

  const toastRef = useRef(null);
  const toast = msg => {
    const el = toastRef.current;
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 800);
  };

  const markCellTemp = (id, state) => {
    setCells(prev => prev.map(c => c.id === id ? {...c, state} : c));
    setTimeout(() => setCells(prev => prev.map(c => c.id === id ? {...c, state:""} : c)), FEEDBACK_MS);
  };

  const reset = () => {
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

    if (!audioUnlockedRef.current) {
      unlockAudio();
      audioUnlockedRef.current = true;
    }
    playStartSfx();
    toast("RESTART");
  };

  // 최초 제스처에서 오디오 unlock & 첫 사운드
  useEffect(() => {
    const handler = () => {
      if (audioUnlockedRef.current) return;
      unlockAudio();
      audioUnlockedRef.current = true;
      playStartSfx();
    };
    window.addEventListener("pointerdown", handler, {once: true});
    window.addEventListener("keydown", handler, {once: true});
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, []);

  // 시간 타이머
  useEffect(() => {
    if (gameOver) return;
    let raf;
    const tick = () => {
      const dt = now() - timeRef.current;
      timeRef.current += dt;
      setTimeLeftMs(v => {
        const nv = v - dt;
        if (nv <= 0) {
          setGameOver(true);
          setLocked(true);
          playTone(180, 0.16, "sawtooth", 0, 0.06);
          playTone(140, 0.20, "sawtooth", 0.08, 0.04);
          return 0;
        }
        return nv;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameOver]);

  // 키보드
  useEffect(() => {
    const onKey = e => {
      if (e.key === "Escape") document.querySelector(".modalBack")?.classList.remove("show");
      if (gameOver || locked || rerolling) return;

      if (e.key.toLowerCase() === "h" && now() >= hintReadyAt) {
        setHintUntil(now() + HINT_MS);
        setHintReadyAt(now() + HINT_COOLDOWN_MS);
      }
      if (e.key.toLowerCase() === "r") requestReroll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gameOver, locked, rerolling, hintReadyAt]);

  const requestReroll = () => {
    if (rerolling || locked) return;
    setRerolling(true); setLocked(true);
    // reroll 사운드 생략 (필요시 추가)

    setTimeout(() => {
      setCells(buildLevelCells(level));
      setRerolling(false); setLocked(false);
      setTimeLeftMs(v => clamp(v + REROLL_BONUS_MS, 0, TIME_LIMIT_MS));
      toast("REROLLED");
    }, REROLL_DELAY_MS);
  };

  const handleHit = cell => {
    if (locked || gameOver || rerolling) return;

    if (cell.value === target) {
      playTone(880, 0.04, "square", 0, 0.06);
      playTone(1320, 0.04, "square", 0.05, 0.05);
      markCellTemp(cell.id, "good");

      setCells(prev => prev.map(c => c.id === cell.id ? {...c, hit: true} : c));
      setScore(s => s + 10);
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
          setTimeLeftMs(v => clamp(v + TIME_BONUS_MS, 0, TIME_LIMIT_MS));
          playStartSfx(); // 레벨업도 start 느낌으로
        }, 180);
      } else {
        setTarget(next);
        setTimeLeftMs(v => clamp(v + TIME_BONUS_MS, 0, TIME_LIMIT_MS));
      }
    } else {
      playTone(220, 0.08, "square", 0, 0.055);
      playTone(180, 0.08, "square", 0.07, 0.04);
      markCellTemp(cell.id, "bad");
      setScore(s => Math.max(0, s - 6));
      setTimeLeftMs(v => clamp(v - TIME_PENALTY_MS, 0, TIME_LIMIT_MS));
    }
  };

  const visibleHint = now() < hintUntil;

  // Auto drift: next와 next+1 보호 강화
  useEffect(() => {
    if (gameOver) return;
    const iv = setInterval(() => {
      if (locked || rerolling) return;
      if (now() - lastProgressRef.current < AUTO_DRIFT_DELAY_MS) return;

      setCells(prev => {
        const eligible = [];
        const nextVal = target;
        const nextPlus = target + 1;

        prev.forEach((c, i) => {
          if (!c.hit && c.value !== nextVal && c.value !== nextPlus) {
            eligible.push(i);
          }
        });

        if (eligible.length < 2) return prev;

        let a = eligible[randInt(0, eligible.length - 1)];
        let b = eligible[randInt(0, eligible.length - 1)];
        if (a === b) b = eligible[(eligible.indexOf(a) + 1) % eligible.length];

        const nextArr = [...prev];
        [nextArr[a], nextArr[b]] = [nextArr[b], nextArr[a]];
        return nextArr;
      });
    }, 480);

    return () => clearInterval(iv);
  }, [gameOver, locked, rerolling, target]);

  const timeText = Math.ceil(timeLeftMs / 1000) + "s";
  const progress = clamp((TIME_LIMIT_MS - timeLeftMs) / TIME_LIMIT_MS, 0, 1);

  return h("div", {className: "app"},
    h("div", {className: "top"},
      h("div", {className: "titleRow"},
        h("div", {className: "titleBlock"},
          h("h1", null, "NumSprint"),
          h("span", {className: "tag"}, "v2"),
          h("span", {className: "sub"}, "Tap in order")
        ),
        h("div", {className: "controls"},
          h("button", {className: "btn", onClick: () => document.querySelector(".modalBack")?.classList.add("show")}, "Help"),
          h("button", {className: "btn danger", onClick: reset}, "Reset"),
          h("button", {className: "btn primary", onClick: requestReroll, disabled: locked||gameOver||rerolling}, "Reroll")
        )
      ),
      h("div", {className: "status"},
        h("div", {className: "stats"},
          h("div", {className: "stat"},
            h("div", {className: "k"}, "STATE"),
            h("div", {className: "v"}, gameOver ? "OVER" : locked ? "LOCKED" : "RUN")
          ),
          h("div", {className: "stat scoreStat"},
            h("div", {className: "k"}, "SCORE"),
            h("div", {className: "v"}, score)
          )
        ),
        h("div", {className: "stateLine"},
          h("span", {className: gameOver||locked ? "pill warn" : "pill ok"}, locked ? "LOCK" : "LIVE"),
          h("span", {className: "pill"}, `LV ${level}`)
        )
      ),
      h("div", {className: "timeBar"},
        h("div", {className: "timeBarRow"},
          h("div", null, "TIME"),
          h("div", null, timeText)
        ),
        h("div", {className: "timeBarTrack"},
          h("div", {className: "timeBarFill", style: {width: `${progress*100}%`}})
        )
      )
    ),

    h("div", {className: "main"},
      h("div", {className: "hudRow"},
        h("div", {className: "hud"},
          h("div", null, "Next: ", h("b", null, target)),
          h("div", null, "Hint: ", now() >= hintReadyAt ? "READY" : "WAIT")
        ),
        h("button", {
          className: "btn",
          onClick: () => {
            if (now() >= hintReadyAt) {
              setHintUntil(now() + HINT_MS);
              setHintReadyAt(now() + HINT_COOLDOWN_MS);
            }
          },
          disabled: now() < hintReadyAt
        }, "Hint (H)")
      ),

      h("div", {className: "board"},
        cells.map(cell => {
          const isHint = visibleHint && cell.value === target;
          const cls = ["cell", cell.state, isHint ? "hint" : "", cell.hit ? "lock" : ""].filter(Boolean).join(" ");
          return h("div", {
            key: cell.id,
            className: cls,
            onPointerDown: () => handleHit(cell)
          },
            cell.value,
            h("span", {className: "subnum"}, cell.value - levelStart(level) + 1)
          );
        })
      ),

      h("div", {className: "footer"}, gameOver ? "Game Over – Try again" : "R: Reroll  /  H: Hint")
    ),

    h("div", {className: "toast", ref: toastRef}),

    // Help Modal
    h("div", {className: "modalBack", onPointerDown: e => e.target.classList.remove("show")},
      h("div", {className: "modal", onPointerDown: e => e.stopPropagation()},
        h("div", {className: "modalHead"},
          h("h2", null, "How to Play"),
          h("button", {className: "btn", onClick: () => document.querySelector(".modalBack")?.classList.remove("show")}, "Close")
        ),
        h("div", {className: "modalBody"},
          h("p", null, "Tap numbers in ascending order as fast as possible."),
          h("p", null, "Time limit: 30 seconds"),
          h("p", null, "Hint (H) highlights the next number (cooldown)"),
          h("p", null, "Reroll (R) reshuffles the current level (+time bonus)"),
          h("p", null, "Stuck? Cells auto-swap gently after a while (next number protected)")
        )
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
