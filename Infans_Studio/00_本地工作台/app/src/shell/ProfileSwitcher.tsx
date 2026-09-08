import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

export type ProfilePersona = "personal" | "creator";

const STORAGE_KEY = "infans.profilePersona";
const FLIP_MS = 560;
const BURN_MS = 1180;
/** Mixkit「Fire match lighting」预览，点燃火柴声。 */
const SOUND_SRC = "/sfx/match-light.mp3";

const PERSONAS: Record<ProfilePersona, { name: string; sub: string; avatar: string }> = {
  personal: { name: "我", sub: "查看档案", avatar: "/api/avatar" },
  creator: { name: "创作者", sub: "查看档案", avatar: "/api/avatar?face=creator" },
};

function readStoredPersona(): ProfilePersona {
  try {
    return localStorage.getItem(STORAGE_KEY) === "creator" ? "creator" : "personal";
  } catch {
    return "personal";
  }
}

function noise1(x: number) {
  const ix = Math.floor(x);
  const fx = x - ix;
  const a = Math.sin(ix * 127.1 + 311.7) * 43758.5453;
  const b = Math.sin((ix + 1) * 127.1 + 311.7) * 43758.5453;
  const t = fx * fx * (3 - 2 * fx);
  const fa = a - Math.floor(a);
  const fb = b - Math.floor(b);
  return fa + (fb - fa) * t;
}

