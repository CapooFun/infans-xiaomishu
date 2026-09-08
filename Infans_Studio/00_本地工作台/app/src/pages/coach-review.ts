import type { HealthSectionData } from "../types";

export type CoachReviewKind = "increase" | "deload" | "makeup" | "balance" | "plateau" | "hint";

export type CoachReviewItem = {
  kind: CoachReviewKind;
  label: string;
  text: string;
  basis: string;
};

export type CoachReviewModel = {
  conclusion: string[];
  items: CoachReviewItem[];
  hasSignals: boolean;
};

const KIND_LABEL: Record<CoachReviewKind, string> = {
  increase: "加重",
  deload: "减量",
  makeup: "补课",
  balance: "左右不均",
  plateau: "可能卡住了",
  hint: "周期提醒",
};

/** 推/拉比偏离此区间才进待处理；区间内只作结论旁证，不造假警报。 */
const PUSH_PULL_LO = 0.7;
const PUSH_PULL_HI = 1.4;
/** 上/下肢比：日常上肢偏多，超过 2.5 才标候选失衡。 */
const UPPER_LOWER_HI = 2.5;
const UPPER_LOWER_LO = 0.5;

const MAX_ITEMS = 8;

function latestWeek(weekly: HealthSectionData["trainingVolume"]["weekly"]) {
  if (!weekly?.length) return null;
  return [...weekly].sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0] ?? null;
}

function formatKg(value: number) {
  return Math.round(value).toLocaleString("zh-CN");
}

function ratioSkewed(ratio: number | null, lo: number, hi: number) {
  return ratio != null && Number.isFinite(ratio) && (ratio < lo || ratio > hi);
}

