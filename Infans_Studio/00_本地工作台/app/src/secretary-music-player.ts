import { DEFAULT_MUSIC_VOLUME } from "./secretary-music-catalog.mjs";

export type MusicTrack = {
  kind: "track";
  id: string;
  name: string;
  title: string;
  path: string;
  folder: string;
  bytes: number;
  modifiedAt: string;
  format: string;
  browserReady: boolean;
  duration: number;
  available?: boolean;
};

export type MusicPlaybackMode = "list" | "repeat-one" | "shuffle";

export type MusicPlayerSnapshot = {
  track: MusicTrack | null;
  queue: MusicTrack[];
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  mode: MusicPlaybackMode;
  error: string;
};

type DefaultQueueSnapshot = { available: boolean; tracks: MusicTrack[]; selectedPath: string };

const VOLUME_STORAGE_KEY = "infans-music-volume";
const MODE_STORAGE_KEY = "infans-music-playback-mode";
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let snapshot: MusicPlayerSnapshot = {
  track: null,
  queue: [],
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: DEFAULT_MUSIC_VOLUME,
  mode: "list",
  error: "",
};

function update(next: Partial<MusicPlayerSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function readSavedVolume() {
  try {
    const value = Number(window.localStorage.getItem(VOLUME_STORAGE_KEY));
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_MUSIC_VOLUME;
  } catch {
    return DEFAULT_MUSIC_VOLUME;
  }
}

function readSavedMode(): MusicPlaybackMode {
  try {
    const mode = window.localStorage.getItem(MODE_STORAGE_KEY);
    return mode === "repeat-one" || mode === "shuffle" ? mode : "list";
  } catch {
    return "list";
  }
}

function trackUrl(trackPath: string) {
  return `/api/tools/music/stream?path=${encodeURIComponent(trackPath)}`;
}

function randomQueueTrack(queue: MusicTrack[], currentPath: string) {
  if (queue.length <= 1) return queue[0];
  const choices = queue.filter((track) => track.path !== currentPath);
  return choices[Math.floor(Math.random() * choices.length)];
}

function getAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "metadata";
  audio.volume = readSavedVolume();
  update({ volume: audio.volume, mode: readSavedMode() });
  audio.addEventListener("play", () => update({ playing: true, error: "" }));
  audio.addEventListener("pause", () => update({ playing: false }));
  audio.addEventListener("timeupdate", () => update({ currentTime: audio?.currentTime || 0 }));
  audio.addEventListener("durationchange", () => {
    if (audio && Number.isFinite(audio.duration)) update({ duration: audio.duration });
  });
  audio.addEventListener("volumechange", () => {
    if (audio) update({ volume: audio.volume });
  });
  audio.addEventListener("error", () => update({ playing: false, error: "这首音乐暂时读不到" }));
  audio.addEventListener("ended", () => {
    if (!snapshot.track) return;
    if (snapshot.mode === "repeat-one") {
      audio!.currentTime = 0;
      void audio!.play().catch(() => undefined);
      return;
    }
    void playAdjacentMusic(1).catch(() => undefined);
  });
  return audio;
}

export function subscribeMusicPlayer(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMusicPlayerSnapshot() {
  return snapshot;
}

export function setMusicQueue(queue: MusicTrack[]) {
  const available = queue.filter((track) => track.available !== false);
  update({ queue: available });
}

export function playMusicTrack(track: MusicTrack, queue?: MusicTrack[]) {
  const nextQueue = (queue || snapshot.queue).filter((item) => item.available !== false);
  const player = getAudio();
  if (snapshot.track?.path !== track.path || !player.src) {
    player.src = trackUrl(track.path);
    player.load();
    update({ track, queue: nextQueue.length ? nextQueue : [track], currentTime: 0, duration: track.duration || 0, error: "" });
  } else if (queue) {
    update({ queue: nextQueue });
  }
  return player.play();
}

export async function startMusicTrial() {
  const response = await fetch("/api/tools/music/default", { headers: { Accept: "application/json" } });
  const body = await response.json() as DefaultQueueSnapshot & { error?: string };
  if (!response.ok) throw new Error(body.error || "读不到音乐库");
  const track = body.tracks.find((item) => item.path === body.selectedPath) || body.tracks[0];
  if (!track) throw new Error("音乐库里还没有歌曲");
  return playMusicTrack(track, body.tracks);
}

export function toggleMusicPlayback() {
  const player = getAudio();
  if (player.paused) {
    if (snapshot.track) return playMusicTrack(snapshot.track);
    return startMusicTrial();
  }
  player.pause();
  return Promise.resolve();
}

export function playAdjacentMusic(direction: -1 | 1) {
  const queue = snapshot.queue;
  if (!queue.length) return Promise.reject(new Error("当前没有可播放的歌曲"));
  const currentPath = snapshot.track?.path || "";
  if (snapshot.mode === "shuffle" && direction === 1) {
    const random = randomQueueTrack(queue, currentPath);
    return random ? playMusicTrack(random) : Promise.reject(new Error("当前没有可播放的歌曲"));
  }
  const index = queue.findIndex((track) => track.path === currentPath);
  const nextIndex = (Math.max(index, 0) + direction + queue.length) % queue.length;
  return playMusicTrack(queue[nextIndex]);
}

export function setMusicPlaybackMode(mode: MusicPlaybackMode) {
  update({ mode });
  try { window.localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* 私密模式下只保留本次设置 */ }
}

export function seekMusic(seconds: number) {
  const player = getAudio();
  player.currentTime = Math.max(0, Math.min(seconds, Number.isFinite(player.duration) ? player.duration : snapshot.duration));
  update({ currentTime: player.currentTime });
}

export function setMusicVolume(volume: number) {
  const next = Math.max(0, Math.min(1, volume));
  const player = getAudio();
  player.volume = next;
  try { window.localStorage.setItem(VOLUME_STORAGE_KEY, String(next)); } catch { /* 私密模式下只保留本次音量 */ }
  update({ volume: next });
}
