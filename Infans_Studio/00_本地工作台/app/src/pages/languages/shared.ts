import type { JapaneseExamKind, LanguageReactorItem } from "../../types";

export type HubSection = "course" | "exploration" | "vocabulary" | "grammar" | "reading" | "collection";
export type ExamScope = {
  kind: JapaneseExamKind;
  level: string;
  track: string;
  label: string;
  mode: string;
  pointIds?: string[];
  passageId?: string;
};

export type JapaneseExamBootstrap = {
  mode: "japaneseExam";
  suggestedScope: { level: string; track: string; label: string };
  examSessionId?: string | null;
  seedAssistant?: string;
  seedUser?: string;
};

export const ALL_LEVELS = ["N5", "N4", "N3", "N2"] as const;
export const ANKIWEB_DECKS_URL = "https://ankiweb.net/decks";

export const EXAM_MODE_META: Array<{ kind: JapaneseExamKind; label: string; blurb: string }> = [
  { kind: "special", label: "专项练习", blurb: "就地多选级别" },
  { kind: "mistake", label: "错题练习", blurb: "就地多选级别" },
];

export function mediaOffset(value: number | null) {
  if (value === null) return "";
  const total = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function usableReactorTranslation(item: LanguageReactorItem) {
  const translation = item.translation?.trim() || "";
  if (translation && !/^[（(][^）)]+[）)]\s*$/.test(translation)) return translation;
  if (item.wordTranslations?.length) return item.wordTranslations.join("；");
  return translation || "暂无翻译";
}

export function pct(n: number | undefined) {
  return `${Math.round((Number(n) || 0) * 1000) / 10}%`;
}

export function lvLabel(lv = 0) {
  if (lv >= 3) return "精通";
  if (lv === 2) return "掌握";
  if (lv === 1) return "入门";
  return "门外汉";
}

export function modeLabel(kind: JapaneseExamKind) {
  return EXAM_MODE_META.find((item) => item.kind === kind)?.label || "练习";
}

export function modeSeed(kind: JapaneseExamKind, level: string) {
  if (kind === "special") {
    return `专项练习：在文法看板里选卡开考，或按级别随机抽卡。`;
  }
  if (kind === "mistake") {
    return `错题练习：按级别重做错题；未选级别会默认全选。`;
  }
  return `按现在页面，建议考 **${level}**。`;
}
