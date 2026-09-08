export type SidebarPetPosition = { x: number; y: number };

export type SidebarPetPointer = {
  pointerId: number;
  isPrimary: boolean;
  button: number;
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
};

export const SIDEBAR_PET_POSITION_KEY = "infans-sidebar-pet-position-v1";
export const DEFAULT_SIDEBAR_PET_POSITION: SidebarPetPosition = { x: 0, y: 0.5 };

/** 快速连点头像只允许第一次改变侧栏，避免显隐来回切换造成整页抖动。 */
export function createSidebarVisibilityGate(options: {
  onChange: (hidden: boolean) => void;
  cooldownMs?: number;
  now?: () => number;
}) {
  const cooldownMs = options.cooldownMs ?? 700;
  const now = options.now ?? (() => performance.now());
  let readyAt = -Infinity;
  return (hidden: boolean) => {
    const at = now();
    if (at < readyAt) return false;
    readyAt = at + cooldownMs;
    options.onChange(hidden);
    return true;
  };
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

export function normalizeSidebarPetPosition(pointer: Pick<SidebarPetPointer, "clientX" | "clientY" | "viewportWidth" | "viewportHeight">, size = 56): SidebarPetPosition {
  const usableWidth = Math.max(1, pointer.viewportWidth - size);
  const usableHeight = Math.max(1, pointer.viewportHeight - size);
  return {
    x: clampUnit((pointer.clientX - size / 2) / usableWidth),
    y: clampUnit((pointer.clientY - size / 2) / usableHeight),
  };
}

export function sidebarPetPixels(position: SidebarPetPosition, viewportWidth: number, viewportHeight: number, size = 56) {
  return {
    left: Math.round(clampUnit(position.x) * Math.max(0, viewportWidth - size)),
    top: Math.round(clampUnit(position.y) * Math.max(0, viewportHeight - size)),
  };
}

export function readSidebarPetPosition(storage?: Pick<Storage, "getItem">): SidebarPetPosition {
  if (!storage) return DEFAULT_SIDEBAR_PET_POSITION;
  try {
    const parsed = JSON.parse(storage.getItem(SIDEBAR_PET_POSITION_KEY) || "null") as Partial<SidebarPetPosition> | null;
    if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number") return DEFAULT_SIDEBAR_PET_POSITION;
    return { x: clampUnit(parsed.x), y: clampUnit(parsed.y) };
  } catch {
    return DEFAULT_SIDEBAR_PET_POSITION;
  }
}

export function writeSidebarPetPosition(position: SidebarPetPosition, storage?: Pick<Storage, "setItem">) {
  if (!storage) return;
  try { storage.setItem(SIDEBAR_PET_POSITION_KEY, JSON.stringify(position)); }
  catch { /* Safari 存储受限时仍可在当前页面拖动。 */ }
}

export function createSidebarPetDragController(options: {
  onActivate: () => void;
  onMove: (position: SidebarPetPosition) => void;
  onCommit: (position: SidebarPetPosition) => void;
  dragThresholdPx?: number;
}) {
  const threshold = options.dragThresholdPx ?? 8;
  let active: (SidebarPetPointer & { dragging: boolean; lastPosition: SidebarPetPosition }) | null = null;

  return {
    pointerDown(pointer: SidebarPetPointer) {
      if (!pointer.isPrimary || pointer.button !== 0 || active) return false;
      active = { ...pointer, dragging: false, lastPosition: normalizeSidebarPetPosition(pointer) };
      return true;
    },
    pointerMove(pointer: SidebarPetPointer) {
      if (!active || active.pointerId !== pointer.pointerId) return false;
      if (!active.dragging && Math.hypot(pointer.clientX - active.clientX, pointer.clientY - active.clientY) < threshold) return false;
      active.dragging = true;
      active.lastPosition = normalizeSidebarPetPosition(pointer);
      options.onMove(active.lastPosition);
      return true;
    },
    pointerUp(pointer: SidebarPetPointer) {
      if (!active || active.pointerId !== pointer.pointerId) return false;
      const completed = active;
      active = null;
      if (completed.dragging) options.onCommit(completed.lastPosition);
      else options.onActivate();
      return completed.dragging;
    },
    pointerCancel(pointerId: number) {
      if (active?.pointerId === pointerId) active = null;
    },
  };
}
