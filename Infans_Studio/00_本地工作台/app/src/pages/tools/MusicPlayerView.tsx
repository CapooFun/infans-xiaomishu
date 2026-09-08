import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Folder, FolderOpen, HardDrive, ListMusic, ListPlus, Music2, Pause, Play, RefreshCw, Repeat1, Search, Shuffle, SkipBack, SkipForward, Volume2, X } from "lucide-react";
import { FANREN_MUSIC_TRACKS } from "../../secretary-music-catalog.mjs";
import {
  getMusicPlayerSnapshot,
  playAdjacentMusic,
  playMusicTrack,
  seekMusic,
  setMusicPlaybackMode,
  setMusicVolume,
  subscribeMusicPlayer,
  toggleMusicPlayback,
  type MusicTrack,
} from "../../secretary-music-player";
import { Card, Empty, Kicker, fmtBytes, jsonFetch } from "../../page-shared";
import { createToolSessionCache } from "../../tool-session-cache";

type MusicDirectory = { kind: "directory"; name: string; path: string };
type MusicEntry = MusicDirectory | MusicTrack;
type MusicLibrarySnapshot = { available: boolean; name: string; path: string; breadcrumbs: string[]; entries: MusicEntry[]; stale?: boolean; cacheWarning?: string };
type DefaultMusicSnapshot = { available: boolean; directory?: MusicLibrarySnapshot };
type MusicPlaylist = { id: string; name: string; createdAt: string; updatedAt: string; tracks: MusicTrack[] };
type MusicPlaylistsSnapshot = { playlists: MusicPlaylist[] };

