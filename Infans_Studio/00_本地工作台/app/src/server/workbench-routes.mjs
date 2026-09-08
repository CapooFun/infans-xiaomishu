import { createCharacterPhotoService } from "./workbench-character-photos.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { scanWorkbenchSection, scanWorkbenchSummary, readLibraryDocumentById, readMarketBriefByDate, readGrammarLevel, queryLanguageReactor, SOURCES, WORKBENCH_VERSION, ensureInside, invalidateVaultScanCache } from "./workbench-data.mjs";
import { buildWorldLaneSection, readWorldLaneByDate, readWorldReadingAudio } from "./workbench-world-brief.mjs";
import { readWorldNewsFavorites, writeWorldNewsFavorite } from "./workbench-world-news-favorites.mjs";
import { createWriteService } from "./workbench-write.mjs";
import { readProjectManagement } from "./workbench-project-management.mjs";
import { readWorkbenchGovernance } from "./workbench-governance.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { createCalendarWriteService, readAppleCalendar, instanceCalendarCacheDir, osCalendarEnabled } from "./workbench-calendar.mjs";
import { streamNativeCalendarChanges } from "./workbench-calendar-native.mjs";
import { readAnkiDayReviews, readAnkiStatus, tokyoYesterday } from "./workbench-anki.mjs";
import { readSecretaryAiRuntimeStatus, streamCursor } from "./workbench-ai.mjs";
import { openRouterStatus } from "./workbench-openrouter.mjs";
import { createOpenAIRealtimeCall, openAIRealtimeStatus } from "./workbench-openai-realtime.mjs";
import { enqueueAskSelection, takePendingAskSelection } from "./workbench-ai-selection.mjs";
import { createAppleHealthImportService } from "./workbench-apple-health.mjs";
import { createAppleHealthDeviceSyncService, healthSyncTokenMatches } from "./workbench-apple-health-sync.mjs";
import { assertCodexCommandDeviceAccess, assertExcludedWatchCommand, createCodexCommandInboxService } from "./workbench-codex-command-inbox.mjs";
import { createYingningInboxService } from "./workbench-yingning-inbox.mjs";
import { createSecretaryMonitorService } from "./workbench-secretary-monitors.mjs";
import { createSecretaryStateService } from "./workbench-secretary-state.mjs";
import { createSecretaryLifeCoreService } from "./workbench-secretary-life-core.mjs";
import { createRelationshipMemoryService } from "./workbench-relationship-memory.mjs";
import { createSecretaryMobileActionService } from "./workbench-secretary-mobile-actions.mjs";
import { createProactiveInteractionService } from "./workbench-proactive-interactions.mjs";
import { createProjectEventService } from "./workbench-project-events.mjs";
import { createLanguageReactorImportService } from "./workbench-language-reactor.mjs";
import { queryJapaneseCollection, readJapaneseCollectionDocumentById } from "./workbench-japanese-knowledge-cards.mjs";
import { listJapaneseLiterature, readJapaneseLiteratureDocument } from "./workbench-japanese-literature.mjs";
import { ASSET_SESSION_TTL_MS, createAssetAccessService } from "./workbench-assets.mjs";
import { createDisplayModeAccessService } from "./workbench-display-mode.mjs";
import { createResidentModeService } from "./workbench-resident-mode.mjs";
import { createLightsOffService } from "./workbench-lights-off.mjs";
import { createDeviceDutyMonitor } from "./workbench-device-duty.mjs";
import { createCodexCleanupService } from "./workbench-codex-cleanup.mjs";
import { readCronMonitor, runCronTasks } from "./workbench-cron-monitor.mjs";
import { readJapanActivities, readJapanActivityGuideImage, readJapanActivityPlaybook, writeJapanActivityInterest } from "./workbench-japan-activities.mjs";
import { readSteamWishlistReleases } from "./workbench-steam.mjs";
import { readPaymentAuthorization, readRenewalExpiry } from "./workbench-renewals.mjs";
import { readDevelopmentLog } from "./workbench-development-log.mjs";
import { previewDialogueLogImport, readDiaryMode } from "./workbench-diary-mode.mjs";
import { listDialogueLogDays, readDialogueLogDay } from "./workbench-dialogue-logs.mjs";
import { listMeetingMinutes, readMeetingMinute } from "./workbench-meeting-minutes.mjs";
import { listTechnicalDiscussions, readTechnicalDiscussion } from "./workbench-technical-discussions.mjs";
import { appendGameAnalyticsEvents, assertLocalGameAnalyticsWrite, readGameAnalyticsSummary, readOfficialGameAnalyticsSummary, writeGameAnalyticsCors } from "./workbench-game-analytics.mjs";
import { readHomePins, writeHomePins } from "./workbench-home-pins.mjs";
import { readSidebarBookmarks, writeSidebarBookmarks } from "./workbench-sidebar-bookmarks.mjs";
import { createPreferencesService } from "./workbench-preferences.mjs";
import { applyHiddenCalendarEvents, readGanttHidden, writeGanttHidden } from "./workbench-gantt-hidden.mjs";
import { followableProjectTaskKeys, readProjectTaskFollows, writeProjectTaskFollow } from "./workbench-project-task-follows.mjs";
import { readFoodMap, writeFoodMapPlaceState } from "./workbench-food-map.mjs";
import { readDomainResearchProgress, writeDomainResearchProgress } from "./workbench-domain-research-progress.mjs";
import { deleteSecretaryChat, listSecretaryChats, readSecretaryChat, renameSecretaryChat, saveSecretaryChat } from "./workbench-secretary-chats.mjs";
import { createSecretaryMobileProtocolService, secretaryMobileAttachmentDescriptor } from "./workbench-secretary-mobile-protocol.mjs";
import { createSecretaryMailboxService } from "./workbench-secretary-mailbox.mjs";
import { createSecretaryMailboxWorker, DEFAULT_SECRETARY_MAILBOX_URL } from "./workbench-secretary-mailbox-worker.mjs";
import { createSecretaryTranscriptionRouteHandler, createSecretaryTranscriptionService } from "./workbench-secretary-transcription.mjs";
import { createSecretaryVoiceCorrectionService } from "./workbench-secretary-voice-corrections.mjs";
import { createWhisperKitSecretaryTranscriptionProvider, whisperKitProviderOptionsFromEnvironment } from "./workbench-secretary-whisperkit.mjs";
import { createSecretaryVoicePlaybackService } from "./workbench-secretary-voice-playback.mjs";
import { describeSecretaryAttachment, readSecretaryAttachment, saveSecretaryAttachment } from "./workbench-secretary-attachments.mjs";
import { getDailyTopicQuiz } from "./workbench-topic-quiz.mjs";
import { launchRegisteredExperience, launchRegisteredProject, ProjectRegistryError } from "./project-registry.mjs";
import { readHomeMarketLive, readWeather, startMarketLiveRefresh, stopMarketLiveRefresh } from "./workbench-live.mjs";
import { synthesizeSecretaryEdgeSpeech } from "./workbench-tts.mjs";
import { readDefaultMusicQueue, readMusicDirectory, streamMusicTrack } from "./workbench-music.mjs";
import { resolvePublicMediaLibraryDir } from "./workbench-public-demo.mjs";
import { createMusicPlaylist, deleteMusicPlaylist, readMusicPlaylists, updateMusicPlaylist } from "./workbench-music-playlists.mjs";
import { readVideoDirectory, streamVideoFile } from "./workbench-video.mjs";
import { addVideoFavorite, readVideoFavorites, removeVideoFavorite } from "./workbench-video-favorites.mjs";
import { DEFAULT_PHOTO_CACHE_DIR, exportPhotoMediaToDesktop, movePhotoMediaToTrash, readPhotoLibrary, sendPhotoThumbnail, streamPhotoMedia } from "./workbench-photo.mjs";
import { createArtLibraryService } from "./workbench-art-library.mjs";
import { createProjectAssetService } from "./workbench-project-assets.mjs";
import { readAiTools, readWebBookmarks, recordAiToolUse, recordWebBookmarkUse } from "./workbench-ai-tools.mjs";
import { appendExternalAgentUsage, importCursorAccountCsv, readAgentObservabilityCached, syncCursorAccountFromLocalSession, writeAgentObservabilityLink } from "./workbench-agent-observability.mjs";
import { readCodexFeatureTasks } from "./workbench-codex-feature-tasks.mjs";
import { applyStoredComputerShortcuts, readComputerShortcuts, writeComputerShortcuts } from "./workbench-computer-shortcuts.mjs";
import { readCourseShelf, streamCourseArtifact } from "./workbench-course-shelf.mjs";
import { streamAnimeCover } from "./workbench-anime-covers.mjs";
import { elevenLabsVoiceStatus, synthesizeSecretaryElevenLabsSpeech } from "./workbench-elevenlabs.mjs";
import { normalizeChatSpeaker } from "../secretary-characters.mjs";
import { exerciseMediaPath, DIR_LIBRARY, DIR_TOPICS, GAME_COVERS_DIR, DEDAO_COVERS_DIR, BOOK_COVERS_DIR, AVATAR_CREATOR_PATH, animeCoversSupportDir, courseLibrarySupportDir } from "./vault-paths.mjs";
import {
  buildJapaneseExploration,
  startJapaneseExam,
  getJapaneseExamSession,
  gradeJapaneseExam,
  commitExamEvidence,
  suggestExamScope,
  registerMockSnapshot,
  parseMockAnalysisMarkdown,
} from "./workbench-japanese-exam.mjs";
import { listReadingLibrary } from "./workbench-japanese-exam-modes.mjs";
import { readCourseStCard } from "./workbench-language-course.mjs";

/** 公开版数据根必须显式给出，禁止默认写回源码树。测试和路由调用应传入 options.root。 */
export function vaultRoot(baseDir = process.cwd()) {
  const fromEnv = String(process.env.INFANS_VAULT_ROOT || "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (process.env.INFANS_ALLOW_SOURCE_VAULT === "1") return path.resolve(baseDir, "../..");
  throw new WorkbenchWriteError("未设置 INFANS_VAULT_ROOT。请先运行 pnpm init:data，不要把运行记录写进源码目录。", 500, "VAULT_ROOT_REQUIRED");
}

function send(response, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(response.__infansAcceptEncoding || ""));
  const bytes = acceptsGzip && body.length >= 1024 ? gzipSync(body, { level: 6 }) : body;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!response.getHeader("Cache-Control")) response.setHeader("Cache-Control", "no-store");
  if (bytes !== body) {
    const vary = String(response.getHeader("Vary") || "");
    response.setHeader("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
    response.setHeader("Content-Encoding", "gzip");
  }
  response.setHeader("Content-Length", bytes.length);
  response.end(bytes);
}

async function readJson(request, limit = 32768) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new WorkbenchWriteError("请求内容过大", 413, "PAYLOAD_TOO_LARGE"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new WorkbenchWriteError("请求内容不是有效 JSON", 400, "INVALID_JSON"); }
}

async function readText(request, limit = 262144) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new WorkbenchWriteError("请求内容过大", 413, "PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const TRUSTED_HOSTS = new Set([
  "mailbox.example.invalid",
  "dev.example.invalid",
]);

const TRUSTED_PRIVATE_ASSET_HOSTS = new Set([
  "mailbox.example.invalid",
]);

function requestHostname(request) {
  return String(request.headers.host || "").split(":")[0].toLowerCase();
}

function isLoopbackHost(hostHeader) {
  return /^(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(String(hostHeader || ""));
}

function displayModePasskeyContext(request) {
  const host = String(request.headers.host || "");
  const rpId = requestHostname(request);
  if (rpId === "127.0.0.1") return null;
  return {
    rpId,
    origin: rpId === "localhost" ? `http://${host}` : `https://${host}`,
  };
}

function requireDisplayModePasskeyContext(request) {
  const context = displayModePasskeyContext(request);
  if (!context) {
    throw new WorkbenchWriteError("当前地址不支持系统生物识别，请改用 localhost 或工作台的 HTTPS 地址", 409, "DISPLAY_MODE_PASSKEY_ORIGIN_UNSUPPORTED");
  }
  return context;
}

function originMatchesHost(origin, hostHeader) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === hostHeader;
  } catch {
    return false;
  }
}

