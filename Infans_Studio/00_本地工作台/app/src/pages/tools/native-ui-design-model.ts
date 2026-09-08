export type NativeDesignDeviceId = "iphone15" | "ipad129";
export type NativeDesignPhoneScene = "chat" | "conversation" | "settings";
export type NativeDesignIpadScene = NativeDesignPhoneScene;
export type NativeDesignScene = NativeDesignIpadScene;
export type NativeDesignOrientation = "portrait" | "landscape";
export type NativeDesignMode = "baseline" | "candidate";

export type NativeDesignTokens = {
  density: number;
  sidebarWidth: number;
  topBarHeight: number;
  composerHeight: number;
  cornerRadius: number;
  accent: string;
  canvas: string;
};

export type NativeDesignLabState = {
  schemeName: string;
  mode: NativeDesignMode;
  selectedDevices: NativeDesignDeviceId[];
  orientation: NativeDesignOrientation;
  showSafeArea: boolean;
  showMeasurements: boolean;
  scenes: Record<NativeDesignDeviceId, NativeDesignScene>;
  tokens: NativeDesignTokens;
};

export type NativeDesignExport = {
  schema: "infans.native-ui-design.v2";
  savedAt: string;
  basis: "current-swiftui";
  note: string;
  state: NativeDesignLabState;
};

export const NATIVE_DESIGN_DEVICES = [
  { id: "iphone15", label: "iPhone 15", points: { portrait: [393, 852] as const, landscape: [852, 393] as const } },
  { id: "ipad129", label: "iPad Pro 12.9″ · 第四代", points: { portrait: [1024, 1366] as const, landscape: [1366, 1024] as const } },
] as const;

export const PHONE_SCENES: ReadonlyArray<{ id: NativeDesignPhoneScene; label: string }> = [
  { id: "chat", label: "聊天主界面" },
  { id: "conversation", label: "会话列表" },
  { id: "settings", label: "设置与连接" },
];

export const IPAD_SCENES: ReadonlyArray<{ id: NativeDesignIpadScene; label: string }> = [
  { id: "chat", label: "聊天主界面" },
  { id: "conversation", label: "会话列表" },
  { id: "settings", label: "设置与连接" },
];

export const NATIVE_BASELINE_TOKENS: NativeDesignTokens = {
  density: 1,
  sidebarWidth: 360,
  topBarHeight: 66,
  composerHeight: 94,
  cornerRadius: 18,
  accent: "#73d4b3",
  canvas: "#071916",
};

export const DEFAULT_NATIVE_DESIGN_STATE: NativeDesignLabState = {
  schemeName: "原生一代 · 交互设计二次迭代",
  mode: "candidate",
  selectedDevices: ["iphone15", "ipad129"],
  orientation: "landscape",
  showSafeArea: false,
  showMeasurements: true,
  scenes: {
    iphone15: "chat",
    ipad129: "chat",
  },
  tokens: structuredClone(NATIVE_BASELINE_TOKENS),
};

const DEVICE_IDS = new Set<NativeDesignDeviceId>(NATIVE_DESIGN_DEVICES.map((device) => device.id));
const PHONE_SCENE_IDS = new Set<NativeDesignPhoneScene>(PHONE_SCENES.map((scene) => scene.id));
const IPAD_SCENE_IDS = new Set<NativeDesignIpadScene>(IPAD_SCENES.map((scene) => scene.id));

function clamp(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function color(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function normalizeNativeDesignState(value: unknown): NativeDesignLabState {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_NATIVE_DESIGN_STATE);
  const input = value as Partial<NativeDesignLabState>;
  const inputScenes: Partial<Record<NativeDesignDeviceId, NativeDesignScene>> = input.scenes && typeof input.scenes === "object" ? input.scenes : {};
  const inputTokens: Partial<NativeDesignTokens> = input.tokens && typeof input.tokens === "object" ? input.tokens : {};
  const selectedDevices = Array.isArray(input.selectedDevices)
    ? [...new Set(input.selectedDevices.filter((id): id is NativeDesignDeviceId => DEVICE_IDS.has(id as NativeDesignDeviceId)))]
    : DEFAULT_NATIVE_DESIGN_STATE.selectedDevices;

  return {
    schemeName: typeof input.schemeName === "string" ? input.schemeName.slice(0, 48) : DEFAULT_NATIVE_DESIGN_STATE.schemeName,
    mode: input.mode === "baseline" || input.mode === "candidate" ? input.mode : DEFAULT_NATIVE_DESIGN_STATE.mode,
    selectedDevices: selectedDevices.length ? selectedDevices : ["iphone15"],
    orientation: input.orientation === "portrait" ? "portrait" : "landscape",
    showSafeArea: input.showSafeArea === true,
    showMeasurements: input.showMeasurements !== false,
    scenes: {
      iphone15: PHONE_SCENE_IDS.has(inputScenes.iphone15 as NativeDesignPhoneScene) ? inputScenes.iphone15 as NativeDesignPhoneScene : DEFAULT_NATIVE_DESIGN_STATE.scenes.iphone15,
      ipad129: IPAD_SCENE_IDS.has(inputScenes.ipad129 as NativeDesignIpadScene) ? inputScenes.ipad129 as NativeDesignIpadScene : DEFAULT_NATIVE_DESIGN_STATE.scenes.ipad129,
    },
    tokens: {
      density: clamp(inputTokens.density, NATIVE_BASELINE_TOKENS.density, 0.82, 1.18),
      sidebarWidth: clamp(inputTokens.sidebarWidth, NATIVE_BASELINE_TOKENS.sidebarWidth, 280, 440),
      topBarHeight: clamp(inputTokens.topBarHeight, NATIVE_BASELINE_TOKENS.topBarHeight, 48, 82),
      composerHeight: clamp(inputTokens.composerHeight, NATIVE_BASELINE_TOKENS.composerHeight, 70, 124),
      cornerRadius: clamp(inputTokens.cornerRadius, NATIVE_BASELINE_TOKENS.cornerRadius, 10, 30),
      accent: color(inputTokens.accent, NATIVE_BASELINE_TOKENS.accent),
      canvas: color(inputTokens.canvas, NATIVE_BASELINE_TOKENS.canvas),
    },
  };
}

export function createNativeDesignExport(state: NativeDesignLabState, savedAt = new Date().toISOString()): NativeDesignExport {
  return {
    schema: "infans.native-ui-design.v2",
    savedAt,
    basis: "current-swiftui",
    note: "当前原生基准来自现有 SwiftUI 与同型号模拟器；候选调整仍以真机验收为准。",
    state: normalizeNativeDesignState(state),
  };
}
