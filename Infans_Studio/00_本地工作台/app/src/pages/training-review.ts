import type { HealthSectionData, WriteAction } from "../types";
import type { CoachReviewModel } from "./coach-review";

/** 与 vault-paths.mjs 的 TRAINING_REVIEW 保持一致；前端不直接依赖 server 模块。 */
export const TRAINING_REVIEW_PATH = "40_身心健康/体魄/训练复盘.md";

export const TRAINING_REVIEW_APPEND_ANCHOR = "<!-- INFANS_TRAINING_REVIEW_APPEND -->";

/** 默认同步约定节奏：约 3 周。 */
export const DEFAULT_REVIEW_DAYS = 21;

/** 训练计划「同步约定」点名的主项（先匹配上斜，避免误入平板）。 */
const MAIN_LIFT_PATTERNS: Array<{ label: string; test: (name: string) => boolean }> = [
  { label: "上斜卧推", test: (name) => /上斜/.test(name) && /卧|推/.test(name) },
  { label: "杠铃平板卧推", test: (name) => /卧推/.test(name) && !/上斜/.test(name) },
  { label: "引体向上", test: (name) => /引体/.test(name) },
];

export type TrainingReviewDraftInput = {
  today: string;
  /** 周期天数，默认 21；夹在 14–28。 */
  days?: number;
  trainingVolume?: HealthSectionData["trainingVolume"] | null;
  measurements?: HealthSectionData["measurements"] | null;
  /** 有客观睡眠分钟再传；缺则写（待填）。 */
  sleepMinutes?: number | null;
  /** 调用方传入已算好的复盘模型（避免本模块再依赖 coach-review 运行时）。 */
  reviewModel: CoachReviewModel;
};

export type TrainingReviewDraft = {
  periodStart: string;
  periodEnd: string;
  heading: string;
  sectionMarkdown: string;
};

function clampDays(days: number | undefined) {
  const n = Number(days);
  if (!Number.isFinite(n)) return DEFAULT_REVIEW_DAYS;
  return Math.min(28, Math.max(14, Math.round(n)));
}