/** 本机回环，或 Vite 精确放行的 Tailscale / sslip 主机名；Origin 必须与 Host 同源。 */
export function assertTrustedOrigin(request) {
  const host = String(request.headers.host || "");
  const origin = request.headers.origin;
  const hostname = requestHostname(request);
  const trusted = isLoopbackHost(host) || TRUSTED_HOSTS.has(hostname);
  if (!trusted || !originMatchesHost(origin, host)) {
    throw new WorkbenchWriteError("仅允许本工作台发起操作", 403, "ORIGIN_REJECTED");
  }
}

/** 选区入队：仅本机 Host；允许同源或 chrome-extension:// Origin（右键扩展）。 */
export function assertAskSelectionOrigin(request) {
  const host = String(request.headers.host || "");
  if (!isLoopbackHost(host)) {
    throw new WorkbenchWriteError("选区提问仅允许本机工作台接收", 403, "ORIGIN_REJECTED");
  }
  const origin = request.headers.origin;
  if (!origin || originMatchesHost(origin, host)) return;
  if (/^chrome-extension:\/\//i.test(String(origin))) return;
  throw new WorkbenchWriteError("选区提问来源不被信任", 403, "ORIGIN_REJECTED");
}

function writeAskSelectionCors(request, response) {
  const origin = String(request.headers.origin || "");
  if (/^chrome-extension:\/\//i.test(origin) || originMatchesHost(origin, String(request.headers.host || ""))) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

function writeYingningIntakeCors(request, response) {
  const origin = String(request.headers.origin || "");
  if (/^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }
}

/** 只允许在 Mac 本机回环执行的本机程序启动与本地文件选取。 */
export function assertLoopbackOnly(request) {
  const host = String(request.headers.host || "");
  const origin = request.headers.origin;
  if (!isLoopbackHost(host) || !isLoopbackPeer(request) || (origin && origin !== `http://${host}`)) {
    throw new WorkbenchWriteError("这个操作仅支持在 Mac 本机执行", 403, "ORIGIN_REJECTED");
  }
}

function isLoopbackPeer(request) {
  const address = String(request.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasVerifiedTailscaleServeIdentity(request) {
  const login = String(request.headers["tailscale-user-login"] || "").trim();
  return login.length > 0 && login.length <= 512 && !/[\r\n]/.test(login);
}

/**
 * 资产读取：本机回环可用；远程只接受 Tailscale Serve 在回环代理连接中注入的登录身份。
 * Host、Origin、UA、查询参数和普通代理头都不能单独形成授权。
 */
export function assertPrivateAssetAccess(request) {
  const host = String(request.headers.host || "");
  const origin = String(request.headers.origin || "");
  const hostname = requestHostname(request);
  if (isLoopbackHost(host)) {
    if (!isLoopbackPeer(request) || (origin && origin !== `http://${host}`)) {
      throw new WorkbenchWriteError("这台设备尚未获得私人内容访问权限", 403, "PRIVATE_ACCESS_REQUIRED");
    }
    return;
  }

  const expectedOrigin = `https://${host}`;
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  const trusted = TRUSTED_PRIVATE_ASSET_HOSTS.has(hostname)
    && isLoopbackPeer(request)
    && (!origin || origin === expectedOrigin)
    && fetchSite !== "cross-site"
    && hasVerifiedTailscaleServeIdentity(request);
  if (!trusted) {
    throw new WorkbenchWriteError("这台设备尚未获得私人内容访问权限", 403, "PRIVATE_ACCESS_REQUIRED");
  }
}

function assertLocalWriteRequest(request) {
  assertTrustedOrigin(request);
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
}

function normalizedWriteLogins(value) {
  const rows = Array.isArray(value) ? value : String(value || "").split(",");
  return new Set(rows.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
}

/**
 * 持久写入身份：Mac 本机要同时满足回环 Host、回环连接与同源；
 * 远程只接受受信 `.ts.net` Serve 代理注入且命中服务端白名单的身份。
 * 这层不限定正文类型，供附件二进制上传和无正文同步调用复用。
 */
export function assertAuthorizedWriteIdentity(request, allowedLogins = process.env.INFANS_TAILSCALE_WRITE_LOGINS) {
  const host = String(request.headers.host || "");
  const origin = String(request.headers.origin || "");
  if (isLoopbackHost(host)) {
    if (!isLoopbackPeer(request) || origin !== `http://${host}`) {
      throw new WorkbenchWriteError("这次写入没有通过本机身份校验", 403, "WRITE_ACCESS_DENIED");
    }
    return;
  }

  const hostname = requestHostname(request);
  const login = String(request.headers["tailscale-user-login"] || "").trim().toLowerCase();
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  const allowlist = normalizedWriteLogins(allowedLogins);
  const trusted = TRUSTED_PRIVATE_ASSET_HOSTS.has(hostname)
    && host === hostname
    && isLoopbackPeer(request)
    && origin === `https://${host}`
    && fetchSite !== "cross-site"
    && hasVerifiedTailscaleServeIdentity(request)
    && allowlist.size > 0
    && allowlist.has(login);
  if (!trusted) {
    throw new WorkbenchWriteError("这次写入没有通过 Tailscale 身份校验", 403, "WRITE_ACCESS_DENIED");
  }
}

/** JSON 持久写入同时检查身份和正文类型。 */
export function assertAuthorizedWriteAccess(request, allowedLogins = process.env.INFANS_TAILSCALE_WRITE_LOGINS) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.startsWith("application/json")) throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
  assertAuthorizedWriteIdentity(request, allowedLogins);
}

/**
 * iPhone 原生同步没有浏览器 Origin，因此使用“Tailscale Serve 身份 + 设备令牌”双门禁。
 * 本机回环只用于测试，仍必须提供同一枚设备令牌。
 */
export function assertAppleHealthDeviceSyncAccess(
  request,
  allowedLogins = process.env.INFANS_TAILSCALE_WRITE_LOGINS,
  expectedToken = process.env.INFANS_HEALTH_SYNC_TOKEN,
) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.startsWith("application/json")) throw new WorkbenchWriteError("同步请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
  const authorization = String(request.headers.authorization || "");
  const suppliedToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!healthSyncTokenMatches(suppliedToken, expectedToken)) {
    throw new WorkbenchWriteError("健康同步设备未配对", 403, "HEALTH_SYNC_DEVICE_DENIED");
  }

  const host = String(request.headers.host || "");
  const origin = String(request.headers.origin || "");
  if (isLoopbackHost(host)) {
    if (!isLoopbackPeer(request) || (origin && origin !== `http://${host}`)) {
      throw new WorkbenchWriteError("健康同步没有通过本机身份校验", 403, "HEALTH_SYNC_ACCESS_DENIED");
    }
    return;
  }

  const hostname = requestHostname(request);
  const login = String(request.headers["tailscale-user-login"] || "").trim().toLowerCase();
  const allowlist = normalizedWriteLogins(allowedLogins);
  const trusted = TRUSTED_PRIVATE_ASSET_HOSTS.has(hostname)
    && host === hostname
    && isLoopbackPeer(request)
    && (!origin || origin === `https://${host}`)
    && hasVerifiedTailscaleServeIdentity(request)
    && allowlist.size > 0
    && allowlist.has(login);
  if (!trusted) {
    throw new WorkbenchWriteError("健康同步没有通过 Tailscale 身份校验", 403, "HEALTH_SYNC_ACCESS_DENIED");
  }
}

function assetSessionToken(request) {
  const cookies = String(request.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key]) => key);
  return decodeURIComponent(cookies.find(([key]) => key === "infans_asset_session")?.[1] || "");
}

function setAssetSessionCookie(request, response, token, maxAgeSeconds) {
  const secure = TRUSTED_PRIVATE_ASSET_HOSTS.has(requestHostname(request)) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `infans_asset_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/assets; Max-Age=${maxAgeSeconds}${secure}`);
}

function protectAssetResponse(response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
}

function sendError(response, error) {
  if (error instanceof WorkbenchWriteError) return send(response, { error: error.message, code: error.code }, error.status);
  const status = Number(error?.statusCode) || 500;
  return send(response, { error: error instanceof Error ? error.message : "本机操作没做成" }, status);
}

/**
 * 把工作台的全部本机 API 注册到传入的路由上。
 *
 * 与传输方式无关：dev 由 vite.config.ts 的插件调用，生产由 serve.mjs 调用。
 * 返回的 dispose 用于停掉后台探针（行情保活）。
 */
