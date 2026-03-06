(() => {
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function lerp(a, b, t) {
    return a + ((b - a) * t);
  }

  function makeNoiseBuffer(ac, seconds = 0.24, brown = false) {
    const length = Math.max(1, Math.floor(ac.sampleRate * seconds));
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);

    if (!brown) {
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2) - 1;
      return buffer;
    }

    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = (Math.random() * 2) - 1;
      last = (last + (0.02 * white)) / 1.02;
      data[i] = clamp(last * 3.5, -1, 1);
    }
    return buffer;
  }

  function makeSoftClipper(ac, drive = 2.1) {
    const ws = ac.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i * 2) / (n - 1)) - 1;
      curve[i] = Math.tanh(drive * x);
    }
    ws.curve = curve;
    ws.oversample = "2x";
    return ws;
  }

  function buildMasterChain(ac) {
    const master = ac.createGain();
    master.gain.value = 0.5;

    const outComp = ac.createDynamicsCompressor();
    outComp.threshold.value = -18;
    outComp.knee.value = 20;
    outComp.ratio.value = 2.5;
    outComp.attack.value = 0.01;
    outComp.release.value = 0.16;

    master.connect(outComp);
    outComp.connect(ac.destination);
    return { master, outComp };
  }

  function buildBuses(ac) {
    const motor = ac.createGain();
    const tick = ac.createGain();
    const impact = ac.createGain();
    const win = ac.createGain();

    motor.gain.value = 0.45;
    tick.gain.value = 0.82;
    impact.gain.value = 1;
    win.gain.value = 1;

    return { motor, tick, impact, win };
  }

  function buildMechChain(ac) {
    const motorComp = ac.createDynamicsCompressor();
    motorComp.threshold.value = -26;
    motorComp.knee.value = 18;
    motorComp.ratio.value = 3;
    motorComp.attack.value = 0.02;
    motorComp.release.value = 0.16;

    const motorToneTamer = ac.createBiquadFilter();
    motorToneTamer.type = "lowpass";
    motorToneTamer.frequency.value = 560;
    motorToneTamer.Q.value = 0.22;

    const tickToneTamer = ac.createBiquadFilter();
    tickToneTamer.type = "lowpass";
    tickToneTamer.frequency.value = 1250;
    tickToneTamer.Q.value = 0.35;

    const mechMix = ac.createGain();
    mechMix.gain.value = 1;

    const mechDrive = makeSoftClipper(ac, 2.2);

    const mechComp = ac.createDynamicsCompressor();
    mechComp.threshold.value = -24;
    mechComp.knee.value = 18;
    mechComp.ratio.value = 3;
    mechComp.attack.value = 0.008;
    mechComp.release.value = 0.12;

    return {
      motorComp,
      motorToneTamer,
      tickToneTamer,
      mechMix,
      mechDrive,
      mechComp,
    };
  }

  function wireGraph(graph) {
    const { buses, mech, master } = graph;

    buses.motor.connect(mech.motorComp);
    mech.motorComp.connect(mech.motorToneTamer);
    mech.motorToneTamer.connect(mech.mechMix);

    buses.tick.connect(mech.tickToneTamer);
    mech.tickToneTamer.connect(mech.mechMix);

    buses.impact.connect(mech.mechMix);

    mech.mechMix.connect(mech.mechDrive);
    mech.mechDrive.connect(mech.mechComp);
    mech.mechComp.connect(master.master);

    buses.win.connect(master.master);
  }

  const WIN_SFX = Object.freeze({
    two: Object.freeze({
      duck: 0.56,
      duckDur: 0.42,
      noise: [
        { gain: 0.06, dur: 0.03, when: 0, filterHz: 2600, bandpass: true },
      ],
      tones: [
        { freq: 360, endFreq: 520, type: "square", gain: 0.07, dur: 0.08, when: 0, filterHz: 2600 },
        { freq: 470, endFreq: 680, type: "triangle", gain: 0.064, dur: 0.09, when: 0.06, filterHz: 3000 },
        { freq: 600, endFreq: 820, type: "square", gain: 0.045, dur: 0.1, when: 0.12, filterHz: 3200 },
      ],
    }),
    three: Object.freeze({
      duck: 0.66,
      duckDur: 0.42,
      noise: [
        { gain: 0.06, dur: 0.03, when: 0, filterHz: 2600, bandpass: true },
        { gain: 0.034, dur: 0.03, when: 0.09, filterHz: 3600, bandpass: true },
      ],
      tones: [
        { freq: 390, endFreq: 580, type: "square", gain: 0.07, dur: 0.08, when: 0, filterHz: 2600 },
        { freq: 510, endFreq: 760, type: "triangle", gain: 0.064, dur: 0.09, when: 0.06, filterHz: 3000 },
        { freq: 670, endFreq: 920, type: "square", gain: 0.055, dur: 0.1, when: 0.12, filterHz: 3200 },
      ],
    }),
    big: Object.freeze({
      duck: 0.78,
      duckDur: 0.56,
      noise: [
        { gain: 0.082, dur: 0.05, when: 0, filterHz: 3200, bandpass: true },
        { gain: 0.046, dur: 0.03, when: 0.09, filterHz: 3600, bandpass: true },
      ],
      tones: [
        { freq: 420, endFreq: 650, type: "square", gain: 0.09, dur: 0.11, when: 0, filterHz: 2600 },
        { freq: 560, endFreq: 840, type: "triangle", gain: 0.082, dur: 0.12, when: 0.06, filterHz: 3000 },
        { freq: 760, endFreq: 1080, type: "square", gain: 0.07, dur: 0.13, when: 0.12, filterHz: 3200 },
        { freq: 960, endFreq: 1320, type: "triangle", gain: 0.068, dur: 0.16, when: 0.2, filterHz: 3400 },
      ],
    }),
  });

  const NEAR_MISS_SFX = Object.freeze({
    build: Object.freeze([
      Object.freeze({ type: "noise", gain: 0.008, dur: 0.24, when: 0, filterHz: 800, bandpass: true, brown: true }),
      Object.freeze({ type: "tone", freq: 220, endFreq: 340, oscType: "triangle", gain: 0.022, dur: 0.28, when: 0, filterHz: 1200 }),
      Object.freeze({ type: "tone", freq: 340, endFreq: 410, oscType: "triangle", gain: 0.012, dur: 0.16, when: 0.08, filterHz: 1600 }),
    ]),
    resolve: Object.freeze([
      Object.freeze({ type: "noise", gain: 0.018, dur: 0.06, when: 0, filterHz: 1800, bandpass: true }),
      Object.freeze({ type: "tone", freq: 280, endFreq: 140, oscType: "triangle", gain: 0.024, dur: 0.12, when: 0, filterHz: 900 }),
      Object.freeze({ type: "tone", freq: 180, endFreq: 110, oscType: "square", gain: 0.014, dur: 0.07, when: 0.02, filterHz: 780 }),
    ]),
  });

  const BRAKE_PROFILE = Object.freeze({
    laneOffsetSec: 0.01,
    noiseGain: 0.046,
    noiseDur: 0.024,
    noiseHz: 2000,
    highBaseFreq: 250,
    highStepPerLane: 14,
    highEndFreq: 170,
    highGain: 0.026,
    highDur: 0.045,
    highFilterHz: 1200,
    lowBaseFreq: 138,
    lowStepPerLane: 9,
    lowEndFreq: 84,
    lowGain: 0.02,
    lowDur: 0.065,
    lowExtraDelaySec: 0.005,
    lowFilterHz: 720,
  });

  const MOTOR_UPDATE_THRESHOLD = 0.012;

  const START_SIGNAL_SEQ = (() => {
    const seq = [
      { type: "noise", gain: 0.032, dur: 0.94, when: 0, filterHz: 520, bandpass: true, brown: true },
      { type: "tone", freq: 88, endFreq: 102, gain: 0.028, dur: 0.9, when: 0, filterHz: 760, oscType: "triangle" },
    ];

    for (let i = 0; i < 5; i++) {
      const when = 0.1 + (i * 0.14);
      const freq = 380 + (i * 44);
      seq.push({
        type: "tone",
        freq,
        endFreq: freq - 92,
        gain: 0.018 + (i * 0.002),
        dur: 0.05,
        when,
        filterHz: 2100 + (i * 120),
        oscType: "square",
      });
      seq.push({
        type: "noise",
        gain: 0.015 + (i * 0.003),
        dur: 0.018,
        when,
        filterHz: 2400 + (i * 140),
        bandpass: true,
      });
    }

    seq.push(
      { type: "tone", freq: 420, endFreq: 760, gain: 0.05, dur: 0.12, when: 0.8, filterHz: 3200, oscType: "triangle" },
      { type: "tone", freq: 760, endFreq: 980, gain: 0.046, dur: 0.1, when: 0.92, filterHz: 3400, oscType: "triangle" },
    );

    return Object.freeze(seq.map((e) => Object.freeze(e)));
  })();

  const START_SIGNAL_TOTAL_MS = (() => {
    let maxMs = 0;
    for (const ev of START_SIGNAL_SEQ) {
      const endMs = (ev.when + ev.dur) * 1000;
      if (endMs > maxMs) maxMs = endMs;
    }
    return Math.ceil(maxMs + 80);
  })();

  function renderTickBuffer(ac, speedNorm = 0.5, phaseKey = "cruise") {
    const phaseDur = phaseKey === "settle" ? 0.024 : phaseKey === "brake" ? 0.02 : 0.018;
    const phaseToneEnd = phaseKey === "settle" ? 92 : phaseKey === "brake" ? 116 : 132;
    const sampleCount = Math.max(16, Math.floor(ac.sampleRate * phaseDur));
    const buffer = ac.createBuffer(1, sampleCount, ac.sampleRate);
    const out = buffer.getChannelData(0);

    const toneStart = 160 + (speedNorm * 120);
    let phase = 0;
    let lp = 0;
    const toneMix = phaseKey === "settle" ? 0.52 : 0.6;
    const noiseMix = phaseKey === "settle" ? 0.36 : 0.42;

    for (let i = 0; i < sampleCount; i++) {
      const t = i / Math.max(1, sampleCount - 1);
      const envIn = Math.min(1, t / 0.16);
      const envOut = Math.pow(1 - t, 1.9);
      const env = envIn * envOut;
      const freq = lerp(toneStart, phaseToneEnd, t);
      phase += (Math.PI * 2 * freq) / ac.sampleRate;
      const triangle = (2 / Math.PI) * Math.asin(Math.sin(phase));
      const white = (Math.random() * 2) - 1;
      lp += (white - lp) * 0.18;
      const sample = ((triangle * toneMix) + (lp * noiseMix)) * env;
      out[i] = clamp(sample * 0.72, -1, 1);
    }

    return buffer;
  }

  function prebakeTickBuffers(ac) {
    const speedSteps = [0, 0.34, 0.68, 1];
    const phaseKeys = ["cruise", "brake", "settle"];
    const map = new Map();

    for (const phaseKey of phaseKeys) {
      for (const speedNorm of speedSteps) {
        map.set(`${phaseKey}:${speedNorm.toFixed(2)}`, renderTickBuffer(ac, speedNorm, phaseKey));
      }
    }

    return { speedSteps, map };
  }

  function createDropPitAudio({ CELL, PHASE, motorProfile = {}, tickProfile = {} } = {}) {
    const MOTOR_PROFILE = Object.freeze({
      noiseStartGain: 0.02,
      toneStartGain: 0.0026,
      noiseBaseGain: 0.005,
      noiseMaxGain: 0.026,
      toneBaseGain: 0.0008,
      toneMaxGain: 0.0022,
      ...motorProfile,
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
      ...tickProfile,
    });

    const sfx = {
      graph: null,
      motor: null,
      state: {
        unlocked: false,
        unlockPromise: null,
        bootBeepDone: false,
        lastMotorNorm: -1,
        lastMotorPhase: PHASE.IDLE,
      },
    };

    function initAudioGraph() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (sfx.graph) return sfx.graph.ctx;

      const ctx = new AC();
      const master = buildMasterChain(ctx);
      const buses = buildBuses(ctx);
      const mech = buildMechChain(ctx);

      sfx.graph = {
        ctx,
        master,
        buses,
        mech,
        whiteNoise: makeNoiseBuffer(ctx, 0.24, false),
        brownNoise: makeNoiseBuffer(ctx, 1.1, true),
        tickBank: prebakeTickBuffers(ctx),
      };

      wireGraph(sfx.graph);
      return ctx;
    }

    function canPlayAudio() {
      return !!(sfx.graph && sfx.state.unlocked && sfx.graph.ctx.state === "running");
    }

    async function unlockAudioFromGesture() {
      const ac = initAudioGraph();
      if (!ac) return false;

      if (ac.state !== "running") {
        if (!sfx.state.unlockPromise) {
          sfx.state.unlockPromise = ac.resume()
            .catch(() => null)
            .finally(() => {
              sfx.state.unlockPromise = null;
            });
        }
        await sfx.state.unlockPromise;
      }

      sfx.state.unlocked = ac.state === "running";
      if (sfx.state.unlocked && !sfx.state.bootBeepDone) {
        sfx.state.bootBeepDone = true;
        playTone({ freq: 320, endFreq: 420, type: "triangle", gain: 0.03, dur: 0.05, filterHz: 1800 });
      }
      return sfx.state.unlocked;
    }

    function resolveBus(busKey) {
      if (!sfx.graph) return null;
      if (busKey === "master") return sfx.graph.master.master;
      const bus = sfx.graph.buses[busKey];
      if (!bus) {
        console.warn(`[audio] unknown busKey: "${String(busKey)}"`);
        return sfx.graph.master.master;
      }
      return bus;
    }

    function playTone({
      freq = 220,
      endFreq = freq,
      type = "square",
      gain = 0.07,
      dur = 0.08,
      when = 0,
      filterHz = 1800,
      busKey = "master",
    } = {}) {
      if (!canPlayAudio()) return;

      const ac = sfx.graph.ctx;
      const t0 = ac.currentTime + when;
      const osc = ac.createOscillator();
      const filt = ac.createBiquadFilter();
      const amp = ac.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(12, endFreq), t0 + dur);

      filt.type = "lowpass";
      filt.frequency.value = filterHz;
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + Math.min(0.014, dur * 0.36));
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(filt);
      filt.connect(amp);
      amp.connect(resolveBus(busKey));
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    function playNoise({
      gain = 0.06,
      dur = 0.04,
      when = 0,
      filterHz = 1800,
      bandpass = false,
      busKey = "master",
      brown = false,
    } = {}) {
      if (!canPlayAudio()) return;

      const ac = sfx.graph.ctx;
      const noiseBuffer = brown ? sfx.graph.brownNoise : sfx.graph.whiteNoise;
      if (!noiseBuffer) return;

      const t0 = ac.currentTime + when;
      const src = ac.createBufferSource();
      src.buffer = noiseBuffer;

      const filt = ac.createBiquadFilter();
      filt.type = bandpass ? "bandpass" : "lowpass";
      filt.frequency.value = filterHz;
      if (bandpass) filt.Q.value = 0.85;

      const amp = ac.createGain();
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + Math.min(0.01, dur * 0.4));
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.connect(filt);
      filt.connect(amp);
      amp.connect(resolveBus(busKey));
      src.start(t0);
      src.stop(t0 + dur + 0.01);
    }

    function startMotor() {
      if (!canPlayAudio() || sfx.motor) return;

      const ac = sfx.graph.ctx;

      const noiseSrc = ac.createBufferSource();
      noiseSrc.buffer = sfx.graph.brownNoise;
      noiseSrc.loop = true;

      const noiseBP = ac.createBiquadFilter();
      noiseBP.type = "bandpass";
      noiseBP.frequency.value = 250;
      noiseBP.Q.value = 0.78;

      const noiseLP = ac.createBiquadFilter();
      noiseLP.type = "lowpass";
      noiseLP.frequency.value = 900;
      noiseLP.Q.value = 0.7;

      const harshNotch = ac.createBiquadFilter();
      harshNotch.type = "notch";
      harshNotch.frequency.value = 2800;
      harshNotch.Q.value = 1.2;

      const duckGain = ac.createGain();
      duckGain.gain.value = 1;

      const noiseAmp = ac.createGain();
      noiseAmp.gain.value = 0.0001;
      noiseAmp.gain.setTargetAtTime(MOTOR_PROFILE.noiseStartGain, ac.currentTime, 0.06);

      const osc = ac.createOscillator();
      const toneLP = ac.createBiquadFilter();
      const toneAmp = ac.createGain();
      const lfo = ac.createOscillator();
      const lfoGain = ac.createGain();

      osc.type = "triangle";
      osc.frequency.value = 50;
      toneLP.type = "lowpass";
      toneLP.frequency.value = 180;
      toneAmp.gain.value = 0.0001;
      toneAmp.gain.setTargetAtTime(MOTOR_PROFILE.toneStartGain, ac.currentTime, 0.06);

      lfo.type = "sine";
      lfo.frequency.value = 3.6;
      lfoGain.gain.value = 4;

      lfo.connect(lfoGain);
      lfoGain.connect(noiseBP.frequency);
      lfoGain.connect(toneLP.frequency);

      noiseSrc.connect(noiseBP);
      noiseBP.connect(noiseLP);
      noiseLP.connect(noiseAmp);
      noiseAmp.connect(harshNotch);

      osc.connect(toneLP);
      toneLP.connect(toneAmp);
      toneAmp.connect(harshNotch);

      harshNotch.connect(duckGain);
      duckGain.connect(sfx.graph.buses.motor);

      noiseSrc.start();
      osc.start();
      lfo.start();

      sfx.motor = {
        noiseSrc,
        noiseBP,
        noiseLP,
        noiseAmp,
        harshNotch,
        duckGain,
        osc,
        toneLP,
        toneAmp,
        lfo,
        lfoGain,
        jitter: 0,
        jitterTarget: 0,
        jitterLastUpdateAt: ac.currentTime,
        jitterIntervalSec: 0.2,
      };
    }

    function duckMotor(depth = 0.58, dur = 0.36) {
      if (!sfx.motor || !sfx.graph) return;
      const g = sfx.motor.duckGain.gain;
      const t = sfx.graph.ctx.currentTime;
      const duckTo = Math.max(0.08, 1 - clamp(depth, 0, 0.9));

      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.linearRampToValueAtTime(duckTo, t + 0.02);
      g.setTargetAtTime(1, t + Math.max(0, dur), 0.08);
    }

    function updateMotor({ avgSpeed = 0, phase = PHASE.IDLE } = {}) {
      if (!sfx.motor || !sfx.graph) return;

      const n = clamp(avgSpeed / (CELL * 18), 0, 1);
      if (
        Math.abs(n - sfx.state.lastMotorNorm) < MOTOR_UPDATE_THRESHOLD
        && phase === sfx.state.lastMotorPhase
      ) {
        return;
      }
      sfx.state.lastMotorNorm = n;
      sfx.state.lastMotorPhase = phase;
      const t = sfx.graph.ctx.currentTime;

      let phaseFactor = 0.88;
      if (phase === PHASE.SPINUP || phase === PHASE.CRUISE) phaseFactor = 1;
      else if (phase === PHASE.BRAKE) phaseFactor = 0.76;
      else if (phase === PHASE.SETTLE) phaseFactor = 0.62;

      if ((t - sfx.motor.jitterLastUpdateAt) >= sfx.motor.jitterIntervalSec) {
        sfx.motor.jitterTarget = (Math.random() * 2) - 1;
        sfx.motor.jitterLastUpdateAt = t;
      }
      sfx.motor.jitter += (sfx.motor.jitterTarget - sfx.motor.jitter) * 0.04;

      const jitter = sfx.motor.jitter * 0.24;
      sfx.motor.noiseBP.frequency.setTargetAtTime(120 + (n * 300), t, 0.1);
      sfx.motor.noiseBP.Q.setTargetAtTime(0.75 + (n * 0.35), t, 0.18);
      sfx.motor.noiseLP.frequency.setTargetAtTime(700 + (n * 900), t, 0.12);
      sfx.motor.noiseAmp.gain.setTargetAtTime(lerp(MOTOR_PROFILE.noiseBaseGain, MOTOR_PROFILE.noiseMaxGain, n) * phaseFactor, t, 0.075);
      sfx.motor.osc.frequency.setTargetAtTime(46 + (n * 11) + jitter, t, 0.1);
      sfx.motor.toneLP.frequency.setTargetAtTime(98 + (n * 86), t, 0.11);
      sfx.motor.toneAmp.gain.setTargetAtTime(lerp(MOTOR_PROFILE.toneBaseGain, MOTOR_PROFILE.toneMaxGain, n) * phaseFactor, t, 0.085);
      sfx.motor.lfoGain.gain.setTargetAtTime(2.5 + (n * 6), t, 0.25);
      sfx.motor.harshNotch.frequency.setTargetAtTime(2400 + (n * 900), t, 0.2);
      sfx.motor.harshNotch.Q.setTargetAtTime(1 + (n * 0.6), t, 0.25);
      sfx.graph.mech.motorToneTamer.frequency.setTargetAtTime(460 + (n * 150), t, 0.12);
    }

    function stopMotor() {
      if (!sfx.motor || !sfx.graph) return;
      const t = sfx.graph.ctx.currentTime;
      const fadeSec = 0.18;
      const motorRef = sfx.motor;
      sfx.state.lastMotorNorm = -1;
      sfx.state.lastMotorPhase = PHASE.IDLE;

      motorRef.duckGain.gain.cancelScheduledValues(t);
      motorRef.duckGain.gain.setValueAtTime(Math.max(0.0001, motorRef.duckGain.gain.value), t);
      motorRef.duckGain.gain.setTargetAtTime(0.0001, t, fadeSec * 0.4);

      motorRef.noiseAmp.gain.cancelScheduledValues(t);
      motorRef.toneAmp.gain.cancelScheduledValues(t);
      motorRef.noiseAmp.gain.setTargetAtTime(0.0001, t, fadeSec * 0.5);
      motorRef.toneAmp.gain.setTargetAtTime(0.0001, t, fadeSec * 0.5);

      try {
        const stopAt = t + fadeSec + 0.04;
        motorRef.noiseSrc.stop(stopAt);
        motorRef.osc.stop(stopAt);
        motorRef.lfo.stop(stopAt);
      } catch {
        // no-op
      }

      sfx.motor = null;
    }

    function reelTickLaneOffset(i) {
      if (i === 0) return -10;
      if (i === 2) return 10;
      return 0;
    }

    function sfxReelTick({
      laneIndex = 1,
      speedNorm = 0,
      phase = PHASE.CRUISE,
      jitter = 0,
    } = {}) {
      if (!canPlayAudio()) return;

      let phaseGain = 0.9;
      let phaseKey = "cruise";
      if (phase === PHASE.BRAKE) {
        phaseGain = 0.96;
        phaseKey = "brake";
      } else if (phase === PHASE.SETTLE) {
        phaseGain = 0.68;
        phaseKey = "settle";
      }

      const ac = sfx.graph.ctx;
      const speed = clamp(speedNorm, 0, 1);
      const steps = sfx.graph.tickBank.speedSteps;
      let nearest = steps[0];
      let bestDist = Math.abs(speed - nearest);
      for (let i = 1; i < steps.length; i++) {
        const d = Math.abs(speed - steps[i]);
        if (d < bestDist) {
          nearest = steps[i];
          bestDist = d;
        }
      }

      const key = `${phaseKey}:${nearest.toFixed(2)}`;
      const buffer = sfx.graph.tickBank.map.get(key);
      if (!buffer) return;

      const src = ac.createBufferSource();
      src.buffer = buffer;
      const amp = ac.createGain();
      const laneDetune = reelTickLaneOffset(laneIndex) * 1.8;
      const jitterDetune = clamp(jitter * 18, -26, 26);
      src.detune.value = laneDetune + jitterDetune;

      const gainBase = lerp(TICK_PROFILE.noiseBaseGain, TICK_PROFILE.noiseMaxGain, speed)
        + lerp(TICK_PROFILE.toneBaseGain, TICK_PROFILE.toneMaxGain, speed);
      const gain = Math.max(0.0003, gainBase * 1.2 * phaseGain);
      const t0 = ac.currentTime;
      amp.gain.setValueAtTime(gain, t0);
      amp.gain.setTargetAtTime(0.0001, t0, buffer.duration * 0.65);

      src.connect(amp);
      amp.connect(resolveBus("tick"));
      src.start(t0);
      src.stop(t0 + buffer.duration + 0.01);
    }

    function sfxBetAdjust(delta) {
      if (!canPlayAudio()) return;
      const up = delta > 0;
      playNoise({
        gain: 0.012,
        dur: 0.012,
        filterHz: up ? 2300 : 1800,
        bandpass: true,
        busKey: "tick",
      });
      playTone({
        freq: up ? 540 : 420,
        endFreq: up ? 760 : 300,
        type: "square",
        gain: 0.016,
        dur: 0.028,
        filterHz: up ? 2400 : 1800,
        busKey: "tick",
      });
    }

    function sfxSpinStart() {
      startMotor();
      playNoise({ gain: 0.056, dur: 0.034, filterHz: 2200, bandpass: true, busKey: "impact" });
    }

    function sfxBrake(reelIndex) {
      const when = reelIndex * BRAKE_PROFILE.laneOffsetSec;
      const highFreq = BRAKE_PROFILE.highBaseFreq - (reelIndex * BRAKE_PROFILE.highStepPerLane);
      const lowFreq = BRAKE_PROFILE.lowBaseFreq - (reelIndex * BRAKE_PROFILE.lowStepPerLane);
      playNoise({
        gain: BRAKE_PROFILE.noiseGain,
        dur: BRAKE_PROFILE.noiseDur,
        when,
        filterHz: BRAKE_PROFILE.noiseHz,
        bandpass: true,
        busKey: "impact",
      });
      playTone({
        freq: highFreq,
        endFreq: BRAKE_PROFILE.highEndFreq,
        type: "square",
        gain: BRAKE_PROFILE.highGain,
        dur: BRAKE_PROFILE.highDur,
        when,
        filterHz: BRAKE_PROFILE.highFilterHz,
        busKey: "impact",
      });
      playTone({
        freq: lowFreq,
        endFreq: BRAKE_PROFILE.lowEndFreq,
        type: "triangle",
        gain: BRAKE_PROFILE.lowGain,
        dur: BRAKE_PROFILE.lowDur,
        when: when + BRAKE_PROFILE.lowExtraDelaySec,
        filterHz: BRAKE_PROFILE.lowFilterHz,
        busKey: "impact",
      });
    }

    function sfxSettle() {
      playNoise({ gain: 0.032, dur: 0.018, filterHz: 2300, bandpass: true, busKey: "impact" });
      playTone({ freq: 170, endFreq: 96, type: "triangle", gain: 0.026, dur: 0.07, filterHz: 760, busKey: "impact" });
      playTone({ freq: 560, endFreq: 360, type: "triangle", gain: 0.018, dur: 0.04, filterHz: 2400, busKey: "impact" });
    }

    function sfxUiDeny() {
      playTone({ freq: 160, endFreq: 120, type: "square", gain: 0.018, dur: 0.08, filterHz: 900, busKey: "impact" });
    }

    function sfxDryDrop() {
      playTone({ freq: 190, endFreq: 132, type: "triangle", gain: 0.018, dur: 0.07, filterHz: 1000, busKey: "impact" });
    }

    function sfxAutoToggle(on) {
      if (on) {
        playTone({ freq: 320, endFreq: 420, type: "triangle", gain: 0.022, dur: 0.06, filterHz: 1900, busKey: "tick" });
        return;
      }
      playTone({ freq: 260, endFreq: 180, type: "triangle", gain: 0.018, dur: 0.06, filterHz: 1300, busKey: "tick" });
    }

    function sfxWin(amount, tier = "two") {
      if (amount <= 0) return;
      const p = WIN_SFX[tier] || WIN_SFX.two;
      duckMotor(p.duck, p.duckDur);

      for (const n of p.noise) playNoise({ ...n, busKey: "win" });
      for (const tone of p.tones) playTone({ ...tone, busKey: "win" });
    }

    function playEventSequence(events, busKey = "impact") {
      for (const ev of events) {
        if (ev.type === "tone") {
          playTone({
            freq: ev.freq,
            endFreq: ev.endFreq,
            type: ev.oscType || "triangle",
            gain: ev.gain,
            dur: ev.dur,
            when: ev.when,
            filterHz: ev.filterHz,
            busKey,
          });
          continue;
        }
        playNoise({
          gain: ev.gain,
          dur: ev.dur,
          when: ev.when,
          filterHz: ev.filterHz,
          bandpass: !!ev.bandpass,
          brown: !!ev.brown,
          busKey,
        });
      }
    }

    function sfxNearMissBuild() {
      if (!canPlayAudio()) return;
      duckMotor(0.22, 0.32);
      playEventSequence(NEAR_MISS_SFX.build, "win");
    }

    function sfxNearMissResolve() {
      if (!canPlayAudio()) return;
      duckMotor(0.28, 0.24);
      playEventSequence(NEAR_MISS_SFX.resolve, "impact");
    }

    async function sfxStartSignal() {
      if (!canPlayAudio()) return;

      duckMotor(0.35, 0.9);
      for (const ev of START_SIGNAL_SEQ) {
        if (ev.type === "tone") {
          playTone({
            freq: ev.freq,
            endFreq: ev.endFreq,
            type: ev.oscType || "triangle",
            gain: ev.gain,
            dur: ev.dur,
            when: ev.when,
            filterHz: ev.filterHz,
            busKey: "win",
          });
          continue;
        }
        playNoise({
          gain: ev.gain,
          dur: ev.dur,
          when: ev.when,
          filterHz: ev.filterHz,
          bandpass: !!ev.bandpass,
          brown: !!ev.brown,
          busKey: "win",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, START_SIGNAL_TOTAL_MS));
    }

    function sfxSpinStop() {
      stopMotor();
    }

    return {
      unlockAudioFromGesture,
      updateMotor,
      sfxSpinStop,
      sfxReelTick,
      sfxBetAdjust,
      sfxSpinStart,
      sfxBrake,
      sfxSettle,
      sfxUiDeny,
      sfxDryDrop,
      sfxAutoToggle,
      sfxWin,
      sfxNearMissBuild,
      sfxNearMissResolve,
      sfxStartSignal,
    };
  }

  window.createDropPitAudio = createDropPitAudio;
})();
