// @ts-nocheck
import { PersonalGallery } from "../personal-gallery/PersonalGallery";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { FolderOpen, ImagePlus, MessageSquarePlus, Mic, Paperclip, Pencil, Save, Search, Send, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { Kicker, jsonFetch } from "../page-shared";
import {
  getSecretarySpeechRatePreset,
  isSecretaryVoiceEnabled,
  onSecretarySpeechBlocked,
  onSecretarySpeechState,
  previewSecretaryHighQuality,
  resumeBlockedSecretarySpeech,
  setSecretaryVoiceEnabled,
  setSecretarySpeechRatePreset,
  speakAsSecretary,
  speakSecretaryTurns,
  stopSecretarySpeech,
  takeHybridSpeechChunks,
  unlockSecretaryAudio,
} from "../secretary-tts";
import type { SecretarySpeechRatePreset } from "../secretary-tts";
import {
  chatCharacterById,
  chatSpeakerLabel,
  normalizeChatSpeaker,
} from "../secretary-characters.mjs";
import { isWorkbenchCodePath } from "../vault-paths";
import type { AiChatAttachment, AiChatMessage, AiProposedAction, AiSecretarySpeaker, HealthSectionData, WorkbenchSummary, WriteAction, WritePreview } from "../types";
import { aiWriteNeedsConfirmation, skipsAiWriteConfirmation } from "../write-confirmation-policy";
import { useIsNarrowViewport, useVisualViewportBackdropStyle, useVisualViewportBox } from "./useVisualViewportBox";
import { isHoldToTalkSpace, mergeVoiceTranscript, waitForVoiceTranscripts } from "../secretary-voice-shortcut";
import { extractSecretarySwitchIntent, PUBLIC_USER_DISPLAY_NAME, secretaryDutyPortrait, secretaryProfileById, secretaryRefreshPortraitSrc } from "../secretary-identity.mjs";
import { isDisplayModeHiddenSecretaryChat } from "../display-mode";
import { archiveMessageSnapshot, chatOriginalMetadata, sameArchiveSnapshot, saveCurrentArchiveSnapshot, type ChatOriginalMetadata } from "../secretary-archive-save";
import { createPublicThreadBuffer, mergeLoadedSession, shouldAutoApplyDiskArchive } from "../opensource-thread-buffer.mjs";

type SpeechRecognitionResultLike = { isFinal: boolean; 0?: { transcript?: string } };
type SpeechRecognitionEventLike = { results: ArrayLike<SpeechRecognitionResultLike>; resultIndex?: number };
type SpeechRecognitionErrorEventLike = { error?: string };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev?: SpeechRecognitionErrorEventLike) => void) | null;
  onspeechstart?: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const MAX_PENDING_ATTACHMENTS = 4;
const NATIVE_TRANSCRIPT_EVENT = "infans:secretary-native-transcript";

function isUnusableModelReplyText(text = "") {
  return !String(text || "").trim();
}












/** 桌面点网页别处时只收回面板，仍露出这一截，好知道银月还在。 */
const AI_PEEK_REMAIN_RATIO = 0.05;
const AI_PEEK_HIDDEN = `${(1 - AI_PEEK_REMAIN_RATIO) * 100}%`;

type PendingAttachment = {
  localId: string;
  kind: "image" | "audio" | "file";
  name: string;
  mime: string;
  file: File | Blob;
  previewUrl?: string;
  durationMs?: number;
  transcript?: string;
};

type AskOptions = {
  include?: string[];
  /** 不插入用户气泡，用于自动续聊 */
  silent?: boolean;
  autoContinue?: boolean;
  attachments?: AiChatAttachment[];
  voiceTranscript?: string;
  /** 覆盖用户气泡展示文案（语音条可只显示「语音」） */
  displayText?: string;
  /** 免按住的混合实时轮次：外部文本模型 + 可打断分段 TTS。 */
  hybrid?: boolean;
};

type HybridVoicePhase = "idle" | "listening" | "hearing" | "thinking" | "speaking" | "error";
const SPEECH_RATE_OPTIONS: Array<{ value: SecretarySpeechRatePreset; label: string }> = [
  { value: "slow", label: "慢" },
  { value: "normal", label: "正常" },
  { value: "fast", label: "快" },
  { value: "veryfast", label: "很快" },
];
function nextSpeechRateOption(current: SecretarySpeechRatePreset) {
  const index = SPEECH_RATE_OPTIONS.findIndex((item) => item.value === current);
  return SPEECH_RATE_OPTIONS[(index + 1) % SPEECH_RATE_OPTIONS.length];
}

type AiQualityMode = "light";
function openRouterUsageCost(raw: unknown) {
  if (!raw || typeof raw !== "object") return 0;
  const usage = raw as Record<string, unknown>;
  const value = Number(usage.cost ?? usage.total_cost ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function openRouterUsageTokens(raw: unknown) {
  if (!raw || typeof raw !== "object") return 0;
  const usage = raw as Record<string, unknown>;
  const value = Number(usage.total_tokens ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function postNativeSecretaryMessage(payload: unknown) {
  const nativeBridge = (window as Window & {
    webkit?: { messageHandlers?: { secretaryPet?: { postMessage: (payload: unknown) => void } } };
  }).webkit?.messageHandlers;
  const bridge = nativeBridge?.secretaryPet;
  if (!bridge) return false;
  bridge.postMessage(payload);
  return true;
}

function requestNativeMicrophonePermission() {
  postNativeSecretaryMessage({ type: "request-microphone" });
}

function setNativeVoiceRecognition(active: boolean) {
  return postNativeSecretaryMessage({ type: "voice-recognition", action: active ? "start" : "stop" });
}

export type PreviewState = { preview: WritePreview; commitUrl: string; afterCommit?: () => void } | null;

export type AskSelectionBootstrap = {
  mode: "askSelection";
  seedUser: string;
  teaching?: boolean;
};

type OrdinaryBackendChoice = "openrouter" | "cursor";
const ORDINARY_BACKEND_STORAGE_KEY = "infans-ordinary-backend-v1";
const OPENSOURCE_UNCONFIGURED = "模型未配置";

function readStoredOrdinaryBackend(): OrdinaryBackendChoice {
  return "cursor";
}

function storeOrdinaryBackend(value: OrdinaryBackendChoice) {
  try {
    window.localStorage.setItem(ORDINARY_BACKEND_STORAGE_KEY, value);
  } catch {
    /* 受限 WebView 仍可保留本次会话选择。 */
  }
}

export type AiPanelBootstrap =
  | AskSelectionBootstrap
  | {
      mode: "healthCoach";
      seedUser: string;
      include: string[];
    }
  | {
      mode: "japaneseExam";
      suggestedScope: { level: string; track: string; label: string };
      examSessionId?: string | null;
      seedAssistant?: string;
      seedUser?: string;
    };


type AiActionResult = { summary: string; ok: boolean; detail: string };
type AiThreadMessage = AiChatMessage & ChatOriginalMetadata & { id: string; sources?: string[]; actionResults?: AiActionResult[]; pending?: boolean };

function normalizeSecretarySpeaker(speaker?: string): AiSecretarySpeaker | null {
  if (!String(speaker || "").trim()) return null;
  return normalizeChatSpeaker(speaker) as AiSecretarySpeaker | null;
}

function secretaryLabel(speaker?: AiSecretarySpeaker) {
  return secretaryProfileById(speaker)?.name || chatSpeakerLabel(speaker) || "";
}

type ChatAvatarVisual = {
  label: string;
  src: string;
  position: string;
  accent: string;
  scale?: number;
  origin?: string;
};

function chatAvatarVisual(speaker?: AiSecretarySpeaker | null, user = false): ChatAvatarVisual {
  if (user) return { label: PUBLIC_USER_DISPLAY_NAME, src: "/api/avatar", position: "center", accent: "#d8aa78" };
  const normalized = normalizeSecretarySpeaker(speaker || undefined) || "yinyue";
  const character = chatCharacterById(normalized);
  const secretary = secretaryProfileById(String(normalized));
  return {
    label: character?.name || secretary?.name || "银月",
    src: secretary?.chatAvatarSrc || secretaryRefreshPortraitSrc(secretary) || "",
    position: "center",
    accent: character?.accent || "#d8aa78",
  };
}

export function ChatAvatar({
  speaker,
  user = false,
  className = "",
  privateAllowed = false,
}: {
  speaker?: AiSecretarySpeaker | null;
  user?: boolean;
  className?: string;
  privateAllowed?: boolean;
}) {
  const visual = chatAvatarVisual(speaker, user);
  return (
    <span
      className={`ai-chat-avatar${className ? ` ${className}` : ""}`}
      style={{ "--speaker-accent": visual.accent } as CSSProperties}
      aria-hidden="true"
    >
      {visual.src ? (
        <img
          src={visual.src}
          alt=""
          width="40"
          height="40"
          loading="lazy"
          style={{ objectPosition: visual.position, transform: visual.scale ? `scale(${visual.scale})` : undefined, transformOrigin: visual.origin }}
        />
      ) : (
        <span>{visual.label.slice(0, 1)}</span>
      )}
    </span>
  );
}

function assistantBubbleSeat(
  message: AiThreadMessage,
  residentSpeaker: AiSecretarySpeaker,
) {
  const speaker = normalizeSecretarySpeaker(message.speaker) || residentSpeaker;
  return `${speaker} resident`;
}

function readSecretaryReplies(raw: unknown): Array<{ speaker: AiSecretarySpeaker; content: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item.content !== "string" || !item.content.trim()) return [];
    const speaker = normalizeSecretarySpeaker(item.speaker);
    const content = String(item.content).trim();
    if (!speaker || isUnusableModelReplyText(content)) return [];
    return [{ speaker, content }];
  });
}

function slimChatMessage(item: AiThreadMessage, residentSpeaker: AiSecretarySpeaker = "yinyue") {
  return archiveMessageSnapshot(item, normalizeSecretarySpeaker(item.speaker) || residentSpeaker);
}

function chatArchiveFingerprint(
  messages: AiThreadMessage[],
  title: string,
  chatState: Record<string, unknown>,
) {
  return JSON.stringify({
    title,
    chatState,
    messages: messages
      .filter((item) => !item.pending && (item.content.trim() || item.attachments?.length))
      .map((item) => slimChatMessage(
        item,
        (chatState.residentSpeaker as AiSecretarySpeaker)
          || (chatState.activeSecretaryId as AiSecretarySpeaker)
          || "yinyue",
      )),
  });
}

function formatAudioDuration(ms?: number) {
  if (!ms || ms <= 0) return "";
  const total = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function guessAttachmentKind(mime: string, fileName = ""): "image" | "audio" | "file" {
  const lower = String(mime || "").toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("audio/") || lower === "video/webm") return "audio";
  const ext = fileName.toLowerCase().split(".").pop() || "";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["webm", "m4a", "mp3", "wav", "mp4"].includes(ext)) return "audio";
  return "file";
}

