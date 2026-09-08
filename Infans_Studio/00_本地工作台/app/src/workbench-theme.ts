import { BASE_THEME_TOKENS } from './workbench-theme-tokens.mjs';
import { DEFAULT_SECRETARY_ID, normalizeSecretaryId } from "./secretary-identity.mjs";

export type PageScene = {
  image: string;
  position: string;
  shade?: string;
};

export const THEME_STORAGE_KEY = "infans-workbench-theme";
export const THEME_SCHEME_STORAGE_KEY = "infans-workbench-theme-scheme";
export const THEME_COLOR_STORAGE_KEY = "infans-workbench-theme-color";

const NIGHT_SCENES: Record<string, PageScene> = {
  "/": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: "linear-gradient(90deg,rgba(4,10,13,.68) 0%,rgba(4,10,13,.55) 50%,rgba(4,10,13,.18) 69%,rgba(4,10,13,.06) 100%)" },
  "/schedule": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
  "/projects": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
  "/health": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
  "/languages": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: "linear-gradient(90deg,rgba(4,10,13,.97) 0%,rgba(5,12,15,.9) 34%,rgba(5,12,15,.52) 62%,rgba(4,10,13,.14) 100%)" },
  "/topics": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: "linear-gradient(90deg,rgba(4,10,13,.96) 0%,rgba(5,12,15,.88) 36%,rgba(5,12,15,.48) 64%,rgba(4,10,13,.16) 100%)" },
  "/library": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
  "/markets": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
  "/markets/assets": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
  "/tools": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
};

const DAY_SHADE = "linear-gradient(90deg,rgba(238,243,240,.96) 0%,rgba(238,243,240,.90) 37%,rgba(238,243,240,.64) 62%,rgba(238,243,240,.18) 100%)";
const DAY_SHADE_SOFT = "linear-gradient(90deg,rgba(238,243,240,.91) 0%,rgba(238,243,240,.77) 48%,rgba(238,243,240,.28) 70%,rgba(238,243,240,.08) 100%)";

const DAY_SCENES: Record<string, PageScene> = {
  "/": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE_SOFT },
  "/schedule": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE },
  "/projects": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE },
  "/health": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE },
  "/languages": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE },
  "/topics": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE },
  "/library": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE_SOFT },
  "/markets": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE },
  "/markets/assets": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE_SOFT },
  "/tools": { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%", shade: DAY_SHADE },
};

export type WorkbenchThemeIcon = "moon" | "sun";

function defineTheme<const Id extends string, const Icon extends WorkbenchThemeIcon>(theme: {
  id: Id;
  name: string;
  fullName: string;
  color: string;
  colorScheme: "dark" | "light";
  icon: Icon;
  cssSelector: string;
  scenes: Record<string, PageScene>;
}) {
  return theme;
}

/**
 * 主题名称与场景注册表。颜色角色由 workbench-theme-tokens.mjs 提供，个人方案由 workbench-appearance.mjs 派生。
 * 新增模式必须同时补齐颜色、场景、偏好校验和默认方案；普通个性化请保存方案。
 */
export const WORKBENCH_THEMES = [
  defineTheme({
    id: "night",
    name: "玄夜",
    fullName: "玄夜仙境 · 玉夜冷青",
    color: BASE_THEME_TOKENS.night["--bg"],
    colorScheme: "dark",
    icon: "moon",
    cssSelector: ":root",
    scenes: NIGHT_SCENES,
  }),
  defineTheme({
    id: "day",
    name: "晴岚",
    fullName: "晴岚仙境 · 云白玉青",
    color: BASE_THEME_TOKENS.day["--bg"],
    colorScheme: "light",
    icon: "sun",
    cssSelector: ':root[data-theme="day"]',
    scenes: DAY_SCENES,
  }),
] as const;

export type WorkbenchTheme = (typeof WORKBENCH_THEMES)[number]["id"];
export type WorkbenchThemeDefinition = (typeof WORKBENCH_THEMES)[number];