export function registerWorkbenchRoutes(router, options = {}) {
  const root = options.root ?? vaultRoot();
  const publicDir = options.publicDir ?? path.join(process.cwd(), "public");
  const writes = createWriteService(root);
  const calendarOs = osCalendarEnabled();
  const calendarCacheDir = instanceCalendarCacheDir(root);
  const calendarReadOptions = { osEnabled: calendarOs, cacheDir: calendarCacheDir };
  const calendarWrites = createCalendarWriteService({ osEnabled: calendarOs, cacheDir: calendarCacheDir });
  const appleHealthImports = createAppleHealthImportService(root);
  const appleHealthDeviceSync = createAppleHealthDeviceSyncService(root);
  const codexCommandInbox = createCodexCommandInboxService({
    root,
    ...options.codexCommandInboxOptions,
  });
  const yingningInbox = createYingningInboxService(root, options.yingningInboxOptions);
  const secretaryState = createSecretaryStateService(root, options.secretaryStateOptions);
  const preferences = createPreferencesService(root, options.preferencesOptions);
  const relationshipMemory = createRelationshipMemoryService(root, options.relationshipMemoryOptions);
  const secretaryMobileActions = options.secretaryMobileOptions?.actionService || createSecretaryMobileActionService(root, {
    ...options.secretaryMobileActionOptions,
    previewAction: options.secretaryMobileActionOptions?.previewAction || (async (action) => {
      if (action?.kind === "calendarCreate") {
        return { authority: "calendar", preview: calendarWrites.preview({
          kind: "create",
          title: action.title,
          calendar: action.calendar,
          start: action.start,
          end: action.end,
          allDay: action.allDay,
        }) };
      }
      if (action?.kind === "relationshipMemory") {
        return { authority: "relationship", preview: await relationshipMemory.preview({
          secretaryId: action.secretaryId,
          operation: action.operation,
          text: action.text,
          oldText: action.oldText,
          newText: action.newText,
        }) };
      }
      return { authority: "write", preview: await writes.preview(action) };
    }),
    commitPreview: options.secretaryMobileActionOptions?.commitPreview || ((authority, token) => {
      if (authority === "calendar") return calendarWrites.commit(token);
      if (authority === "relationship") return relationshipMemory.commit(token);
      return writes.commit(token);
    }),
  });
  const secretaryMobile = createSecretaryMobileProtocolService(root, {
    ...options.secretaryMobileOptions,
    serviceVersion: WORKBENCH_VERSION,
    actionService: secretaryMobileActions,
    readActiveSecretary: options.secretaryMobileOptions?.readActiveSecretary || (() => secretaryState.read()),
    readRelationshipMemory: options.secretaryMobileOptions?.readRelationshipMemory
      || ((secretaryId) => relationshipMemory.read(secretaryId)),
    readAiStatus: options.secretaryMobileOptions?.readAiStatus || (() => readSecretaryAiRuntimeStatus(root)),
    onExternalUsage: options.secretaryMobileOptions?.onExternalUsage || ((event) => appendExternalAgentUsage(root, {
      ...event,
      surface: "secretary-mobile-chat",
      taskWindowKind: "secretary-chat",
      taskWindowId: String(event?.taskWindowId || "secretary-mobile"),
    })),
  });
  const secretaryMailbox = createSecretaryMailboxService(root, options.secretaryMailboxOptions);
  const secretaryVoiceCorrections = createSecretaryVoiceCorrectionService(
    root,
    options.secretaryVoiceCorrectionOptions,
  );
  const characterPhotos = createCharacterPhotoService(root);
  const secretaryVoicePlayback = createSecretaryVoicePlaybackService(root, options.secretaryVoicePlaybackOptions);
  const secretaryTranscriptionOptions = options.secretaryTranscriptionOptions || {};
  const whisperKitOptions = whisperKitProviderOptionsFromEnvironment(options.environment || process.env);
  const secretaryTranscription = createSecretaryTranscriptionService({
    ...secretaryTranscriptionOptions,
    provider: secretaryTranscriptionOptions.provider || (whisperKitOptions
      ? createWhisperKitSecretaryTranscriptionProvider({ ...whisperKitOptions, fetchImpl: secretaryTranscriptionOptions.fetchImpl })
      : undefined),
  });
  const proactiveInteractions = createProactiveInteractionService({
    ...options.proactiveInteractionOptions,
    readActiveSecretary: options.proactiveInteractionOptions?.readActiveSecretary || (() => secretaryState.read()),
    calendarStateFor: options.proactiveInteractionOptions?.calendarStateFor || (async (spec) => {
      const plannedAt = new Date(spec?.plannedAt);
      if (Number.isNaN(plannedAt.getTime())) return "unknown";
      const localDay = String(spec?.plannedAt || "").slice(0, 10);
      const dayStart = new Date(`${localDay}T00:00:00+09:00`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
      const snapshot = await readAppleCalendar(dayStart, dayEnd, calendarReadOptions);
      if (!snapshot?.available || snapshot?.stale) return "unknown";
      const guardStart = new Date(plannedAt.getTime() - 30 * 60_000);
      const guardEnd = new Date(plannedAt.getTime() + 30 * 60_000);
      const busy = (snapshot.events || []).some((event) => {
        if (event?.holiday) return false;
        const start = new Date(event?.start);
        const end = new Date(event?.end);
        return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start < guardEnd && end > guardStart;
      });
      return busy ? "busy" : "clear";
    }),
    careContextFor: options.proactiveInteractionOptions?.careContextFor || (async () => {
      const summary = await scanWorkbenchSummary(root);
      return {
        todayTraining: summary.health?.todayPlan || null,
        // iOS 没有提供可验证的实时睡眠／专注状态时保持 unknown，触感会自动降为静默。
        sleepState: "unknown",
        focusState: "unknown",
      };
    }),
  });
  const secretaryMonitors = createSecretaryMonitorService(root, {
    ...options.secretaryMonitorOptions,
    notify: options.secretaryMonitorOptions?.notify || ((candidate) => proactiveInteractions.plan(candidate)),
    deliveryItems: options.secretaryMonitorOptions?.deliveryItems || (() => proactiveInteractions.list()),
  });
  const projectEvents = createProjectEventService({
    readProjectManagement: (now) => readProjectManagement(root, { now }),
    planInteraction: (candidate, now) => proactiveInteractions.plan(candidate, now),
  });
  const secretaryLifeCore = createSecretaryLifeCoreService(root, {
    readActiveSecretary: () => secretaryState.read(),
    readRelationshipMemory: (secretaryId) => relationshipMemory.read(secretaryId),
    listInteractions: () => proactiveInteractions.list(),
  });
  const languageReactorImports = createLanguageReactorImportService(root);
  const assets = createAssetAccessService(root);
  const displayModeAccess = createDisplayModeAccessService(options.displayModeAccessOptions);
  const residentMode = createResidentModeService(options.residentModeOptions);
  const lightsOff = createLightsOffService({
    root,
    readToggleChord: async () => (await readComputerShortcuts(root)).native.lightsOff,
    ...options.lightsOffOptions,
  });
  const artLibrary = createArtLibraryService({ ...options.artLibraryOptions, vaultRoot: options.artLibraryOptions?.vaultRoot || root });
  const projectAssets = createProjectAssetService({ sources: options.artLibraryOptions?.sources, resolveArtItems: artLibrary.resolveLinkedItems, ...options.projectAssetOptions });
  const deviceDuty = options.deviceDutyMonitor || createDeviceDutyMonitor(options.deviceDutyOptions);
  const codexCleanup = options.codexCleanupService || createCodexCleanupService({ root, ...options.codexCleanupOptions });
  const remoteWriteLogins = options.remoteWriteLogins ?? process.env.INFANS_TAILSCALE_WRITE_LOGINS;
  const healthSyncToken = options.healthSyncToken ?? process.env.INFANS_HEALTH_SYNC_TOKEN;
  const codexCommandToken = options.codexCommandToken ?? process.env.INFANS_CODEX_COMMAND_TOKEN;
  const secretaryMailboxWorker = createSecretaryMailboxWorker({
    mailboxBaseUrl: options.secretaryMailboxWorkerOptions?.mailboxBaseUrl
      ?? options.environment?.INFANS_SECRETARY_MAILBOX_URL
      ?? process.env.INFANS_SECRETARY_MAILBOX_URL
      ?? DEFAULT_SECRETARY_MAILBOX_URL,
    token: options.secretaryMailboxWorkerOptions?.token ?? codexCommandToken,
    secretaryMobile,
    yingningInbox,
    fetchImpl: options.secretaryMailboxWorkerOptions?.fetchImpl,
    intervalMs: options.secretaryMailboxWorkerOptions?.intervalMs,
    workerId: options.secretaryMailboxWorkerOptions?.workerId,
    logger: options.secretaryMailboxWorkerOptions?.logger,
  });
  const assertPersistentWriteIdentity = (request) => assertAuthorizedWriteIdentity(request, remoteWriteLogins);
  const assertPersistentWrite = (request) => assertAuthorizedWriteAccess(request, remoteWriteLogins);

  const warmFrom = new Date(); warmFrom.setHours(0, 0, 0, 0);
  const warmTo = new Date(warmFrom); warmTo.setDate(warmTo.getDate() + 8);
  if (calendarOs) readAppleCalendar(warmFrom, warmTo, calendarReadOptions).catch(() => {});
  deviceDuty.start();
  startMarketLiveRefresh();
  secretaryMonitors.start();
  secretaryMailboxWorker.start();

  router.use(async (request, response, next) => {
    response.__infansAcceptEncoding = request.headers["accept-encoding"];
    const match = String(request.url || "").match(/^\/theme\/([^/?]+\.v\d+\.avif)(?:\?|$)/);
    if (match) {
      try {
        await fs.access(path.join(publicDir, "theme", match[1]));
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } catch {
        response.setHeader("Cache-Control", "no-store");
      }
    }
    next();
  });

  router.use("/api/health", (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    return send(response, {
      ok: true,
      localOnly: true,
      controlledWrites: true,
      version: WORKBENCH_VERSION,
      instanceId: options.instanceId || null,
      vaultRoot: root,
      product: "infans-opensource",
    });
  });

  router.use("/api/avatar", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const query = new URL(request.url || "", "http://127.0.0.1").searchParams;
      const creator = query.get("face") === "creator";
      const file = path.join(root, creator ? AVATAR_CREATOR_PATH : SOURCES.avatar);
      const bytes = await fs.readFile(file);
      response.statusCode = 200;
      response.setHeader("Content-Type", creator ? "image/png" : "image/jpeg");
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.end(bytes);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/library-cover", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const query = new URL(request.url || "", "http://127.0.0.1").searchParams;
      const relative = String(query.get("path") || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!relative || relative.includes("..") || relative.includes("\0")) {
        return send(response, { error: "封面路径不合法" }, 400);
      }
      let vaultRelative;
      if (relative.startsWith(`${GAME_COVERS_DIR}/`) || relative.startsWith(`${DEDAO_COVERS_DIR}/`)) {
        vaultRelative = relative;
      } else if (relative.startsWith(`${DIR_LIBRARY}/`)) {
        vaultRelative = relative;
      } else if (relative.startsWith("封面/")) {
        // 游戏封面短路径兼容：封面/Steam/...
        vaultRelative = path.posix.join(path.posix.dirname(GAME_COVERS_DIR), relative);
      } else if (relative.startsWith(`${DIR_TOPICS}/`)) {
        vaultRelative = relative;
      } else {
        vaultRelative = path.posix.join(GAME_COVERS_DIR, relative.replace(/^封面\//, ""));
      }
      const allowed = vaultRelative.startsWith(`${GAME_COVERS_DIR}/`)
        || vaultRelative.startsWith(`${DEDAO_COVERS_DIR}/`)
        || vaultRelative.startsWith(`${BOOK_COVERS_DIR}/`);
      if (!allowed) {
        return send(response, { error: "只能读取游戏、书籍或得到课封面目录" }, 400);
      }
      const absolute = ensureInside(root, vaultRelative);
      const bytes = await fs.readFile(absolute);
      const ext = path.extname(absolute).toLowerCase();
      const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      response.statusCode = 200;
      response.setHeader("Content-Type", type);
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.end(bytes);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return send(response, { error: "找不到封面" }, 404);
      }
      return sendError(response, error);
    }
  });

  router.use("/api/exercises", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const raw = decodeURIComponent(String(request.url || "").replace(/^\//, "").split("?")[0] || "");
      const match = raw.match(/^([0-9]{4}-[A-Za-z0-9]+)\.(gif|jpg)$/);
      if (!match) throw new WorkbenchWriteError("动作媒体文件名不合法", 400, "INVALID_EXERCISE_MEDIA");
      const [, stem, ext] = match;
      const folder = ext === "gif" ? "videos" : "images";
      const relative = exerciseMediaPath(folder, stem, ext);
      const bytes = await fs.readFile(ensureInside(root, relative));
      response.statusCode = 200;
      response.setHeader("Content-Type", ext === "gif" ? "image/gif" : "image/jpeg");
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.end(bytes);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return send(response, { error: "找不到该动作媒体" }, 404);
      }
      return sendError(response, error);
    }
  });

  router.use("/api/summary", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try { return send(response, await scanWorkbenchSummary(root)); } catch (error) { return sendError(response, error); }
  });

  router.use("/api/project-management", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try { return send(response, await readProjectManagement(root)); } catch (error) { return sendError(response, error); }
  });

  router.use("/api/workbench-governance", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
    try { return send(response, await readWorkbenchGovernance(root, { displayMode: query.get("display") === "1" })); } catch (error) { return sendError(response, error); }
  });

  router.use("/api/game-analytics/events", async (request, response) => {
    writeGameAnalyticsCors(request, response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      return response.end();
    }
    if (request.method !== "POST") return send(response, { error: "只允许上报事件" }, 405);
    try {
      assertLocalGameAnalyticsWrite(request);
      return send(response, await appendGameAnalyticsEvents(root, await readJson(request, 32_768)), 202);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/weather", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try { return send(response, await readWeather(root)); } catch (error) { return sendError(response, error); }
  });

  router.use("/api/market-live", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try { return send(response, await readHomeMarketLive(root)); } catch (error) { return sendError(response, error); }
  });

  router.use("/api/home-pins", async (request, response) => {
    if (request.method === "GET") {
      try { return send(response, await readHomePins(root)); } catch (error) { return sendError(response, error); }
    }
    if (request.method === "PUT") {
      try {
        assertPersistentWrite(request);
        return send(response, await writeHomePins(root, await readJson(request, 4096)));
      } catch (error) { return sendError(response, error); }
    }
    return send(response, { error: "只允许读取或更新" }, 405);
  });

  router.use("/api/sidebar-bookmarks", async (request, response) => {
    if (request.method === "GET") {
      try { return send(response, await readSidebarBookmarks(root)); } catch (error) { return sendError(response, error); }
    }
    if (request.method === "PUT") {
      try {
        assertPersistentWrite(request);
        return send(response, await writeSidebarBookmarks(root, await readJson(request, 8192)));
      } catch (error) { return sendError(response, error); }
    }
    return send(response, { error: "只允许读取或更新" }, 405);
  });

  router.use("/api/workbench-preferences", async (request, response) => {
    try {
      assertPrivateAssetAccess(request);
      if (request.method === "GET") return send(response, await preferences.read());
      if (request.method === "PUT") {
        assertPersistentWrite(request);
        return send(response, await preferences.write(await readJson(request, 131072)));
      }
      return send(response, { error: "只允许读取或保存设置" }, 405);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/gantt-hidden", async (request, response) => {
    if (request.method === "GET") {
      try { return send(response, await readGanttHidden(root)); } catch (error) { return sendError(response, error); }
    }
    if (request.method === "PUT") {
      try {
        assertPersistentWrite(request);
        return send(response, await writeGanttHidden(root, await readJson(request, 65536)));
      } catch (error) { return sendError(response, error); }
    }
    return send(response, { error: "只允许读取或更新" }, 405);
  });

  router.use("/api/project-task-follows", async (request, response) => {
    if (request.method === "GET") {
      try { return send(response, await readProjectTaskFollows(root)); } catch (error) { return sendError(response, error); }
    }
    if (request.method === "PUT") {
      try {
        assertPersistentWrite(request);
        const payload = await readJson(request, 4096);
        if (payload?.followed === true) {
          const followable = followableProjectTaskKeys(await readProjectManagement(root));
          if (!followable.has(String(payload.taskKey || "").trim())) {
            throw new WorkbenchWriteError("这个项目待办已经不存在、已完成或没有稳定编号", 409, "PROJECT_TASK_NOT_FOLLOWABLE");
          }
        }
        return send(response, await writeProjectTaskFollow(root, payload));
      } catch (error) { return sendError(response, error); }
    }
    return send(response, { error: "只允许读取或更新" }, 405);
  });

  router.use("/api/tools/food-map", async (request, response) => {
    if (request.method === "GET") {
      try { return send(response, await readFoodMap(root)); } catch (error) { return sendError(response, error); }
    }
    if (request.method === "PUT") {
      try {
        assertPersistentWrite(request);
        return send(response, await writeFoodMapPlaceState(root, await readJson(request, 4096)));
      } catch (error) { return sendError(response, error); }
    }
    return send(response, { error: "只允许读取或更新" }, 405);
  });

  router.use("/api/domain-research-progress", async (request, response) => {
    if (request.method === "GET") {
      try { return send(response, await readDomainResearchProgress(root)); } catch (error) { return sendError(response, error); }
    }
    if (request.method === "PUT") {
      try {
        assertPersistentWrite(request);
        return send(response, await writeDomainResearchProgress(root, await readJson(request, 16_384)));
      } catch (error) { return sendError(response, error); }
    }
    return send(response, { error: "只允许读取或更新" }, 405);
  });

  router.use("/api/topic-quiz/daily", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const topicId = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("topicId") || "";
      return send(response, await getDailyTopicQuiz(root, topicId));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/secretary-chats", async (request, response) => {
    const sub = String(request.url || "/").split("?")[0];
    try {
      if (request.method === "GET" && (sub === "/" || sub === "")) {
        return send(response, await listSecretaryChats(root));
      }
      if (request.method === "GET" && sub.startsWith("/") && sub.length > 1) {
        const id = decodeURIComponent(sub.slice(1));
        return send(response, await readSecretaryChat(root, id));
      }
      if (request.method === "POST" && (sub === "/" || sub === "")) {
        assertPersistentWrite(request);
        return send(response, await saveSecretaryChat(root, await readJson(request, 2_000_000)), 201);
      }
      if (request.method === "PATCH" && sub.startsWith("/") && sub.length > 1) {
        assertPersistentWrite(request);
        const id = decodeURIComponent(sub.slice(1));
        const body = await readJson(request, 8_000);
        return send(response, await renameSecretaryChat(root, id, body?.title, { expectedArchiveVersion: body?.expectedArchiveVersion }));
      }
      if (request.method === "DELETE" && sub.startsWith("/") && sub.length > 1) {
        assertPersistentWrite(request);
        const id = decodeURIComponent(sub.slice(1));
        return send(response, await deleteSecretaryChat(root, id));
      }
      return send(response, { error: "只允许列出、读取、保存、改名或删除" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/secretary-mobile/transcription", createSecretaryTranscriptionRouteHandler({
    service: secretaryTranscription,
    authorize: (request, accessOptions) => assertCodexCommandDeviceAccess(
      request,
      remoteWriteLogins,
      codexCommandToken,
      accessOptions,
    ),
  }));

  router.use("/api/secretary-mobile", async (request, response) => {
    protectAssetResponse(response);
    const sub = String(request.url || "/").split("?")[0];
    try {
      if (request.method === "GET" || request.method === "HEAD" || request.method === "POST" && sub === "/attachments") {
        assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken, { requireJson: false });
      } else {
        assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      }
      if (sub === "/character-photos" && request.method === "GET") return send(response, await characterPhotos.list());
      if (sub === "/character-photos/import" && request.method === "POST") return send(response, await characterPhotos.import(await readJson(request, 35 * 1024 * 1024)));
      if (sub === "/character-photos/reset" && request.method === "POST") return send(response, await characterPhotos.reset(await readJson(request, 4_000)));
      if ((sub === "/character-photos/select" || sub === "/character-photos/remove") && request.method === "POST") {
        throw new WorkbenchWriteError("旧版角色图片相册已停用，请更新小秘书", 410);
      }
      if (request.method === "GET" && /^\/character-photos\/photo-[a-f0-9-]{36}\/(content|thumbnail)$/.test(sub)) {
        const result = await characterPhotos.content(sub.split("/")[2], sub.endsWith("/thumbnail"));
        response.setHeader("Content-Type", result.mime);
        response.setHeader("Content-Length", result.data.length);
        response.end(result.data);
        return undefined;
      }
      if (request.method === "GET" && sub === "/bootstrap") {
        return send(response, await secretaryMobile.bootstrap());
      }
      if (request.method === "POST" && sub === "/mailbox/messages") {
        const result = await secretaryMailbox.accept(await readJson(request, 96_000));
        return send(response, result, result.duplicate ? 200 : 202);
      }
      if (request.method === "POST" && sub === "/mailbox/claim") {
        return send(response, await secretaryMailbox.claim(await readJson(request, 4_000)));
      }
      if (request.method === "POST" && sub === "/mailbox/complete") {
        return send(response, await secretaryMailbox.complete(await readJson(request, 48_000)));
      }
      if (request.method === "POST" && sub === "/mailbox/release") {
        return send(response, await secretaryMailbox.release(await readJson(request, 4_000)));
      }
      if (request.method === "GET" && sub === "/mailbox/sync") {
        const url = new URL(request.url || "/", "http://localhost");
        return send(response, await secretaryMailbox.sync({
          conversationId: url.searchParams.get("conversationId") || undefined,
          afterRevision: Number(url.searchParams.get("afterRevision") || 0),
        }));
      }
      if (request.method === "GET" && sub === "/tts/status") {
        return send(response, secretaryVoicePlayback.status());
      }
      if (request.method === "GET" && sub === "/voice-corrections") {
        return send(response, await secretaryVoiceCorrections.list());
      }
      if (request.method === "POST" && sub === "/voice-corrections") {
        return send(response, await secretaryVoiceCorrections.apply(await readJson(request, 16_000)));
      }
      if (request.method === "POST" && /^\/voice-corrections\/[^/]+\/revert$/u.test(sub)) {
        const id = decodeURIComponent(sub.slice("/voice-corrections/".length, -"/revert".length));
        return send(response, await secretaryVoiceCorrections.revert(id));
      }
      if (request.method === "POST" && sub === "/tts") {
        const aborter = new AbortController();
        response.on("close", () => aborter.abort());
        const result = await secretaryVoicePlayback.synthesize(
          await readJson(request, 24_000),
          { signal: aborter.signal },
        );
        response.statusCode = 200;
        response.setHeader("Content-Type", result.contentType || "audio/mpeg");
        response.setHeader("Cache-Control", "private, no-store, max-age=0");
        response.setHeader("X-Secretary-Voice-Source", "mac-private-service");
        response.setHeader("X-Secretary-Voice-Provider", "edge");
        response.setHeader("X-Secretary-Voice", result.voice || "");
        response.setHeader("X-Secretary-Speaker", result.speaker || "yinyue");
        response.setHeader("X-Secretary-Voice-Cache", result.cacheHit ? "hit" : "miss");
        response.setHeader("Content-Length", result.audio.length);
        response.end(result.audio);
        return undefined;
      }
      if (request.method === "POST" && sub === "/attachments") {
        const saved = await saveSecretaryAttachment(root, request);
        const { created, duplicate, ...attachment } = saved;
        return send(response, { created, duplicate, attachment: secretaryMobileAttachmentDescriptor(attachment) }, created ? 201 : 200);
      }
      if (request.method === "GET" && sub.startsWith("/attachments/")) {
        const parts = sub.slice("/attachments/".length).split("/").filter(Boolean).map(decodeURIComponent);
        if (parts.length === 1) {
          return send(response, { attachment: secretaryMobileAttachmentDescriptor(await describeSecretaryAttachment(root, parts[0])) });
        }
        if (parts.length === 2 && parts[1] === "content") {
          const file = await readSecretaryAttachment(root, parts[0]);
          response.statusCode = 200;
          response.setHeader("Content-Type", file.mime || "application/octet-stream");
          response.setHeader("Cache-Control", "private, no-store");
          response.setHeader("Content-Length", file.data.length);
          if (file.name) response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
          response.end(file.data);
          return undefined;
        }
        return send(response, { error: "找不到这份附件", code: "ATTACHMENT_NOT_FOUND" }, 404);
      }
      if (request.method === "POST" && sub === "/conversations") {
        const result = await secretaryMobile.createConversation(await readJson(request, 16_000));
        return send(response, result, result.created ? 201 : 200);
      }
      if (request.method === "GET" && sub === "/conversations") {
        return send(response, await secretaryMobile.listConversations());
      }
      if (request.method === "GET" && /^\/conversations\/[^/]+\/actions$/u.test(sub)) {
        const id = decodeURIComponent(sub.slice("/conversations/".length, -"/actions".length));
        return send(response, await secretaryMobile.listActions(id));
      }
      if (request.method === "POST" && /^\/actions\/[^/]+\/decision$/u.test(sub)) {
        const id = decodeURIComponent(sub.slice("/actions/".length, -"/decision".length));
        const result = await secretaryMobile.decideAction(id, await readJson(request, 8_000));
        return send(response, result, result.stale ? 409 : 200);
      }
      if (request.method === "PATCH" && sub.startsWith("/conversations/") && sub.length > "/conversations/".length) {
        const id = decodeURIComponent(sub.slice("/conversations/".length));
        return send(response, await secretaryMobile.updateConversation(id, await readJson(request, 32_000)));
      }
      if (request.method === "DELETE" && sub.startsWith("/conversations/") && sub.length > "/conversations/".length) {
        const id = decodeURIComponent(sub.slice("/conversations/".length));
        return send(response, await secretaryMobile.deleteConversation(id, await readJson(request, 8_000)));
      }
      if (request.method === "GET" && sub.startsWith("/conversations/") && sub.length > "/conversations/".length) {
        return send(response, await secretaryMobile.readConversation(decodeURIComponent(sub.slice("/conversations/".length))));
      }
      if (request.method === "POST" && sub === "/turns/cancel") {
        return send(response, secretaryMobile.cancel(await readJson(request, 8_000)));
      }
      if (request.method === "POST" && sub === "/turns/stream") {
        const payload = await readJson(request, 64_000);
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "private, no-store, max-age=0, no-transform",
          Connection: "keep-alive",
        });
        const write = (event) => {
          if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
        };
        const result = await secretaryMobile.streamTurn(payload, write);
        if (result?.ok && result.conversation && payload?.messageId && payload?.generationId) {
          const prefix = `reply-${payload.generationId}`;
          const replies = (result.conversation.messages || []).filter((item) => item.id === prefix || item.id.startsWith(`${prefix}:`));
          if (replies.length === 1) {
            await secretaryMailbox.complete({
              messageId: payload.messageId,
              generationId: payload.generationId,
              reply: {
                messageId: replies[0].id,
                text: replies[0].text || replies[0].fallbackText,
                speakerId: replies[0].sender?.id || "yinyue",
                createdAt: replies[0].createdAt,
              },
            }).catch(() => undefined);
          }
        }
        if (!response.destroyed) response.end();
        return undefined;
      }
      return send(response, { error: "找不到这项移动端聊天能力", code: "NATIVE_CHAT_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      if (!response.headersSent && error?.type === "resync_required") {
        return send(response, {
          type: "resync_required",
          error: error.message,
          code: error.code,
          expectedVersion: error.expectedVersion,
          currentVersion: error.currentVersion,
        }, 409);
      }
      if (!response.headersSent) return sendError(response, error);
      if (!response.destroyed) {
        response.write(`${JSON.stringify({
          type: "failed",
          code: String(error?.code || "NATIVE_CHAT_STREAM_FAILED"),
          message: error instanceof Error ? error.message : "移动端聊天没有完成",
          retryable: Number(error?.status || 500) >= 500,
        })}\n`);
        response.end();
      }
      return undefined;
    }
  });

  router.use("/api/secretary-attachments", async (request, response) => {
    const sub = String(request.url || "/").split("?")[0];
    try {
      if (request.method === "POST" && (sub === "/" || sub === "")) {
        assertPersistentWriteIdentity(request);
        return send(response, await saveSecretaryAttachment(root, request), 201);
      }
      if (request.method === "GET" && sub.startsWith("/") && sub.length > 1) {
        assertTrustedOrigin(request);
        const id = decodeURIComponent(sub.slice(1).split("/")[0]);
        const file = await readSecretaryAttachment(root, id);
        response.statusCode = 200;
        response.setHeader("Content-Type", file.mime || "application/octet-stream");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Length", file.data.length);
        if (file.name) {
          response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        }
        response.end(file.data);
        return undefined;
      }
      return send(response, { error: "只允许上传或读取附件" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/sections", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    const section = String(request.url || "").replace(/^\//, "").split("?")[0];
    try { return send(response, await scanWorkbenchSection(root, section)); } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/grammar", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const level = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("level") || "";
      return send(response, await readGrammarLevel(root, level));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/course-card", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const params = new URL(request.url || "/", "http://127.0.0.1").searchParams;
      const data = await readCourseStCard(root, {
        book: params.get("book") || "",
        lesson: params.get("lesson") || "",
        st: params.get("st") || "",
      });
      return send(response, { data });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/reactor", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const params = new URL(request.url || "/", "http://127.0.0.1").searchParams;
      return send(response, await queryLanguageReactor(root, {
        kind: params.get("kind") || "all",
        source: params.get("source") || "全部作品",
        q: params.get("q") || "",
        offset: params.get("offset") || 0,
        limit: params.get("limit") || 36,
      }));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/collection", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const params = new URL(request.url || "/", "http://127.0.0.1").searchParams;
      const detailId = params.get("detailId") || "";
      if (detailId) {
        const document = await readJapaneseCollectionDocumentById(root, detailId);
        return document ? send(response, { version: WORKBENCH_VERSION, data: document }) : send(response, { error: "找不到这张收藏卡原件" }, 404);
      }
      return send(response, {
        version: WORKBENCH_VERSION,
        generatedAt: new Date().toISOString(),
        data: await queryJapaneseCollection(root, {
          scope: params.get("scope") || "all",
          cardType: params.get("cardType") || "全部类型",
          category: params.get("category") || "全部分类",
          verification: params.get("verification") || "全部状态",
          source: params.get("source") || "全部作品",
          corpusType: params.get("corpusType") || "all",
          q: params.get("q") || "",
          offset: params.get("offset") || 0,
          limit: params.get("limit") || 60,
          review: params.get("review") || 0,
        }),
      });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/exploration", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const section = await scanWorkbenchSection(root, "languages");
      return send(response, { data: section.data.exploration || await buildJapaneseExploration(root, section.data) });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/reading-library", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const level = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("level") || "N2";
      return send(response, { data: await listReadingLibrary(level) });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/reading-literature", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const detailId = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("detailId") || "";
      if (detailId) {
        const document = await readJapaneseLiteratureDocument(root, detailId);
        return document ? send(response, { data: document }) : send(response, { error: "找不到这篇本地赏析" }, 404);
      }
      return send(response, { data: await listJapaneseLiterature(root) });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/exam/suggest", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许 POST" }, 405);
    try {
      assertTrustedOrigin(request);
      const body = await readJson(request, 8192);
      return send(response, { data: suggestExamScope(body.context || body) });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/exam/start", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许 POST" }, 405);
    try {
      assertLocalWriteRequest(request);
      const body = await readJson(request, 8192);
      const section = await scanWorkbenchSection(root, "languages");
      return send(response, { data: await startJapaneseExam(root, section.data, body) }, 201);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/exam/session", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const id = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("id") || "";
      const session = getJapaneseExamSession(id);
      if (!session) return send(response, { error: "考试会话不存在或已过期" }, 404);
      return send(response, { data: session });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/exam/submit", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许 POST" }, 405);
    try {
      assertPersistentWrite(request);
      const body = await readJson(request, 65_536);
      const graded = gradeJapaneseExam(body.sessionId, body.answers || {});
      let written = [];
      let clearedMistakes = [];
      if (body.write !== false) {
        const commit = await commitExamEvidence(root, graded);
        written = commit.written;
        clearedMistakes = commit.clearedMistakes || [];
        invalidateVaultScanCache();
      }
      return send(response, { data: { ...graded, written, clearedMistakes } });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/languages/exam/mock-snapshot", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许 POST" }, 405);
    try {
      assertPersistentWrite(request);
      const body = await readJson(request, 65_536);
      const parsed = body.analysisText ? parseMockAnalysisMarkdown(body.analysisText) : {};
      const accuracy = body.accuracy ?? parsed.accuracy;
      const data = await registerMockSnapshot(root, {
        accuracy,
        sitting: body.sitting || parsed.sitting,
        correct: body.correct ?? parsed.correct,
        total: body.total ?? parsed.total,
        durationMinutes: body.durationMinutes ?? parsed.durationMinutes,
        language: body.language ?? parsed.language,
        reading: body.reading ?? parsed.reading,
        listening: body.listening ?? parsed.listening,
        source: body.analysisText ? "paste" : "api",
        at: body.at,
      });
      invalidateVaultScanCache();
      return send(response, { data }, 201);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/markets/favorites", async (request, response) => {
    if (request.method === "GET") {
      try { return send(response, await readWorldNewsFavorites(root)); } catch (error) { return sendError(response, error); }
    }
    if (request.method === "PUT") {
      try {
        assertPersistentWrite(request);
        return send(response, await writeWorldNewsFavorite(root, await readJson(request, 4096)));
      } catch (error) { return sendError(response, error); }
    }
    return send(response, { error: "只允许读取或更新" }, 405);
  });

  router.use("/api/markets/brief", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const date = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("date");
      return send(response, await readMarketBriefByDate(root, date));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/markets/world", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const lane = url.searchParams.get("lane");
      const date = url.searchParams.get("date");
      if (url.pathname === "/reading-audio") {
        const audio = await readWorldReadingAudio(root, lane, date, url.searchParams.get("id"));
        response.statusCode = 200;
        response.setHeader("Content-Type", audio.contentType);
        response.setHeader("Cache-Control", "private, max-age=3600");
        response.setHeader("Content-Length", audio.bytes.length);
        response.end(audio.bytes);
        return;
      }
      if (!date) return send(response, await buildWorldLaneSection(root, lane));
      return send(response, await readWorldLaneByDate(root, lane, date));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/assets/unlock", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许解锁" }, 405);
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      const session = assets.unlock((await readJson(request, 4096)).password);
      setAssetSessionCookie(request, response, session.token, Math.floor(ASSET_SESSION_TTL_MS / 1000));
      return send(response, { unlocked: true, expiresAt: new Date(session.expiresAt).toISOString() });
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/display-mode/disable", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许验证关闭" }, 405);
    try {
      assertPrivateAssetAccess(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      return send(response, displayModeAccess.verify((await readJson(request, 4096)).password));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/tools/resident-mode", async (request, response) => {
    try {
      assertPrivateAssetAccess(request);
      if (request.method === "GET") return send(response, residentMode.read());
      if (request.method !== "POST") return send(response, { error: "只允许读取或切换常亮模式" }, 405);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      const { enabled } = await readJson(request, 4096);
      if (typeof enabled !== "boolean") {
        throw new WorkbenchWriteError("常亮模式状态必须是 true 或 false", 400, "RESIDENT_MODE_STATE_REQUIRED");
      }
      return send(response, await residentMode.setEnabled(enabled));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/lights-off", async (request, response) => {
    try {
      assertPrivateAssetAccess(request);
      if (request.method === "GET") return send(response, lightsOff.read());
      if (request.method !== "POST") return send(response, { error: "只允许读取或开关关灯模式" }, 405);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      const body = await readJson(request, 4096);
      if (body?.toggle === true) return send(response, await lightsOff.toggle());
      if (typeof body?.enabled !== "boolean") {
        throw new WorkbenchWriteError("关灯模式状态必须是 true 或 false", 400, "LIGHTS_OFF_STATE_REQUIRED");
      }
      return send(response, await lightsOff.setEnabled(body.enabled));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/display-mode/passkey/status", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取状态" }, 405);
    try {
      assertPrivateAssetAccess(request);
      const context = displayModePasskeyContext(request);
      if (!context) return send(response, { available: false, enrolled: false, reason: "请改用 localhost 或工作台的 HTTPS 地址" });
      return send(response, displayModeAccess.status(context));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/display-mode/passkey/register/options", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许开始设置" }, 405);
    try {
      assertPrivateAssetAccess(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      return send(response, displayModeAccess.beginRegistration((await readJson(request, 4096)).password, requireDisplayModePasskeyContext(request)));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/display-mode/passkey/register/verify", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许完成设置" }, 405);
    try {
      assertPrivateAssetAccess(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      return send(response, displayModeAccess.finishRegistration(await readJson(request, 65_536), requireDisplayModePasskeyContext(request)));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/display-mode/passkey/authenticate/options", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许开始验证" }, 405);
    try {
      assertPrivateAssetAccess(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      await readJson(request, 4096);
      return send(response, displayModeAccess.beginAuthentication(requireDisplayModePasskeyContext(request)));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/display-mode/passkey/authenticate/verify", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许完成验证" }, 405);
    try {
      assertPrivateAssetAccess(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      return send(response, displayModeAccess.finishAuthentication(await readJson(request, 65_536), requireDisplayModePasskeyContext(request)));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/assets/lock", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许锁定" }, 405);
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      const result = assets.lock(assetSessionToken(request));
      setAssetSessionCookie(request, response, "", 0);
      return send(response, result);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/assets/bills/import-downloads", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许导入" }, 405);
    try {
      protectAssetResponse(response);
      assertPersistentWrite(request);
      assertPrivateAssetAccess(request);
      const body = await readJson(request, 4096);
      return send(response, await assets.importBillDownloads(assetSessionToken(request), body));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/assets/custody/import-downloads", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许导入" }, 405);
    try {
      protectAssetResponse(response);
      assertPersistentWrite(request);
      assertPrivateAssetAccess(request);
      await readJson(request, 4096);
      return send(response, await assets.importCustodyDownloads(assetSessionToken(request)));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/assets/investment-series", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      const instrumentId = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("instrumentId");
      return send(response, await assets.readInvestmentSeries(assetSessionToken(request), instrumentId));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/assets/investment-performance", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      return send(response, await assets.readInvestmentPerformance(assetSessionToken(request), {
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
      }));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/assets/payment-authorization", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    protectAssetResponse(response);
    try {
      assertPrivateAssetAccess(request);
      assets.requireSession(assetSessionToken(request));
      return send(response, await readPaymentAuthorization(root));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/assets", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    protectAssetResponse(response);
    try { assertPrivateAssetAccess(request); return send(response, await assets.read(assetSessionToken(request))); } catch (error) { return sendError(response, error); }
  });

  router.use("/api/tools/development-log", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      return send(response, await readDevelopmentLog(root));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/inbox", async (request, response) => {
    protectAssetResponse(response);
    try {
      if (request.method === "GET") {
        assertPrivateAssetAccess(request);
        const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
        if (query.get("intakeId") && query.get("attachmentId")) {
          const share = query.get("share") === "1";
          const attachment = share
            ? await yingningInbox.readShareCopy(query.get("intakeId"), query.get("attachmentId"))
            : await yingningInbox.readAttachment(query.get("intakeId"), query.get("attachmentId"));
          response.setHeader("Content-Type", attachment.contentType);
          response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
          response.end(attachment.data);
          return;
        }
        return send(response, await yingningInbox.list(query.get("limit")));
      }
      if (request.method === "DELETE") {
        assertPersistentWrite(request);
        const body = await readJson(request, 4096);
        return send(response, await yingningInbox.remove(body?.intakeId));
      }
      if (request.method === "POST") {
        assertPersistentWrite(request);
        const body = await readJson(request, 4096);
        if (body?.action === "restore") return send(response, await yingningInbox.restore(body?.intakeId));
        if (body?.action === "empty-trash") return send(response, await yingningInbox.emptyTrash());
        throw new WorkbenchWriteError("不支持的收件箱操作", 400, "YINGNING_INBOX_ACTION_INVALID");
      }
      return send(response, { error: "只允许读取、删除到回收站、复原或清空回收站" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/ai-tools", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      if (request.method === "GET") return send(response, await readAiTools(root));
      if (request.method === "POST") {
        assertPersistentWrite(request);
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
          throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
        }
        return send(response, await recordAiToolUse(root, await readJson(request, 4096)));
      }
      return send(response, { error: "工具与素材只支持读取和记录使用" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/web-bookmarks", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      if (request.method === "GET") return send(response, await readWebBookmarks(root));
      if (request.method === "POST") {
        assertPersistentWrite(request);
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
          throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
        }
        return send(response, await recordWebBookmarkUse(root, await readJson(request, 4096)));
      }
      return send(response, { error: "网页收藏只支持读取和记录使用" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/diary-mode", async (request, response) => {
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      if (pathname === "/preview") {
        if (request.method !== "POST") return send(response, { error: "只允许预览导入" }, 405);
        assertPersistentWrite(request);
        const { handoff } = await readJson(request, 64_000);
        return send(response, await previewDialogueLogImport(root, handoff, writes));
      }
      if (pathname !== "/" && pathname !== "") return send(response, { error: "找不到这个日记模式接口" }, 404);
      if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
      return send(response, await readDiaryMode(root));
    } catch (error) {
      return sendError(response, error);
    }
  });

  const handleDialogueDiaries = async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const date = url.searchParams.get("date");
      return send(response, date ? await readDialogueLogDay(root, date) : await listDialogueLogDays(root));
    } catch (error) {
      return sendError(response, error);
    }
  };
  router.use("/api/tools/dialogue-diaries", handleDialogueDiaries);
  router.use("/api/tools/dialogue-logs", handleDialogueDiaries);

  router.use("/api/tools/meeting-minutes", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      const id = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("id");
      return send(response, id ? await readMeetingMinute(root, id) : await listMeetingMinutes(root));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/technical-discussions", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      protectAssetResponse(response);
      assertPrivateAssetAccess(request);
      const id = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("id");
      return send(response, id ? await readTechnicalDiscussion(root, id) : await listTechnicalDiscussions(root));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/music", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const libraryDir = resolvePublicMediaLibraryDir(root, "", "music");
      if (url.pathname === "/playlists") {
        if (request.method === "GET") return send(response, await readMusicPlaylists(root, libraryDir));
        if (["POST", "PUT", "DELETE"].includes(request.method || "")) {
          assertPersistentWrite(request);
          const body = await readJson(request, 8192);
          if (request.method === "POST") return send(response, await createMusicPlaylist(root, libraryDir, body.name));
          if (request.method === "PUT") return send(response, await updateMusicPlaylist(root, libraryDir, body));
          return send(response, await deleteMusicPlaylist(root, libraryDir, body.playlistId));
        }
        return send(response, { error: "这个歌单操作不受支持" }, 405);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return send(response, { error: "只允许读取" }, 405);
      const force = url.searchParams.get("refresh") === "1";
      if (url.pathname === "/" || url.pathname === "") return send(response, await readMusicDirectory(libraryDir, url.searchParams.get("path") || "", { force }));
      if (url.pathname === "/default") return send(response, await readDefaultMusicQueue(libraryDir, { force }));
      if (url.pathname === "/stream") return streamMusicTrack(request, response, libraryDir, url.searchParams.get("path") || "");
      return send(response, { error: "找不到这个音乐接口" }, 404);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/video", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const libraryDir = resolvePublicMediaLibraryDir(root, "", "video");
      if (url.pathname === "/favorites") {
        if (request.method === "GET") return send(response, await readVideoFavorites(root, libraryDir));
        if (request.method === "PUT" || request.method === "DELETE") {
          assertPersistentWrite(request);
          const body = await readJson(request, 4096);
          return send(response, request.method === "PUT"
            ? await addVideoFavorite(root, libraryDir, body.path)
            : await removeVideoFavorite(root, libraryDir, body.path));
        }
        return send(response, { error: "这个收藏操作不受支持" }, 405);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return send(response, { error: "只允许读取" }, 405);
      if (url.pathname === "/" || url.pathname === "") {
        return send(response, await readVideoDirectory(libraryDir, url.searchParams.get("path") || "", { force: url.searchParams.get("refresh") === "1" }));
      }
      if (url.pathname === "/stream") {
        return streamVideoFile(request, response, libraryDir, url.searchParams.get("path") || "");
      }
      return send(response, { error: "找不到这个视频接口" }, 404);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/project-assets", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/annotation") {
        if (request.method !== "POST") return send(response, { error: "素材说明只支持 POST" }, 405);
        assertPersistentWrite(request);
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
        return send(response, await projectAssets.saveAnnotation(await readJson(request, 16384)));
      }
      if (!["GET", "HEAD"].includes(request.method)) return send(response, { error: "只支持浏览和保存素材说明" }, 405);
      if (url.pathname === "/file") return await projectAssets.streamFile(request, response, { projectId: url.searchParams.get("project") || "", itemId: url.searchParams.get("id") || "" });
      if (url.pathname === "/links" || url.pathname === "/related") {
        if (request.method !== "GET") return send(response, { error: "素材关联只支持 GET" }, 405);
        const projectId = url.searchParams.get("project") || "";
        if (url.pathname === "/links") return send(response, await projectAssets.links({ projectId, itemId: url.searchParams.get("id") || "", assetPath: url.searchParams.get("path") || "" }));
        return send(response, await projectAssets.related({ projectId, objectId: url.searchParams.get("object") || "", offset: url.searchParams.get("offset") || 0, limit: url.searchParams.get("limit") || 30 }));
      }
      if (url.pathname === "/" || url.pathname === "") {
        if (request.method === "HEAD") return send(response, { error: "素材目录只支持 GET" }, 405);
        return send(response, await projectAssets.browse({
          projectId: url.searchParams.get("project") || "", kind: url.searchParams.get("kind") || "font",
          q: url.searchParams.get("q") || "", category: url.searchParams.get("category") || "",
          zone: url.searchParams.get("zone") || "", directory: url.searchParams.get("directory") || "",
          attention: url.searchParams.get("attention") === "1", missing: url.searchParams.get("missing") === "1",
          offset: url.searchParams.get("offset") || 0, limit: url.searchParams.get("limit") || 60,
        }));
      }
      return send(response, { error: "没有这个素材接口" }, 404);
    } catch (error) {
      if (response.headersSent) { response.destroy(error); return; }
      return send(response, { error: error instanceof WorkbenchWriteError ? error.message : "项目素材暂时无法读取，请检查项目清单。", code: error.code || "PROJECT_ASSET_ERROR", ...(error.annotation ? { annotation: error.annotation } : {}) }, error.status || 500);
    }
  });

  router.use("/api/tools/art-library", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/decision") {
        if (request.method !== "POST") return send(response, { error: "人工标记只支持 POST" }, 405);
        assertLoopbackOnly(request);
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
          throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
        }
        return send(response, await artLibrary.appendDecision(await readJson(request, 8192)));
      }
      if (url.pathname === "/annotation") {
        if (request.method !== "POST") return send(response, { error: "素材说明只支持 POST" }, 405);
        assertPersistentWrite(request);
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
          throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
        }
        return send(response, await artLibrary.appendAnnotation(await readJson(request, 16384)));
      }
      if (url.pathname === "/attention" || url.pathname === "/attention-batch") {
        if (request.method !== "POST") return send(response, { error: "待处理标记只支持 POST" }, 405);
        assertPersistentWrite(request);
        const body = await readJson(request, url.pathname === "/attention-batch" ? 65536 : 8192);
        return send(response, url.pathname === "/attention-batch"
          ? await artLibrary.setAssetsAttention(body)
          : await artLibrary.setAssetAttention(body));
      }
      if (url.pathname === "/replacement-preview") {
        if (request.method !== "POST") return send(response, { error: "替换预览只支持 POST" }, 405);
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
          throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
        }
        return send(response, await artLibrary.previewVisualReplacement(await readJson(request, 8192)));
      }
      if (["/move", "/move/undo", "/open"].includes(url.pathname)) {
        if (request.method !== "POST") return send(response, { error: "这个素材操作只支持 POST" }, 405);
        if (url.pathname === "/move") assertPersistentWrite(request); else assertLoopbackOnly(request);
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
          throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
        }
        const body = await readJson(request, 65536);
        if (url.pathname === "/move") return send(response, await artLibrary.moveAssets(body));
        if (url.pathname === "/move/undo") return send(response, await artLibrary.undoMove(body));
        return send(response, await artLibrary.openItem(body));
      }
      if (request.method !== "GET" && request.method !== "HEAD") return send(response, { error: "美术库只允许浏览和受控的本机素材管理" }, 405);
      if (url.pathname === "/thumb") {
        if (request.method === "HEAD") return send(response, { error: "缩略图只允许 GET" }, 405);
        return artLibrary.sendThumbnail(response, {
          projectId: url.searchParams.get("project") || "",
          assetId: url.searchParams.get("id") || "",
          size: url.searchParams.get("size") || "small",
        });
      }
      if (url.pathname === "/preview") {
        return artLibrary.streamOriginal(request, response, {
          projectId: url.searchParams.get("project") || "",
          assetId: url.searchParams.get("id") || "",
        });
      }
      if (url.pathname === "/browse") {
        if (request.method === "HEAD") return send(response, { error: "目录浏览只允许 GET" }, 405);
        return send(response, await artLibrary.browse({
          projectId: url.searchParams.get("project") || "",
          rootId: url.searchParams.get("root") || "",
          directory: url.searchParams.get("directory") || "",
          q: url.searchParams.get("q") || "",
          system: url.searchParams.get("system") || "",
          displayMode: url.searchParams.get("display") === "1",
          limit: url.searchParams.get("limit") || 240,
        }));
      }
      if (url.pathname === "/usage") {
        if (request.method === "HEAD") return send(response, { error: "使用清单只允许 GET" }, 405);
        return send(response, await artLibrary.usage({
          projectId: url.searchParams.get("project") || "",
          recentMinutes: url.searchParams.get("minutes") || 30,
        }));
      }
      if (url.pathname === "/semantic") {
        if (request.method === "HEAD") return send(response, { error: "内容索引只允许 GET" }, 405);
        return send(response, await artLibrary.semantic({
          projectId: url.searchParams.get("project") || "",
          category: url.searchParams.get("category") || "",
          displayMode: url.searchParams.get("display") === "1",
          limit: url.searchParams.get("limit") || 180,
        }));
      }
      if (url.pathname === "/" || url.pathname === "") {
        return send(response, await artLibrary.snapshot({
          projectId: url.searchParams.get("project") || "",
          view: url.searchParams.get("view") || "groups",
          q: url.searchParams.get("q") || "",
          conclusion: url.searchParams.get("conclusion") || "",
          workflow: url.searchParams.get("workflow") || "",
          system: url.searchParams.get("system") || "",
          cursor: url.searchParams.get("cursor") || 0,
          limit: url.searchParams.get("limit") || 180,
          displayMode: url.searchParams.get("display") === "1",
          refresh: ["1", "incremental"].includes(url.searchParams.get("refresh")),
        }));
      }
      return send(response, { error: "找不到这个美术库接口" }, 404);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/photo", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const libraryDir = resolvePublicMediaLibraryDir(root, "", "photos");
      const cacheDir = DEFAULT_PHOTO_CACHE_DIR;
      if (url.pathname === "/export") {
        if (request.method !== "POST") return send(response, { error: "只允许导出" }, 405);
        assertPersistentWrite(request);
        const body = await readJson(request, 32768);
        return send(response, await exportPhotoMediaToDesktop({ libraryDir, cacheDir, ids: body.ids }));
      }
      if (url.pathname === "/trash") {
        if (request.method !== "POST") return send(response, { error: "只允许移到回收目录" }, 405);
        assertPersistentWrite(request);
        const body = await readJson(request, 32768);
        if (body.confirm !== true) throw new WorkbenchWriteError("删除前需要明确确认", 400, "PHOTO_TRASH_CONFIRM_REQUIRED");
        return send(response, await movePhotoMediaToTrash({ libraryDir, cacheDir, ids: body.ids }));
      }
      if (request.method !== "GET" && request.method !== "HEAD") return send(response, { error: "只允许读取" }, 405);
      if (url.pathname === "/" || url.pathname === "") {
        return send(response, await readPhotoLibrary({
          libraryDir,
          cacheDir,
          view: url.searchParams.get("view") || "month",
          anchor: url.searchParams.get("anchor") || "",
          cursor: url.searchParams.get("cursor") || 0,
          limit: url.searchParams.get("limit") || undefined,
          kind: url.searchParams.get("kind") || "all",
          folder: url.searchParams.get("folder") || "",
          query: url.searchParams.get("q") || "",
          refresh: ["1", "incremental"].includes(url.searchParams.get("refresh"))
            ? "incremental"
            : url.searchParams.get("refresh") === "full" ? "full" : "none",
        }));
      }
      if (url.pathname === "/thumb") {
        if (request.method === "HEAD") return send(response, { error: "缩略图只允许 GET" }, 405);
        return sendPhotoThumbnail(response, {
          libraryDir,
          cacheDir,
          id: url.searchParams.get("id") || "",
          size: url.searchParams.get("size") || "small",
        });
      }
      if (url.pathname === "/stream") {
        return streamPhotoMedia(request, response, {
          libraryDir,
          cacheDir,
          id: url.searchParams.get("id") || "",
          motion: url.searchParams.get("motion") === "1",
          download: url.searchParams.get("download") === "1",
        });
      }
      return send(response, { error: "找不到这个相册接口" }, 404);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/course-shelf", async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
      const parts = pathname.split("/").filter(Boolean);
      const libraryDir = courseLibrarySupportDir(root);
      if (!parts.length) return send(response, await readCourseShelf(libraryDir));
      if (parts.length === 2 && (parts[1] === "pdf" || parts[1] === "cover")) {
        return streamCourseArtifact(request, response, libraryDir, parts[0], parts[1]);
      }
      return send(response, { error: "找不到这个课件接口" }, 404);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/anime-cover", async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return send(response, { error: "找不到这张动漫封面" }, 404);
      return streamAnimeCover(request, response, animeCoversSupportDir(root), parts[0]);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/game-analytics", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
      const gameId = query.get("game_id") || "example-game";
      const environment = query.get("environment") || "production";
      const days = Number(query.get("days") || 30);
      const summary = environment === "production"
        ? await readOfficialGameAnalyticsSummary({ gameId, days, force: query.get("force") === "1" })
        : await readGameAnalyticsSummary(root, { gameId, environment, days });
      return send(response, summary);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/cron/run", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许 POST" }, 405);
    try {
      // 只执行服务端白名单任务；授权后的 Mac、iPad 与 iPhone 使用同一写入身份边界。
      assertPersistentWrite(request);
      const body = await readJson(request);
      return send(response, await runCronTasks(root, body || {}));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/device-duty/codex-cleanup", async (request, response) => {
    try {
      if (request.method === "GET") {
        assertTrustedOrigin(request);
        return send(response, codexCleanup.read());
      }
      if (request.method === "POST") {
        assertPersistentWrite(request);
        await readJson(request, 1024);
        const receipt = await codexCleanup.dispatch();
        return send(response, receipt, receipt.duplicate ? 200 : 202);
      }
      return send(response, { error: "只允许读取状态或交给 Codex" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/device-duty", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
      if (query.get("active") === "1") deviceDuty.observe();
      const snapshot = deviceDuty.read();
      const age = snapshot.observedAt ? Date.now() - new Date(snapshot.observedAt).getTime() : Number.POSITIVE_INFINITY;
      if (query.get("force") === "1" || age > deviceDuty.intervalMs()) await deviceDuty.refresh();
      return send(response, deviceDuty.read());
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/cron", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      // 定期任务状态是工作台只读信息，三端读取同权。
      assertTrustedOrigin(request);
      return send(response, await readCronMonitor(root));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/japan-activities", async (request, response) => {
    try {
      if (request.method === "GET") {
        assertTrustedOrigin(request);
        return send(response, await readJapanActivities(root));
      }
      if (request.method === "PATCH") {
        // 感兴趣只写入活动 ID 的布尔状态，但仍是持久化写入；远程必须命中 Serve 身份白名单。
        assertPersistentWrite(request);
        return send(response, await writeJapanActivityInterest(root, await readJson(request, 4096)));
      }
      return send(response, { error: "只允许读取或标记感兴趣" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/schedule/releases", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      const force = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("force") === "1";
      response.setHeader("Cache-Control", "private, no-store, max-age=0");
      return send(response, await readSteamWishlistReleases(root, { force }));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/japan-activity-guide", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      const id = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("id") || "";
      return send(response, await readJapanActivityPlaybook(root, id));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/japan-guide-image", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      const id = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("id") || "";
      const result = await readJapanActivityGuideImage(root, id);
      response.statusCode = 200;
      response.setHeader("Content-Type", result.contentType);
      response.setHeader("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800");
      response.setHeader("Content-Length", result.bytes.length);
      return response.end(result.bytes);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/renewals", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      return send(response, await readRenewalExpiry(root));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/computer-shortcuts", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      if (request.method === "GET") return send(response, await readComputerShortcuts(root));
      if (request.method === "PUT") {
        assertPersistentWrite(request);
        return send(response, await writeComputerShortcuts(root, await readJson(request, 16_384)));
      }
      if (request.method === "POST") {
        assertLoopbackOnly(request);
        return send(response, await applyStoredComputerShortcuts(root));
      }
      return send(response, { error: "只允许读取、保存或应用" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/agent-observability/cursor-account", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      if (request.method !== "POST") return send(response, { error: "只允许导入" }, 405);
      assertPersistentWrite(request);
      const body = await readJson(request, 8_000_000);
      if (body?.source === "local-session") {
        assertLoopbackOnly(request);
        return send(response, await syncCursorAccountFromLocalSession(root, { since: body.since }));
      }
      return send(response, await importCursorAccountCsv(root, body?.csv));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/tools/agent-observability", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      if (request.method === "GET") {
        const search = new URL(request.url || "/", "http://127.0.0.1").searchParams;
        const days = Number(search.get("days")) || 30;
        const hours = Number(search.get("hours"));
        const force = search.get("refresh") === "1";
        const periodOptions = hours === 24 ? { hours: 24 } : { days };
        return send(response, await readAgentObservabilityCached(root, {
          ...periodOptions,
          force,
          readExternalStatus: () => openRouterStatus({ probe: true }),
        }));
      }
      if (request.method === "POST") {
        assertPersistentWrite(request);
        return send(response, await writeAgentObservabilityLink(root, await readJson(request, 16_384)));
      }
      return send(response, { error: "只允许读取或关联功能" }, 405);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/codex-feature-tasks", async (request, response) => {
    try {
      assertTrustedOrigin(request);
      if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
      const search = new URL(request.url || "/", "http://127.0.0.1").searchParams;
      return send(response, await readCodexFeatureTasks(root, {
        projectId: search.get("projectId") || "",
        featureId: search.get("featureId") || "",
        limit: Number(search.get("limit")) || 8,
      }));
    } catch (error) {
      return sendError(response, error);
    }
  });

  /** 本机唤起教练执行台窗口；手机仍走前端直链。 */
  router.use("/api/tools/launch-coach", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许 POST" }, 405);
    try {
      assertLoopbackOnly(request);
      await launchRegisteredProject(root, "life-coach", "chrome");
      return send(response, { ok: true, mode: "chrome-app" });
    } catch (error) {
      if (error instanceof ProjectRegistryError) {
        return send(response, { error: error.publicMessage }, error.status);
      }
      return sendError(response, error);
    }
  });

  /** 只允许本机按登记表启动游戏体验；项目根目录和启动方式不接受前端传入。 */
  router.use("/api/tools/launch-project-experience", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许 POST" }, 405);
    try {
      assertLoopbackOnly(request);
      assertTrustedOrigin(request);
      const body = await readJson(request);
      const projectId = String(body?.projectId || "").trim();
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(projectId)) return send(response, { error: "项目入口不对" }, 400);
      return send(response, { ok: true, ...(await launchRegisteredExperience(root, projectId)) });
    } catch (error) {
      if (error instanceof ProjectRegistryError) return send(response, { error: error.publicMessage }, error.status);
      return sendError(response, error);
    }
  });

  router.use("/api/content", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    const id = decodeURIComponent(String(request.url || "").replace(/^\//, "").split("?")[0]);
    try {
      const content = await readLibraryDocumentById(root, id);
      return content ? send(response, content) : send(response, { error: "找不到这篇文章" }, 404);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.use("/api/calendar/changes", (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      if (!calendarOs) return send(response, { available: false, permission: "disabled", backend: "none", message: "未启用操作系统日历。" });
      streamNativeCalendarChanges(response, calendarCacheDir, () => invalidateVaultScanCache());
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/calendar/preview", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许预览" }, 405);
    try { assertPersistentWrite(request); return send(response, calendarWrites.preview(await readJson(request))); } catch (error) { return sendError(response, error); }
  });
  router.use("/api/calendar/commit", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许确认" }, 405);
    try { assertPersistentWrite(request); const { token } = await readJson(request); return send(response, await calendarWrites.commit(token)); } catch (error) { return sendError(response, error); }
  });
  router.use("/api/calendar", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const from = new Date(url.searchParams.get("from") || Date.now() - 86400000);
    const to = new Date(url.searchParams.get("to") || Date.now() + 7 * 86400000);
    const force = url.searchParams.get("force") === "1";
    try {
      const snapshot = await readAppleCalendar(from, to, { ...calendarReadOptions, force });
      const hidden = await readGanttHidden(root);
      return send(response, applyHiddenCalendarEvents(snapshot, hidden.texts));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/secretary-life-core", async (request, response) => {
    try {
      if (request.method !== "GET") return send(response, { error: "只允许查看生命核心" }, 405);
      const secretaryId = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("secretaryId");
      return send(response, await secretaryLifeCore.read(secretaryId));
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/secretary", async (request, response) => {
    try {
      if (request.method === "GET") return send(response, await secretaryState.read());
      if (request.method === "PUT") {
        assertPersistentWrite(request);
        const body = await readJson(request, 4 * 1024);
        return send(response, await secretaryState.write(body?.activeSecretaryId));
      }
      return send(response, { error: "只允许读取或切换当前秘书" }, 405);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/relationship-memory/preview", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许生成预览" }, 405);
      assertPersistentWrite(request);
      return send(response, await relationshipMemory.preview(await readJson(request, 16 * 1024)));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/relationship-memory/commit", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许本人确认" }, 405);
      assertPersistentWrite(request);
      const { token } = await readJson(request, 4 * 1024);
      return send(response, await relationshipMemory.commit(token));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/relationship-memory", async (request, response) => {
    try {
      if (request.method === "GET") {
        assertPersistentWriteIdentity(request);
        const secretaryId = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("secretaryId");
        return send(response, await relationshipMemory.read(secretaryId));
      }
      return send(response, { error: "关系记忆正文只允许受控读取" }, 405);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/proactive-interactions/pull", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许设备拉取" }, 405);
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      const body = await readJson(request, 4 * 1024);
      const deviceId = String(body?.deviceId || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,128}$/u.test(deviceId)) throw new WorkbenchWriteError("设备标识不合法", 400, "PROACTIVE_DEVICE_INVALID");
      return send(response, await proactiveInteractions.pull(deviceId));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/proactive-interactions/ack", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许设备确认" }, 405);
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      const body = await readJson(request, 8 * 1024);
      const deviceId = String(body?.deviceId || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,128}$/u.test(deviceId)) throw new WorkbenchWriteError("设备标识不合法", 400, "PROACTIVE_DEVICE_INVALID");
      return send(response, await proactiveInteractions.acknowledge(body?.interactionIds, deviceId, undefined, body?.stage));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/proactive-interactions/reaction", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许设备回应" }, 405);
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      return send(response, await proactiveInteractions.react(await readJson(request, 4 * 1024)));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/proactive-interactions/project-event", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许登记项目事件" }, 405);
      assertPersistentWrite(request);
      return send(response, await projectEvents.plan(await readJson(request, 8 * 1024)));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/proactive-interactions", async (request, response) => {
    try {
      if (request.method === "GET") {
        assertPersistentWriteIdentity(request);
        return send(response, { ok: true, items: await proactiveInteractions.list() });
      }
      if (request.method === "POST") {
        assertPersistentWrite(request);
        return send(response, await proactiveInteractions.plan(await readJson(request, 16 * 1024)));
      }
      return send(response, { error: "只允许读取或规划主动互动" }, 405);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/anki", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const day = url.searchParams.get("day");
    if (day || url.searchParams.get("reviews") === "1") {
      return send(response, await readAnkiDayReviews(day || tokyoYesterday(), root));
    }
    return send(response, await readAnkiStatus(root));
  });

  router.use("/api/apple-health/preview", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许预览导入" }, 405);
    try {
      assertTrustedOrigin(request);
      const contentType = String(request.headers["content-type"] || "");
      if (!/^(application\/(zip|xml|octet-stream)|text\/xml)/i.test(contentType)) throw new WorkbenchWriteError("请选择 Apple Health 导出的 ZIP 或 export.xml", 415, "CONTENT_TYPE_REQUIRED");
      return send(response, await appleHealthImports.preview(request));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/apple-health/device-sync", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许设备同步" }, 405);
    try {
      assertAppleHealthDeviceSyncAccess(request, remoteWriteLogins, healthSyncToken);
      const result = await appleHealthDeviceSync.sync(await readJson(request, 2 * 1024 * 1024));
      invalidateVaultScanCache();
      return send(response, result);
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/inbox", async (request, response) => {
    protectAssetResponse(response);
    writeYingningIntakeCors(request, response);
    if (request.method === "OPTIONS") return send(response, { ok: true });
    if (request.method !== "POST") return send(response, { error: "只允许设备投递来件" }, 405);
    try {
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken, { allowChromeExtensionOrigin: true });
      const receipt = await yingningInbox.accept(await readJson(request, 48 * 1024 * 1024));
      return send(response, receipt, receipt.duplicate ? 200 : 201);
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/codex-command/inbox", async (request, response) => {
    try {
      if (request.method === "POST") {
        assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
        const body = await readJson(request, 16 * 1024);
        assertExcludedWatchCommand(body);
        const receipt = await codexCommandInbox.accept(body);
        if (receipt.routing?.responseRoute === "companion") {
          return send(response, { error: "手表产品不在公开范围", code: "WATCH_EXCLUDED" }, 404);
        }
        return send(response, receipt);
      }
      if (request.method === "GET") {
        assertLoopbackOnly(request);
        const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
        return send(response, { ok: true, items: await codexCommandInbox.list(query.get("limit")) });
      }
      return send(response, { error: "只允许接收或本机查看指令" }, 405);
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/secretary-monitors", async (request, response) => {
    protectAssetResponse(response);
    try {
      if (request.method !== "GET") return send(response, { error: "登记或取消请通过小秘书监控确认卡" }, 405);
      assertPersistentWriteIdentity(request);
      return send(response, await secretaryMonitors.list());
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/codex-command/reply", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许设备查询回复" }, 405);
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      const body = await readJson(request, 4 * 1024);
      if (Number(body?.schemaVersion) !== 1) {
        throw new WorkbenchWriteError("回复查询版本不受支持", 400, "CODEX_COMMAND_SCHEMA_INVALID");
      }
      const receipt = await codexCommandInbox.receipt(body?.commandId, body?.deviceId);
      return send(response, receipt);
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/codex-command/delivery-ack", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许设备确认逐跳状态" }, 405);
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      const body = await readJson(request, 4 * 1024);
      if (Number(body?.schemaVersion) !== 1) {
        throw new WorkbenchWriteError("逐跳确认版本不受支持", 400, "CODEX_COMMAND_SCHEMA_INVALID");
      }
      return send(response, await codexCommandInbox.acknowledgeDelivery(body));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/codex-command/confirm", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许确认或取消" }, 405);
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      const body = await readJson(request, 8 * 1024);
      if (Number(body?.schemaVersion) !== 1) {
        throw new WorkbenchWriteError("确认版本不受支持", 400, "CODEX_COMMAND_SCHEMA_INVALID");
      }
      const result = await codexCommandInbox.confirmAction(body, async (action, command) => {
        if (action.kind === "secretaryMonitor") return secretaryMonitors.applyAction(action, command);
        if (action.kind === "unifiedReminder") {
          const { kind: _kind, label: _label, summary: _summary, requiresConfirm: _requiresConfirm, ...nativeAction } = action;
          return { summary: "等待 iPhone 本机执行", nativeAction };
        }
        if (action.kind === "calendarCreate") {
          const preview = calendarWrites.preview({
            kind: "create",
            calendar: action.calendar,
            title: action.title,
            start: action.start,
            end: action.end,
            allDay: action.allDay,
          });
          await calendarWrites.commit(preview.token);
          return { summary: `已写入苹果日历：${action.title}` };
        }
        const preview = await writes.preview(action);
        const committed = await writes.commit(preview.token);
        return { summary: `已完成：${action.label || committed.targetPath || "写入"}` };
      });
      return send(response, { ...result, commandId: body.commandId });
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/codex-command/native-action-result", async (request, response) => {
    try {
      if (request.method !== "POST") return send(response, { error: "只允许设备回传本机执行结果" }, 405);
      assertCodexCommandDeviceAccess(request, remoteWriteLogins, codexCommandToken);
      const body = await readJson(request, 16 * 1024);
      return send(response, { ...(await codexCommandInbox.completeNativeAction(body)), commandId: body.commandId });
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/apple-health/preview-local", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许预览导入" }, 405);
    try { assertLoopbackOnly(request); return send(response, await appleHealthImports.previewFromDownloads()); } catch (error) { return sendError(response, error); }
  });
  router.use("/api/apple-health/commit", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许确认导入" }, 405);
    try {
      assertPersistentWrite(request);
      const { token } = await readJson(request);
      const result = await appleHealthImports.commit(token);
      invalidateVaultScanCache();
      return send(response, result);
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/language-reactor/preview", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许预览导入" }, 405);
    try {
      assertTrustedOrigin(request);
      const contentType = String(request.headers["content-type"] || "");
      if (!/^(application\/(json|octet-stream)|text\/(json|plain))/i.test(contentType)) throw new WorkbenchWriteError("请选择 Language Reactor 导出的 JSON 文件", 415, "CONTENT_TYPE_REQUIRED");
      return send(response, await languageReactorImports.preview(request));
    } catch (error) { return sendError(response, error); }
  });
  router.use("/api/language-reactor/commit", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许确认导入" }, 405);
    try {
      assertPersistentWrite(request);
      const { token } = await readJson(request);
      const result = await languageReactorImports.commit(token);
      invalidateVaultScanCache();
      return send(response, result);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/tts", async (request, response) => {
    if (request.method === "GET" && /^\/status(?:\?|$)/.test(String(request.url || ""))) {
      try {
        return send(response, await elevenLabsVoiceStatus());
      } catch (error) { return sendError(response, error); }
    }
    if (request.method !== "POST") return send(response, { error: "只允许合成语音" }, 405);
    try {
      assertLocalWriteRequest(request);
      const payload = await readJson(request, 16384);
      const aborter = new AbortController();
      response.on("close", () => aborter.abort());
      const speaker = normalizeChatSpeaker(payload?.speaker || "yinyue");
      if (!speaker) return send(response, { error: "未知朗读角色", code: "UNKNOWN_TTS_SPEAKER" }, 400);
      const requestedProvider = payload?.provider === "elevenlabs" ? "elevenlabs" : "edge";
      let actualProvider = requestedProvider;
      let fallbackCode = "";
      let result;
      if (requestedProvider === "elevenlabs") {
        try {
          result = await synthesizeSecretaryElevenLabsSpeech(payload?.text ?? payload?.content ?? "", {
            signal: aborter.signal,
            speaker,
          });
        } catch (error) {
          if (aborter.signal.aborted) throw error;
          actualProvider = "edge";
          fallbackCode = String(error?.code || "ELEVENLABS_UNAVAILABLE").replace(/[^A-Z0-9_-]/g, "").slice(0, 80);
        }
      }
      if (!result) {
        result = await synthesizeSecretaryEdgeSpeech(payload?.text ?? payload?.content ?? "", {
          signal: aborter.signal,
          speaker,
        });
      }
      if (!result) return send(response, { error: "无可朗读文本" }, 400);
      response.statusCode = 200;
      response.setHeader("Content-Type", result.contentType);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Secretary-Voice", result.voice);
      response.setHeader("X-Secretary-Speaker", result.speaker || speaker);
      response.setHeader("X-Secretary-Requested-Provider", requestedProvider);
      response.setHeader("X-Secretary-Provider", actualProvider);
      if (fallbackCode) response.setHeader("X-Secretary-Fallback", fallbackCode);
      if (result.voices?.length) response.setHeader("X-Secretary-Voices", result.voices.join(","));
      if (result.langs?.length) response.setHeader("X-Secretary-Langs", result.langs.join(","));
      response.setHeader("Content-Length", result.audio.length);
      response.end(result.audio);
    } catch (error) {
      if (error?.code === "ABORTED" || response.destroyed) return;
      return sendError(response, error);
    }
  });

  router.use("/api/openai-realtime/status", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertTrustedOrigin(request);
      return send(response, await openAIRealtimeStatus());
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/openai-realtime/session", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许建立实时语音" }, 405);
    try {
      assertTrustedOrigin(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/sdp")) {
        throw new WorkbenchWriteError("实时语音请求必须使用 SDP", 415, "CONTENT_TYPE_REQUIRED");
      }
      const query = new URL(request.url || "", "http://127.0.0.1").searchParams;
      const aborter = new AbortController();
      response.on("close", () => aborter.abort("client_closed"));
      const result = await createOpenAIRealtimeCall({
        sdp: await readText(request),
        speaker: query.get("speaker") || "yinyue",
        model: query.get("model") || undefined,
        includeTranscription: query.get("transcript") === "1",
        vaultRoot: root,
        signal: aborter.signal,
      });
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/sdp; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Length", Buffer.byteLength(result.answerSdp));
      return response.end(result.answerSdp);
    } catch (error) { return sendError(response, error); }
  });

  router.use("/api/ai/status", async (request, response) => {
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    return send(response, await readSecretaryAiRuntimeStatus(root));
  });
  router.use("/api/ai/ask-selection", async (request, response) => {
    writeAskSelectionCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "POST") return send(response, { error: "只允许投递选区" }, 405);
    try {
      assertAskSelectionOrigin(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
      }
      return send(response, { ok: true, ...enqueueAskSelection(await readJson(request)) });
    } catch (error) {
      return sendError(response, error);
    }
  });
  router.use("/api/ai/pending-selection", async (request, response) => {
    writeAskSelectionCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "GET") return send(response, { error: "只允许读取" }, 405);
    try {
      assertAskSelectionOrigin(request);
      const item = takePendingAskSelection();
      return send(response, { pending: item });
    } catch (error) {
      return sendError(response, error);
    }
  });
  router.use("/api/ai/query", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许问答" }, 405);
    try {
      assertLocalWriteRequest(request);
      const payload = await readJson(request);
      const relationshipContexts = [];
      if (payload?.ordinaryBackend !== "openrouter") {
        try {
          const memory = await relationshipMemory.read(payload?.activeSecretaryId);
          if (memory?.content) relationshipContexts.push({
            source: `infans:relationship-memory:${memory.secretaryId}`,
            text: `当前秘书经使用者确认的关系记忆原件：\n${memory.content.slice(0, 12_000)}\n只把“已确认”内容当事实；“待确认候选”不能当事实，也不得自动写回。`,
          });
        } catch { /* 关系记忆缺失不能阻断普通问答。 */ }
      }
      response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      const aborter = new AbortController();
      response.on("close", () => aborter.abort());
      const write = (value) => { if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`); };
      const result = await streamCursor(root, payload, {
        signal: aborter.signal,
        extraContexts: relationshipContexts,
        onSources: (sources) => write({ type: "sources", sources }),
        onChunk: (text) => write({ type: "chunk", text }),
        onActions: (actions) => write({ type: "actions", actions }),
        onExternalUsage: (event) => appendExternalAgentUsage(root, {
          ...event,
          surface: "secretary-chat",
          taskWindowKind: "secretary-chat",
          taskWindowId: String(payload?.taskWindowId || `live:${payload?.activeSecretaryId || "secretary"}`),
        }),
      });
      write({ type: result.ok ? "done" : "error", ...result });
      response.end();
    } catch (error) {
      if (!response.headersSent) return sendError(response, error);
      if (!response.destroyed) { response.write(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "AI 问答没成功" })}\n`); response.end(); }
    }
  });

  router.use("/api/write/preview", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许预览写入" }, 405);
    try { assertPersistentWrite(request); return send(response, await writes.preview(await readJson(request))); } catch (error) { return sendError(response, error); }
  });
  router.use("/api/write/commit", async (request, response) => {
    if (request.method !== "POST") return send(response, { error: "只允许确认写入" }, 405);
    try { assertPersistentWrite(request); const { token } = await readJson(request); return send(response, await writes.commit(token)); } catch (error) { return sendError(response, error); }
  });

  return { dispose() { secretaryMailboxWorker.stop(); secretaryMonitors.stop(); secretaryTranscription.dispose(); lightsOff.dispose(); residentMode.dispose(); codexCleanup.dispose(); deviceDuty.stop(); stopMarketLiveRefresh(); } };
}