async function uploadSecretaryAttachment(item: PendingAttachment): Promise<AiChatAttachment> {
  const response = await fetch("/api/secretary-attachments", {
    method: "POST",
    headers: {
      "Content-Type": item.mime || "application/octet-stream",
      "X-Infans-Filename": encodeURIComponent(item.name || "附件"),
      ...(item.durationMs ? { "X-Infans-Duration-Ms": String(Math.round(item.durationMs)) } : {}),
    },
    body: item.file,
  });
  if (!response.ok) {
    let message = `上传失败（${response.status}）`;
    try {
      const payload = await response.json();
      if (payload?.error) message = String(payload.error);
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  const saved = await response.json();
  return {
    id: String(saved.id),
    kind: saved.kind === "image" || saved.kind === "audio" || saved.kind === "file" ? saved.kind : item.kind,
    name: String(saved.name || item.name),
    mime: String(saved.mime || item.mime),
    url: String(saved.url || `/api/secretary-attachments/${encodeURIComponent(saved.id)}`),
    path: saved.path ? String(saved.path) : undefined,
    durationMs: Number(saved.durationMs) > 0 ? Number(saved.durationMs) : item.durationMs,
    transcript: item.transcript,
  };
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

type AiPendingWrite = {
  action: AiProposedAction;
  preview: WritePreview;
  commitUrl: string;
  resolve: (ok: boolean) => void;
};
type PendingHighQualityPreview = {
  id: string;
  content: string;
  speaker: AiSecretarySpeaker;
};
type SecretaryChatListItem = {
  archiveVersion?: string;
  id: string;
  title: string;
  savedAt: string;
  messageCount: number;
  preview: string;
  path: string;
  private?: boolean;
};

function AiCompactConfirm({
  title,
  description,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="ai-confirm-backdrop">
      <motion.section
        className="ai-write-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-confirm-title"
        aria-describedby="ai-confirm-description"
        initial={{ opacity: 0, scale: .98 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        <h3 id="ai-confirm-title">{title}</h3>
        <p id="ai-confirm-description">{description}</p>
        <footer>
          <button type="button" className="ghost-button" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="gold-button" disabled={busy} onClick={onConfirm}>{busy ? "正在执行…" : confirmLabel}</button>
        </footer>
      </motion.section>
    </div>
  );
}

type AiOrdinaryStatus = {
  available: boolean;
  configured?: boolean;
  backend?: string;
  model?: string;
  label: string;
};

type AiRuntimeStatus = {
  installed: boolean;
  loggedIn: boolean;
  label: string;
  model?: string;
  email?: string;
  ordinary?: AiOrdinaryStatus;
};

type AiSessionSnapshot = {
  messages: AiThreadMessage[];
  archiveId: string | null;
  archiveVersion?: string;
  saveConflict?: boolean;
  title: string;
  qualityMode: AiQualityMode;
  private: boolean;
};

function emptyAiSession(): AiSessionSnapshot {
  return {
    messages: [],
    archiveId: null,
    title: "",
    qualityMode: "light",
    private: false,
  };
}

function normalizeStoredMessages(raw: unknown[]): AiThreadMessage[] {
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .flatMap<AiThreadMessage>((item, index): AiThreadMessage[] => {
      const speaker: AiSecretarySpeaker | undefined = item.role === "assistant"
        ? normalizeSecretarySpeaker(typeof item.speaker === "string" ? item.speaker : undefined) || undefined
        : undefined;
      if (item.role === "assistant" && !speaker) {
        return [{
          id: String(item.id || `restored-${index}`),
          role: "assistant" as const,
          content: String(item.content),
          ...chatOriginalMetadata(item as ChatOriginalMetadata),
          sources: Array.isArray(item.sources) ? item.sources.map(String) : undefined,
          attachments: Array.isArray(item.attachments) ? item.attachments as AiChatAttachment[] : undefined,
        }];
      }
      return [{
        id: String(item.id || `restored-${index}`),
        role: item.role as "user" | "assistant",
        content: String(item.content),
        ...chatOriginalMetadata(item as ChatOriginalMetadata),
        speaker,
        sources: Array.isArray(item.sources) ? item.sources.map(String) : undefined,
        attachments: Array.isArray(item.attachments) ? item.attachments as AiChatAttachment[] : undefined,
      }];
    });
}

function formatChatSavedAt(value: string) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Tokyo",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(value));
  } catch {
    return value.slice(0, 16);
  }
}

async function previewAiAction(action: AiProposedAction): Promise<{ preview: WritePreview; commitUrl: string }> {
  if (action.kind === "calendarCreate") {
    const preview = await jsonFetch<WritePreview>("/api/calendar/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "create", title: action.title, start: action.start, end: action.end, calendar: action.calendar, allDay: action.allDay }),
    });
    return { preview, commitUrl: "/api/calendar/commit" };
  }
  if (action.kind === "relationshipMemory") {
    const preview = await jsonFetch<WritePreview>("/api/relationship-memory/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secretaryId: action.secretaryId, operation: action.operation, text: action.text, oldText: action.oldText, newText: action.newText }),
    });
    return { preview, commitUrl: "/api/relationship-memory/commit" };
  }
  let payload: WriteAction;
  if (action.kind === "addTodo") {
    payload = action.scope === "project" && action.projectId
      ? { kind: "addTodo", scope: "project", projectId: action.projectId, text: action.text }
      : { kind: "addTodo", scope: action.scope === "longTerm" ? "longTerm" : "today", text: action.text };
  }
  else if (action.kind === "journal") payload = { kind: "journal", text: action.text };
  else if (action.kind === "editFile") {
    payload = action.content != null
      ? { kind: "editFile", path: action.path, content: action.content }
      : { kind: "editFile", path: action.path, oldText: action.oldText, newText: action.newText };
  } else {
    throw new Error("不支持的行动类型");
  }
  const preview = await jsonFetch<WritePreview>("/api/write/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { preview, commitUrl: "/api/write/commit" };
}

async function commitAiPreview(commitUrl: string, token: string) {
  await jsonFetch(commitUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
}

function actionSuccessDetail(action: AiProposedAction) {
  if (action.kind === "calendarCreate") return "已写入苹果日历";
  if (action.kind === "addTodo") return "已加入待办";
  if (action.kind === "editFile") return action.requiresConfirm ? "已确认并写入代码" : "已写入文件";
  if (action.kind === "relationshipMemory") return "已确认并写入关系记忆";
  return "已记入今天日记";
}

function actionNeedsConfirm(action: AiProposedAction, preview: WritePreview) {
  return aiWriteNeedsConfirmation(action, preview, action.kind === "editFile" && isWorkbenchCodePath(action.path));
}

export function IdentityOverlay({ data, onClose }: { data: WorkbenchSummary; onClose: () => void }) {
  return <PersonalGallery data={data} onClose={onClose}/>;
}

export function AiPanel({
  activeSecretaryId,
  onSecretaryChange,
  displayMode = false,
  onClose,
  peeked = false,
  onPeek,
  onExpand,
  onToast,
  onDataRefresh,
  onCalendarRefresh,
  bootstrap = null,
  onBootstrapConsumed,
}: {
  activeSecretaryId: AiSecretarySpeaker;
  onSecretaryChange: (secretaryId: string) => void | Promise<void>;
  displayMode?: boolean;
  onClose: () => void;
  peeked?: boolean;
  onPeek?: () => void;
  onExpand?: () => void;
  onToast: (message: string) => void;
  onDataRefresh: () => void;
  onCalendarRefresh: () => void;
  bootstrap?: AiPanelBootstrap | null;
  onBootstrapConsumed?: () => void;
}) {
  const activeSecretary = secretaryProfileById(activeSecretaryId)!;
  const ordinaryDutyPortrait = secretaryDutyPortrait(activeSecretary);
  const initialSession = useRef(emptyAiSession()).current;
  const [bufferReady, setBufferReady] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const threadBufferRef = useRef(createPublicThreadBuffer());
  const [status, setStatus] = useState<AiRuntimeStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AiThreadMessage[]>(() => initialSession.messages);
  const messagesRef = useRef<AiThreadMessage[]>(initialSession.messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [applying, setApplying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(() => isSecretaryVoiceEnabled());
  const [speechRatePreset, setSpeechRatePreset] = useState<SecretarySpeechRatePreset>(() => getSecretarySpeechRatePreset());
  const [pendingWrite, setPendingWrite] = useState<AiPendingWrite | null>(null);
  const [savingChat, setSavingChat] = useState(false);
  const [showArchives, setShowArchives] = useState(false);
  const [archives, setArchives] = useState<SecretaryChatListItem[]>([]);
  const [archivesLoading, setArchivesLoading] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [loadingArchiveId, setLoadingArchiveId] = useState<string | null>(null);
  const [pendingLoad, setPendingLoad] = useState<SecretaryChatListItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SecretaryChatListItem | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null);
  const [activeArchiveId, setActiveArchiveId] = useState<string | null>(() => initialSession.archiveId);
  const [archiveTitle, setArchiveTitle] = useState(() => initialSession.title);
  const [currentChatPrivate, setCurrentChatPrivate] = useState(() => initialSession.private);
  const [examSessionId, setExamSessionId] = useState<string | null>(null);
  const [autoSavedHint, setAutoSavedHint] = useState("");
  const [archiveSaveConflict, setArchiveSaveConflictState] = useState(Boolean(initialSession.saveConflict));
  const archiveSaveConflictRef = useRef(Boolean(initialSession.saveConflict));
  const setArchiveSaveConflict = (value: boolean) => {
    archiveSaveConflictRef.current = value;
    setArchiveSaveConflictState(value);
  };
  const [qualityMode, setQualityMode] = useState<AiQualityMode>(() => initialSession.qualityMode);
  const [ordinaryChannel, setOrdinaryChannel] = useState<OrdinaryBackendChoice>(() => readStoredOrdinaryBackend());
  const [ordinaryModelMenuOpen, setOrdinaryModelMenuOpen] = useState(false);
  const [speakingSpeaker, setSpeakingSpeaker] = useState<AiSecretarySpeaker | null>(null);
  const [speechBlocked, setSpeechBlocked] = useState(false);
  const [highQualityPreviewId, setHighQualityPreviewId] = useState<string | null>(null);
  const [pendingHighQualityPreview, setPendingHighQualityPreview] = useState<PendingHighQualityPreview | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [recording, setRecording] = useState(false);
  const [voiceCancel, setVoiceCancel] = useState(false);
  const [uploadingAttach, setUploadingAttach] = useState(false);
  const [hybridVoiceActive, setHybridVoiceActive] = useState(false);
  const [hybridVoicePhase, setHybridVoicePhase] = useState<HybridVoicePhase>("idle");
  const [hybridVoiceError, setHybridVoiceError] = useState("");
  const [hybridLastTranscript, setHybridLastTranscript] = useState("");
  /** true = 按住说话；手机默认开，电脑默认关（打字）。 */
  const [voiceCompose, setVoiceCompose] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 900px)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  });
  const displayModeHidesCurrent = displayMode && currentChatPrivate;
  const visibleArchives = displayMode
    ? archives.filter((item) => !isDisplayModeHiddenSecretaryChat(item))
    : archives;
  const ordinaryBackendAvailable = Boolean(status?.ordinary?.available);
  const ordinaryBackendLabel = status?.ordinary?.label || OPENSOURCE_UNCONFIGURED;
  const oneOnOneBackendAvailable = Boolean(status?.ordinary?.available);
  const currentBackendAvailable = oneOnOneBackendAvailable;
  const hybridBackendAvailable = oneOnOneBackendAvailable;
  const composerBackendAvailable = oneOnOneBackendAvailable;
  const controller = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const holdTalkButtonRef = useRef<HTMLButtonElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const hybridVoiceActiveRef = useRef(false);
  const hybridRecognitionRestartTimerRef = useRef<number | null>(null);
  const hybridDrainTimerRef = useRef<number | null>(null);
  const hybridPendingTextRef = useRef("");
  const hybridLastSubmitRef = useRef({ text: "", at: 0 });
  const hybridInterruptRef = useRef<() => void>(() => undefined);
  const hybridSubmitRef = useRef<(text: string) => void>(() => undefined);
  const hybridStartEngineRef = useRef<() => boolean>(() => false);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordStartedAtRef = useRef(0);
  const recordTranscriptRef = useRef("");
  const nativeRecognitionDoneRef = useRef<Promise<void>>(Promise.resolve());
  const resolveNativeRecognitionRef = useRef<(() => void) | null>(null);
  const recordPointerIdRef = useRef<number | null>(null);
  const recordStartYRef = useRef(0);
  const voiceCancelRef = useRef(false);
  const spaceRecordHeldRef = useRef(false);
  const askRef = useRef<(forced?: string, options?: AskOptions | string[]) => Promise<void>>(async () => undefined);
  const examSessionRef = useRef<string | null>(null);
  const includeRef = useRef<string[]>([]);
  const archiveIdRef = useRef<string | null>(initialSession.archiveId);
  const archiveVersionRef = useRef<string | null>(initialSession.archiveVersion || null);
  const archiveEpochRef = useRef(0);
  const currentArchiveSnapshot = () => ({ id: archiveIdRef.current, version: archiveVersionRef.current, epoch: archiveEpochRef.current });
  const initialRestoreAttemptedRef = useRef(false);
  const autoSaveTimer = useRef<number | null>(null);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const lastSavedFingerprintRef = useRef("");
  const saveChatRef = useRef<(options?: { silent?: boolean; auto?: boolean; asNew?: boolean }) => Promise<boolean>>(async () => false);
  const persistCurrentSessionRef = useRef<() => boolean>(() => false);

  const bindArchive = (id: string | null, title = "", archiveVersion?: string) => {
    if (id !== archiveIdRef.current || !id) {
      archiveEpochRef.current += 1;
      archiveVersionRef.current = null;
      setArchiveSaveConflict(false);
    }
    archiveIdRef.current = id;
    if (archiveVersion) archiveVersionRef.current = archiveVersion;
    setActiveArchiveId(id);
    if (title || !id) setArchiveTitle(title);
  };
  const autoBubbleCountRef = useRef(0);
  const autoRunningRef = useRef(false);
  const qualityModeRef = useRef<AiQualityMode>(initialSession.qualityMode);
  const ordinaryChannelRef = useRef<OrdinaryBackendChoice>(ordinaryChannel);
  const teachingSessionRef = useRef(false);
  const privateSessionActiveRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const buffer = createPublicThreadBuffer();
    threadBufferRef.current = buffer;
    void buffer.bind().then((bound) => {
      if (cancelled || bound.stale) return;
      if (bound.error) {
        setIdentityError("无法确认当前工作台实例，聊天缓冲暂不写入。请重试。");
        setBufferReady(false);
        return;
      }
      const loaded = buffer.load(activeSecretaryId);
      const merged = mergeLoadedSession(loaded, { messages: messagesRef.current, title: "" });
      setMessages(merged.messages);
      messagesRef.current = merged.messages;
      setActiveArchiveId(merged.archiveId);
      setArchiveTitle(merged.title);
      setArchiveSaveConflict(Boolean(merged.saveConflict));
      archiveIdRef.current = merged.archiveId;
      archiveVersionRef.current = merged.archiveVersion || null;
      Object.assign(initialSession, { ...emptyAiSession(), ...merged });
      buffer.markReady();
      setIdentityError(null);
      setBufferReady(true);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { qualityModeRef.current = qualityMode; }, [qualityMode]);
  useEffect(() => { ordinaryChannelRef.current = ordinaryChannel; }, [ordinaryChannel]);
  const [narrowAi, setNarrowAi] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches);
  const [examSheet, setExamSheet] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("exam-session"));
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setNarrowAi(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const html = document.documentElement;
    const syncExam = () => setExamSheet(html.classList.contains("exam-session"));
    syncExam();
    const observer = new MutationObserver(syncExam);
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!narrowAi) return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, [narrowAi]);
  useVisualViewportBox(panelRef, narrowAi, examSheet ? "exam-sheet" : "fullscreen");
  const canDockPeek = !narrowAi;
  useEffect(() => {
    if (canDockPeek || !peeked) return;
    onExpand?.();
  }, [canDockPeek, peeked, onExpand]);
  useEffect(() => {
    if (!canDockPeek || peeked) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".ai-panel, .ai-button, .selection-ask-menu, .selection-ask-fab, .ai-peek-hit")) return;
      onPeek?.();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [canDockPeek, peeked, onPeek]);
  useEffect(() => {
    unlockSecretaryAudio();
    jsonFetch<typeof status>("/api/ai/status").then(setStatus);
    const offBlocked = onSecretarySpeechBlocked(setSpeechBlocked);
    const offSpeechState = onSecretarySpeechState((next) => {
      setSpeakingSpeaker(next.active ? normalizeSecretarySpeaker(next.speaker) : null);
      if (!hybridVoiceActiveRef.current) return;
      if (next.active) setHybridVoicePhase("speaking");
      else if (controller.current) setHybridVoicePhase("thinking");
      else setHybridVoicePhase("listening");
    });
    const onNativeTranscript = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; final?: boolean }>).detail || {};
      const text = String(detail.text || "").trim();
      if (hybridVoiceActiveRef.current) {
        if (text && !detail.final) hybridInterruptRef.current();
        if (text && detail.final) hybridSubmitRef.current(text);
        if (detail.final) {
          window.setTimeout(() => {
            if (hybridVoiceActiveRef.current) hybridStartEngineRef.current();
          }, 160);
        }
        return;
      }
      recordTranscriptRef.current = mergeVoiceTranscript(recordTranscriptRef.current, text);
      if (detail.final) {
        resolveNativeRecognitionRef.current?.();
        resolveNativeRecognitionRef.current = null;
      }
    };
    window.addEventListener(NATIVE_TRANSCRIPT_EVENT, onNativeTranscript);
    return () => {
      controller.current?.abort();
      stopSecretarySpeech();
      offBlocked();
      offSpeechState();
      window.removeEventListener(NATIVE_TRANSCRIPT_EVENT, onNativeTranscript);
      hybridVoiceActiveRef.current = false;
      if (hybridRecognitionRestartTimerRef.current != null) window.clearTimeout(hybridRecognitionRestartTimerRef.current);
      if (hybridDrainTimerRef.current != null) window.clearTimeout(hybridDrainTimerRef.current);
      setNativeVoiceRecognition(false);
      resolveNativeRecognitionRef.current?.();
      resolveNativeRecognitionRef.current = null;
      try {
        recognitionRef.current?.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
      const stream = mediaStreamRef.current;
      mediaStreamRef.current = null;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      mediaRecorderRef.current = null;
    };
  }, []);
  persistCurrentSessionRef.current = () => {
    const buffer = threadBufferRef.current;
    if (!buffer?.persistAllowed) return false;
    const result = buffer.persist({
      messages,
      archiveId: archiveIdRef.current,
      title: archiveTitle,
      archiveVersion: archiveVersionRef.current,
      saveConflict: archiveSaveConflictRef.current,
    }, activeSecretaryId);
    return result.ok === true;
  };
  useEffect(() => {
    if (!bufferReady) return;
    persistCurrentSessionRef.current();
  }, [bufferReady, messages, archiveTitle, activeArchiveId, savingChat, archiveSaveConflict, activeSecretaryId]);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading, applying, pendingWrite]);

  useEffect(() => {
    if (!bufferReady) return;
    if (loading || applying || pendingWrite || savingChat || loadingArchiveId || archiveBusyId || archiveSaveConflict) return;
    const payload = messages
      .filter((item) => !item.pending && (item.content.trim() || item.attachments?.length))
      .map((item) => slimChatMessage(item, activeSecretaryId));
    if (payload.length < 2) return;
    const fingerprint = chatArchiveFingerprint(messages, archiveTitle, {
      activeSecretaryId,
      privacy: currentChatPrivate ? "private" : "standard",
    });
    if (fingerprint === lastSavedFingerprintRef.current) return;
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      autoSaveTimer.current = null;
      void saveChatRef.current({ silent: true, auto: true });
    }, 1600);
    return () => {
      if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    };
  }, [bufferReady, messages, loading, applying, pendingWrite, savingChat, loadingArchiveId, archiveBusyId, archiveSaveConflict, archiveTitle, activeSecretaryId, currentChatPrivate]);

  useEffect(() => {
    if (!bootstrap || displayModeHidesCurrent) return;
    const teachingTurn = bootstrap.mode === "japaneseExam"
      || bootstrap.mode === "healthCoach"
      || Boolean(bootstrap.mode === "askSelection" && bootstrap.teaching);
    if (teachingTurn) {
      teachingSessionRef.current = true;
      ordinaryChannelRef.current = "cursor";
      setOrdinaryChannel("cursor");
      setOrdinaryModelMenuOpen(false);
    }
    if (bootstrap.mode === "japaneseExam") {
      if (bootstrap.examSessionId) {
        setExamSessionId(bootstrap.examSessionId);
        examSessionRef.current = bootstrap.examSessionId;
      }
      const stamp = Date.now();
      if (bootstrap.seedAssistant) {
        setMessages((current) => [
          ...current,
          { id: `exam-a-${stamp}`, role: "assistant", speaker: activeSecretaryId, content: bootstrap.seedAssistant || "" },
        ]);
      }
      const seedUser = bootstrap.seedUser?.trim();
      onBootstrapConsumed?.();
      if (seedUser) {
        window.setTimeout(() => { void askRef.current(seedUser); }, 40);
      }
      return;
    }
    if (bootstrap.mode === "askSelection") {
      const seedUser = bootstrap.seedUser?.trim();
      onBootstrapConsumed?.();
      if (seedUser) {
        window.setTimeout(() => { void askRef.current(seedUser); }, 40);
      }
      return;
    }
    if (bootstrap.mode === "healthCoach") {
      includeRef.current = Array.isArray(bootstrap.include) ? bootstrap.include : ["health"];
      const seedUser = bootstrap.seedUser?.trim();
      onBootstrapConsumed?.();
      if (seedUser) {
        window.setTimeout(() => { void askRef.current(seedUser, includeRef.current); }, 40);
      }
    }
  }, [bootstrap, onBootstrapConsumed, activeSecretaryId, displayModeHidesCurrent]);

  const toggleVoice = () => {
    unlockSecretaryAudio();
    const next = !voiceOn;
    setVoiceOn(next);
    setSecretaryVoiceEnabled(next);
    if (!next) stopSecretarySpeech();
  };
  const cycleSpeechRate = () => {
    const next = nextSpeechRateOption(speechRatePreset);
    const value = setSecretarySpeechRatePreset(next.value);
    setSpeechRatePreset(value);
    onToast(`朗读语速已设为${next.label}；正在读的也会马上变`);
  };

  const clearPendingAttachments = () => {
    setPendingAttachments((current) => {
      for (const item of current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
  };

  const addPendingFiles = (fileList: FileList | File[] | null, forceKind?: "image" | "file") => {
    if (!fileList) return;
    const files = Array.from(fileList);
    if (!files.length) return;
    setPendingAttachments((current) => {
      const next = [...current];
      for (const file of files) {
        if (next.length >= MAX_PENDING_ATTACHMENTS) break;
        const kind = forceKind === "image" ? "image" : forceKind === "file" ? "file" : guessAttachmentKind(file.type, file.name);
        const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
        next.push({
          localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind,
          name: file.name || (kind === "image" ? "图片" : "文件"),
          mime: file.type || (kind === "image" ? "image/jpeg" : "application/octet-stream"),
          file,
          previewUrl,
        });
      }
      return next;
    });
  };

  const removePendingAttachment = (localId: string) => {
    setPendingAttachments((current) => {
      const target = current.find((item) => item.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.localId !== localId);
    });
  };

  const stopRecordingTracks = () => {
    const stream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
  };

  const finishBrowserRecognition = () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      recognition.onend = finish;
      recognition.onerror = finish;
      try {
        recognition.stop();
      } catch {
        finish();
      }
      window.setTimeout(finish, 700);
    });
  };

  const finishVoiceRecognition = async () => {
    const browserDone = finishBrowserRecognition();
    const nativeDone = nativeRecognitionDoneRef.current;
    setNativeVoiceRecognition(false);
    await waitForVoiceTranscripts([browserDone, nativeDone]);
    resolveNativeRecognitionRef.current = null;
    return recordTranscriptRef.current.trim();
  };

  const finishVoiceMessage = async (blob: Blob, mime: string, durationMs: number, transcript: string) => {
    const text = transcript.trim();
    setUploadingAttach(true);
    try {
      if (!text) {
        onToast("语音录到了，但没转成文字，再说一次试试");
        return;
      }
      if (!oneOnOneBackendAvailable) {
        onToast(ordinaryBackendLabel || status?.label || "模型未配置");
        return;
      }
      const pending: PendingAttachment = {
        localId: `voice-${Date.now()}`,
        kind: "audio",
        name: "语音",
        mime: mime || "audio/webm",
        file: blob,
        durationMs,
        transcript: text,
      };
      unlockSecretaryAudio();
      const uploaded = await uploadSecretaryAttachment(pending);
      await askRef.current(text, {
        attachments: [uploaded],
        voiceTranscript: text,
        displayText: "语音",
      });
    } catch (error) {
      onToast(error instanceof Error ? error.message : "语音发送失败");
    } finally {
      setUploadingAttach(false);
    }
  };

  const interruptHybridReply = () => {
    if (!hybridVoiceActiveRef.current) return;
    controller.current?.abort();
    stopSecretarySpeech();
    setHybridVoicePhase("hearing");
  };
  hybridInterruptRef.current = interruptHybridReply;

  const drainHybridTranscript = () => {
    if (hybridDrainTimerRef.current != null) window.clearTimeout(hybridDrainTimerRef.current);
    hybridDrainTimerRef.current = window.setTimeout(() => {
      hybridDrainTimerRef.current = null;
      if (!hybridVoiceActiveRef.current) return;
      if (controller.current) {
        drainHybridTranscript();
        return;
      }
      const text = hybridPendingTextRef.current.trim();
      hybridPendingTextRef.current = "";
      if (!text) {
        setHybridVoicePhase("listening");
        return;
      }
      setHybridVoicePhase("thinking");
      void askRef.current(text, {
        hybrid: true,
        voiceTranscript: text,
        displayText: text,
      }).finally(() => {
        window.setTimeout(() => {
          if (!hybridVoiceActiveRef.current || controller.current) return;
          setHybridVoicePhase((current) => current === "speaking" ? current : "listening");
        }, 30);
      });
    }, 90);
  };

  const submitHybridTranscript = (raw: string) => {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    if (!hybridVoiceActiveRef.current || !text) return;
    const now = Date.now();
    if (hybridLastSubmitRef.current.text === text && now - hybridLastSubmitRef.current.at < 1_500) return;
    hybridLastSubmitRef.current = { text, at: now };
    hybridPendingTextRef.current = text;
    setHybridLastTranscript(text);
    setHybridVoiceError("");
    interruptHybridReply();
    drainHybridTranscript();
  };
  hybridSubmitRef.current = submitHybridTranscript;

  const startHybridRecognitionEngine = () => {
    if (!hybridVoiceActiveRef.current) return false;
    requestNativeMicrophonePermission();
    if (setNativeVoiceRecognition(true)) return true;
    if (recognitionRef.current) return true;
    const Recognition = getSpeechRecognitionCtor();
    if (!Recognition) return false;
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onspeechstart = () => hybridInterruptRef.current();
    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let finalText = "";
      const startAt = Math.max(0, Number(event.resultIndex) || 0);
      for (let index = startAt; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = String(result[0]?.transcript || "").trim();
        if (!transcript) continue;
        hybridInterruptRef.current();
        if (result.isFinal) finalText += `${transcript} `;
      }
      if (finalText.trim()) hybridSubmitRef.current(finalText);
    };
    recognition.onerror = (event) => {
      if (!hybridVoiceActiveRef.current) return;
      const code = String(event?.error || "");
      if (code === "not-allowed" || code === "service-not-allowed") {
        hybridVoiceActiveRef.current = false;
        setHybridVoiceActive(false);
        setHybridVoicePhase("error");
        setHybridVoiceError("没有麦克风权限。请在浏览器或系统设置中允许后再试。");
        return;
      }
      setHybridVoiceError("语音识别刚才中断，正在自动重连。");
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (!hybridVoiceActiveRef.current) return;
      if (hybridRecognitionRestartTimerRef.current != null) window.clearTimeout(hybridRecognitionRestartTimerRef.current);
      hybridRecognitionRestartTimerRef.current = window.setTimeout(() => {
        hybridRecognitionRestartTimerRef.current = null;
        if (hybridVoiceActiveRef.current) hybridStartEngineRef.current();
      }, 180);
    };
    try {
      recognition.start();
      setHybridVoiceError("");
      setHybridVoicePhase("listening");
      return true;
    } catch {
      recognitionRef.current = null;
      return false;
    }
  };
  hybridStartEngineRef.current = startHybridRecognitionEngine;

  const stopHybridVoice = (stopReply = true) => {
    hybridVoiceActiveRef.current = false;
    setHybridVoiceActive(false);
    hybridPendingTextRef.current = "";
    if (hybridRecognitionRestartTimerRef.current != null) window.clearTimeout(hybridRecognitionRestartTimerRef.current);
    if (hybridDrainTimerRef.current != null) window.clearTimeout(hybridDrainTimerRef.current);
    hybridRecognitionRestartTimerRef.current = null;
    hybridDrainTimerRef.current = null;
    setNativeVoiceRecognition(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    recognitionRef.current = null;
    if (stopReply) {
      controller.current?.abort();
      stopSecretarySpeech();
    }
    setHybridVoicePhase("idle");
    setHybridVoiceError("");
  };

  const startHybridVoice = async () => {
    if (hybridVoiceActiveRef.current) return;
    if (!hybridBackendAvailable) {
      const message = ordinaryBackendLabel || status?.label || "模型未配置";
      setHybridVoiceError(message);
      onToast(message);
      return;
    }
    if (recording || mediaRecorderRef.current) {
      onToast("请先结束当前按段录音，再开始混合实时");
      return;
    }
    unlockSecretaryAudio();
    setSecretaryVoiceEnabled(true);
    setVoiceOn(true);
    setHybridVoiceError("");
    setHybridLastTranscript("");
    hybridVoiceActiveRef.current = true;
    setHybridVoiceActive(true);
    setHybridVoicePhase("listening");
    if (!startHybridRecognitionEngine()) {
      hybridVoiceActiveRef.current = false;
      setHybridVoiceActive(false);
      setHybridVoicePhase("error");
      setHybridVoiceError("当前浏览器不支持持续语音识别。请用最新版 Chrome，或在工作台 iPhone App 中使用。");
    }
  };

  const beginVoiceRecord = async (sourceId: number, startY = 0, capturePointer?: () => void) => {
    if (hybridVoiceActiveRef.current || loading || applying || pendingWrite || uploadingAttach || recording || !currentBackendAvailable) return;
    unlockSecretaryAudio();
    recordPointerIdRef.current = sourceId;
    recordStartYRef.current = startY;
    voiceCancelRef.current = false;
    setVoiceCancel(false);
    try {
      requestNativeMicrophonePermission();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 请求权限期间手指或空格已经松开：放弃这次录音。
      if (recordPointerIdRef.current !== sourceId) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      mediaStreamRef.current = stream;
      recordChunksRef.current = [];
      recordTranscriptRef.current = "";
      nativeRecognitionDoneRef.current = new Promise<void>((resolve) => {
        resolveNativeRecognitionRef.current = resolve;
      });
      if (!setNativeVoiceRecognition(true)) {
        resolveNativeRecognitionRef.current?.();
        resolveNativeRecognitionRef.current = null;
      }
      recordStartedAtRef.current = Date.now();
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (ev) => {
        if (ev.data?.size) recordChunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const cancelled = voiceCancelRef.current;
        const durationMs = Math.max(0, Date.now() - recordStartedAtRef.current);
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        stopRecordingTracks();
        setRecording(false);
        setVoiceCancel(false);
        voiceCancelRef.current = false;
        recordPointerIdRef.current = null;
        if (cancelled) {
          void finishVoiceRecognition();
          onToast("已取消");
          return;
        }
        if (durationMs < 400 || !chunks.length) {
          void finishVoiceRecognition();
          onToast("说话时间太短");
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
        setUploadingAttach(true);
        void finishVoiceRecognition().then((transcript) => finishVoiceMessage(blob, blob.type, durationMs, transcript));
      };
      const Recognition = getSpeechRecognitionCtor();
      if (Recognition) {
        const recognition = new Recognition();
        recognitionRef.current = recognition;
        recognition.lang = "zh-CN";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (ev: SpeechRecognitionEventLike) => {
          let finalText = "";
          for (let i = 0; i < ev.results.length; i += 1) {
            const result = ev.results[i];
            if (result.isFinal) finalText += result[0]?.transcript || "";
            else finalText += result[0]?.transcript || "";
          }
          const text = finalText.trim();
          recordTranscriptRef.current = mergeVoiceTranscript(recordTranscriptRef.current, text);
        };
        try {
          recognition.start();
        } catch {
          /* ignore */
        }
      }
      recorder.start(250);
      setRecording(true);
      capturePointer?.();
    } catch {
      void finishVoiceRecognition();
      stopRecordingTracks();
      setRecording(false);
      setVoiceCancel(false);
      voiceCancelRef.current = false;
      recordPointerIdRef.current = null;
      onToast("没法用麦克风，看看权限开了没");
    }
  };

  const startVoiceRecord = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    void beginVoiceRecord(event.pointerId, event.clientY, () => {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    });
  };

  const moveVoiceRecord = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!recording || recordPointerIdRef.current !== event.pointerId) return;
    const deltaUp = recordStartYRef.current - event.clientY;
    const cancel = deltaUp > 56;
    if (cancel !== voiceCancelRef.current) {
      voiceCancelRef.current = cancel;
      setVoiceCancel(cancel);
    }
  };

  const endVoiceRecord = (event?: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    if (event && recordPointerIdRef.current != null && event.pointerId !== recordPointerIdRef.current) return;
    if (!recording && !mediaRecorderRef.current) {
      recordPointerIdRef.current = null;
      return;
    }
    if (cancelled) {
      voiceCancelRef.current = true;
      setVoiceCancel(true);
    }
    if (event) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    }
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        void finishVoiceRecognition();
        stopRecordingTracks();
        setRecording(false);
        setVoiceCancel(false);
        voiceCancelRef.current = false;
        recordPointerIdRef.current = null;
      }
    } else {
      void finishVoiceRecognition();
      stopRecordingTracks();
      setRecording(false);
      setVoiceCancel(false);
      voiceCancelRef.current = false;
      recordPointerIdRef.current = null;
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!voiceCompose || !holdTalkButtonRef.current || holdTalkButtonRef.current.disabled) return;
      if (!isHoldToTalkSpace(event) || spaceRecordHeldRef.current) return;
      event.preventDefault();
      spaceRecordHeldRef.current = true;
      void beginVoiceRecord(-1);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const isSpace = event.code === "Space" || event.key === " ";
      if (!isSpace || !spaceRecordHeldRef.current) return;
      event.preventDefault();
      spaceRecordHeldRef.current = false;
      endVoiceRecord();
    };
    const cancelHeldSpace = () => {
      if (!spaceRecordHeldRef.current) return;
      spaceRecordHeldRef.current = false;
      endVoiceRecord(undefined, true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", cancelHeldSpace);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", cancelHeldSpace);
    };
  }, [voiceCompose, recording, loading, applying, pendingWrite, uploadingAttach, currentBackendAvailable]);

  const openArchives = async () => {
    setPendingLoad(null);
    setPendingDelete(null);
    setRenamingId(null);
    setShowArchives(true);
    setArchivesLoading(true);
    try {
      const data = await jsonFetch<{ items: SecretaryChatListItem[] }>("/api/secretary-chats");
      setArchives(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "读取存档失败");
      setArchives([]);
    } finally {
      setArchivesLoading(false);
    }
  };

  const saveChat = async ({ silent = false, auto = false, asNew = false }: { silent?: boolean; auto?: boolean; asNew?: boolean } = {}) => {
    if (loadingArchiveId || archiveBusyId || (archiveSaveConflictRef.current && !asNew)) return false;
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    const snapshot = currentArchiveSnapshot();
    const previousSave = saveInFlightRef.current;
    const payload = messages
      .filter((item) => !item.pending && (item.content.trim() || item.attachments?.length))
      .map((item) => slimChatMessage(item, activeSecretaryId));
    if (!payload.length) {
      if (!silent) onToast("还没有可保存的对话");
      return false;
    }
    const chatState = {
      activeSecretaryId,
      privacy: currentChatPrivate ? "private" : "standard",
    };
    const fingerprint = chatArchiveFingerprint(messages, archiveTitle, chatState);
    if (!asNew && fingerprint === lastSavedFingerprintRef.current && !previousSave) return true;
    setSavingChat(true);
    const sourceArchiveId = snapshot.id;
    const expectedArchiveVersion = asNew ? undefined : snapshot.version || undefined;
    const run = saveCurrentArchiveSnapshot(snapshot, currentArchiveSnapshot, previousSave, async () => {
      try {
        const saved = await jsonFetch<{ id: string; title: string; messageCount: number; archiveVersion?: string }>("/api/secretary-chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: asNew ? undefined : sourceArchiveId || undefined,
            expectedArchiveVersion,
            title: archiveTitle || undefined,
            auto,
            chatState,
            messages: payload,
          }),
        });
        // 保存期间若已切换会话，回执属于原会话，不能重新绑定当前界面。
        if (!sameArchiveSnapshot(snapshot, currentArchiveSnapshot())) return false;
        lastSavedFingerprintRef.current = chatArchiveFingerprint(messages, saved.title, chatState);
        bindArchive(saved.id, saved.title, saved.archiveVersion);
        setArchiveSaveConflict(false);
        // 当前渲染的会话缓冲由 effect 写入；异步回执不拿旧闭包覆盖较新的草稿。
        setAutoSavedHint(`${auto ? "已自动保存" : "已保存"} · ${saved.messageCount} 条`);
        if (!silent) onToast(`已保存「${saved.title}」· ${saved.messageCount} 条`);
        if (showArchives && !silent) void openArchives();
        return true;
      } catch (error) {
        if (!sameArchiveSnapshot(snapshot, currentArchiveSnapshot())) return false;
        const code = (error as { code?: string } | null)?.code;
        const status = (error as { status?: number } | null)?.status;
        if (code === "CHAT_VERSION_CONFLICT" || code === "CHAT_MESSAGE_CONFLICT" || (status === 409 && code !== "CHAT_WRITE_CONFLICT")) {
          setArchiveSaveConflict(true);
          setAutoSavedHint("存档已有其他更新 · 本页内容保留，点保存可另存");
          onToast("存档已有其他更新。本页内容未覆盖，点保存可另存为新聊天。");
        } else {
          setAutoSavedHint(auto ? "自动保存未成功 · 本页内容仍保留" : "保存未成功 · 本页内容仍保留");
          if (!auto) onToast(error instanceof Error ? error.message : "保存失败");
        }
        return false;
      }
    }).then((saved) => saved === true).finally(() => {
      if (saveInFlightRef.current === run) {
        setSavingChat(false);
        saveInFlightRef.current = null;
      }
    });
    saveInFlightRef.current = run;
    return run;
  };
  saveChatRef.current = saveChat;

  const resetConversationInMemory = () => {
    stopSecretarySpeech();
    privateSessionActiveRef.current = false;
    autoRunningRef.current = false;
    autoBubbleCountRef.current = 0;
    qualityModeRef.current = "light";
    const storedOrdinary = readStoredOrdinaryBackend();
    teachingSessionRef.current = false;
    ordinaryChannelRef.current = storedOrdinary;
    setOrdinaryChannel(storedOrdinary);
    setOrdinaryModelMenuOpen(false);
    setQualityMode("light");
    clearPendingAttachments();
    setMessages([]);
    setCurrentChatPrivate(false);
    bindArchive(null, "");
    lastSavedFingerprintRef.current = "";
    setAutoSavedHint("");
    setPendingLoad(null);
    setPendingDelete(null);
    setRenamingId(null);
  };

  useEffect(() => {
    if (!displayModeHidesCurrent) return;
    let cancelled = false;
    controller.current?.abort();
    stopSecretarySpeech();
    pendingWrite?.resolve(false);
    const hidePrivateConversation = async () => {
      const hidingSnapshot = currentArchiveSnapshot();
      const hasContent = messages.some((item) => !item.pending && (item.content.trim() || item.attachments?.length));
      const saved = !hasContent || await saveChat({ silent: true });
      if (cancelled) return;
      if (hidingSnapshot.epoch !== archiveEpochRef.current && !saved) return;
      // 展示模式由 return null 立即遮盖；失败草稿留在既有缓冲，解锁后恢复/另存。
      // 缓冲额度不足时保持组件内存：保存发出后仍可能有一段新回复到达。
      const buffered = persistCurrentSessionRef.current();
      if (buffered || !hasContent) onClose();
    };
    void hidePrivateConversation();
    return () => { cancelled = true; };
  }, [displayModeHidesCurrent]);

  const applyLoadedChat = async (id: string) => {
    const loadEpoch = ++archiveEpochRef.current;
    setLoadingArchiveId(id);
    try {
      const data = await jsonFetch<{
        messages: AiThreadMessage[];
        title: string;
        archiveVersion?: string;
        private?: boolean;
        privacyClass?: string;
        indexPolicy?: string;
        chatState?: { activeSecretaryId?: string; privacy?: string };
      }>(`/api/secretary-chats/${encodeURIComponent(id)}`);
      if (loadEpoch !== archiveEpochRef.current) return;
      const loadedSecretaryId = (secretaryProfileById(data.chatState?.activeSecretaryId)?.id || activeSecretaryId) as AiSecretarySpeaker;
      if (loadedSecretaryId !== activeSecretaryId) await onSecretaryChange(loadedSecretaryId);
      if (loadEpoch !== archiveEpochRef.current) return;
      const next = (data.messages || [])
        .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
        .map((item, index) => ({
          id: String(item.id || `loaded-${index}`),
          role: item.role,
          content: item.content,
          ...chatOriginalMetadata(item),
          speaker: item.role === "assistant" ? (normalizeSecretarySpeaker(item.speaker) || loadedSecretaryId) : undefined,
          attachments: Array.isArray(item.attachments) ? item.attachments : undefined,
        }));
      if (!next.length) throw new Error("存档是空的");
      stopSecretarySpeech();
      const loadedPrivate = isDisplayModeHiddenSecretaryChat({
        private: data.private,
        privacy: data.chatState?.privacy,
        privacyClass: data.privacyClass,
        indexPolicy: data.indexPolicy,
      });
      lastSavedFingerprintRef.current = chatArchiveFingerprint(next, data.title || "", {
        activeSecretaryId: loadedSecretaryId,
        privacy: loadedPrivate ? "private" : "standard",
      });
      setMessages(next);
      messagesRef.current = next;
      setCurrentChatPrivate(loadedPrivate);
      privateSessionActiveRef.current = false;
      bindArchive(id, data.title || "", data.archiveVersion);
      setArchiveSaveConflict(false);
      if (threadBufferRef.current?.persistAllowed) {
        threadBufferRef.current.persist({
          messages: next,
          archiveId: id,
          title: data.title || "",
          archiveVersion: data.archiveVersion,
        }, loadedSecretaryId);
      }
      setAutoSavedHint("已载入存档 · 继续聊会自动更新");
      setPendingLoad(null);
      setPendingDelete(null);
      setShowArchives(false);
      onToast(`已载入「${data.title}」`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "载入失败");
    } finally {
      if (loadEpoch === archiveEpochRef.current || archiveIdRef.current === id) setLoadingArchiveId(null);
    }
  };

  useEffect(() => {
    if (!bufferReady) return;
    if (initialRestoreAttemptedRef.current) return;
    initialRestoreAttemptedRef.current = true;
    const archiveId = archiveIdRef.current || initialSession.archiveId;
    if (!shouldAutoApplyDiskArchive({
      archiveId,
      messages: messagesRef.current,
      saveConflict: archiveSaveConflictRef.current,
      hasBufferedBody: messagesRef.current.length > 0,
      generation: messagesRef.current.length,
    })) return;
    void applyLoadedChat(archiveId);
  }, [bufferReady]);

  const requestLoadChat = (item: SecretaryChatListItem) => {
    if (loading || applying || pendingWrite || loadingArchiveId || archiveBusyId) return;
    if (item.id === activeArchiveId) {
      setShowArchives(false);
      onToast("就是当前这份聊天");
      return;
    }
    const hasCurrent = messages.some((msg) => !msg.pending && (msg.content.trim() || msg.attachments?.length));
    if (hasCurrent) {
      setPendingDelete(null);
      setPendingLoad(item);
      return;
    }
    void applyLoadedChat(item.id);
  };

  const confirmLoadChat = async () => {
    if (!pendingLoad || loadingArchiveId) return;
    const target = pendingLoad;
    const hasContent = messages.some((item) => !item.pending && (item.content.trim() || item.attachments?.length));
    if (hasContent && !(await saveChat({ silent: true }))) return;
    await applyLoadedChat(target.id);
  };

  const beginRenameChat = (item: SecretaryChatListItem) => {
    if (item.private || loading || applying || pendingWrite || archiveBusyId || savingChat) return;
    setPendingLoad(null);
    setPendingDelete(null);
    setRenamingId(item.id);
    setRenameDraft(item.title);
  };

  const submitRenameChat = async () => {
    if (!renamingId || archiveBusyId || saveInFlightRef.current) return;
    const title = renameDraft.trim();
    if (!title) {
      onToast("名字不能是空的");
      return;
    }
    const targetId = renamingId;
    const snapshot = currentArchiveSnapshot();
    const expectedArchiveVersion = targetId === snapshot.id
      ? snapshot.version || undefined
      : archives.find((item) => item.id === targetId)?.archiveVersion;
    setArchiveBusyId(targetId);
    try {
      const saved = await jsonFetch<{ id: string; title: string; archiveVersion?: string }>(`/api/secretary-chats/${encodeURIComponent(targetId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, expectedArchiveVersion }),
      });
      setArchives((current) => current.map((item) => (item.id === saved.id ? { ...item, title: saved.title, archiveVersion: saved.archiveVersion } : item)));
      if (snapshot.id === saved.id && sameArchiveSnapshot(snapshot, currentArchiveSnapshot())) {
        // 只有验证过本页版本的改名回执才能推进本页正文的保存权限。
        bindArchive(saved.id, saved.title, expectedArchiveVersion ? saved.archiveVersion : undefined);
      }
      setRenamingId(null);
      onToast(`已改名「${saved.title}」`);
    } catch (error) {
      if (targetId === snapshot.id && sameArchiveSnapshot(snapshot, currentArchiveSnapshot())
        && (error as { code?: string })?.code === "CHAT_VERSION_CONFLICT") {
        setArchiveSaveConflict(true);
        setAutoSavedHint("存档已有其他更新 · 本页内容保留，点保存可另存");
      }
      onToast(error instanceof Error ? error.message : "改名失败");
    } finally {
      setArchiveBusyId(null);
    }
  };

  const confirmDeleteChat = async () => {
    if (!pendingDelete || archiveBusyId) return;
    const target = pendingDelete;
    setArchiveBusyId(target.id);
    try {
      await jsonFetch(`/api/secretary-chats/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setArchives((current) => current.filter((item) => item.id !== target.id));
      setPendingDelete(null);
      if (activeArchiveId === target.id) {
        stopSecretarySpeech();
        privateSessionActiveRef.current = false;
        autoRunningRef.current = false;
        autoBubbleCountRef.current = 0;
        clearPendingAttachments();
        setMessages([]);
        setCurrentChatPrivate(false);
        bindArchive(null, "");
        lastSavedFingerprintRef.current = "";
        setAutoSavedHint("");
        if (threadBufferRef.current?.persistAllowed) threadBufferRef.current.persist({ messages: [], archiveId: null, title: "" }, activeSecretaryId);
      }
      onToast(`已删掉「${target.title}」`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "删除失败");
    } finally {
      setArchiveBusyId(null);
    }
  };
  const patchAssistant = (id: string, patch: Partial<AiThreadMessage> | ((old: AiThreadMessage) => AiThreadMessage)) => {
    setMessages((current) => current.map((item) => {
      if (item.id !== id) return item;
      return typeof patch === "function" ? patch(item) : { ...item, ...patch };
    }));
  };

  const requestWriteConfirm = (action: AiProposedAction, preview: WritePreview, commitUrl: string) => new Promise<boolean>((resolve) => {
    setPendingWrite({ action, preview, commitUrl, resolve });
  });

  const applyActions = async (assistantId: string, actions: AiProposedAction[]) => {
    if (!actions.length) return;
    setApplying(true);
    patchAssistant(assistantId, { actionResults: actions.map((action) => ({
      summary: action.summary,
      ok: false,
      detail: !skipsAiWriteConfirmation(action) && action.requiresConfirm ? "等待确认…" : "正在写入…",
    })) });
    const results: AiActionResult[] = [];
    let wroteCalendar = false;
    let wroteVault = false;
    for (const action of actions) {
      let result: AiActionResult;
      try {
        const { preview, commitUrl } = await previewAiAction(action);
        const needsConfirm = !skipsAiWriteConfirmation(action) && actionNeedsConfirm(action, preview);
        if (needsConfirm) {
          patchAssistant(assistantId, {
            actionResults: [...results, { summary: action.summary, ok: false, detail: preview.requiresConfirm ? "请确认代码修改…" : "请确认写入…" }, ...actions.slice(results.length + 1).map((item) => ({ summary: item.summary, ok: false, detail: "排队中…" }))],
          });
          const approved = await requestWriteConfirm(action, preview, commitUrl);
          if (!approved) {
            result = { summary: action.summary, ok: false, detail: preview.requiresConfirm ? "已取消代码修改" : "已取消写入" };
          } else {
            await commitAiPreview(commitUrl, preview.token);
            result = { summary: action.summary, ok: true, detail: actionSuccessDetail({ ...action, requiresConfirm: preview.requiresConfirm || action.requiresConfirm }) };
          }
        } else {
          await commitAiPreview(commitUrl, preview.token);
          result = { summary: action.summary, ok: true, detail: actionSuccessDetail(action) };
        }
      } catch (error) {
        result = { summary: action.summary, ok: false, detail: error instanceof Error ? error.message : "写入失败" };
      }
      results.push(result);
      patchAssistant(assistantId, {
        actionResults: [...results, ...actions.slice(results.length).map((item) => ({ summary: item.summary, ok: false, detail: "排队中…" }))],
      });
      if (result.ok && action.kind === "calendarCreate") wroteCalendar = true;
      if (result.ok && action.kind !== "calendarCreate") wroteVault = true;
    }
    setPendingWrite(null);
    patchAssistant(assistantId, { actionResults: results, pending: false });
    setApplying(false);
    if (wroteVault) onDataRefresh();
    if (wroteCalendar) onCalendarRefresh();
    const failed = results.filter((item) => !item.ok).length;
    const succeeded = results.length - failed;
    if (succeeded && !failed) onToast(succeeded === 1 ? results[0].detail : `已成功完成 ${succeeded} 项`);
    else if (succeeded && failed) onToast(`完成 ${succeeded} 项，失败 ${failed} 项`);
    else if (failed) onToast(results[0]?.detail || "写入失败");
  };

  const ask = async (forcedText?: string, optionsOrInclude: AskOptions | string[] = {}) => {
    if (displayModeHidesCurrent) return;
    const options: AskOptions = Array.isArray(optionsOrInclude)
      ? { include: optionsOrInclude }
      : (optionsOrInclude || {});
    const silent = Boolean(options.silent);
    const hybrid = Boolean(options.hybrid);
    const rawText = (forcedText ?? question).trim();
    const pendingToSend = silent ? [] : pendingAttachments;
    const switchIntent = !silent && !pendingToSend.length && !options.attachments?.length
      ? extractSecretarySwitchIntent(rawText)
      : null;
    if (switchIntent) {
      if (loading || applying || pendingWrite) {
        onToast("这轮还没结束，稍后再换班");
        return;
      }
      const next = secretaryProfileById(switchIntent.secretaryId)!;
      const alreadyActive = next.id === activeSecretaryId;
      const reply = alreadyActive
        ? `${next.name}已经在值班。`
        : next.id === "yinyue"
          ? "你好，银月到了。今天由我值班。"
          : "我回来了。今天由我值班。";
      const stamp = Date.now();
      setQuestion("");
      if (!alreadyActive) {
        await onSecretaryChange(next.id);
      }
      setMessages((current) => [
        ...current,
        { id: `u-switch-${stamp}`, role: "user", content: rawText },
        { id: `a-switch-${stamp}`, role: "assistant", speaker: next.id as AiSecretarySpeaker, content: reply },
      ]);
      speakAsSecretary(reply, { enabled: voiceOn, speaker: next.id as AiSecretarySpeaker, append: false });
      onToast(alreadyActive ? `${next.name}正在值班` : `已换班：${next.fullName}`);
      return;
    }
    // 开源版没有内置对话模型。
    if (!oneOnOneBackendAvailable) {
      onToast(ordinaryBackendLabel || status?.label || "模型未配置");
      return;
    }
    let uploadedAttachments = options.attachments || [];
    if (!silent && pendingToSend.length && !uploadedAttachments.length) {
      try {
        setUploadingAttach(true);
        uploadedAttachments = [];
        for (const item of pendingToSend) {
          uploadedAttachments.push(await uploadSecretaryAttachment(item));
        }
      } catch (error) {
        onToast(error instanceof Error ? error.message : "附件上传失败");
        setUploadingAttach(false);
        return;
      } finally {
        setUploadingAttach(false);
      }
    }
    const voiceTranscript = String(options.voiceTranscript || uploadedAttachments.find((item) => item.transcript)?.transcript || "").trim();
    if ((!rawText && !uploadedAttachments.length && !voiceTranscript) || (!hybrid && loading) || applying || pendingWrite) return;

    unlockSecretaryAudio();

    const spellSource = rawText || voiceTranscript || "请看我发的附件。";
    const displayText = silent
      ? ""
      : (options.displayText ?? rawText)
        || (uploadedAttachments.some((item) => item.kind === "audio") ? "语音" : "")
        || (uploadedAttachments.some((item) => item.kind === "image") ? "图片" : "")
        || (uploadedAttachments.length ? "附件" : "");
    const questionForModel = spellSource.trim()
      || voiceTranscript
      || (uploadedAttachments.some((item) => item.kind === "image") ? "请看我发的图片。" : "")
      || (uploadedAttachments.some((item) => item.kind === "file") ? "请看我发的文件。" : "")
      || "请看我发的附件。";
    const backendAvailableForRequest = oneOnOneBackendAvailable;
    if (!backendAvailableForRequest) {
      onToast(ordinaryBackendLabel || status?.label || "模型未配置");
      return;
    }
    autoRunningRef.current = false;
    autoBubbleCountRef.current = 0;
    const allowedSpeakers = [activeSecretaryId];
    const autoChat = Boolean(options.autoContinue);

    const active = new AbortController();
    controller.current = active;
    if (hybrid) setHybridVoicePhase("thinking");
    const history = messages
      .filter((item) => !item.pending && item.content.trim())
      .slice(-8)
      .map((item) => ({
        role: item.role,
        content: item.content,
        ...(item.role === "assistant" ? { speaker: normalizeSecretarySpeaker(item.speaker) || activeSecretaryId } : {}),
      }));
    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now()}`;
    const includePayload = Array.isArray(options.include) && options.include.length
      ? options.include
      : includeRef.current.length
        ? includeRef.current
        : undefined;
    setLoading(true);
    if (!forcedText && !silent) {
      setQuestion("");
      clearPendingAttachments();
    }
    // 发送后先别掐断上一段语音；等新回复出来再由 speak*(append:false) 接上新内容
    setMessages((current) => [
      ...current,
      ...(silent || (!displayText && !uploadedAttachments.length) ? [] : [{
        id: userId,
        role: "user" as const,
        content: displayText,
        attachments: uploadedAttachments.length ? uploadedAttachments : undefined,
      }]),
      { id: assistantId, role: "assistant", speaker: activeSecretaryId, content: "", sources: [], pending: true },
    ]);
    let finalActions: AiProposedAction[] = [];
    let actionTargetId = assistantId;
    let streamedAnswer = "";
    let hybridSpeechBuffer = "";
    let hybridSpeechQueued = false;
    const queueHybridSpeech = (chunks: string[]) => {
      if (!hybrid || !chunks.length) return;
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        speakAsSecretary(chunk, { enabled: true, speaker: activeSecretaryId, append: true });
        hybridSpeechQueued = true;
      }
      if (hybridSpeechQueued) setHybridVoicePhase("speaking");
    };
    try {
      const response = await fetch("/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: questionForModel,
          taskWindowId: archiveIdRef.current || `live:${activeSecretaryId}`,
          history,
          examSessionId: examSessionRef.current || examSessionId,
          activeSecretaryId,
          allowedSpeakers,
          autoChat,
          ordinaryBackend: "",
          cursorModel: "",
          teaching: teachingSessionRef.current,
          ...(includePayload ? { include: includePayload } : {}),
          ...(uploadedAttachments.length ? { attachments: uploadedAttachments.map((item) => item.id) } : {}),
          ...(voiceTranscript ? { voiceTranscript } : {}),
        }),
        signal: active.signal,
      });
      if (!response.ok || !response.body) throw new Error(`问答接口不可用（${response.status}）`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "sources") continue;
          if (event.type === "chunk") {
            const chunkText = String(event.text ?? "");
            streamedAnswer += chunkText;
            patchAssistant(assistantId, (old) => ({ ...old, content: `${old.content}${chunkText}` }));
            if (hybrid && chunkText) {
              hybridSpeechBuffer += chunkText;
              const segmented = takeHybridSpeechChunks(hybridSpeechBuffer);
              hybridSpeechBuffer = segmented.remainder;
              queueHybridSpeech(segmented.chunks);
            }
          }
          if (event.type === "actions") finalActions = event.actions ?? [];
          if (event.type === "done") {
            finalActions = event.actions ?? finalActions;
            const next = String(event.answer ?? "").trim() || streamedAnswer.trim() || String(event.message ?? "").trim();
            const usable = next && !isUnusableModelReplyText(next) ? next : "";
            if (!usable) {
              const message = "开源版没有内置对话模型。请自行接入后再聊。";
              patchAssistant(assistantId, { content: message, pending: false });
            } else {
              if (hybrid) {
                const segmented = takeHybridSpeechChunks(hybridSpeechBuffer, true);
                hybridSpeechBuffer = segmented.remainder;
                queueHybridSpeech(segmented.chunks);
                if (!hybridSpeechQueued) queueHybridSpeech([usable]);
              } else {
                speakAsSecretary(usable, { enabled: voiceOn, speaker: activeSecretaryId, append: silent || autoChat });
              }
              patchAssistant(assistantId, { content: usable, speaker: activeSecretaryId, pending: false });
            }
          }
          if (event.type === "error") {
            const message = event.message ?? "问答失败";
            setMessages((current) => {
              const hasLive = current.some((item) => String(item.id).startsWith(`${assistantId}-`));
              if (hasLive) return current.filter((item) => item.id !== assistantId);
              return current.map((item) => item.id === assistantId ? { ...item, content: message, pending: false } : item);
            });
            if (hybrid) {
              setHybridVoiceError(message);
              setHybridVoicePhase("error");
            } else {
              speakAsSecretary(message, { enabled: voiceOn, speaker: activeSecretaryId, append: silent });
            }
            autoRunningRef.current = false;
          }
        }
        if (done) break;
      }
      if (!active.signal.aborted && finalActions.length) await applyActions(actionTargetId, finalActions);
      else patchAssistant(actionTargetId, { pending: false });
    } catch (error) {
      autoRunningRef.current = false;
      setMessages((current) => {
        const hasLive = current.some((item) => String(item.id).startsWith(`${assistantId}-`));
        if (hasLive) return current.filter((item) => item.id !== assistantId);
        return current.flatMap((item) => {
          if (item.id !== assistantId) return [item];
          if (hybrid && active.signal.aborted) return item.content.trim() ? [{ ...item, pending: false }] : [];
          return [{
            ...item,
            content: active.signal.aborted ? "已停止生成。" : (error instanceof Error ? error.message : "问答失败"),
            pending: false,
          }];
        });
      });
      if (hybrid && !active.signal.aborted) {
        const message = error instanceof Error ? error.message : "问答失败";
        setHybridVoiceError(message);
        setHybridVoicePhase("error");
      }
    } finally {
      if (controller.current === active) controller.current = null;
      setLoading(false);
    }
  };
  askRef.current = ask;

  const stop = () => {
    autoRunningRef.current = false;
    controller.current?.abort();
    stopSecretarySpeech();
  };
  const startNewChat = async () => {
    if (loading || applying || pendingWrite) return;
    const hasContent = messages.some((item) => !item.pending && (item.content.trim() || item.attachments?.length));
    if (hasContent && !(await saveChat({ silent: true }))) return;
    resetConversationInMemory();
    if (threadBufferRef.current?.persistAllowed) threadBufferRef.current.persist({ messages: [], archiveId: null, title: "" }, activeSecretaryId);
    if (hasContent) onToast("已保存旧聊天，并开了一份新对话");
  };

  const cancelPendingWrite = () => {
    pendingWrite?.resolve(false);
    setPendingWrite(null);
  };
  const approvePendingWrite = () => {
    pendingWrite?.resolve(true);
    setPendingWrite(null);
  };
  const confirmHighQualityPreview = () => {
    if (!pendingHighQualityPreview || highQualityPreviewId) return;
    const target = pendingHighQualityPreview;
    setPendingHighQualityPreview(null);
    setHighQualityPreviewId(target.id);
    void previewSecretaryHighQuality(target.content, target.speaker)
      .then((result) => {
        if (result.provider === "elevenlabs") onToast(`${secretaryLabel(target.speaker)}的 ElevenLabs 高质试听已播放`);
        else if (result.fallback.includes("VOICE_NOT_CONFIGURED")) onToast("这位角色尚未选择 ElevenLabs 声线，已改用 Edge 试听");
        else if (result.fallback.includes("KEY_NOT_CONFIGURED")) onToast("本机尚未配置 ElevenLabs 密钥，已改用 Edge 试听");
        else onToast("ElevenLabs 当前不可用，已改用 Edge 试听");
      })
      .catch((error) => onToast(error instanceof Error ? error.message : "高质试听失败"))
      .finally(() => setHighQualityPreviewId(null));
  };
  const closePanel = async () => {
    if (hybridVoiceActiveRef.current) stopHybridVoice();
    else controller.current?.abort();
    autoRunningRef.current = false;
    const hasContent = messages.some((item) => !item.pending && (item.content.trim() || item.attachments?.length));
    if (hasContent && !(await saveChat({ silent: true }))) return;
    if (pendingWrite) cancelPendingWrite();
    onClose();
  };
  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart ?? question.length;
      const end = el.selectionEnd ?? question.length;
      const next = `${question.slice(0, start)}\n${question.slice(end)}`;
      setQuestion(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
      return;
    }
    event.preventDefault();
    void ask();
  };

  const panelFullscreen = narrowAi;
  const dockPeeked = peeked && canDockPeek;
  const showOrdinaryDutyPortrait = Boolean(ordinaryDutyPortrait?.src);
  const headerTitle = `与${activeSecretary.name}聊天`;
  const emptyHint = ordinaryBackendLabel || status?.label || OPENSOURCE_UNCONFIGURED;
  const composerTitle = oneOnOneBackendAvailable ? (narrowAi ? "回车发送，可接着上一句问" : "回车发送，⌘↵ 换行") : emptyHint;
  const speechRateLabel = SPEECH_RATE_OPTIONS.find((item) => item.value === speechRatePreset)?.label || "正常";
  const ordinaryChannelReady = oneOnOneBackendAvailable;
  const ordinaryChannelLabel = ordinaryBackendLabel || OPENSOURCE_UNCONFIGURED;
  const activeStatusOnline = oneOnOneBackendAvailable;
  const activeStatusLabel = ordinaryChannelLabel;
  const chooseOrdinaryChannel = (next: OrdinaryBackendChoice) => {
    const nextAvailable = next === "cursor"
      ? Boolean(status?.loggedIn)
      : ordinaryBackendAvailable;
    if (!nextAvailable) {
      onToast("模型未配置");
      return;
    }
    teachingSessionRef.current = false;
    ordinaryChannelRef.current = next;
    setOrdinaryChannel(next);
    storeOrdinaryBackend(next);
    setOrdinaryModelMenuOpen(false);
    onToast("模型未配置");
  };
  // 手机上只让输入框进系统「上下字段」切换，减轻 Safari 键盘上方 ↑↓ 工具条
  const skipTab = narrowAi ? -1 : undefined;

  if (displayModeHidesCurrent) return null;

  return (
    <motion.aside
      ref={panelRef}
      className={`ai-panel${showOrdinaryDutyPortrait ? " with-duty-background" : ""}${narrowAi ? " vv-pinned" : ""}${dockPeeked ? " is-peeked" : ""}`}
      initial={panelFullscreen ? { opacity: 0 } : { x: "100%" }}
      animate={panelFullscreen ? { opacity: 1 } : { x: dockPeeked ? AI_PEEK_HIDDEN : 0 }}
      exit={panelFullscreen ? { opacity: 0 } : { x: "100%" }}
      transition={panelFullscreen ? { duration: 0.2 } : { type: "tween", duration: 0.28 }}
      inert={dockPeeked || undefined}
    >
      {dockPeeked && typeof document !== "undefined"
        ? createPortal(
          <button
            type="button"
            className="ai-peek-hit"
            aria-label={`显示与${activeSecretary.name}的聊天`}
            title={`${activeSecretary.name}还在，鼠标移过来就会出来`}
            onPointerEnter={() => onExpand?.()}
            onFocus={() => onExpand?.()}
            onPointerDown={(event) => {
              event.preventDefault();
              onExpand?.();
            }}
          />,
          document.body,
        )
        : null}
      {null}
      <div className="ai-panel-main">
        {showOrdinaryDutyPortrait && ordinaryDutyPortrait ? (
          <div className="ai-panel-duty-background" aria-hidden="true">
            <img src={ordinaryDutyPortrait.src} alt="" />
          </div>
        ) : null}
        <header className="ai-chat-header">
          <div>
            <div>
              <Kicker>小秘书</Kicker>
              <h2>{headerTitle}</h2>
              {identityError ? <p className="ai-identity-error" role="status">{identityError}</p> : null}
            </div>
          </div>
          <div className="ai-header-actions">
            <button
              type="button"
              tabIndex={skipTab}
              className="ai-header-rate"
              onClick={cycleSpeechRate}
              aria-label={`朗读语速：${speechRateLabel}，点击切换`}
              title={`朗读语速：${speechRateLabel}（点一下换下一档）`}
            >
              {speechRateLabel}
            </button>
            <button
              type="button"
              tabIndex={skipTab}
              className={voiceOn ? "active" : ""}
              onClick={toggleVoice}
              aria-label={voiceOn ? "关闭自动朗读" : "打开自动朗读"}
              title={voiceOn ? "关闭自动朗读" : "打开自动朗读"}
            >
              {voiceOn ? <Volume2 size={16}/> : <VolumeX size={16}/>}
            </button>
            <button
              type="button"
              tabIndex={skipTab}
              disabled={displayModeHidesCurrent || savingChat || loading || applying || !!pendingWrite || !messages.some((item) => !item.pending && (item.content.trim() || item.attachments?.length))}
              onClick={() => void saveChat({ asNew: archiveSaveConflict })}
              aria-label={archiveSaveConflict ? "另存为新聊天" : autoSavedHint ? "立刻再存一次" : "保存本次聊天"}
              title={archiveSaveConflict ? "另存为新聊天" : autoSavedHint ? "立刻再存一次" : "保存本次聊天"}
            >
              <Save size={16}/>
            </button>
            <button
              type="button"
              tabIndex={skipTab}
              className={showArchives ? "active" : ""}
              disabled={loading || applying || !!pendingWrite}
              onClick={() => {
                if (showArchives) {
                  setPendingLoad(null);
                  setPendingDelete(null);
                  setRenamingId(null);
                  setShowArchives(false);
                } else {
                  void openArchives();
                }
              }}
              aria-label={showArchives ? "关闭聊天存档" : "打开聊天存档"}
              title={showArchives ? "关闭聊天存档" : "打开聊天存档"}
            >
              <FolderOpen size={16}/>
            </button>
            <button
              type="button"
              tabIndex={skipTab}
              disabled={loading || applying || !!pendingWrite || (!messages.length && !activeArchiveId)}
              onClick={() => void startNewChat()}
              aria-label="新建对话"
              title="新建对话"
            >
              <MessageSquarePlus size={16}/>
            </button>
            <button type="button" tabIndex={skipTab} onClick={() => void closePanel()} aria-label={`关闭与${activeSecretary.name}的聊天`} title="关闭"><X size={18}/></button>
          </div>
        </header>
        <div className={`ai-status ${activeStatusOnline ? "online" : ""}`}>
          <i/>
          <span>{activeStatusLabel}</span>
          {messages.length && !displayModeHidesCurrent ? <em>{loading ? "生成中" : pendingWrite ? "等你确认" : applying ? "正在写" : autoSavedHint || `已聊 ${Math.ceil(messages.filter((m) => m.role === "user").length)} 轮 · 可以接着问`}</em> : null}
        </div>
        {speechBlocked ? (
          <button
            type="button"
            className="ai-speech-unblock"
            onClick={() => {
              unlockSecretaryAudio();
              resumeBlockedSecretarySpeech();
            }}
          >
            点一下听
          </button>
        ) : null}
        {showArchives ? (
          <section className="ai-archive-panel">
            <header>
              <div>
                <Kicker>聊天存档</Kicker>
                <strong>以前的聊天</strong>
              </div>
              <button type="button" onClick={() => { setPendingLoad(null); setPendingDelete(null); setRenamingId(null); setShowArchives(false); }} aria-label="关闭聊天存档" title="关闭列表"><X size={15}/></button>
            </header>
            {!pendingLoad && !pendingDelete ? (
              <>
                <label className="ai-archive-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    value={archiveQuery}
                    onChange={(event) => setArchiveQuery(event.target.value)}
                    placeholder="搜标题或预览…"
                    aria-label="搜索聊天存档"
                  />
                </label>
                <div className="ai-archive-list">
                  {archivesLoading ? <p className="ai-archive-empty">正在找以前保存的聊天…</p> : null}
                  {!archivesLoading && !visibleArchives.length ? <p className="ai-archive-empty">还没有保存过的聊天。</p> : null}
                  {!archivesLoading && visibleArchives.length && !visibleArchives.filter((item) => {
                    const q = archiveQuery.trim().toLowerCase();
                    if (!q) return true;
                    return `${item.title} ${item.preview}`.toLowerCase().includes(q);
                  }).length ? <p className="ai-archive-empty">没有匹配的聊天。</p> : null}
                  {!archivesLoading ? visibleArchives
                    .filter((item) => {
                      const q = archiveQuery.trim().toLowerCase();
                      if (!q) return true;
                      return `${item.title} ${item.preview}`.toLowerCase().includes(q);
                    })
                    .map((item) => {
                      const isCurrent = item.id === activeArchiveId;
                      const busy = archiveBusyId === item.id || loadingArchiveId === item.id;
                      if (renamingId === item.id) {
                        return (
                          <div key={item.id} className={`ai-archive-item editing${isCurrent ? " current" : ""}`}>
                            <input
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void submitRenameChat();
                                }
                                if (event.key === "Escape") setRenamingId(null);
                              }}
                              aria-label="聊天新名字"
                              autoFocus
                            />
                            <div className="ai-archive-item-actions">
                              <button type="button" className="ghost-button" disabled={busy} onClick={() => setRenamingId(null)}>取消</button>
                              <button type="button" className="gold-button" disabled={busy} onClick={() => void submitRenameChat()}>保存</button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <article key={item.id} className={`ai-archive-item${isCurrent ? " current" : ""}`}>
                          <button
                            type="button"
                            className="ai-archive-item-main"
                            disabled={busy}
                            onClick={() => requestLoadChat(item)}
                          >
                            <strong>
                              {item.title}
                              {isCurrent ? <em>正在聊</em> : null}
                            </strong>
                            <small>{formatChatSavedAt(item.savedAt)} · {item.messageCount} 条</small>
                            <span>{item.preview}</span>
                          </button>
                          <div className="ai-archive-item-actions">
                            {!item.private ? (
                              <button type="button" disabled={busy} onClick={() => beginRenameChat(item)} aria-label={`改名 ${item.title}`} title="改名">
                                <Pencil size={14} />
                              </button>
                            ) : null}
                            <button type="button" disabled={busy} onClick={() => { setPendingLoad(null); setPendingDelete(item); }} aria-label={`删除 ${item.title}`} title="删除">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </article>
                      );
                    }) : null}
                </div>
              </>
            ) : null}
          </section>
        ) : (
          <section className="ai-thread" ref={threadRef}>
            {!messages.length ? (
              showOrdinaryDutyPortrait ? null : (
              <div className="ai-void">
                <p>{emptyHint}</p>
              </div>
              )
            ) : messages.map((message) => {
              const messageSpeaker = message.role === "assistant"
                ? normalizeSecretarySpeaker(message.speaker) || activeSecretaryId
                : null;
              const messageVisual = chatAvatarVisual(messageSpeaker, message.role === "user");
              const typingName = secretaryLabel(messageSpeaker || activeSecretaryId);
              return (
                <article
                className={`ai-bubble ${message.role}${message.role === "assistant" ? ` ${assistantBubbleSeat(message, activeSecretaryId)}` : ""}${message.pending ? " pending" : ""}${message.role === "assistant" && !message.pending && message.content.trim() ? " replayable" : ""}`}
                key={message.id}
                style={{ "--speaker-accent": messageVisual.accent } as CSSProperties}
                onClick={() => {
                  if (message.role !== "assistant" || message.pending || !message.content.trim()) return;
                  unlockSecretaryAudio();
                  speakAsSecretary(message.content, {
                    enabled: true,
                    speaker: normalizeSecretarySpeaker(message.speaker) || activeSecretaryId,
                    append: false,
                  });
                }}
                onKeyDown={(event) => {
                  if (message.role !== "assistant" || message.pending || !message.content.trim()) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  unlockSecretaryAudio();
                  speakAsSecretary(message.content, {
                    enabled: true,
                    speaker: normalizeSecretarySpeaker(message.speaker) || activeSecretaryId,
                    append: false,
                  });
                }}
                title={message.role === "assistant" && !message.pending && message.content.trim() ? "点击重播这段语音" : undefined}
                role={message.role === "assistant" && !message.pending && message.content.trim() ? "button" : undefined}
                tabIndex={message.role === "assistant" && !message.pending && message.content.trim() ? 0 : undefined}
              >
                <ChatAvatar privateAllowed={!displayMode} speaker={messageSpeaker} user={message.role === "user"} className="ai-message-avatar" />
                <div className="ai-bubble-head">
                  <span className="ai-bubble-name">
                    <span>
                      {message.role === "user" ? "我" : secretaryLabel(messageSpeaker || activeSecretaryId)}
                    </span>
                  </span>
                </div>
                {message.attachments?.length ? (
                  <div className="ai-bubble-attachments">
                    {message.attachments.map((att) => {
                      if (att.kind === "image") {
                        return (
                          <span key={att.id} className="ai-attach-image" onClick={(e) => e.stopPropagation()}>
                            <img src={att.url || `/api/secretary-attachments/${encodeURIComponent(att.id)}`} alt={att.name || "图片"} />
                          </span>
                        );
                      }
                      if (att.kind === "audio") {
                        return (
                          <div key={att.id} className="ai-attach-audio" onClick={(e) => e.stopPropagation()}>
                            <audio controls preload="metadata" src={att.url || `/api/secretary-attachments/${encodeURIComponent(att.id)}`} />
                            <span>{formatAudioDuration(att.durationMs) || "语音"}{att.transcript ? ` · ${att.transcript.slice(0, 40)}${att.transcript.length > 40 ? "…" : ""}` : ""}</span>
                          </div>
                        );
                      }
                      return (
                        <a key={att.id} className="ai-attach-file" href={att.url || `/api/secretary-attachments/${encodeURIComponent(att.id)}`} download={att.name || undefined} onClick={(e) => e.stopPropagation()}>
                          <Paperclip size={14} />
                          <span>{att.name || "文件"}</span>
                        </a>
                      );
                    })}
                  </div>
                ) : null}
                {message.content && !(message.attachments?.some((att) => att.kind === "audio") && message.content === "语音") ? (
                  <p>{message.content}</p>
                ) : message.content && message.attachments?.some((att) => att.kind === "audio") ? null : message.pending ? (
                  <p className="ai-thinking" role="status" aria-label={`${typingName}正在输入中`}>
                    <span>{`${typingName}正在输入中`}</span>
                    <span className="ai-thinking-dots" aria-hidden="true">
                      <span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span>
                    </span>
                  </p>
                ) : !message.attachments?.length ? (
                  <p />
                ) : null}
                {message.actionResults?.length ? (
                  <div className="ai-actions">
                    <strong>改了这些文件</strong>
                    {message.actionResults.map((result, index) => (
                      <div key={`${result.summary}-${index}`} className={`ai-action-card ${result.ok ? "ok" : "fail"}`}>
                        <span>{result.summary}</span>
                        <small>{result.detail}</small>
                        <em>{result.ok ? "成功" : result.detail.endsWith("…") ? "正在做" : "失败"}</em>
                      </div>
                    ))}
                  </div>
                ) : null}
                </article>
              );
            })}
          </section>
        )}
        {!displayModeHidesCurrent ? (pendingWrite ? (
          <AiCompactConfirm
            title={pendingWrite.preview.requiresConfirm ? "确认改代码？" : "确认写入？"}
            description={pendingWrite.preview.summary}
            confirmLabel={pendingWrite.preview.requiresConfirm ? "确认修改" : "确认写入"}
            onCancel={cancelPendingWrite}
            onConfirm={approvePendingWrite}
          />
        ) : pendingLoad ? (
          <AiCompactConfirm
            title="确认载入？"
            description={`将保存当前聊天，并载入「${pendingLoad.title}」。`}
            confirmLabel="确认载入"
            busy={Boolean(loadingArchiveId)}
            onCancel={() => setPendingLoad(null)}
            onConfirm={() => { void confirmLoadChat(); }}
          />
        ) : pendingDelete ? (
          <AiCompactConfirm
            title="确认删除？"
            description={`将删除「${pendingDelete.title}」及其未被其他聊天使用的附件。删除后无法恢复。`}
            confirmLabel="确认删除"
            busy={Boolean(archiveBusyId)}
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => { void confirmDeleteChat(); }}
          />
        ) : pendingHighQualityPreview ? (
          <AiCompactConfirm
            title="确认试听？"
            description="会把这条台词发送给 ElevenLabs，并可能消耗账户额度。"
            confirmLabel="确认试听"
            busy={Boolean(highQualityPreviewId)}
            onCancel={() => setPendingHighQualityPreview(null)}
            onConfirm={confirmHighQualityPreview}
          />
        ) : null) : null}
        {!displayModeHidesCurrent ? <footer>
          {pendingAttachments.length ? (
            <div className="ai-pending-attachments">
              {pendingAttachments.map((item) => (
                <div key={item.localId} className={`ai-pending-chip ${item.kind}`}>
                  {item.kind === "image" && item.previewUrl ? <img src={item.previewUrl} alt="" /> : null}
                  {item.kind === "audio" ? <Mic size={14} /> : null}
                  {item.kind === "file" ? <Paperclip size={14} /> : null}
                  <span>{item.name}</span>
                  <button type="button" aria-label={`去掉${item.name}`} onClick={() => removePendingAttachment(item.localId)}><X size={12} /></button>
                </div>
              ))}
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            hidden
            tabIndex={-1}
            multiple
            onChange={(e) => {
              addPendingFiles(e.target.files, "file");
              e.target.value = "";
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            hidden
            tabIndex={-1}
            multiple
            onChange={(e) => {
              addPendingFiles(e.target.files, "image");
              e.target.value = "";
            }}
          />
          <div className="ai-composer-tools">
              <>
                <button
                  type="button"
                  tabIndex={skipTab}
                  className="ai-composer-icon"
                  disabled={!!pendingWrite || loading || applying || uploadingAttach || recording}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="发文件"
                  title="发文件"
                >
                  <Paperclip size={18} />
                </button>
                <button
                  type="button"
                  tabIndex={skipTab}
                  className="ai-composer-icon"
                  disabled={!!pendingWrite || loading || applying || uploadingAttach || recording}
                  onClick={() => imageInputRef.current?.click()}
                  aria-label="发图片"
                  title="发图片"
                >
                  <ImagePlus size={18} />
                </button>
              </>
              <button
                type="button"
                tabIndex={skipTab}
                className={`ai-composer-icon ai-compose-toggle${voiceCompose ? "" : " text-mode"}`}
                disabled={hybridVoiceActive || !!pendingWrite || uploadingAttach || recording}
                onClick={() => {
                  unlockSecretaryAudio();
                  setVoiceCompose((current) => {
                    const next = !current;
                    if (next) requestNativeMicrophonePermission();
                    if (!next) window.setTimeout(() => textareaRef.current?.focus(), 30);
                    return next;
                  });
                }}
                aria-label={voiceCompose ? "改用打字" : "改用语音"}
                title={voiceCompose ? "改用打字" : "改用语音"}
              >
                {voiceCompose ? <span className="ai-compose-wen">文</span> : <Mic size={18} />}
              </button>
            </div>
          <div className={`ai-composer-row${voiceCompose ? " voice-compose" : " text-compose"}${voiceCompose && (pendingAttachments.length || loading) ? " with-send" : ""}`}>
            {voiceCompose ? (
              <button
                ref={holdTalkButtonRef}
                type="button"
                tabIndex={skipTab}
                className={`ai-hold-talk${recording ? (voiceCancel ? " cancel" : " recording") : ""}`}
                disabled={hybridVoiceActive || !!pendingWrite || loading || applying || uploadingAttach || !currentBackendAvailable}
                onPointerDown={startVoiceRecord}
                onPointerMove={moveVoiceRecord}
                onPointerUp={(e) => endVoiceRecord(e)}
                onPointerCancel={(e) => endVoiceRecord(e, true)}
                onContextMenu={(e) => e.preventDefault()}
                aria-label={recording ? (voiceCancel ? "松开取消" : "松开发送") : "按住说话，也可以按住空格键"}
              >
                {recording ? (
                  <>
                    <strong>{voiceCancel ? "松开取消" : "松开发送"}</strong>
                    <small>{voiceCancel ? "继续上滑" : "上滑取消"}</small>
                  </>
                ) : "按住 说话 · 空格键"}
              </button>
            ) : (
              <textarea
                ref={textareaRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onFocus={() => {
                  window.scrollTo(0, 0);
                  document.documentElement.scrollTop = 0;
                  document.body.scrollTop = 0;
                }}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const files: File[] = [];
                  for (const item of items) {
                    if (item.kind === "file" && item.type.startsWith("image/")) {
                      const file = item.getAsFile();
                      if (file) files.push(file);
                    }
                  }
                  if (files.length) {
                    e.preventDefault();
                    addPendingFiles(files, "image");
                  }
                }}
                onKeyDown={onComposerKeyDown}
                enterKeyHint="send"
                autoComplete="off"
                autoCorrect="on"
                aria-label={`给${activeSecretary.name}发消息`}
                placeholder={composerTitle}
                title={composerTitle}
                disabled={!!pendingWrite}
              />
            )}
            {!voiceCompose || pendingAttachments.length || loading ? (
              <button
                type="button"
                tabIndex={skipTab}
                className="ai-send-button"
                disabled={!!pendingWrite || uploadingAttach || recording || (!loading && (!composerBackendAvailable || applying || (!question.trim() && !pendingAttachments.length)))}
                onClick={loading ? stop : () => void ask()}
                aria-label={loading ? "停止生成" : "发送"}
                title={loading ? "停止本机显示和后续自动调用" : "发送"}
              >
                {loading ? <X size={16}/> : <Send size={16}/>}
              </button>
            ) : null}
          </div>
        </footer> : null}
      </div>
    </motion.aside>
  );
}

export function PreviewModal({ state, onClose, onCommit }: { state: NonNullable<PreviewState>; onClose: () => void; onCommit: () => void }) {
  const narrow = useIsNarrowViewport();
  const backdropStyle = useVisualViewportBackdropStyle(narrow, "center");
  const source = state.preview.sourceFile;
  const sourceTimeLabel = source?.createdAtKind === "birthtime"
    ? "导出文件生成时间"
    : source?.createdAtKind === "browser"
      ? "导出文件修改时间（浏览器提供）"
      : "导出文件修改时间";
  const health = state.preview.health;
  const healthDates = (health?.daily || [])
    .map((row) => String(row.date || ""))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const healthLatestDate = healthDates.at(-1) || null;
  return (
    <div className="modal-backdrop compact-confirm-backdrop" style={backdropStyle}>
      <motion.div className="preview-modal compact-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="write-confirm-title" aria-describedby="write-confirm-description" initial={{ opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }}>
        <h2 id="write-confirm-title">确认写入？</h2>
        <p id="write-confirm-description">{state.preview.summary}</p>
        {source ? (
          <section className="preview-source" aria-label="导入来源核对">
            <div><strong>来源文件</strong><span>{source.name}</span></div>
            <div><strong>{sourceTimeLabel}</strong><em>{source.createdAt}</em></div>
          </section>
        ) : null}
        {health ? (
          <section className="preview-health-check" aria-label="Apple Health 数据覆盖核对">
            <div>
              <strong>数据覆盖到</strong>
              <em>{healthLatestDate || "没有识别到有效日期"}</em>
            </div>
            <p>
              识别 {health.recordCount ?? 0} 条记录 · {healthDates.length} 天活动 · {health.workouts?.length ?? 0} 次运动 · {health.body?.length ?? 0} 条身体测量
            </p>
            <small>请先核对文件时间和覆盖日期；日期过早就取消，不写入。</small>
          </section>
        ) : null}
        <footer>
          <button className="ghost-button" onClick={onClose}>取消</button>
          <button className="gold-button" onClick={onCommit}>确认写入</button>
        </footer>
      </motion.div>
    </div>
  );
}
