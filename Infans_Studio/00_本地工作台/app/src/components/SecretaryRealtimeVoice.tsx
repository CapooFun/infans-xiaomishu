import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, PhoneOff, X } from "lucide-react";
import { CHAT_CHARACTER_REGISTRY, chatCharacterById } from "../secretary-characters.mjs";
import { stopSecretarySpeech } from "../secretary-tts";
import "./secretary-realtime-voice.css";

type RealtimeStatus = {
  available: boolean;
  configured: boolean;
  health: string;
  model: string;
  models?: Array<{ id: string; label: string; cost: string }>;
  label: string;
  privacy: string;
};

type CallPhase = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";
type HybridVoicePhase = "idle" | "listening" | "hearing" | "thinking" | "speaking" | "error";
type VoiceMode = "hybrid" | "realtime";
type RealtimeTurn = { id: number; who: "user" | "assistant"; speaker: string; text: string };

const MAX_CALL_MS = 10 * 60 * 1000;
/**
 * 原生 OpenAI Realtime 暂时只保留实现，不进入正常 UI。
 * 余额与密钥就绪后把这一处改为 true，即可恢复入口。
 */
export const OPENAI_REALTIME_UI_ENABLED = false;

const PHASE_LABELS: Record<CallPhase, string> = {
  idle: "还没有接通",
  connecting: "正在接通…",
  listening: "正在听你说",
  thinking: "听见了，正在回应…",
  speaking: "正在说话，你可以随时插话",
  error: "这次没有接通",
};

const HYBRID_PHASE_LABELS: Record<HybridVoicePhase, string> = {
  idle: "还没有开始",
  listening: "正在听你说",
  hearing: "听见你开口，已打断播报",
  thinking: "转写已交给当前文字模型",
  speaking: "正在分段播报，你可以随时插话",
  error: "这轮遇到问题，仍可继续说话",
};

function eventUsage(event: Record<string, unknown>) {
  const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : null;
  const usage = response?.usage && typeof response.usage === "object" ? response.usage as Record<string, unknown> : null;
  return {
    total: Number(usage?.total_tokens) || 0,
    input: Number(usage?.input_tokens) || 0,
    output: Number(usage?.output_tokens) || 0,
  };
}

