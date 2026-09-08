import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Film, Folder, FolderOpen, HardDrive, Maximize2, Minimize2, Pause, Play, RefreshCw, RotateCcw, RotateCw, Search, Star } from "lucide-react";
import { Card, Empty, Kicker, fmtBytes, jsonFetch } from "../../page-shared";
import { createToolSessionCache } from "../../tool-session-cache";
import {
  clampVideoTime,
  formatVideoTime,
  getEffectiveVideoAspectRatio,
  MOBILE_VIDEO_CONTROLS_QUERY,
  requestVideoFullscreen,
  type VideoRotation,
} from "./video-player-controls";

type VideoDirectory = { kind: "directory"; name: string; path: string };
type VideoFile = {
  kind: "video";
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
  format: string;
  browserReady: boolean;
};
type VideoEntry = VideoDirectory | VideoFile;
type VideoFavorite = VideoFile & { folder: string; addedAt: string; available: boolean };
type VideoFavoritesSnapshot = { items: VideoFavorite[] };
type VideoLibrarySnapshot = {
  available: boolean;
  name: string;
  path: string;
  breadcrumbs: string[];
  entries: VideoEntry[];
  stale?: boolean;
  cacheWarning?: string;
};
type SavedProgress = Record<string, { seconds: number; updatedAt: number }>;
const PROGRESS_KEY = "infans-video-progress-v1";

const videoDirectoryCache = createToolSessionCache<string, VideoLibrarySnapshot>((folder, options) => jsonFetch<VideoLibrarySnapshot>(
  `/api/tools/video?path=${encodeURIComponent(folder)}${options.force ? "&refresh=1" : ""}`,
));
const videoFavoritesCache = createToolSessionCache<"favorites", VideoFavoritesSnapshot>(() => jsonFetch<VideoFavoritesSnapshot>("/api/tools/video/favorites"));
let lastVideoDirectoryPath = "";

function readProgress(): SavedProgress {
  try {
    const value = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeProgress(filePath: string, seconds: number) {
  const progress = readProgress();
  if (seconds <= 1) delete progress[filePath];
  else progress[filePath] = { seconds: Math.floor(seconds), updatedAt: Date.now() };
  const newest = Object.entries(progress)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, 200);
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // 浏览器禁用本地存储时只失去续播，不影响播放。
  }
}

function streamUrl(filePath: string) {
  return `/api/tools/video/stream?path=${encodeURIComponent(filePath)}`;
}

function useMobileVideoControls() {
  const [enabled, setEnabled] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_VIDEO_CONTROLS_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_VIDEO_CONTROLS_QUERY);
    const sync = () => setEnabled(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return enabled;
}