/** 东京日历日加减，输入/输出均为 YYYY-MM-DD。 */
export function shiftTokyoDay(day: string, deltaDays: number) {
  const base = new Date(`${day}T12:00:00+09:00`);
  base.setDate(base.getDate() + deltaDays);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, "0");
  const d = String(base.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function pickMainLifts(series: HealthSectionData["trainingVolume"]["topSetSeries"] | undefined, periodStart: string, periodEnd: string) {
  const rows: Array<{ label: string; topSet: string; date: string }> = [];
  const list = series ?? [];

  for (const pattern of MAIN_LIFT_PATTERNS) {
    let best: { label: string; topSet: string; date: string; weightKg: number } | null = null;
    for (const item of list) {
      if (!pattern.test(item.name)) continue;
      for (const point of item.points ?? []) {
        if (point.date < periodStart || point.date > periodEnd) continue;
        if (!point.topSet?.trim()) continue;
        const weight = point.weightKg ?? (point.bodyweight ? 0 : -1);
        if (weight < 0 && !point.bodyweight) continue;
        if (!best || point.date > best.date || (point.date === best.date && weight > best.weightKg)) {
          best = { label: item.name, topSet: point.topSet.trim(), date: point.date, weightKg: weight };
        }
      }
    }
    if (best) {
      rows.push({ label: best.label, topSet: best.topSet, date: best.date });
    } else {
      rows.push({ label: pattern.label, topSet: "（待填）", date: "" });
    }
  }
  return rows;
}

function pickLatestMeasurement(
  measurements: HealthSectionData["measurements"] | null | undefined,
  periodStart: string,
  periodEnd: string,
) {
  const inPeriod = (measurements ?? []).filter((row) => row.date >= periodStart && row.date <= periodEnd);
  const withWeight = [...inPeriod].reverse().find((row) => row.weightKg != null);
  const withWaist = [...inPeriod].reverse().find((row) => row.waist != null);
  // 周期内没有则取全局最近一条，但仍标注日期，方便人工核对；没有就待填。
  const fallbackWeight = withWeight ?? [...(measurements ?? [])].reverse().find((row) => row.weightKg != null);
  const fallbackWaist = withWaist ?? [...(measurements ?? [])].reverse().find((row) => row.waist != null);
  return {
    weight: fallbackWeight?.weightKg != null
      ? `${fallbackWeight.weightKg.toFixed(1)} kg（${fallbackWeight.date}${withWeight ? "" : " · 周期外最近"}）`
      : "（待填）",
    waist: fallbackWaist?.waist != null
      ? `${fallbackWaist.waist} cm（${fallbackWaist.date}${withWaist ? "" : " · 周期外最近"}）`
      : "（待填）",
  };
}

function formatSleep(sleepMinutes: number | null | undefined) {
  if (sleepMinutes == null || !Number.isFinite(sleepMinutes) || sleepMinutes <= 0) {
    return "（待填：客观睡眠未解析或本周期无数据；可写主观三档）";
  }
  const hours = (sleepMinutes / 60).toFixed(1);
  return `近一次可用约 ${hours} h/夜（来自 Apple 摘要分钟数；非月均，请人工核对）`;
}

/**
 * 拼一节周期复盘 Markdown（不含锚点）。
 * 缺数据写「（待填）」；不插值、不编造睡眠/体测。
 */
export function buildTrainingReviewDraft(input: TrainingReviewDraftInput): TrainingReviewDraft {
  const today = input.today;
  const days = clampDays(input.days);
  const periodEnd = today;
  const periodStart = shiftTokyoDay(today, -(days - 1));
  const heading = `## ${periodStart} ~ ${periodEnd}`;
  const model = input.reviewModel;
  const lifts = pickMainLifts(input.trainingVolume?.topSetSeries, periodStart, periodEnd);
  const body = pickLatestMeasurement(input.measurements, periodStart, periodEnd);

  const lines: string[] = [
    heading,
    "",
    "> 对齐训练计划「同步约定」。派生数字来自训练日志 / 三维；缺则（待填），不编造。",
    "",
    "### 主项数字",
    "",
    "| 动作 | 周期内最重一组 | 来源日 |",
    "|---|---|---|",
  ];
  for (const lift of lifts) {
    lines.push(`| ${lift.label} | ${lift.topSet} | ${lift.date || "—"} |`);
  }

  lines.push(
    "",
    "### 体测",
    "",
    `- 体重：${body.weight}`,
    `- 腰围：${body.waist}`,
    "",
    "### 睡眠",
    "",
    `- ${formatSleep(input.sleepMinutes)}`,
    "",
    "### 主观",
    "",
    "- 哪天最累：（待填）",
    "- 哪个动作卡住：（待填）",
    "- 关节有无不舒服：（待填）",
    "",
    "### 教练复盘（工作台规则派生，非 LLM）",
    "",
    "**结论**",
  );
  for (const line of model.conclusion) {
    lines.push(`- ${line}`);
  }
  if (!model.conclusion.length) {
    lines.push("- （无）");
  }

  lines.push("", "**待处理**");
  if (model.items.length) {
    model.items.forEach((item, index) => {
      lines.push(`${index + 1}. [${item.label}] ${item.text}`);
      if (item.basis) lines.push(`   依据：${item.basis}`);
    });
  } else {
    lines.push("- （无）");
  }
  lines.push("");

  return {
    periodStart,
    periodEnd,
    heading,
    sectionMarkdown: lines.join("\n"),
  };
}

/**
 * 从现有文件内容生成 editFile 写入载荷。
 * - 同区间标题已存在 → 替换该节（不叠双份）
 * - 否则在锚点后追加
 * - 无锚点 → 整文件 content（锚点 + 新节接在文末）
 */
export function buildTrainingReviewWriteAction(
  existingContent: string,
  draft: TrainingReviewDraft,
): WriteAction {
  const section = draft.sectionMarkdown.trimEnd() + "\n";
  const content = existingContent.replace(/\r\n?/g, "\n");

  const headingEscaped = draft.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(`${headingEscaped}\\n[\\s\\S]*?(?=\\n## |$)`);
  if (sectionRe.test(content)) {
    const next = content.replace(sectionRe, section.trimEnd() + "\n");
    return { kind: "editFile", path: TRAINING_REVIEW_PATH, content: next };
  }

  if (content.includes(TRAINING_REVIEW_APPEND_ANCHOR)) {
    const oldText = TRAINING_REVIEW_APPEND_ANCHOR;
    const newText = `${TRAINING_REVIEW_APPEND_ANCHOR}\n\n${section}`;
    return { kind: "editFile", path: TRAINING_REVIEW_PATH, oldText, newText };
  }

  const next = `${content.trimEnd()}\n\n${TRAINING_REVIEW_APPEND_ANCHOR}\n\n${section}`;
  return { kind: "editFile", path: TRAINING_REVIEW_PATH, content: next };
}

/** 前端「落库本期」默认走锚点追加（服务端 preview 读盘；确认前不改盘）。 */
export function buildTrainingReviewAppendAction(draft: TrainingReviewDraft): WriteAction {
  return {
    kind: "editFile",
    path: TRAINING_REVIEW_PATH,
    oldText: TRAINING_REVIEW_APPEND_ANCHOR,
    newText: `${TRAINING_REVIEW_APPEND_ANCHOR}\n\n${draft.sectionMarkdown.trimEnd()}\n`,
  };
}