export const DEFAULT_WORKBENCH_THEME: WorkbenchTheme = "night";
export const THEME_IDS = WORKBENCH_THEMES.map((theme) => theme.id) as WorkbenchTheme[];

const THEME_BY_ID = Object.fromEntries(
  WORKBENCH_THEMES.map((theme) => [theme.id, theme]),
) as Record<WorkbenchTheme, WorkbenchThemeDefinition>;

export const THEME_META = Object.fromEntries(
  WORKBENCH_THEMES.map(({ id, name, fullName, color, colorScheme, icon, cssSelector }) => [
    id,
    { name, fullName, color, colorScheme, icon, cssSelector },
  ]),
) as Record<WorkbenchTheme, Omit<WorkbenchThemeDefinition, "id" | "scenes">>;

export const PAGE_SCENES_BY_THEME = Object.fromEntries(
  WORKBENCH_THEMES.map(({ id, scenes }) => [id, scenes]),
) as Record<WorkbenchTheme, Record<string, PageScene>>;

export const SECRETARY_HOME_SCENES_BY_THEME = {
  night: {
    yinyue: { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
    meining: { image: "/theme/avatar-meining-public.svg", position: "50% 50%" },
  },
  day: {
    yinyue: { image: "/theme/avatar-yinyue-public.svg", position: "50% 50%" },
    meining: { image: "/theme/avatar-meining-public.svg", position: "50% 50%" },
  },
} as const;

export function isWorkbenchTheme(value: unknown): value is WorkbenchTheme {
  return typeof value === "string" && Object.hasOwn(THEME_BY_ID, value);
}

export function getThemeDefinition(theme: WorkbenchTheme): WorkbenchThemeDefinition {
  return THEME_BY_ID[theme] || THEME_BY_ID[DEFAULT_WORKBENCH_THEME];
}

export function getNextTheme(theme: WorkbenchTheme): WorkbenchTheme {
  const index = Math.max(0, THEME_IDS.indexOf(theme));
  return THEME_IDS[(index + 1) % THEME_IDS.length] || DEFAULT_WORKBENCH_THEME;
}

export function readInitialTheme(): WorkbenchTheme {
  const applied = document.documentElement.dataset.theme;
  if (isWorkbenchTheme(applied)) return applied;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isWorkbenchTheme(stored) ? stored : DEFAULT_WORKBENCH_THEME;
  } catch {
    return DEFAULT_WORKBENCH_THEME;
  }
}

export function applyWorkbenchTheme(theme: WorkbenchTheme) {
  const definition = getThemeDefinition(theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = definition.colorScheme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", definition.color);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.localStorage.setItem(THEME_SCHEME_STORAGE_KEY, definition.colorScheme);
    window.localStorage.setItem(THEME_COLOR_STORAGE_KEY, definition.color);
  } catch {
    // 私密浏览或受限 WebView 仍可在当前会话切换。
  }
}

export function getPageScene(theme: WorkbenchTheme, path: string, secretaryId: string = DEFAULT_SECRETARY_ID): PageScene {
  if (path === "/") {
    const normalized = normalizeSecretaryId(secretaryId) || DEFAULT_SECRETARY_ID;
    return SECRETARY_HOME_SCENES_BY_THEME[theme][normalized as keyof (typeof SECRETARY_HOME_SCENES_BY_THEME)[WorkbenchTheme]]
      || SECRETARY_HOME_SCENES_BY_THEME[theme][DEFAULT_SECRETARY_ID];
  }
  return PAGE_SCENES_BY_THEME[theme][path] || PAGE_SCENES_BY_THEME[theme]["/"];
}

export function getThemeSceneImages(theme: WorkbenchTheme): string[] {
  return [...new Set([
    ...Object.values(PAGE_SCENES_BY_THEME[theme]).map((scene) => scene.image),
    ...Object.values(SECRETARY_HOME_SCENES_BY_THEME[theme]).map((scene) => scene.image),
  ])];
}