const musicDirectoryCache = createToolSessionCache<string, MusicLibrarySnapshot>((folder, options) => jsonFetch<MusicLibrarySnapshot>(
  `/api/tools/music?path=${encodeURIComponent(folder)}${options.force ? "&refresh=1" : ""}`,
));
const musicDefaultCache = createToolSessionCache<"default", DefaultMusicSnapshot>((_, options) => jsonFetch<DefaultMusicSnapshot>(
  `/api/tools/music/default${options.force ? "?refresh=1" : ""}`,
));
const musicPlaylistsCache = createToolSessionCache<"playlists", MusicPlaylistsSnapshot>(() => jsonFetch<MusicPlaylistsSnapshot>("/api/tools/music/playlists"));
let lastMusicDirectoryPath = "";

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export default function MusicPlayerView({ active }: { active: boolean }) {
  const player = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayerSnapshot);
  const retryAttempt = useRef(0);
  const directoryRefreshTimer = useRef<number | null>(null);
  const [library, setLibrary] = useState<MusicLibrarySnapshot | null>(() => musicDirectoryCache.get(lastMusicDirectoryPath));
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>(() => musicPlaylistsCache.get("playlists")?.playlists || []);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [view, setView] = useState<"library" | "playlists">("library");
  const [query, setQuery] = useState("");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);

  const selectedPlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId) || playlists[0] || null;
  const currentTrack = player.track;
  const knownArtwork = FANREN_MUSIC_TRACKS.find((track) => track.title === currentTrack?.title);

  const loadDirectory = async (nextPath = library?.path || "", options: { force?: boolean; background?: boolean; maxAgeMs?: number; followup?: boolean } = {}) => {
    if (!options.background) setLoading(true);
    if (!options.background) setError("");
    try {
      const next = await musicDirectoryCache.load(nextPath, { force: options.force, maxAgeMs: options.maxAgeMs });
      lastMusicDirectoryPath = next.path;
      musicDirectoryCache.set(next.path, next);
      setLibrary(next);
      setQuery("");
      setError(next.cacheWarning || (next.stale ? "正在显示上次成功读取的音乐目录，并在后台检查更新" : ""));
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
      setError(reason instanceof Error ? reason.message : "读不到音乐库");
      retryAttempt.current += 1;
      setRetryRevision((revision) => revision + 1);
    } finally {
      if (!options.background) setLoading(false);
    }
  };

  const loadPlaylists = async (force = false) => {
    try {
      const next = await musicPlaylistsCache.load("playlists", { force });
      setPlaylists(next.playlists);
      setSelectedPlaylistId((current) => next.playlists.some((playlist) => playlist.id === current) ? current : next.playlists[0]?.id || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读不到我的歌单");
    }
  };

  const loadDefaultDirectory = async (options: { force?: boolean; background?: boolean } = {}) => {
    if (!options.background) setLoading(true);
    if (!options.background) setError("");
    try {
      const preferred = await musicDefaultCache.load("default", { force: options.force });
      if (preferred.directory) {
        lastMusicDirectoryPath = preferred.directory.path;
        musicDirectoryCache.set(preferred.directory.path, preferred.directory);
        setLibrary(preferred.directory);
        setError(preferred.directory.cacheWarning || (preferred.directory.stale ? "正在显示上次成功读取的音乐目录，并在后台检查更新" : ""));
      } else await loadDirectory("", options);
      setQuery("");
      retryAttempt.current = 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读不到音乐库");
      retryAttempt.current += 1;
      setRetryRevision((revision) => revision + 1);
    } finally {
      if (!options.background) setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    void loadPlaylists();
    if (library) void loadDirectory(library.path, { background: true, maxAgeMs: 30_000 });
    else void loadDefaultDirectory();
  }, [active]);

  useEffect(() => {
    if (!active || library || !error) return;
    const delays = [1_500, 4_000, 10_000];
    if (retryAttempt.current > delays.length) return;
    const index = Math.max(0, Math.min(retryAttempt.current - 1, delays.length - 1));
    const timer = window.setTimeout(() => { void loadDefaultDirectory({ background: true }); }, delays[index]);
    return () => window.clearTimeout(timer);
  }, [active, Boolean(library), retryRevision]);

  useEffect(() => () => {
    if (directoryRefreshTimer.current !== null) window.clearTimeout(directoryRefreshTimer.current);
  }, []);

  const folderTracks = useMemo(() => (library?.entries || []).filter((entry): entry is MusicTrack => entry.kind === "track"), [library]);
  const visibleEntries = useMemo(() => {
    const source: MusicEntry[] = view === "library" ? library?.entries || [] : selectedPlaylist?.tracks || [];
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return source;
    return source.filter((entry) => entry.name.toLocaleLowerCase("zh-CN").includes(needle)
      || (entry.kind === "track" && (entry.title.toLocaleLowerCase("zh-CN").includes(needle) || entry.folder.toLocaleLowerCase("zh-CN").includes(needle))));
  }, [library, query, selectedPlaylist, view]);

  const playlistWrite = async (method: "POST" | "PUT", body: Record<string, unknown>) => {
    if (pending) return null;
    setPending(true);
    setError("");
    try {
      const next = await jsonFetch<MusicPlaylistsSnapshot>("/api/tools/music/playlists", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      musicPlaylistsCache.set("playlists", next);
      setPlaylists(next.playlists);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "歌单操作失败");
      return null;
    } finally {
      setPending(false);
    }
  };

  const createPlaylist = async () => {
    const name = newPlaylistName.trim();
    if (!name) return;
    const next = await playlistWrite("POST", { name });
    if (!next) return;
    const created = next.playlists.find((playlist) => playlist.name === name);
    if (created) setSelectedPlaylistId(created.id);
    setNewPlaylistName("");
    setView("playlists");
  };

  const addToPlaylist = async (track: MusicTrack) => {
    if (!selectedPlaylist) {
      setView("playlists");
      setError("先新建一个歌单，再把歌曲放进去");
      return;
    }
    await playlistWrite("PUT", { playlistId: selectedPlaylist.id, action: "add", path: track.path });
  };

  const changePlaylistTrack = async (track: MusicTrack, action: "remove" | "move", toIndex?: number) => {
    if (!selectedPlaylist) return;
    await playlistWrite("PUT", { playlistId: selectedPlaylist.id, action, path: track.path, toIndex });
  };

  const openBreadcrumb = (index: number) => {
    const nextPath = index < 0 ? "" : (library?.breadcrumbs || []).slice(0, index + 1).join("/");
    void loadDirectory(nextPath);
  };

  const chooseTrack = (track: MusicTrack, queue: MusicTrack[]) => {
    setError("");
    void playMusicTrack(track, queue.filter((item) => item.available !== false)).catch(() => setError("这首音乐暂时无法播放"));
  };

  const modeButton = (mode: "repeat-one" | "shuffle") => {
    setMusicPlaybackMode(player.mode === mode ? "list" : mode);
  };

  return (
    <div className="music-player-page">
      <Card className="music-now-card">
        <div className={`music-disc${player.playing ? " is-playing" : ""}`}>
          {knownArtwork ? (
            <span style={{ "--music-art-position": knownArtwork.artworkPosition, "--music-art-scale": knownArtwork.artworkScale ?? 1 } as React.CSSProperties}>
              <img src={knownArtwork.artwork} alt={`${currentTrack?.title} · ${knownArtwork.artworkAlt}`} />
            </span>
          ) : <span className="music-disc-placeholder"><Music2 size={28} /><b>{currentTrack?.title.slice(0, 1) || "乐"}</b></span>}
        </div>
        <div className="music-now-copy">
          <Kicker>{currentTrack?.folder || "音乐库"}</Kicker>
          <h2>{currentTrack?.title || "选一首开始听"}</h2>
          <p>{player.error || error || (currentTrack ? "道阻且长，听一会儿再出发。" : "打开右侧文件夹，音乐可以放在任意层级。")}</p>
          <div className="music-progress-row">
            <span>{formatTime(player.currentTime)}</span>
            <input type="range" min="0" max={Math.max(player.duration, currentTrack?.duration || 0, 1)} step="1" value={Math.min(player.currentTime, Math.max(player.duration, currentTrack?.duration || 0, 1))} onChange={(event) => seekMusic(Number(event.target.value))} aria-label="播放进度" style={{ "--range-progress": `${Math.min(100, player.currentTime / Math.max(player.duration, currentTrack?.duration || 0, 1) * 100)}%` } as React.CSSProperties} />
            <span>{formatTime(player.duration || currentTrack?.duration || 0)}</span>
          </div>
          <div className="music-control-row">
            <div className="music-control-actions">
              <button type="button" onClick={() => void playAdjacentMusic(-1)} aria-label="上一首" disabled={!player.queue.length}><SkipBack size={19} /></button>
              <button className="music-play-button" type="button" onClick={() => void toggleMusicPlayback()} aria-label={player.playing ? "暂停" : "播放"}>
                {player.playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
              </button>
              <button type="button" onClick={() => void playAdjacentMusic(1)} aria-label="下一首" disabled={!player.queue.length}><SkipForward size={19} /></button>
              <button type="button" className={player.mode === "repeat-one" ? "is-active" : ""} onClick={() => modeButton("repeat-one")} aria-label="单曲循环" aria-pressed={player.mode === "repeat-one"}><Repeat1 size={18} /></button>
              <button type="button" className={player.mode === "shuffle" ? "is-active" : ""} onClick={() => modeButton("shuffle")} aria-label="随机播放" aria-pressed={player.mode === "shuffle"}><Shuffle size={18} /></button>
            </div>
          </div>
          <label className="music-volume"><Volume2 size={17} aria-hidden="true" /><input type="range" min="0" max="1" step="0.01" value={player.volume} onChange={(event) => setMusicVolume(Number(event.target.value))} aria-label="音量" style={{ "--range-progress": `${player.volume * 100}%` } as React.CSSProperties} /><span>{Math.round(player.volume * 100)}%</span></label>
          <div className="music-mode-status">{player.mode === "repeat-one" ? "正在单曲循环" : player.mode === "shuffle" ? "正在随机播放" : "按列表顺序播放"}</div>
        </div>
      </Card>

      <Card className="music-track-card">
        <header>
          <div>
            <Kicker>{view === "library" ? "音乐库" : "我的歌单"}</Kicker>
            {view === "library" ? (
              <nav className="music-breadcrumbs" aria-label="当前音乐文件夹">
                <button type="button" onClick={() => openBreadcrumb(-1)}><HardDrive size={14} />音乐库</button>
                {(library?.breadcrumbs || []).map((part, index) => <span key={`${part}-${index}`}><ChevronRight size={13} /><button type="button" onClick={() => openBreadcrumb(index)}>{part}</button></span>)}
              </nav>
            ) : <h3>{selectedPlaylist?.name || "建立第一张歌单"}</h3>}
          </div>
          <button type="button" className="music-refresh" onClick={() => view === "library" ? void loadDirectory(undefined, { force: true }) : void loadPlaylists(true)} disabled={loading || pending} aria-label="重新扫描音乐库"><RefreshCw size={16} className={loading ? "is-spinning" : ""} /></button>
        </header>

        <div className="music-view-tabs" role="tablist" aria-label="音乐列表">
          <button type="button" role="tab" aria-selected={view === "library"} className={view === "library" ? "is-active" : ""} onClick={() => { setView("library"); setQuery(""); }}><FolderOpen size={14} />资料库</button>
          <button type="button" role="tab" aria-selected={view === "playlists"} className={view === "playlists" ? "is-active" : ""} onClick={() => { setView("playlists"); setQuery(""); }}><ListMusic size={14} />我的歌单 {playlists.length}</button>
        </div>

        {view === "playlists" ? (
          <div className="music-playlist-tools">
            <div className="music-playlist-picker">
              {playlists.map((playlist) => <button type="button" key={playlist.id} className={selectedPlaylist?.id === playlist.id ? "is-active" : ""} onClick={() => setSelectedPlaylistId(playlist.id)}>{playlist.name}<small>{playlist.tracks.length}</small></button>)}
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void createPlaylist(); }}><input value={newPlaylistName} maxLength={40} onChange={(event) => setNewPlaylistName(event.target.value)} placeholder="新歌单名称" /><button type="submit" disabled={!newPlaylistName.trim() || pending}>新建</button></form>
          </div>
        ) : null}

        <label className="music-search"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "library" ? "在当前文件夹里查找" : "在当前歌单里查找"} /></label>

        {error && !currentTrack ? <p className="music-library-error">{error}</p> : null}
        {!loading && !visibleEntries.length ? <Empty>{query ? "没有匹配的音乐" : view === "library" ? "这个文件夹还没有音乐" : selectedPlaylist ? "歌单还是空的。回到资料库，把喜欢的歌加进来。" : "输入名字，新建第一张歌单。"}</Empty> : null}
        {visibleEntries.length ? (
          <ol className="music-track-list music-library-list">
            {visibleEntries.map((entry, index) => {
              const selected = entry.kind === "track" && currentTrack?.path === entry.path;
              const playlistQueue = (selectedPlaylist?.tracks || []).filter((track) => track.available !== false);
              return (
                <li key={entry.path}>
                  <button type="button" className={selected ? "active" : ""} disabled={entry.kind === "track" && entry.available === false} onClick={() => entry.kind === "directory" ? void loadDirectory(entry.path) : chooseTrack(entry, view === "library" ? folderTracks : playlistQueue)}>
                    <span>{entry.kind === "directory" ? <Folder size={17} /> : String(index + 1).padStart(2, "0")}</span>
                    <span className="music-entry-name"><strong>{entry.kind === "directory" ? entry.name : entry.title}</strong><small>{entry.kind === "directory" ? "文件夹" : entry.available === false ? `${entry.folder} · 文件已移动` : `${entry.format} · ${fmtBytes(entry.bytes)}`}</small></span>
                    <i aria-hidden="true">{entry.kind === "directory" ? <ChevronRight size={16} /> : selected && player.playing ? <Pause size={14} /> : <Play size={14} />}</i>
                  </button>
                  {entry.kind === "track" && view === "library" ? <button type="button" className="music-row-action" onClick={() => void addToPlaylist(entry)} disabled={pending} aria-label={`把 ${entry.title} 加入${selectedPlaylist?.name || "歌单"}`}><ListPlus size={16} /></button> : null}
                  {entry.kind === "track" && view === "playlists" ? <span className="music-sort-actions"><button type="button" onClick={() => void changePlaylistTrack(entry, "move", index - 1)} disabled={pending || index === 0} aria-label={`上移 ${entry.title}`}><ArrowUp size={14} /></button><button type="button" onClick={() => void changePlaylistTrack(entry, "move", index + 1)} disabled={pending || index === visibleEntries.length - 1} aria-label={`下移 ${entry.title}`}><ArrowDown size={14} /></button><button type="button" onClick={() => void changePlaylistTrack(entry, "remove")} disabled={pending} aria-label={`从歌单移除 ${entry.title}`}><X size={14} /></button></span> : null}
                </li>
              );
            })}
          </ol>
        ) : null}
        <footer><FolderOpen size={14} />音乐可以放进任意层级；MP3、M4A、FLAC 最稳。</footer>
      </Card>
      <p className="music-trial-note">音频文件保存在 NAS，歌单与播放列表由小秘书本地管理。</p>
    </div>
  );
}