function fireRadiusAtAngle(angle: number, progress: number, maxRadius: number) {
  const base = progress * maxRadius;
  return (
    base
    + noise1(angle * 3.1 + progress * 4.2) * maxRadius * 0.12
    + noise1(angle * 8.4 + progress * 9.1) * maxRadius * 0.05
    + noise1(angle * 16.2 + progress * 14.5) * maxRadius * 0.02
  );
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

let burnAudio: HTMLAudioElement | null = null;
let burnStopTimer = 0;

function playPaperBurnSound() {
  try {
    if (!burnAudio) {
      burnAudio = new Audio(SOUND_SRC);
      burnAudio.preload = "auto";
    }
    if (burnStopTimer) window.clearTimeout(burnStopTimer);
    burnAudio.pause();
    burnAudio.currentTime = 0;
    burnAudio.volume = 0.7;
    void burnAudio.play().catch(() => { /* 未解锁则静音跳过 */ });
    // 火柴点燃取前约 1.2s，避免拖成篝火长音
    burnStopTimer = window.setTimeout(() => {
      if (burnAudio) {
        burnAudio.pause();
        burnAudio.currentTime = 0;
      }
    }, 1250);
  } catch {
    /* ignore */
  }
}

type Props = {
  canOpenIdentity: boolean;
  onOpenIdentity: () => void;
};

export function ProfileSwitcher({ canOpenIdentity, onOpenIdentity }: Props) {
  const [persona, setPersona] = useState<ProfilePersona>(() => readStoredPersona());
  const [flipping, setFlipping] = useState(false);
  const [burning, setBurning] = useState(false);
  const [frontName, setFrontName] = useState(() => PERSONAS[readStoredPersona()].name);
  const [backName, setBackName] = useState(() => PERSONAS[readStoredPersona()].name);
  const timers = useRef<number[]>([]);
  const stackRef = useRef<HTMLSpanElement | null>(null);
  const nameRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const burnRaf = useRef(0);
  const burnToken = useRef(0);

  useEffect(() => {
    const img = new Image();
    img.src = PERSONAS.creator.avatar;
    const audio = new Audio(SOUND_SRC);
    audio.preload = "auto";
    burnAudio = audio;
  }, []);

  useEffect(() => () => {
    for (const id of timers.current) window.clearTimeout(id);
    if (burnRaf.current) cancelAnimationFrame(burnRaf.current);
    if (burnStopTimer) window.clearTimeout(burnStopTimer);
  }, []);

  const schedule = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timers.current.push(id);
  };

  useLayoutEffect(() => {
    if (!burning) return;
    const stack = stackRef.current;
    const canvas = canvasRef.current;
    const nameEl = nameRef.current;
    if (!stack || !canvas || !nameEl) return;

    const token = ++burnToken.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nameStyles = getComputedStyle(nameEl);
    const ink = nameStyles.color || "#edf3ee";
    // 侧栏底色：必须铺满整块，否则短名字盖不住底下的长名字
    const plate = "#071014";
    // 旧名字用自己的字号画，避免和底下新名字抢同一套字号
    const frontIsLong = frontName === PERSONAS.creator.name;
    const font = `700 ${frontIsLong ? "11px" : nameStyles.fontSize} ${nameStyles.fontFamily}`;

    const width = Math.max(1, stack.clientWidth);
    const height = Math.max(1, stack.clientHeight);
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const originX = -8;
    const originY = height + 8;
    const maxRadius = Math.hypot(width - originX, height - originY) * 1.25;
    const started = performance.now();
    const textX = 0;
    const textY = height / 2;

    const drawPlateAndText = () => {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = plate;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = ink;
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(frontName, textX, textY);
      ctx.restore();
    };

    const drawFrame = (progress: number) => {
      ctx.clearRect(0, 0, width, height);
      if (progress >= 1) return;

      drawPlateAndText();

      // 火区啃穿遮罩板，底下新名字才露出来
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.moveTo(originX, originY);
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const angle = (Math.PI * 1.12) * (i / steps) - Math.PI * 0.06;
        const radius = fireRadiusAtAngle(angle, progress, maxRadius);
        ctx.lineTo(originX + Math.cos(angle) * radius, originY - Math.sin(angle) * radius);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const edgeProgress = Math.min(1, progress * 1.02);
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const angle = (Math.PI * 1.12) * (i / steps) - Math.PI * 0.06;
        const radius = fireRadiusAtAngle(angle, edgeProgress, maxRadius);
        const x = originX + Math.cos(angle) * radius;
        const y = originY - Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(22, 12, 8, ${0.65 * (1 - progress * 0.3)})`;
      ctx.lineWidth = 2.4;
      ctx.stroke();

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const angle = (Math.PI * 1.12) * (i / steps) - Math.PI * 0.06;
        const radius = fireRadiusAtAngle(angle, edgeProgress, maxRadius) - 1.1;
        const x = originX + Math.cos(angle) * radius;
        const y = originY - Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(255, 118, 32, ${0.78 * (1 - progress * 0.2)})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "rgba(255, 90, 20, 0.9)";
      ctx.shadowBlur = 5;
      ctx.stroke();

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const angle = (Math.PI * 1.12) * (i / steps) - Math.PI * 0.06;
        const radius = fireRadiusAtAngle(angle, edgeProgress, maxRadius) - 2.1;
        const x = originX + Math.cos(angle) * radius;
        const y = originY - Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.shadowBlur = 2;
      ctx.strokeStyle = `rgba(255, 214, 130, ${0.5 * (1 - progress * 0.35)})`;
      ctx.lineWidth = 0.85;
      ctx.stroke();
      ctx.restore();
    };

    if (reduceMotion) {
      drawFrame(1);
      return;
    }

    // 首帧立刻盖住，避免 React 提交后闪一帧双名重叠
    drawFrame(0);

    const tick = (now: number) => {
      if (burnToken.current !== token) return;
      const raw = Math.min(1, (now - started) / BURN_MS);
      const progress = easeInOut(Math.pow(raw, 0.88));
      drawFrame(progress);
      if (raw < 1) burnRaf.current = requestAnimationFrame(tick);
    };
    burnRaf.current = requestAnimationFrame(tick);

    return () => {
      if (burnRaf.current) cancelAnimationFrame(burnRaf.current);
    };
  }, [burning, frontName, backName]);

  const togglePersona = () => {
    if (flipping || burning) return;
    const next: ProfilePersona = persona === "personal" ? "creator" : "personal";
    const outgoing = PERSONAS[persona].name;
    const incoming = PERSONAS[next].name;

    playPaperBurnSound();
    setFrontName(outgoing);
    setBackName(incoming);
    setBurning(true);
    setFlipping(true);
    setPersona(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }

    schedule(() => {
      setFrontName(incoming);
      setBurning(false);
      setFlipping(false);
    }, Math.max(FLIP_MS, BURN_MS) + 40);
  };

  const current = PERSONAS[persona];
  const shownName = burning ? backName : frontName;
  const longName = shownName === PERSONAS.creator.name;

  return (
    <div className={`profile${persona === "creator" ? " is-creator" : ""}${flipping ? " is-flipping" : ""}`}>
      <button
        type="button"
        className={`avatar avatar-flip${persona === "creator" ? " is-creator" : ""}${flipping ? " is-flipping" : ""}`}
        onClick={togglePersona}
        aria-label={persona === "personal" ? "切换到抖音出镜身份" : "切回个人身份"}
        title={persona === "personal" ? "点头像切换到抖音出镜身份" : "点头像切回个人身份"}
      >
        <span className="avatar-flip-inner" aria-hidden="true">
          <span className="avatar-face front"><img src={PERSONAS.personal.avatar} alt=""/></span>
          <span className="avatar-face back"><img src={PERSONAS.creator.avatar} alt=""/></span>
        </span>
      </button>
      <button
        type="button"
        className="profile-meta"
        onClick={onOpenIdentity}
        disabled={!canOpenIdentity}
        aria-label="查看档案"
      >
        <span ref={stackRef} className={`profile-name-stack${burning ? " is-burning" : ""}`}>
          <strong
            ref={nameRef}
            className={`profile-name under${longName ? " is-long" : ""}${burning ? " is-revealing" : ""}`}
          >
            {shownName}
          </strong>
          {burning ? <canvas ref={canvasRef} className="profile-burn-canvas" aria-hidden="true"/> : null}
        </span>
        <small>{current.sub}</small>
      </button>
      <button
        type="button"
        className="profile-chevron"
        onClick={onOpenIdentity}
        disabled={!canOpenIdentity}
        aria-label="打开档案"
        tabIndex={-1}
      >
        <ChevronRight size={14}/>
      </button>
    </div>
  );
}