export default function VideoLibraryView({ active }: { active: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedSecond = useRef(0);
  const controlsTimer = useRef<number | null>(null);
  const directoryRefreshTimer = useRef<number | null>(null);
  const retryAttempt = useRef(0);
  const mobileVideoControls = useMobileVideoControls();
  const initialLibrary = videoDirectoryCache.get(lastVideoDirectoryPath);
  const [directoryPath, setDirectoryPath] = useState(() => initialLibrary?.path || "");
  const [library, setLibrary] = useState<VideoLibrarySnapshot | null>(() => initialLibrary);
  const [favorites, setFavorites] = useState<VideoFavorite[]>(() => videoFavoritesCache.get("favorites")?.items || []);
  const [view, setView] = useState<"library" | "favorites">("library");
  const [selected, setSelected] = useState<VideoFile | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const [favoriteError, setFavoriteError] = useState("");
  const [favoritePending, setFavoritePending] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const [progress, setProgress] = useState<SavedProgress>(() => readProgress());
  const [mobileControlsVisible, setMobileControlsVisible] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [inAppFullscreen, setInAppFullscreen] = useState(false);
  const [immersiveActionsVisible, setImmersiveActionsVisible] = useState(false);
  const [videoRotation, setVideoRotation] = useState<VideoRotation>(0);
  const [videoDimensions, setVideoDimensions] = useState<{ path: string; width: number; height: number } | null>(null);
  const customVideoControls = mobileVideoControls || videoRotation !== 0;
  const activeVideoDimensions = selected && videoDimensions?.path === selected.path ? videoDimensions : null;
  const videoAspectRatio = getEffectiveVideoAspectRatio(
    activeVideoDimensions?.width || 0,
    activeVideoDimensions?.height || 0,
    videoRotation,
  );
  const portraitVideo = Boolean(selected && videoAspectRatio < 1);
  const videoLayoutStyle = { "--video-aspect-ratio": String(videoAspectRatio) } as CSSProperties;

  const loadDirectory = async (nextPath = directoryPath, options: { force?: boolean; background?: boolean; maxAgeMs?: number; followup?: boolean } = {}) => {
    if (!options.background) setLoading(true);
    if (!options.background) setError("");
    try {
      const next = await videoDirectoryCache.load(nextPath, { force: options.force, maxAgeMs: options.maxAgeMs });
      lastVideoDirectoryPath = next.path;
      videoDirectoryCache.set(next.path, next);
      setLibrary(next);
      setDirectoryPath(next.path);
      setQuery("");
      setError(next.cacheWarning || (next.stale ? "正在显示上次成功读取的视频目录，并在后台检查更新" : ""));
      retryAttempt.current = 0;
      if (!next.stale && directoryRefreshTimer.current !== null) {
        window.clearTimeout(directoryRefreshTimer.current);
        directoryRefreshTimer.current = null;
      }
      if (next.stale && !options.force && !options.followup) {
        if (directoryRefreshTimer.current !== null) window.clearTimeout(directoryRefreshTimer.current);
        directoryRefreshTimer.current = window.setTimeout(() => {
          directoryRefreshTimer.current = null;
          void loadDirectory(next.path, { background: true, maxAgeMs: -1, followup: true });
        }, 800);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读不到视频库");
      retryAttempt.current += 1;
      setRetryRevision((revision) => revision + 1);
    } finally {
      if (!options.background) setLoading(false);
    }
  };

  const loadFavorites = async (force = false) => {
    setFavoriteError("");
    try {
      const next = await videoFavoritesCache.load("favorites", { force });
      setFavorites(next.items);
    } catch (reason) {
      setFavoriteError(reason instanceof Error ? reason.message : "读不到收藏夹");
    }
  };

  useEffect(() => {
    if (!active) return;
    if (library) void loadDirectory(library.path, { background: true, maxAgeMs: 30_000 });
    else void loadDirectory("");
    void loadFavorites();
  }, [active]);

  useEffect(() => {
    if (!active || library || !error) return;
    const delays = [1_500, 4_000, 10_000];
    if (retryAttempt.current > delays.length) return;
    const index = Math.max(0, Math.min(retryAttempt.current - 1, delays.length - 1));
    const timer = window.setTimeout(() => { void loadDirectory("", { background: true }); }, delays[index]);
    return () => window.clearTimeout(timer);
  }, [active, Boolean(library), retryRevision]);

  useEffect(() => {
    if (active) return;
    setInAppFullscreen(false);
  }, [active]);

  useEffect(() => {
    if (!inAppFullscreen) {
      setImmersiveActionsVisible(false);
      return;
    }
    const root = document.documentElement;
    let hideActionsTimer: number | null = null;
    const revealImmersiveActions = () => {
      setImmersiveActionsVisible(true);
      if (hideActionsTimer !== null) window.clearTimeout(hideActionsTimer);
      hideActionsTimer = window.setTimeout(() => {
        setImmersiveActionsVisible(false);
        hideActionsTimer = null;
      }, 2200);
    };
    const handleFullscreenKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setInAppFullscreen(false);
        return;
      }
      revealImmersiveActions();
    };
    root.classList.add("video-in-app-fullscreen-open");
    revealImmersiveActions();
    document.addEventListener("pointermove", revealImmersiveActions, { passive: true });
    document.addEventListener("pointerdown", revealImmersiveActions, { capture: true, passive: true });
    document.addEventListener("keydown", handleFullscreenKey, true);
    return () => {
      if (hideActionsTimer !== null) window.clearTimeout(hideActionsTimer);
      root.classList.remove("video-in-app-fullscreen-open");
      document.removeEventListener("pointermove", revealImmersiveActions);
      document.removeEventListener("pointerdown", revealImmersiveActions, true);
      document.removeEventListener("keydown", handleFullscreenKey, true);
    };
  }, [inAppFullscreen]);

  useEffect(() => () => {
    if (controlsTimer.current !== null) window.clearTimeout(controlsTimer.current);
    if (directoryRefreshTimer.current !== null) window.clearTimeout(directoryRefreshTimer.current);
  }, []);

  const visibleFavorites = useMemo(
    () => favorites,
    [favorites],
  );

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const source: Array<VideoEntry | VideoFavorite> = view === "favorites" ? visibleFavorites : library?.entries || [];
    const entries = source;
    if (!needle) return entries;
    return entries.filter((entry) => entry.name.toLocaleLowerCase("zh-CN").includes(needle)
      || ("folder" in entry && entry.folder.toLocaleLowerCase("zh-CN").includes(needle)));
  }, [library, query, view, visibleFavorites]);
  const videos = useMemo(() => view === "favorites"
    ? visibleFavorites.filter((entry) => entry.available)
    : (library?.entries || []).filter((entry): entry is VideoFile => entry.kind === "video"), [library, view, visibleFavorites]);
  const favoritePaths = useMemo(() => new Set(favorites.map((entry) => entry.path)), [favorites]);

  const chooseVideo = (entry: VideoFile) => {
    setPlaybackError("");
    lastSavedSecond.current = 0;
    setMobileControlsVisible(true);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoRotation(0);
    setSelected(entry);
  };

  const revealMobileControls = (autoHide = true) => {
    if (!customVideoControls) return;
    setMobileControlsVisible(true);
    if (controlsTimer.current !== null) window.clearTimeout(controlsTimer.current);
    controlsTimer.current = null;
    if (autoHide && videoRef.current && !videoRef.current.paused) {
      controlsTimer.current = window.setTimeout(() => {
        setMobileControlsVisible(false);
        controlsTimer.current = null;
      }, 2600);
    }
  };

  const saveCurrentProgress = (clear = false) => {
    if (!selected || !videoRef.current) return;
    writeProgress(selected.path, clear ? 0 : videoRef.current.currentTime);
    setProgress(readProgress());
  };

  const handleLoadedMetadata = () => {
    if (!selected || !videoRef.current) return;
    const video = videoRef.current;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoDimensions({ path: selected.path, width: video.videoWidth, height: video.videoHeight });
    }
    const saved = progress[selected.path]?.seconds || 0;
    if (saved >= 10 && saved < video.duration - 15) video.currentTime = saved;
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setCurrentTime(video.currentTime);
  };

  const handleTimeUpdate = () => {
    const nextTime = videoRef.current?.currentTime || 0;
    if (customVideoControls) setCurrentTime(nextTime);
    const current = Math.floor(nextTime);
    if (current - lastSavedSecond.current < 5) return;
    lastSavedSecond.current = current;
    saveCurrentProgress();
  };

  const seekBy = (offset: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clampVideoTime(video.currentTime, video.duration, offset);
    setCurrentTime(video.currentTime);
    revealMobileControls();
  };

  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clampVideoTime(0, video.duration, seconds);
    setCurrentTime(video.currentTime);
    revealMobileControls();
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        setPlaybackError("无法开始播放，请重新选择这个视频。");
      }
    } else {
      video.pause();
    }
  };

  const enterFullscreen = () => {
    setPlaybackError("");
    if (inAppFullscreen) {
      setInAppFullscreen(false);
      return;
    }
    const video = videoRef.current as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitSupportsFullscreen?: boolean;
    }) | null;
    const stage = video?.closest(".video-stage") as (HTMLElement & { webkitRequestFullscreen?: () => void }) | null;
    if (!video || !stage) return;
    requestVideoFullscreen(video, stage, () => setInAppFullscreen(true));
  };

  const rotateVideo = () => {
    setPlaybackError("");
    setMobileControlsVisible(true);
    setVideoRotation((current) => ((current + 90) % 360) as VideoRotation);
  };

  const playNext = () => {
    if (!selected) return;
    saveCurrentProgress(true);
    const index = videos.findIndex((entry) => entry.path === selected.path);
    if (index >= 0 && index < videos.length - 1) chooseVideo(videos[index + 1]);
  };

  const openBreadcrumb = (index: number) => {
    const nextPath = index < 0 ? "" : (library?.breadcrumbs || []).slice(0, index + 1).join("/");
    void loadDirectory(nextPath);
  };

  const switchView = (next: "library" | "favorites") => {
    setView(next);
    setQuery("");
    if (next === "favorites") void loadFavorites();
  };

  const toggleFavorite = async (entry: VideoFile) => {
    if (favoritePending) return;
    const removing = favoritePaths.has(entry.path);
    setFavoritePending(entry.path);
    setFavoriteError("");
    try {
      const next = await jsonFetch<VideoFavoritesSnapshot>("/api/tools/video/favorites", {
        method: removing ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.path }),
      });
      videoFavoritesCache.set("favorites", next);
      setFavorites(next.items);
    } catch (reason) {
      setFavoriteError(reason instanceof Error ? reason.message : "收藏操作失败");
    } finally {
      setFavoritePending("");
    }
  };

  return (
    <div className={`video-library-page${portraitVideo ? " is-portrait-video" : ""}`} style={videoLayoutStyle}>
      <Card className={`video-stage-card${inAppFullscreen ? " has-in-app-fullscreen" : ""}`}>
        <div className="video-stage-head">
          <div>
            <Kicker>视频库</Kicker>
            <h2>{selected?.name || "选一部开始播放"}</h2>
          </div>
          <div className="video-stage-actions">
            {selected ? (
              <>
                <button type="button" className="video-rotate-button" onClick={rotateVideo} aria-label="顺时针旋转画面">
                  <RotateCw size={16} aria-hidden="true" />
                  旋转画面
                </button>
                <button type="button" className="video-fullscreen-button" onClick={enterFullscreen} aria-label="全屏播放">
                  <Maximize2 size={16} aria-hidden="true" />
                  全屏
                </button>
                <button
                  type="button"
                  className={favoritePaths.has(selected.path) ? "is-favorite" : ""}
                  onClick={() => void toggleFavorite(selected)}
                  disabled={Boolean(favoritePending)}
                  aria-label={favoritePaths.has(selected.path) ? "取消收藏" : "收藏这个视频"}
                >
                  <Star size={16} fill={favoritePaths.has(selected.path) ? "currentColor" : "none"} />
                  {favoritePaths.has(selected.path) ? "已收藏" : "收藏"}
                </button>
              </>
            ) : null}
            <span><HardDrive size={15} /> 只读视频库</span>
          </div>
        </div>
        <div
          className={`video-stage${selected ? " has-video" : ""}${customVideoControls ? " has-mobile-controls" : ""}${inAppFullscreen ? " is-in-app-fullscreen" : ""}${videoRotation ? ` is-rotated-${videoRotation}` : ""}`}
          onPointerDown={() => revealMobileControls()}
        >
          {selected ? (
            <>
              <video
                key={selected.path}
                ref={videoRef}
                src={streamUrl(selected.path)}
                controls={!customVideoControls}
                autoPlay
                playsInline
                preload="metadata"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => {
                  setIsPlaying(true);
                  revealMobileControls();
                }}
                onPause={() => {
                  setIsPlaying(false);
                  setMobileControlsVisible(true);
                  saveCurrentProgress();
                }}
                onEnded={() => {
                  setIsPlaying(false);
                  playNext();
                }}
                onError={() => setPlaybackError("这个视频无法直接播放，可能是浏览器不支持它的编码。")}
              />
              {inAppFullscreen ? (
                <div className={`video-immersive-actions${immersiveActionsVisible ? "" : " is-hidden"}`} onPointerDown={(event) => event.stopPropagation()}>
                  <button type="button" onClick={rotateVideo} aria-label="顺时针旋转画面"><RotateCw size={18} />旋转画面</button>
                  <button type="button" onClick={() => setInAppFullscreen(false)} aria-label="退出全屏"><Minimize2 size={18} />退出全屏</button>
                </div>
              ) : null}
              {customVideoControls ? (
                <div className={`video-mobile-controls${mobileControlsVisible ? "" : " is-hidden"}`}>
                  <div className="video-mobile-main-controls" onPointerDown={(event) => event.stopPropagation()}>
                    <button type="button" className="video-mobile-seek is-forward" onClick={() => seekBy(15)} aria-label="前进 15 秒">
                      <RotateCw size={31} aria-hidden="true" />
                      <b>15</b>
                    </button>
                    <button type="button" className="video-mobile-play" onClick={() => void togglePlayback()} aria-label={isPlaying ? "暂停" : "播放"}>
                      {isPlaying ? <Pause size={31} fill="currentColor" /> : <Play size={31} fill="currentColor" />}
                    </button>
                    <button type="button" className="video-mobile-seek is-back" onClick={() => seekBy(-15)} aria-label="后退 15 秒">
                      <RotateCcw size={31} aria-hidden="true" />
                      <b>15</b>
                    </button>
                  </div>
                  <div className="video-mobile-timeline" onPointerDown={(event) => event.stopPropagation()}>
                    <span>{formatVideoTime(currentTime)}</span>
                    <input
                      type="range"
                      min="0"
                      max={Math.max(duration, 1)}
                      step="0.5"
                      value={Math.min(currentTime, Math.max(duration, 1))}
                      onChange={(event) => seekTo(Number(event.target.value))}
                      aria-label="播放进度"
                    />
                    <span>{formatVideoTime(duration)}</span>
                    <button type="button" onClick={rotateVideo} aria-label="顺时针旋转画面"><RotateCw size={20} /></button>
                    <button type="button" onClick={enterFullscreen} aria-label={inAppFullscreen ? "退出全屏" : "全屏播放"}>
                      {inAppFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="video-stage-empty">
              <span><Play size={28} fill="currentColor" /></span>
              <strong>片库已就位</strong>
              <p>把视频放进 NAS「视频库」，可以自由分文件夹和多层目录。</p>
            </div>
          )}
        </div>
        {selected ? (
          <div className="video-stage-meta">
            <span>{selected.format}</span>
            <span>{fmtBytes(selected.bytes)}</span>
            <span>{progress[selected.path]?.seconds ? `从 ${Math.floor(progress[selected.path].seconds / 60)} 分钟处续播` : "首次播放"}</span>
            {!selected.browserReady ? <strong>该格式的播放效果取决于当前设备</strong> : null}
          </div>
        ) : null}
        {playbackError ? <p className="video-playback-error">{playbackError}</p> : null}
      </Card>

      <Card className="video-browser-card">
        <header className="video-browser-head">
          <div>
            <Kicker>片库</Kicker>
            <nav className="video-breadcrumbs" aria-label="当前文件夹">
              <button type="button" onClick={() => openBreadcrumb(-1)}><HardDrive size={14} />视频库</button>
              {(library?.breadcrumbs || []).map((part, index) => (
                <span key={`${part}-${index}`}><ChevronRight size={13} /><button type="button" onClick={() => openBreadcrumb(index)}>{part}</button></span>
              ))}
            </nav>
          </div>
          <button type="button" className="video-refresh" onClick={() => void loadDirectory(undefined, { force: true })} disabled={loading} aria-label="刷新视频库">
            <RefreshCw size={16} className={loading ? "is-spinning" : ""} />
          </button>
        </header>

        <div className="video-view-tabs" role="tablist" aria-label="视频列表">
          <button type="button" role="tab" aria-selected={view === "library"} className={view === "library" ? "is-active" : ""} onClick={() => switchView("library")}>全部</button>
          <button type="button" role="tab" aria-selected={view === "favorites"} className={view === "favorites" ? "is-active" : ""} onClick={() => switchView("favorites")}><Star size={14} fill={view === "favorites" ? "currentColor" : "none"} />收藏 {visibleFavorites.length}</button>
        </div>

        <label className="video-search">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "favorites" ? "查找收藏的视频" : "在当前文件夹里查找"} />
        </label>

        {favoriteError ? <p className="video-favorite-error">{favoriteError}</p> : null}
        {view === "library" && error && !library ? <div className="video-library-error"><strong>视频库暂时不可用</strong><p>{error}</p><button type="button" onClick={() => void loadDirectory(undefined, { force: true })}>重新读取</button></div> : null}
        {view === "library" && error && library ? <p className="video-favorite-error">{error}</p> : null}
        {view === "favorites" && !visibleEntries.length ? <Empty>{query ? "收藏夹里没有匹配项" : "还没有收藏。点视频右侧的星星就能放进这里。"}</Empty> : null}
        {view === "library" && library && !loading && !visibleEntries.length ? <Empty>{query ? "当前文件夹没有匹配项" : "这个文件夹还没有视频"}</Empty> : null}
        {(view === "favorites" || library) && visibleEntries.length ? (
          <ul className="video-entry-list">
            {visibleEntries.map((entry) => {
              const saved = entry.kind === "video" ? progress[entry.path]?.seconds || 0 : 0;
              const playing = entry.kind === "video" && selected?.path === entry.path;
              const isFavorite = entry.kind === "video" && favoritePaths.has(entry.path);
              const unavailable = "available" in entry && !entry.available;
              return (
                <li key={entry.path} className={entry.kind === "video" ? "has-favorite-action" : ""}>
                  <button
                    type="button"
                    className={`video-entry-open${playing ? " is-playing" : ""}`}
                    onClick={() => entry.kind === "directory" ? void loadDirectory(entry.path) : chooseVideo(entry)}
                    disabled={unavailable}
                  >
                    <span className="video-entry-icon">{entry.kind === "directory" ? <Folder size={20} /> : <Film size={19} />}</span>
                    <span className="video-entry-name"><strong>{entry.name}</strong><small>{entry.kind === "directory" ? "文件夹" : unavailable ? `${"folder" in entry && entry.folder ? entry.folder : "视频库"} · 文件已移动` : view === "favorites" ? `${"folder" in entry && entry.folder ? entry.folder : "视频库"} · ${entry.format}` : `${entry.format} · ${fmtBytes(entry.bytes)}`}</small></span>
                    {entry.kind === "directory" ? <ChevronRight size={17} /> : saved && !unavailable ? <span className="video-resume-mark">续播 {Math.floor(saved / 60)}:{String(saved % 60).padStart(2, "0")}</span> : !unavailable ? <Play size={16} /> : null}
                  </button>
                  {entry.kind === "video" ? (
                    <button
                      type="button"
                      className={`video-favorite-toggle${isFavorite ? " is-favorite" : ""}`}
                      onClick={() => void toggleFavorite(entry)}
                      disabled={Boolean(favoritePending)}
                      aria-label={isFavorite ? `取消收藏 ${entry.name}` : `收藏 ${entry.name}`}
                    >
                      <Star size={17} fill={isFavorite ? "currentColor" : "none"} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <footer><FolderOpen size={14} />MP4（H.264 + AAC）在 Mac、iPhone 和浏览器上最稳。</footer>
      </Card>
    </div>
  );
}