export function buildCoachReview(input: {
  trainingVolume?: HealthSectionData["trainingVolume"] | null;
  progressionAdvice?: HealthSectionData["progressionAdvice"] | null;
  muscleBalance?: HealthSectionData["muscleBalance"] | null;
  recoveryLoad?: HealthSectionData["recoveryLoad"] | null;
  mesocycle?: HealthSectionData["mesocycle"] | null;
  staleMuscles?: HealthSectionData["staleMuscles"] | null;
  coachHints?: HealthSectionData["coachHints"] | null;
}): CoachReviewModel {
  const progression = input.progressionAdvice ?? [];
  const balance = input.muscleBalance ?? null;
  const recovery = input.recoveryLoad ?? null;
  const meso = input.mesocycle ?? null;
  const stale = input.staleMuscles ?? [];
  const coachHints = input.coachHints ?? [];
  const week = latestWeek(input.trainingVolume?.weekly ?? []);

  const items: CoachReviewItem[] = [];

  // S8：恢复负荷减量优先于动作级进阶 deload 展示顺序（同为 deload 档）
  if (recovery?.suggestDeload && recovery.text) {
    items.push({
      kind: "deload",
      label: "该减量了",
      text: recovery.text,
      basis: recovery.basis,
    });
  }

  for (const advice of progression) {
    if (advice.kind !== "deload" && advice.kind !== "increase") continue;
    items.push({
      kind: advice.kind,
      label: KIND_LABEL[advice.kind],
      text: advice.text,
      basis: advice.basis,
    });
  }

  // S7：周期位置 —— 满 4 周提示讨论 deload；未满也给出周次旁证
  if (meso?.suggestDeloadDiscuss && meso.text) {
    items.push({
      kind: "hint",
      label: "周期提醒",
      text: meso.text,
      basis: meso.basis,
    });
  } else if (meso?.weekIndex != null && meso.text) {
    // 未到 deload 窗：不塞进待处理，结论段可引用；此处不加 item 以免噪音
  }

  for (const muscle of stale) {
    if (muscle.status !== "overdue") continue;
    items.push({
      kind: "makeup",
      label: KIND_LABEL.makeup,
      text: `${muscle.label} 已 ${muscle.daysSince} 天未练，本周排一次`,
      basis: muscle.lastDate ? `最近练到 ${muscle.lastDate}` : `已经 ${muscle.daysSince} 天没练`,
    });
  }

  if (balance) {
    if (ratioSkewed(balance.pushPullRatio, PUSH_PULL_LO, PUSH_PULL_HI) && balance.pushPullRatio != null) {
      const lean = balance.pushPullRatio > 1 ? "推多于拉" : "拉多于推";
      items.push({
        kind: "balance",
        label: KIND_LABEL.balance,
        text: `推的量比拉多 ${balance.pushPullRatio.toFixed(2)} 倍（${lean}），建议多练拉的动作`,
        basis: balance.pushPullBasis,
      });
    }
    if (ratioSkewed(balance.upperLowerRatio, UPPER_LOWER_LO, UPPER_LOWER_HI) && balance.upperLowerRatio != null) {
      const lean = balance.upperLowerRatio > 1 ? "上肢远多于下肢" : "下肢远多于上肢";
      items.push({
        kind: "balance",
        label: KIND_LABEL.balance,
        text: `上肢练得是下肢的 ${balance.upperLowerRatio.toFixed(2)} 倍（${lean}），建议补腿`,
        basis: balance.upperLowerBasis,
      });
    }
    for (const plateau of balance.plateauCandidates ?? []) {
      items.push({
        kind: "plateau",
        label: KIND_LABEL.plateau,
        text: plateau.text,
        basis: plateau.basis,
      });
    }
  }

  // S6：原教练条上的周期 hint 迁到复盘位；跳过与补课重复的「天未练」
  for (const hint of coachHints) {
    if (hint.tone === "info") continue;
    if (/天未练/.test(hint.text)) continue;
    if (items.some((item) => item.text === hint.text)) continue;
    items.push({
      kind: "hint",
      label: KIND_LABEL.hint,
      text: hint.text,
      basis: hint.basis || "",
    });
  }

  const KIND_ORDER: Record<CoachReviewKind, number> = {
    deload: 0,
    increase: 1,
    makeup: 2,
    hint: 3,
    balance: 4,
    plateau: 5,
  };
  items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const capped = items.slice(0, MAX_ITEMS);
  const conclusion: string[] = [];
  const hasVolume = Boolean(week && week.totalTonnageKg > 0);
  const hasSignals = capped.length > 0 || hasVolume || Boolean(balance?.pushPullRatio != null || balance?.upperLowerRatio != null);

  if (!hasSignals) {
    conclusion.push("训练记录太少，还看不出趋势。再练几次就有了。");
    return { conclusion, items: [], hasSignals: false };
  }

  const deload = capped.filter((item) => item.kind === "deload");
  const increase = capped.filter((item) => item.kind === "increase");
  const balanceItems = capped.filter((item) => item.kind === "balance");
  const plateau = capped.filter((item) => item.kind === "plateau");
  const makeup = capped.filter((item) => item.kind === "makeup");
  const hints = capped.filter((item) => item.kind === "hint");

  if (week) {
    conclusion.push(`最近一周总共举了约 ${formatKg(week.totalTonnageKg)} kg（自 ${week.weekStart}）。`);
  } else if (meso?.weekIndex != null && meso.text && !meso.suggestDeloadDiscuss) {
    conclusion.push(meso.text);
  }

  if (deload.length) {
    const names = deload.map((item) => item.text.split(/\s/)[0]).filter(Boolean).slice(0, 2);
    conclusion.push(`先处理减量：${names.join("、")}。`);
  } else if (increase.length) {
    const names = increase.map((item) => item.text.split(/\s/)[0]).filter(Boolean).slice(0, 2);
    conclusion.push(`${increase.length} 个动作可以加重了（${names.join("、")}）。`);
  } else if (plateau.length) {
    conclusion.push(`${plateau[0].text}`);
  } else if (balanceItems.length) {
    conclusion.push(`练的量不太均衡：${balanceItems[0].text}`);
  } else if (makeup.length) {
    conclusion.push(`这些部位太久没练：${makeup.map((item) => item.text.split(" 已")[0]).slice(0, 2).join("、")}。`);
  } else if (hints.length) {
    conclusion.push(hints[0].text);
  } else if (balance?.pushPullRatio != null || balance?.upperLowerRatio != null) {
    const bits: string[] = [];
    if (balance.pushPullRatio != null) bits.push(`推比拉 ${balance.pushPullRatio.toFixed(2)}`);
    if (balance.upperLowerRatio != null) bits.push(`上肢比下肢 ${balance.upperLowerRatio.toFixed(2)}`);
    conclusion.push(`这周没有必须加重的动作；${bits.join(" · ")} 的比例还在正常范围。`);
  } else {
    conclusion.push("没有必须加重或补练的，照计划练就行。");
  }

  return { conclusion: conclusion.slice(0, 2), items: capped, hasSignals: true };
}

export function buildCoachReviewSeed(model: CoachReviewModel): string {
  const lines = [
    "请根据以下「教练复盘」指标细讲：不要另编一套结论，可解释依据、追问细节或给下一步执行方案。",
    "",
    "【本周结论】",
    ...model.conclusion,
  ];
  if (model.items.length) {
    lines.push("", "【待处理项】");
    model.items.forEach((item, index) => {
      lines.push(`${index + 1}. [${item.label}] ${item.text}`);
      lines.push(`   依据：${item.basis}`);
    });
  } else {
    lines.push("", "【待处理项】无");
  }
  return lines.join("\n");
}
