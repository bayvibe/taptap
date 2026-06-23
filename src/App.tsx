import { RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import drumPadSrc from "./assets/drum-pad-cutout.webp";

type Quality = "perfect" | "fast" | "slow";
type AppMode = "quiz" | "practice";
type QuizState = "idle" | "countdown" | "listen" | "prep" | "active" | "done";
type SettingPanel = "bpm" | "signature" | null;

type PracticeConfig = {
  bpm: number;
  beatsPerMeasure: number;
  beatUnit: number;
  silentAlternate: boolean;
};

type ClockState = {
  beatIndex: number;
  beatInMeasure: number;
  measureIndex: number;
  progress: number;
  audible: boolean;
};

type TapRecord = {
  id: string;
  targetIndex: number;
  errorMs: number;
  quality: Quality;
};

type TapBubble = {
  id: string;
  quality: Quality;
  label: string;
};

type TipCopy = {
  quality: Quality;
  title: string;
  detail: string;
};

type QuizResult = {
  accuracy: number;
  hits: number;
  expected: number;
  averageErrorMs: number | null;
};

const SIGNATURE_OPTIONS = [
  { label: "1/4", beats: 1, unit: 4 },
  { label: "2/4", beats: 2, unit: 4 },
  { label: "3/4", beats: 3, unit: 4 },
  { label: "4/4", beats: 4, unit: 4 },
  { label: "5/4", beats: 5, unit: 4 },
  { label: "6/8", beats: 6, unit: 8 },
  { label: "7/8", beats: 7, unit: 8 },
];

const QUIZ_MEASURES = 5;
const COUNTDOWN_SECONDS = 3;
const IDLE_HINT_MS = 5000;
const FULL_SCORE_TOLERANCE_MS = 35;
const DRUM_PULSE_MS = 300;

const INITIAL_CLOCK: ClockState = {
  beatIndex: 0,
  beatInMeasure: 0,
  measureIndex: 0,
  progress: 0,
  audible: true,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const beatDuration = (bpm: number) => 60 / bpm;

const toleranceFor = (bpm: number) => {
  const durationMs = beatDuration(bpm) * 1000;
  return clamp(durationMs * 0.18, 90, 170);
};

const quizBeatCount = (config: PracticeConfig) => config.beatsPerMeasure * QUIZ_MEASURES;

const shouldPauseBeat = (mode: AppMode, state: QuizState) =>
  mode === "quiz" && (state === "idle" || state === "countdown" || state === "done");

const getBeatProfile = (beatIndex: number, config: PracticeConfig) => {
  const measureIndex = Math.floor(beatIndex / config.beatsPerMeasure);
  const beatInMeasure = beatIndex % config.beatsPerMeasure;
  const audible = !config.silentAlternate || measureIndex % 2 === 0;

  return {
    measureIndex,
    beatInMeasure,
    audible,
  };
};

const playClick = (context: AudioContext, time: number, volume: number, accented = false) => {
  const duration = accented ? 0.078 : 0.058;
  const sampleRate = context.sampleRate;
  const frameCount = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = context.createBuffer(1, frameCount, sampleRate);
  const data = buffer.getChannelData(0);
  const source = context.createBufferSource();
  const gain = context.createGain();
  const bodyStart = accented ? 360 : 520;
  const bodyEnd = accented ? 180 : 320;
  const rimFrequency = accented ? 1080 : 1320;
  let bodyPhase = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const t = index / sampleRate;
    const attack = clamp(t / 0.0024, 0, 1);
    const sweep = Math.pow(bodyEnd / bodyStart, clamp(t / duration, 0, 1));
    const bodyFrequency = bodyStart * sweep;
    const bodyEnvelope = Math.exp(-t * (accented ? 42 : 58));
    const rimEnvelope = Math.exp(-t * 135);
    const noiseEnvelope = Math.exp(-t * 230);
    const noise = Math.random() * 2 - 1;

    bodyPhase += (2 * Math.PI * bodyFrequency) / sampleRate;

    const body = Math.sin(bodyPhase) * (accented ? 0.72 : 0.46) * bodyEnvelope;
    const rim = Math.sin(2 * Math.PI * rimFrequency * t) * 0.34 * rimEnvelope;
    const strike = noise * (accented ? 0.22 : 0.16) * noiseEnvelope;

    data[index] = (body + rim + strike) * attack;
  }

  source.buffer = buffer;
  gain.gain.setValueAtTime(volume * (accented ? 0.78 : 0.58), time);

  source.connect(gain);
  gain.connect(context.destination);
  source.start(time);
  source.stop(time + duration);

  return source;
};

const classifyTap = (errorMs: number): Quality => {
  if (Math.abs(errorMs) <= 55) return "perfect";
  return errorMs < 0 ? "fast" : "slow";
};

const makeTip = (errorMs: number): TipCopy => {
  const absolute = Math.round(Math.abs(errorMs));

  if (Math.abs(errorMs) <= 55) {
    return {
      quality: "perfect",
      title: "准",
      detail: "贴住拍点",
    };
  }

  if (errorMs < 0) {
    return {
      quality: "fast",
      title: "快了",
      detail: `${absolute} ms`,
    };
  }

  return {
    quality: "slow",
    title: "慢了",
    detail: `${absolute} ms`,
  };
};

const formatMs = (value: number | null) => {
  if (value === null) return "0 ms";
  const rounded = Math.round(value);
  if (rounded === 0) return "0 ms";
  return `${rounded > 0 ? "+" : ""}${rounded} ms`;
};

const getQuizResultCopy = (result: QuizResult) => {
  if (result.accuracy === 100) {
    return {
      title: "满分，节拍器刚才沉默了三秒",
      body: "它可能在怀疑自己是不是被你反向校准了。可以加 BPM 了，别让它太舒服。",
    };
  }

  if (result.accuracy >= 90) {
    return {
      title: "差一点满分，节拍器先眨眼了",
      body: "已经非常稳，只差一点点把拍子钉在地板上。下一轮可以冲那个稀有的 100%。",
    };
  }

  if (result.accuracy >= 70) {
    return {
      title: "节奏大巴基本赶上了",
      body: "有几拍像在门口刷卡，但主脉搏已经在线。再来一轮，手腕会更听话。",
    };
  }

  if (result.accuracy >= 45) {
    return {
      title: "拍子还在找自己的鞋",
      body: "先别追全中，盯住第一拍。等脚穿对了，中间那些拍会自己排队进场。",
    };
  }

  return {
    title: "这一轮像锅盖在跳舞",
    body: "问题不大，锅盖也有节奏。把 BPM 降一点，只敲强拍，先抓住一个稳稳的点。",
  };
};

const analyzeQuiz = (
  taps: TapRecord[],
  startBeat: number,
  expected: number,
  config: PracticeConfig,
): QuizResult => {
  const tolerance = toleranceFor(config.bpm);
  const bestByTarget = new Map<number, TapRecord>();

  taps.forEach((tap) => {
    if (tap.targetIndex < startBeat || tap.targetIndex >= startBeat + expected) return;

    const existing = bestByTarget.get(tap.targetIndex);
    if (!existing || Math.abs(tap.errorMs) < Math.abs(existing.errorMs)) {
      bestByTarget.set(tap.targetIndex, tap);
    }
  });

  const bestTaps = Array.from(bestByTarget.values());
  const hits = bestTaps.filter((tap) => Math.abs(tap.errorMs) <= tolerance);
  const rawAccuracy = Math.round((hits.length / expected) * 100);
  const strictFullScore =
    rawAccuracy === 100 &&
    taps.length === expected &&
    bestTaps.length === expected &&
    bestTaps.every((tap) => Math.abs(tap.errorMs) <= FULL_SCORE_TOLERANCE_MS);
  const averageErrorMs = bestTaps.length
    ? bestTaps.reduce((sum, tap) => sum + tap.errorMs, 0) / bestTaps.length
    : null;

  return {
    accuracy: rawAccuracy === 100 && !strictFullScore ? 99 : rawAccuracy,
    hits: hits.length,
    expected,
    averageErrorMs,
  };
};

export default function App() {
  const [mode, setMode] = useState<AppMode>("quiz");
  const [bpm, setBpm] = useState(60);
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(4);
  const [beatUnit, setBeatUnit] = useState(4);
  const [silentAlternate, setSilentAlternate] = useState(false);
  const [clock, setClock] = useState<ClockState>(INITIAL_CLOCK);
  const [tapBubbles, setTapBubbles] = useState<TapBubble[]>([]);
  const [tapPulseId, setTapPulseId] = useState<string | null>(null);
  const [showIdleHint, setShowIdleHint] = useState(false);
  const [activeSetting, setActiveSetting] = useState<SettingPanel>(null);
  const [quizState, setQuizState] = useState<QuizState>("idle");
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [quizResult, setQuizResult] = useState<QuizResult | null>(null);

  const audioRef = useRef<AudioContext | null>(null);
  const audioPrimedRef = useRef(false);
  const schedulerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const nextBeatIndexRef = useRef(0);
  const sessionStartRef = useRef(0);
  const configRef = useRef<PracticeConfig | null>(null);
  const volumeRef = useRef(0.68);
  const idleTimerRef = useRef<number | null>(null);
  const scheduledClicksRef = useRef<AudioScheduledSourceNode[]>([]);
  const pageAudibleRef = useRef(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );
  const modeRef = useRef<AppMode>("quiz");
  const quizStateRef = useRef<QuizState>("idle");
  const quizListenEndBeatRef = useRef(0);
  const quizPrepEndBeatRef = useRef(0);
  const quizStartBeatRef = useRef(0);
  const quizEndBeatRef = useRef(0);
  const quizTapsRef = useRef<TapRecord[]>([]);

  const config = useMemo<PracticeConfig>(
    () => ({
      bpm,
      beatsPerMeasure,
      beatUnit,
      silentAlternate,
    }),
    [bpm, beatsPerMeasure, beatUnit, silentAlternate],
  );

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    quizStateRef.current = quizState;
  }, [quizState]);

  const unlockAudio = useCallback(async () => {
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextCtor) return false;

    if (!audioRef.current) {
      audioRef.current = new AudioContextCtor();
    }

    try {
      if (audioRef.current.state !== "running") {
        await audioRef.current.resume();
      }
      const running = audioRef.current.state === "running";

      if (running && document.visibilityState === "visible") {
        pageAudibleRef.current = true;
      }

      if (running && !audioPrimedRef.current) {
        const buffer = audioRef.current.createBuffer(1, 1, audioRef.current.sampleRate);
        const source = audioRef.current.createBufferSource();
        const gain = audioRef.current.createGain();

        source.buffer = buffer;
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(audioRef.current.destination);
        source.start(audioRef.current.currentTime);
        audioPrimedRef.current = true;
      }

      return running;
    } catch {
      return false;
    }
  }, []);

  const clearScheduledClicks = useCallback(() => {
    scheduledClicksRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Already stopped or already ended.
      }
    });
    scheduledClicksRef.current = [];
  }, []);

  const cancelQuiz = useCallback(() => {
    quizStateRef.current = "idle";
    quizListenEndBeatRef.current = 0;
    quizPrepEndBeatRef.current = 0;
    quizStartBeatRef.current = 0;
    quizEndBeatRef.current = 0;
    quizTapsRef.current = [];
    setCountdown(COUNTDOWN_SECONDS);
    setQuizResult(null);
    setQuizState("idle");
    clearScheduledClicks();
    setClock(INITIAL_CLOCK);
  }, [clearScheduledClicks]);

  const resetIdleHint = useCallback(() => {
    setShowIdleHint(false);

    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }

    idleTimerRef.current = window.setTimeout(() => {
      setShowIdleHint(true);
    }, IDLE_HINT_MS);
  }, []);

  const resetTimeline = useCallback(() => {
    clearScheduledClicks();
    sessionStartRef.current = performance.now() / 1000;
    nextBeatIndexRef.current = 0;
    setClock(INITIAL_CLOCK);
  }, [clearScheduledClicks]);

  const runScheduler = useCallback(() => {
    if (shouldPauseBeat(modeRef.current, quizStateRef.current)) {
      clearScheduledClicks();
      return;
    }

    const context = audioRef.current;
    const currentConfig = configRef.current;
    if (!pageAudibleRef.current || !context || !currentConfig || context.state !== "running") return;

    const duration = beatDuration(currentConfig.bpm);
    const wallNow = performance.now() / 1000;
    const currentBeatFloat = (wallNow - sessionStartRef.current) / duration;
    const firstSchedulableBeat = Math.max(0, Math.ceil(currentBeatFloat - 0.03));
    const beatsAhead = Math.max(2, Math.ceil(0.16 / duration) + 1);

    if (nextBeatIndexRef.current < firstSchedulableBeat) {
      nextBeatIndexRef.current = firstSchedulableBeat;
    }

    while (nextBeatIndexRef.current <= firstSchedulableBeat + beatsAhead) {
      const profile = getBeatProfile(nextBeatIndexRef.current, currentConfig);

      if (profile.audible) {
        const targetWallTime = sessionStartRef.current + nextBeatIndexRef.current * duration;
        const secondsUntilBeat = targetWallTime - wallNow;
        const audioTime = context.currentTime + Math.max(0.012, secondsUntilBeat);
        const source = playClick(context, audioTime, volumeRef.current, profile.beatInMeasure === 0);
        scheduledClicksRef.current.push(source);
        source.onended = () => {
          scheduledClicksRef.current = scheduledClicksRef.current.filter((item) => item !== source);
        };
      }

      nextBeatIndexRef.current += 1;
    }
  }, [clearScheduledClicks]);

  const enableSound = useCallback(() => {
    void unlockAudio().then((ready) => {
      if (ready) runScheduler();
    });
  }, [runScheduler, unlockAudio]);

  const updateClock = useCallback(() => {
    if (shouldPauseBeat(modeRef.current, quizStateRef.current)) {
      setClock(INITIAL_CLOCK);
      rafRef.current = window.requestAnimationFrame(updateClock);
      return;
    }

    const currentConfig = configRef.current;
    if (!currentConfig) return;

    const duration = beatDuration(currentConfig.bpm);
    const elapsed = Math.max(0, performance.now() / 1000 - sessionStartRef.current);
    const beatIndex = Math.max(0, Math.floor(elapsed / duration));
    const profile = getBeatProfile(beatIndex, currentConfig);
    const progress = clamp((elapsed - beatIndex * duration) / duration, 0, 1);

    setClock({
      beatIndex,
      beatInMeasure: profile.beatInMeasure,
      measureIndex: profile.measureIndex,
      progress,
      audible: profile.audible,
    });

    rafRef.current = window.requestAnimationFrame(updateClock);
  }, []);

  const activateQuiz = useCallback((startBeat?: number) => {
    const currentConfig = configRef.current;
    if (!currentConfig) return;

    const now = performance.now() / 1000;
    const duration = beatDuration(currentConfig.bpm);
    const firstQuizBeat = startBeat ?? Math.floor((now - sessionStartRef.current) / duration) + 1;

    quizStartBeatRef.current = firstQuizBeat;
    quizEndBeatRef.current = firstQuizBeat + quizBeatCount(currentConfig);
    quizTapsRef.current = [];
    setQuizResult(null);
    quizStateRef.current = "active";
    setQuizState("active");
  }, []);

  const startQuizListen = useCallback(() => {
    const currentConfig = configRef.current;
    if (!currentConfig) return;

    resetTimeline();
    quizListenEndBeatRef.current = currentConfig.beatsPerMeasure;
    quizPrepEndBeatRef.current = currentConfig.beatsPerMeasure * 2;
    quizStartBeatRef.current = 0;
    quizEndBeatRef.current = 0;
    quizTapsRef.current = [];
    setQuizResult(null);
    quizStateRef.current = "listen";
    setQuizState("listen");
  }, [resetTimeline]);

  const finishQuiz = useCallback(() => {
    const currentConfig = configRef.current;
    if (!currentConfig || quizStateRef.current !== "active") return;

    const result = analyzeQuiz(
      quizTapsRef.current,
      quizStartBeatRef.current,
      quizBeatCount(currentConfig),
      currentConfig,
    );

    setQuizResult(result);
    quizStateRef.current = "done";
    clearScheduledClicks();
    setClock(INITIAL_CLOCK);
    setQuizState("done");
  }, [clearScheduledClicks]);

  const startQuiz = useCallback(() => {
    modeRef.current = "quiz";
    setMode("quiz");
    quizStateRef.current = "countdown";
    clearScheduledClicks();
    setClock(INITIAL_CLOCK);
    resetIdleHint();
    quizListenEndBeatRef.current = 0;
    quizPrepEndBeatRef.current = 0;
    quizStartBeatRef.current = 0;
    quizEndBeatRef.current = 0;
    quizTapsRef.current = [];
    setQuizResult(null);
    setCountdown(COUNTDOWN_SECONDS);
    setQuizState("countdown");
    enableSound();
  }, [clearScheduledClicks, enableSound, resetIdleHint]);

  const enterQuizMode = useCallback(() => {
    modeRef.current = "quiz";
    setMode("quiz");
    setActiveSetting(null);
    setTapBubbles([]);
    setTapPulseId(null);
    cancelQuiz();
  }, [cancelQuiz]);

  const enterPracticeMode = useCallback(() => {
    modeRef.current = "practice";
    setMode("practice");
    setActiveSetting(null);
    setTapBubbles([]);
    setTapPulseId(null);
    cancelQuiz();
    resetTimeline();
    enableSound();
  }, [cancelQuiz, enableSound, resetTimeline]);

  const registerTap = useCallback(() => {
    enableSound();
    resetIdleHint();

    const currentConfig = configRef.current;
    if (!currentConfig) return;

    if (
      modeRef.current === "quiz" &&
      (quizStateRef.current === "idle" ||
        quizStateRef.current === "countdown" ||
        quizStateRef.current === "listen" ||
        quizStateRef.current === "done")
    ) {
      const waitBubble: TapBubble = {
        id: `wait-${Date.now()}`,
        quality: "slow",
        label:
          quizStateRef.current === "idle" || quizStateRef.current === "done"
            ? "点开始"
            : quizStateRef.current === "countdown"
              ? "等等"
              : "先听",
      };
      setTapBubbles((current) => [...current.slice(-2), waitBubble]);
      window.setTimeout(() => {
        setTapBubbles((current) => current.filter((item) => item.id !== waitBubble.id));
      }, 1800);
      return;
    }

    const duration = beatDuration(currentConfig.bpm);
    const now = performance.now() / 1000;
    const rawIndex = (now - sessionStartRef.current) / duration;
    const targetIndex = Math.round(rawIndex);

    if (targetIndex < 0) return;

    const targetTime = sessionStartRef.current + targetIndex * duration;
    const errorMs = (now - targetTime) * 1000;
    const quality = classifyTap(errorMs);
    const record: TapRecord = {
      id: `${Date.now()}-${Math.round(Math.random() * 100000)}`,
      targetIndex,
      errorMs,
      quality,
    };
    const nextTip = makeTip(errorMs);
    const bubble: TapBubble = {
      id: record.id,
      quality,
      label: nextTip.quality === "perfect" ? nextTip.title : `${nextTip.title} ${nextTip.detail}`,
    };

    setTapBubbles((current) => [...current.slice(-2), bubble]);
    setTapPulseId(record.id);
    window.setTimeout(() => {
      setTapPulseId((current) => (current === record.id ? null : current));
    }, DRUM_PULSE_MS);
    window.setTimeout(() => {
      setTapBubbles((current) => current.filter((item) => item.id !== bubble.id));
    }, 1800);

    if (
      quizStateRef.current === "active" &&
      targetIndex >= quizStartBeatRef.current &&
      targetIndex < quizEndBeatRef.current
    ) {
      quizTapsRef.current = [...quizTapsRef.current, record];
    }
  }, [enableSound, resetIdleHint]);

  useEffect(() => {
    window.addEventListener("pointerdown", enableSound, { passive: true });
    window.addEventListener("touchstart", enableSound, { passive: true });
    window.addEventListener("keydown", enableSound);

    return () => {
      window.removeEventListener("pointerdown", enableSound);
      window.removeEventListener("touchstart", enableSound);
      window.removeEventListener("keydown", enableSound);
    };
  }, [enableSound]);

  useEffect(() => {
    resetTimeline();
    if (!shouldPauseBeat(modeRef.current, quizStateRef.current)) {
      enableSound();
    }

    const audioKickTimer = window.setTimeout(() => {
      if (!shouldPauseBeat(modeRef.current, quizStateRef.current)) {
        enableSound();
      }
    }, 120);
    resetIdleHint();

    schedulerRef.current = window.setInterval(runScheduler, 25);
    rafRef.current = window.requestAnimationFrame(updateClock);

    return () => {
      if (schedulerRef.current !== null) {
        window.clearInterval(schedulerRef.current);
        schedulerRef.current = null;
      }

      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }

      clearScheduledClicks();
      window.clearTimeout(audioKickTimer);
    };
  }, [
    clearScheduledClicks,
    enableSound,
    resetIdleHint,
    resetTimeline,
    runScheduler,
    updateClock,
  ]);

  useEffect(() => {
    const setPageAudible = (audible: boolean) => {
      if (pageAudibleRef.current === audible) return;

      pageAudibleRef.current = audible;

      if (!audible) {
        clearScheduledClicks();
        return;
      }

      enableSound();
    };

    const syncPageAudibility = () => {
      setPageAudible(document.visibilityState === "visible");
    };
    const mutePage = () => setPageAudible(false);

    syncPageAudibility();
    document.addEventListener("visibilitychange", syncPageAudibility);
    window.addEventListener("focus", syncPageAudibility);
    window.addEventListener("pageshow", syncPageAudibility);
    window.addEventListener("pagehide", mutePage);

    return () => {
      document.removeEventListener("visibilitychange", syncPageAudibility);
      window.removeEventListener("focus", syncPageAudibility);
      window.removeEventListener("pageshow", syncPageAudibility);
      window.removeEventListener("pagehide", mutePage);
    };
  }, [clearScheduledClicks, enableSound]);

  useEffect(() => {
    resetTimeline();
    if (quizStateRef.current !== "idle") {
      cancelQuiz();
    }
  }, [bpm, beatsPerMeasure, beatUnit, silentAlternate, resetTimeline, cancelQuiz]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.closest("input, select, textarea, [contenteditable='true']");

      if (event.code === "Space" && !editing) {
        event.preventDefault();
        registerTap();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [registerTap]);

  useEffect(() => {
    if (quizState !== "countdown") return;

    if (countdown <= 0) {
      startQuizListen();
      return;
    }

    const timeout = window.setTimeout(() => {
      setCountdown((current) => current - 1);
    }, 1000);

    return () => window.clearTimeout(timeout);
  }, [countdown, quizState, startQuizListen]);

  useEffect(() => {
    if (quizState !== "listen") return;

    if (quizListenEndBeatRef.current > 0 && clock.beatIndex >= quizListenEndBeatRef.current) {
      setQuizState("prep");
    }
  }, [clock.beatIndex, quizState]);

  useEffect(() => {
    if (quizState !== "prep") return;

    if (quizPrepEndBeatRef.current > 0 && clock.beatIndex >= quizPrepEndBeatRef.current) {
      activateQuiz(quizPrepEndBeatRef.current);
    }
  }, [activateQuiz, clock.beatIndex, quizState]);

  useEffect(() => {
    if (quizState !== "active") return;

    if (quizEndBeatRef.current > 0 && clock.beatIndex >= quizEndBeatRef.current) {
      finishQuiz();
    }
  }, [clock.beatIndex, finishQuiz, quizState]);

  const updateSignature = (value: string) => {
    const [beats, unit] = value.split("/").map(Number);
    resetTimeline();
    setBeatsPerMeasure(beats);
    setBeatUnit(unit);
    setActiveSetting(null);
  };

  const signatureValue = `${beatsPerMeasure}/${beatUnit}`;
  const beatDots = Array.from({ length: beatsPerMeasure }, (_, index) => index);
  const currentMeasureLabel = silentAlternate ? "开" : "关";
  const expectedQuizBeats = quizBeatCount(config);
  const quizVisualHidden = mode === "quiz" && quizState === "active";
  const drumLocked =
    mode === "quiz" &&
    (quizState === "idle" ||
      quizState === "listen" ||
      quizState === "countdown" ||
      quizState === "done");
  const quizButtonLabel =
    quizState === "active"
      ? "测试中"
      : quizState === "prep"
        ? "预备"
      : quizState === "listen"
        ? "听一遍"
      : quizState === "countdown"
        ? "倒计时"
      : quizState === "done"
        ? "再测一次"
        : "测一测你的节奏感";
  const quizResultCopy = quizResult ? getQuizResultCopy(quizResult) : null;

  return (
    <main className="mobile-shell">
      <nav className="mode-switch" aria-label="练习入口">
        <button
          className={mode === "quiz" ? "is-selected" : ""}
          type="button"
          aria-pressed={mode === "quiz"}
          onClick={() => {
            if (mode !== "quiz") enterQuizMode();
          }}
        >
          测试模式
        </button>
        <button
          className={mode === "practice" ? "is-selected" : ""}
          type="button"
          aria-pressed={mode === "practice"}
          onClick={() => {
            if (mode !== "practice") enterPracticeMode();
          }}
        >
          自由练习
        </button>
      </nav>

      <section className="status-hero" aria-label="当前节拍状态">
        <div className="status-grid">
          <button
            className={activeSetting === "bpm" ? "is-editing" : ""}
            type="button"
            onClick={() => setActiveSetting((current) => (current === "bpm" ? null : "bpm"))}
          >
            <span>BPM</span>
            <strong>{bpm}</strong>
          </button>
          <button
            className={activeSetting === "signature" ? "is-editing" : ""}
            type="button"
            onClick={() =>
              setActiveSetting((current) => (current === "signature" ? null : "signature"))
            }
          >
            <span>拍号</span>
            <strong>{signatureValue}</strong>
          </button>
          <button
            type="button"
            onClick={() => {
              resetTimeline();
              setSilentAlternate((current) => !current);
              setActiveSetting(null);
            }}
          >
            <span>静音</span>
            <strong>{currentMeasureLabel}</strong>
          </button>
        </div>

        {activeSetting === "bpm" && (
          <label className="inline-editor">
            <span>{bpm} BPM</span>
            <input
              type="range"
              min="40"
              max="180"
              value={bpm}
              onChange={(event) => {
                resetTimeline();
                setBpm(Number(event.target.value));
              }}
            />
          </label>
        )}

        {activeSetting === "signature" && (
          <div className="signature-editor" aria-label="选择拍号">
            {SIGNATURE_OPTIONS.map((signature) => (
              <button
                type="button"
                className={signatureValue === signature.label ? "is-selected" : ""}
                key={signature.label}
                onClick={() => updateSignature(signature.label)}
              >
                {signature.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="beat-panel" aria-label="节拍跟打">
        <div
          className={`beat-dots ${quizVisualHidden ? "is-hidden" : ""}`}
          aria-label="当前小节拍点"
          aria-hidden={quizVisualHidden}
          style={{ "--beat-count": beatsPerMeasure } as CSSProperties}
        >
          {beatDots.map((dot) => {
            const beatDotActive =
              beatsPerMeasure === 1 ? clock.progress < 0.5 : clock.beatInMeasure === dot;

            return <span key={dot} className={`beat-dot ${beatDotActive ? "is-active" : ""}`} />;
          })}
        </div>

        <button
          className={`drum-button ${tapPulseId ? "is-hit" : ""} ${drumLocked ? "is-locked" : ""}`}
          type="button"
          aria-disabled={drumLocked}
          aria-label="敲击鼓面跟拍"
          onPointerDown={registerTap}
        >
          <img src={drumPadSrc} alt="" draggable={false} />
          {(quizState === "listen" || quizState === "prep") && (
            <span className="listen-hint">{quizState === "prep" ? "预备拍" : "先听一遍"}</span>
          )}
          {showIdleHint && !drumLocked && <span className="tap-hint">tap tap</span>}
          {tapBubbles.map((bubble) => (
            <span className={`tap-bubble ${bubble.quality}`} key={bubble.id}>
              {bubble.label}
            </span>
          ))}
          <span className="drum-ring" />
        </button>

        {mode === "quiz" && (
          <section className="quiz-panel" aria-label="测验模式">
            <button
              className="quiz-button"
              type="button"
              disabled={
                quizState === "active" ||
                quizState === "countdown" ||
                quizState === "listen" ||
                quizState === "prep"
              }
              onClick={startQuiz}
            >
              {quizButtonLabel}
            </button>
            <p className="quiz-meta">
              {QUIZ_MEASURES}小节·{expectedQuizBeats}拍
            </p>
          </section>
        )}
      </section>

      {mode === "quiz" && quizState === "countdown" && (
        <div className="countdown-overlay" aria-live="assertive" role="status">
          <strong key={countdown}>{Math.max(countdown, 1)}</strong>
        </div>
      )}

      {mode === "quiz" && quizState === "done" && quizResult && quizResultCopy && (
        <div className="result-overlay" role="dialog" aria-modal="true" aria-labelledby="result-title">
          <section className="result-dialog">
            <button
              className="result-close"
              type="button"
              aria-label="关闭结果"
              onClick={cancelQuiz}
            >
              <X size={18} />
            </button>
            <strong className="result-score">{quizResult.accuracy}%</strong>
            <h2 id="result-title">{quizResultCopy.title}</h2>
            <p>{quizResultCopy.body}</p>
            <div className="result-stats">
              <span>
                <small>命中</small>
                <strong>
                  {quizResult.hits}/{quizResult.expected}
                </strong>
              </span>
              <span>
                <small>平均误差</small>
                <strong>{formatMs(quizResult.averageErrorMs)}</strong>
              </span>
            </div>
            <div className="result-actions">
              <button className="result-primary" type="button" onClick={startQuiz}>
                <RotateCcw size={17} />
                再来一轮
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
