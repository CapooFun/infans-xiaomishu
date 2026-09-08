export const MOBILE_VIDEO_CONTROLS_QUERY = "(any-pointer: coarse), (max-width: 1024px)";

export type VideoRotation = 0 | 90 | 180 | 270;

export function getEffectiveVideoAspectRatio(width: number, height: number, rotation: VideoRotation) {
  const naturalRatio = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 16 / 9;
  return rotation === 90 || rotation === 270 ? 1 / naturalRatio : naturalRatio;
}

type VideoFullscreenTarget = {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};

type StageFullscreenTarget = {
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => void;
};

export function requestVideoFullscreen(
  video: VideoFullscreenTarget,
  stage: StageFullscreenTarget,
  useInAppFullscreen: () => void,
) {
  // Safari 的视频全屏必须在用户点击的同步链上直接调用。
  if (video.webkitEnterFullscreen && video.webkitSupportsFullscreen !== false) {
    try {
      video.webkitEnterFullscreen();
      return;
    } catch {
      // 当前播放状态不允许时，在同一次用户手势中继续尝试标准 API。
    }
  }

  try {
    if (stage.requestFullscreen) {
      void stage.requestFullscreen().catch(useInAppFullscreen);
    } else if (stage.webkitRequestFullscreen) {
      stage.webkitRequestFullscreen();
    } else {
      useInAppFullscreen();
    }
  } catch {
    useInAppFullscreen();
  }
}

export function clampVideoTime(currentTime: number, duration: number, offset: number) {
  const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(currentTime + offset, upperBound));
}

export function formatVideoTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
