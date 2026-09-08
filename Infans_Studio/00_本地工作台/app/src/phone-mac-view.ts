export const PHONE_MAC_VIEW_STORAGE_KEY = "infans-phone-mac-view-v1";
export const PHONE_MAC_VIEW_WIDTH = 1440;
export const PHONE_MAC_FRAME_ID = "phone-mac-frame";
export const PHONE_MAC_HOST_CLIP_ID = "phone-mac-host-clip";
export const PHONE_MAC_HOST_CLIP_STYLE = "position:fixed;top:env(safe-area-inset-top,0px);right:env(safe-area-inset-right,0px);bottom:env(safe-area-inset-bottom,0px);left:env(safe-area-inset-left,0px);overflow:hidden;z-index:1;";

export const PHONE_VIEWPORT_CONTENT = "width=device-width, initial-scale=1.0, user-scalable=yes, viewport-fit=cover, interactive-widget=resizes-content";

type NavigatorIdentity = Pick<Navigator, "userAgent">;
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export type PhoneMacFrameBox = {
  width: number;
  height: number;
};

export function isIPhoneClient(identity: NavigatorIdentity = window.navigator) {
  return /iPhone|iPod/u.test(identity.userAgent || "");
}

export function isNestedBrowsingContext(view: Pick<Window, "self" | "top"> = window) {
  try {
    return view.self !== view.top;
  } catch {
    return true;
  }
}

export function readPhoneMacView(
  storage: StorageReader = window.localStorage,
  identity: NavigatorIdentity = window.navigator,
) {
  if (!isIPhoneClient(identity)) return false;
  try {
    return storage.getItem(PHONE_MAC_VIEW_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writePhoneMacView(enabled: boolean, storage: StorageWriter = window.localStorage) {
  try {
    storage.setItem(PHONE_MAC_VIEW_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Safari 存储受限时，仍允许本次页面切换。
  }
}

export function shouldMountPhoneMacHost(
  storage: StorageReader = window.localStorage,
  identity: NavigatorIdentity = window.navigator,
  view: Pick<Window, "self" | "top"> = window,
) {
  return readPhoneMacView(storage, identity) && !isNestedBrowsingContext(view);
}

export function phoneMacScale(deviceCssWidth: number) {
  return Math.min(1, Math.max(0.05, deviceCssWidth / PHONE_MAC_VIEW_WIDTH));
}

export function formatPhoneMacScale(scale: number) {
  return String(Math.round(scale * 1e5) / 1e5);
}

export function layoutPhoneMacFrame(box: PhoneMacFrameBox) {
  const scale = phoneMacScale(Math.max(1, box.width));
  return {
    scale,
    width: PHONE_MAC_VIEW_WIDTH,
    height: Math.max(1, Math.round(Math.max(1, box.height) / scale)),
  };
}

/** Mac 模式固定为横屏；外层仍是竖向坐标时，把桌面画布顺时针旋转一次。 */
export function orientPhoneMacFrameBox(box: PhoneMacFrameBox) {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  if (width >= height) return { box: { width, height }, rotation: 0 };
  return { box: { width: height, height: width }, rotation: 90 };
}

export function phoneMacFrameStyle(box: PhoneMacFrameBox) {
  const oriented = orientPhoneMacFrameBox(box);
  const layout = layoutPhoneMacFrame(oriented.box);
  const scale = formatPhoneMacScale(layout.scale);
  const transform = oriented.rotation === 90
    ? `translateX(${Math.max(1, box.width)}px) rotate(90deg) scale(${scale})`
    : `scale(${scale})`;
  return `position:absolute;left:0;top:0;border:0;margin:0;padding:0;width:${layout.width}px;height:${layout.height}px;transform:${transform};transform-origin:top left;z-index:1;`;
}

function readHostBox(view: Window, target: Document, clip: HTMLElement) {
  return {
    width: clip.clientWidth || target.documentElement.clientWidth || view.innerWidth,
    height: clip.clientHeight || target.documentElement.clientHeight || view.innerHeight,
  };
}

export function reloadAfterPhoneMacViewChange(enabled: boolean, view: Window = window) {
  try {
    if (!enabled && view.top && view.top !== view.self) {
      view.top.location.reload();
      return;
    }
  } catch {
    // 跨域 top 读不到时，退回当前页刷新。
  }
  view.location.reload();
}

/** 外层保留手机安全区；内层 iframe 是固定横屏的 1440px 桌面画布。 */
export function mountPhoneMacHost(view: Window = window, target: Document = document) {
  target.documentElement.dataset.phoneMacHost = "on";
  const viewport = target.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  viewport?.setAttribute("content", PHONE_VIEWPORT_CONTENT);
  const root = target.getElementById("root");
  if (root) root.hidden = true;
  let clip = target.getElementById(PHONE_MAC_HOST_CLIP_ID);
  let frame = target.getElementById(PHONE_MAC_FRAME_ID) as HTMLIFrameElement | null;
  if (!clip) {
    clip = target.createElement("div");
    clip.id = PHONE_MAC_HOST_CLIP_ID;
    target.body.appendChild(clip);
  }
  clip.style.cssText = PHONE_MAC_HOST_CLIP_STYLE;
  if (!frame) {
    frame = target.createElement("iframe");
    frame.id = PHONE_MAC_FRAME_ID;
    frame.title = "小秘书桌面视图";
    frame.setAttribute("allow", "autoplay; clipboard-read; clipboard-write; microphone; fullscreen");
    clip.appendChild(frame);
    frame.src = view.location.href;
  } else if (frame.parentElement !== clip) {
    clip.appendChild(frame);
  }
  const sync = () => {
    frame.style.cssText = phoneMacFrameStyle(readHostBox(view, target, clip));
  };
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
  sync();
  if (resizeObserver) resizeObserver.observe(clip);
  else view.addEventListener("resize", sync);
  return () => {
    resizeObserver?.disconnect();
    if (!resizeObserver) view.removeEventListener("resize", sync);
  };
}