export function SecretaryRealtimeVoice({
  tabIndex,
  disabled = false,
  hybridAvailable,
  hybridModelLabel,
  hybridActive,
  hybridPhase,
  hybridLastTranscript,
  hybridError,
  onStartHybrid,
  onStopHybrid,
  onToast,
}: {
  tabIndex?: number;
  disabled?: boolean;
  hybridAvailable: boolean;
  hybridModelLabel: string;
  hybridActive: boolean;
  hybridPhase: HybridVoicePhase;
  hybridLastTranscript: string;
  hybridError: string;
  onStartHybrid: () => void | Promise<void>;
  onStopHybrid: () => void;
  onToast: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<VoiceMode>("hybrid");
  const [status, setStatus] = useState<RealtimeStatus | null>(null);
  const [speaker, setSpeaker] = useState("yinyue");
  const [model, setModel] = useState("gpt-realtime-2.1-mini");
  const [includeTranscription, setIncludeTranscription] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<RealtimeTurn[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [usage, setUsage] = useState({ total: 0, input: 0, output: 0 });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const handshakeAbortRef = useRef<AbortController | null>(null);
  const callGenerationRef = useRef(0);
  const stopTimerRef = useRef<number | null>(null);
  const clockTimerRef = useRef<number | null>(null);
  const assistantDraftRef = useRef("");
  const turnIdRef = useRef(0);

  const active = phase !== "idle" && phase !== "error";
  const character = chatCharacterById(speaker);

  const clearTimers = () => {
    if (stopTimerRef.current != null) window.clearTimeout(stopTimerRef.current);
    if (clockTimerRef.current != null) window.clearInterval(clockTimerRef.current);
    stopTimerRef.current = null;
    clockTimerRef.current = null;
  };

  const stopCall = (message = "") => {
    callGenerationRef.current += 1;
    clearTimers();
    handshakeAbortRef.current?.abort();
    channelRef.current?.close();
    peerRef.current?.close();
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
    channelRef.current = null;
    peerRef.current = null;
    micStreamRef.current = null;
    remoteAudioRef.current = null;
    handshakeAbortRef.current = null;
    assistantDraftRef.current = "";
    setAssistantDraft("");
    setElapsedSeconds(0);
    setPhase("idle");
    if (message) onToast(message);
  };

  useEffect(() => () => stopCall(), []);

  const refreshStatus = async () => {
    setStatus(null);
    try {
      const response = await fetch("/api/openai-realtime/status", { cache: "no-store" });
      const payload = await response.json() as RealtimeStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error || "实时语音状态检查失败");
      setStatus(payload);
    } catch (statusError) {
      setStatus({
        available: false,
        configured: false,
        health: "unreachable",
        model: "gpt-realtime-2.1",
        models: [],
        label: statusError instanceof Error ? statusError.message : "实时语音状态检查失败",
        privacy: "没有建立外部连接。",
      });
    }
  };

  const openDialog = () => {
    setOpen(true);
    setError("");
    if (OPENAI_REALTIME_UI_ENABLED) void refreshStatus();
  };

  const closeDialog = () => {
    if (active) stopCall("实时语音已结束");
    setOpen(false);
  };

  const appendTurn = (turn: Omit<RealtimeTurn, "id">) => {
    setTurns((current) => [...current.slice(-7), { ...turn, id: ++turnIdRef.current }]);
  };

  const handleRealtimeEvent = (raw: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type || "");
    if (type === "input_audio_buffer.speech_started") {
      if (remoteAudioRef.current) remoteAudioRef.current.muted = true;
      setPhase("listening");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      setPhase("thinking");
      if (!includeTranscription) appendTurn({ who: "user", speaker: "你", text: "（语音已发送）" });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(event.transcript || "").trim();
      if (transcript) appendTurn({ who: "user", speaker: "你", text: transcript });
      return;
    }
    if (type === "response.created") {
      if (remoteAudioRef.current) remoteAudioRef.current.muted = false;
      assistantDraftRef.current = "";
      setAssistantDraft("");
      setPhase("speaking");
      return;
    }
    if (type === "response.output_audio_transcript.delta") {
      assistantDraftRef.current += String(event.delta || "");
      setAssistantDraft(assistantDraftRef.current);
      return;
    }
    if (type === "response.output_audio_transcript.done") {
      const transcript = String(event.transcript || assistantDraftRef.current).trim();
      if (transcript) appendTurn({ who: "assistant", speaker: character?.name || "角色", text: transcript });
      assistantDraftRef.current = "";
      setAssistantDraft("");
      return;
    }
    if (type === "response.done") {
      const nextUsage = eventUsage(event);
      setUsage((current) => ({
        total: current.total + nextUsage.total,
        input: current.input + nextUsage.input,
        output: current.output + nextUsage.output,
      }));
      setPhase("listening");
      return;
    }
    if (type === "error") {
      const detail = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : null;
      const message = String(detail?.message || "OpenAI 实时语音返回了错误。");
      stopCall();
      setError(message);
      setPhase("error");
    }
  };

  const startCall = async () => {
    if (!status?.available || active) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setError("当前浏览器不支持 WebRTC 麦克风通话。请用最新版 Safari 或 Chrome。 ");
      setPhase("error");
      return;
    }
    stopSecretarySpeech();
    setError("");
    setTurns([]);
    setUsage({ total: 0, input: 0, output: 0 });
    setElapsedSeconds(0);
    setPhase("connecting");
    const generation = ++callGenerationRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const peer = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      peerRef.current = peer;
      micStreamRef.current = stream;
      remoteAudioRef.current = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void audio.play().catch(() => {});
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected"].includes(peer.connectionState)) {
          stopCall();
          setError("实时语音连接已经断开。 ");
          setPhase("error");
        }
      };
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (event) => handleRealtimeEvent(String(event.data || ""));
      channel.onopen = () => setPhase("listening");

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const query = new URLSearchParams({ speaker, model, transcript: includeTranscription ? "1" : "0" });
      const handshakeAborter = new AbortController();
      handshakeAbortRef.current = handshakeAborter;
      const response = await fetch(`/api/openai-realtime/session?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
        signal: handshakeAborter.signal,
      });
      if (generation !== callGenerationRef.current) return;
      if (!response.ok) {
        const contentType = response.headers.get("content-type") || "";
        const payload = contentType.includes("application/json")
          ? await response.json() as { error?: string }
          : null;
        throw new Error(payload?.error || "实时语音没有建立成功。 ");
      }
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
      handshakeAbortRef.current = null;
      const startedAt = Date.now();
      clockTimerRef.current = window.setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }, 1_000);
      stopTimerRef.current = window.setTimeout(() => stopCall("已到十分钟费用保护上限，实时语音自动结束"), MAX_CALL_MS);
    } catch (callError) {
      if (generation !== callGenerationRef.current) return;
      const message = callError instanceof Error ? callError.message : "实时语音没有建立成功。";
      stopCall();
      setError(message);
      setPhase("error");
    }
  };

  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");

  return (
    <>
      <button
        type="button"
        tabIndex={tabIndex}
        className={active || hybridActive ? "active" : ""}
        disabled={disabled}
        onClick={openDialog}
        aria-label="选择普通对话或混合实时"
        title={hybridActive ? "混合实时正在听；点此查看或结束" : "对话模式：普通对话 / 混合实时"}
      >
        <Mic size={15}/>
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div className="realtime-voice-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDialog()}>
          <section className="realtime-voice-dialog" role="dialog" aria-modal="true" aria-labelledby="realtime-voice-title">
            <header>
              <div>
                <span>VOICE MODE</span>
                <h2 id="realtime-voice-title">选择说话方式</h2>
              </div>
              <button type="button" onClick={closeDialog} aria-label="关闭语音模式选择"><X size={18}/></button>
            </header>

            <div className="realtime-voice-mode-choices" aria-label="对话模式">
              <button
                type="button"
                onClick={() => {
                  if (hybridActive) onStopHybrid();
                  closeDialog();
                }}
              >
                <strong>普通对话</strong>
                <span>低成本 · 文字或按段语音</span>
                <small>保留现有文字对话和 TTS；按住说完一段再发送。</small>
              </button>
              <button
                type="button"
                className={selectedMode === "hybrid" ? "selected" : ""}
                aria-pressed={selectedMode === "hybrid"}
                onClick={() => {
                  if (active) stopCall();
                  setSelectedMode("hybrid");
                }}
              >
                <strong>混合实时</strong>
                <span>免按住 · 可打断 · 外部模型</span>
                <small>持续听你说；转写后交给你自行接入的模型，再把回复分段播出。低延迟，但不是端到端实时音频模型。</small>
              </button>
              {OPENAI_REALTIME_UI_ENABLED ? (
                <button
                  type="button"
                  className={selectedMode === "realtime" ? "selected" : ""}
                  aria-pressed={selectedMode === "realtime"}
                  onClick={() => {
                    if (hybridActive) onStopHybrid();
                    setSelectedMode("realtime");
                  }}
                >
                  <strong>OpenAI 原生实时</strong>
                  <span>一对一 · 端到端音频</span>
                  <small>麦克风、生成和语音输出全部由 OpenAI Realtime 处理。</small>
                </button>
              ) : null}
            </div>

            {selectedMode === "hybrid" ? (
              <>
                <div className="realtime-voice-status">
                  <i className={hybridAvailable ? "online" : ""}/>
                  <div>
                    <strong>{hybridModelLabel}</strong>
                    <small>回复内容继续由你自行接入的文字模型生成；语音层只负责转写、打断和分段朗读。</small>
                  </div>
                </div>
                <div className={`realtime-voice-pulse ${hybridPhase}`}>
                  <i/><i/><i/>
                  <strong>{HYBRID_PHASE_LABELS[hybridPhase]}</strong>
                  {hybridActive ? <small>持续收音中</small> : null}
                </div>
                <div className="realtime-voice-transcript hybrid" aria-live="polite">
                  {hybridLastTranscript ? (
                    <article className="user">
                      <strong>刚才听见</strong>
                      <span>{hybridLastTranscript}</span>
                    </article>
                  ) : (
                    <p>开始后直接说话。你在角色播报时开口，当前生成与朗读会立刻停止，再接收你的新一句。</p>
                  )}
                </div>
                {hybridError ? <p className="realtime-voice-error">{hybridError}</p> : null}
                <footer>
                  <small>混合实时复用普通模式的转写与朗读，不绑定作者私人模型。</small>
                  {hybridActive ? (
                    <button type="button" className="realtime-voice-end" onClick={onStopHybrid}><PhoneOff size={16}/>结束混合实时</button>
                  ) : (
                    <button type="button" className="realtime-voice-start" disabled={!hybridAvailable} onClick={() => void onStartHybrid()}><Mic size={16}/>开始混合实时</button>
                  )}
                </footer>
              </>
            ) : null}

            {OPENAI_REALTIME_UI_ENABLED && selectedMode === "realtime" ? (
              <>
                <div className="realtime-voice-status">
                  <i className={status?.available ? "online" : ""}/>
                  <div>
                    <strong>{status?.label || "正在检查本机配置…"}</strong>
                    <small>{status?.privacy || "浏览器不会收到长期 API 密钥。"}</small>
                  </div>
                </div>

                {!status?.configured && status ? (
                  <div className="realtime-voice-setup">
                    请在 macOS“钥匙串访问”中新建通用密码：服务填 <code>Infans OpenAI API</code>，账户填 <code>Infans</code>，密码填 OpenAI API Key。还需要该 API 项目有可用余额。
                  </div>
                ) : null}

                <div className="realtime-voice-controls">
                  <label>
                    <span>Realtime 模型</span>
                    <select value={model} disabled={active} onChange={(event) => setModel(event.target.value)}>
                      {(status?.models?.length ? status.models : [
                        { id: "gpt-realtime-2.1-mini", label: "GPT-Realtime-2.1 mini", cost: "较低成本" },
                        { id: "gpt-realtime-2.1", label: "GPT-Realtime-2.1", cost: "较强表现" },
                      ]).map((item) => (
                        <option key={item.id} value={item.id}>{item.label} · {item.cost}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>这次和谁说</span>
                    <select value={speaker} disabled={active} onChange={(event) => setSpeaker(event.target.value)}>
                      {CHAT_CHARACTER_REGISTRY.map((item) => (
                        <option key={item.id} value={item.id}>{item.name} · {item.shortTag}</option>
                      ))}
                    </select>
                  </label>
                  <label className="realtime-voice-transcript-option">
                    <input
                      type="checkbox"
                      checked={includeTranscription}
                      disabled={active}
                      onChange={(event) => setIncludeTranscription(event.target.checked)}
                    />
                    <span>显示我的语音转写 <small>会另行计费；默认关闭</small></span>
                  </label>
                </div>

                <div className={`realtime-voice-pulse ${phase}`}>
                  <i/><i/><i/>
                  <strong>{PHASE_LABELS[phase]}</strong>
                  {active ? <small>{minutes}:{seconds} / 10:00</small> : null}
                </div>

                <div className="realtime-voice-transcript" aria-live="polite">
                  {!turns.length && !assistantDraft ? (
                    <p>接通后直接说话。角色发言时你一开口，播放会立即静音，服务端也会取消未说完的回答。</p>
                  ) : null}
                  {turns.map((turn) => (
                    <article key={turn.id} className={turn.who}>
                      <strong>{turn.speaker}</strong>
                      <span>{turn.text}</span>
                    </article>
                  ))}
                  {assistantDraft ? (
                    <article className="assistant live">
                      <strong>{character?.name || "角色"}</strong>
                      <span>{assistantDraft}</span>
                    </article>
                  ) : null}
                </div>

                {error ? <p className="realtime-voice-error">{error}</p> : null}
                <footer>
                  <small>累计用量：{usage.total ? `${usage.total} tokens（输入 ${usage.input} / 输出 ${usage.output}）` : "尚无返回"}</small>
                  {active ? (
                    <button type="button" className="realtime-voice-end" onClick={() => stopCall("实时语音已结束")}><PhoneOff size={16}/>结束</button>
                  ) : (
                    <button type="button" className="realtime-voice-start" disabled={!status?.available} onClick={() => void startCall()}><Mic size={16}/>开始实时语音</button>
                  )}
                </footer>
              </>
            ) : null}
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
