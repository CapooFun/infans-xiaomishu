import type { WriteAction } from "../types";

export const LIFE_DESIGN_LOG_PATH = "40_身心健康/平衡/人生设计校准.md";

/** 每月节尾锚点：新增月度自评时插在锚点前；同月已有 ### 月度自评时由带全文的 WriteAction 替换。 */
export function monthTailAnchor(month: string) {
  return `<!-- INFANS_MONTH_TAIL:${month} -->`;
}

/** 当月月度自评草稿（三需要分列 + 动机质量）；缺省待填，不编造。 */
export function buildMonthlySelfAssessmentSection(month: string, lineNames: string[] = [], status: "pending" | "confirmed" | "dismissed" = "pending") {
  const motives = (lineNames.length ? lineNames : ["（待填线名）"])
    .map((name) => `| ${name} | （待填：外部/内摄/认同/整合/内部） |`)
    .join("\n");
  const statusLine =
    status === "pending"
      ? "> AI 草稿 · 待本人改"
      : status === "confirmed"
        ? "> 本人已确认"
        : "> 已关闭未确认";
  return [
    `### 月度自评`,
    "",
    `<!-- INFANS_MONTHLY_REVIEW:${status} -->`,
    statusLine,
    "",
    "> 三需要满足与受挫分列，不合成总分。动机质量为自陈档。",
    "",
    "#### 三需要",
    "",
    "| 需要 | 满足 | 受挫 |",
    "|---|---|---|",
    "| 自主 | （待填：高/中/低） | （待填） |",
    "| 胜任 | （待填） | （待填） |",
    "| 联结 | （待填） | （待填） |",
    "",
    "#### 动机质量",
    "",
    "| 线 | 动机档 |",
    "|---|---|",
    motives,
    "",
  ].join("\n");
}

/** 给待审阅稿打上确认 / 关闭标记（保留正文，可先改过）。 */
export function stampMonthlySelfAssessmentSection(
  section: string,
  status: "pending" | "confirmed" | "dismissed",
  day = "",
) {
  const marker = `<!-- INFANS_MONTHLY_REVIEW:${status} -->`;
  const note =
    status === "pending"
      ? "> AI 草稿 · 待本人改"
      : status === "confirmed"
        ? `> 本人已确认${day ? ` · ${day}` : ""}`
        : `> 已关闭未确认${day ? ` · ${day}` : ""}`;
  let next = String(section || "").replace(/\r\n?/g, "\n").trim();
  if (!/^###\s*月度自评/m.test(next)) next = `### 月度自评\n\n${next}`;
  next = next.replace(/<!--\s*INFANS_MONTHLY_REVIEW:\w+\s*-->\n?/g, "");
  next = next.replace(/^###\s*月度自评\n+(?:>[^\n]*\n+)*/m, `### 月度自评\n\n${marker}\n${note}\n\n`);
  if (!next.includes(marker)) {
    next = next.replace(/^###\s*月度自评\n+/, `### 月度自评\n\n${marker}\n${note}\n\n`);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

/**
 * 从现有文件内容生成 editFile：同月已有 ### 月度自评 → 整节替换；否则插在月尾锚点前。
 */
export function buildMonthlySelfAssessmentWriteAction(
  existingContent: string,
  month: string,
  lineNames: string[] = [],
): WriteAction {
  const section = buildMonthlySelfAssessmentSection(month, lineNames);
  const content = existingContent.replace(/\r\n?/g, "\n");
  const monthHead = `## ${month}`;
  const monthIdx = content.indexOf(monthHead);
  if (monthIdx < 0) {
    const anchor = monthTailAnchor(month);
    const next = `${content.trimEnd()}\n\n${monthHead}\n\n${section}\n${anchor}\n`;
    return { kind: "editFile", path: LIFE_DESIGN_LOG_PATH, content: next };
  }

  const afterHead = monthIdx + monthHead.length;
  const nextMonth = content.slice(afterHead).search(/\n## \d{4}-\d{2}\s*$/m);
  const monthEnd = nextMonth < 0 ? content.length : afterHead + nextMonth;
  const monthBody = content.slice(afterHead, monthEnd);
  const selfRe = /\n### 月度自评\n[\s\S]*?(?=\n### |\n## |<!-- INFANS_MONTH_TAIL:|$)/;
  let newMonthBody: string;
  if (selfRe.test(monthBody)) {
    newMonthBody = monthBody.replace(selfRe, `\n${section}`);
  } else {
    const anchor = monthTailAnchor(month);
    if (monthBody.includes(anchor)) {
      newMonthBody = monthBody.replace(anchor, `${section}\n${anchor}`);
    } else {
      newMonthBody = `${monthBody.trimEnd()}\n\n${section}\n${anchor}\n`;
    }
  }
  const next = content.slice(0, afterHead) + newMonthBody + content.slice(monthEnd);
  return { kind: "editFile", path: LIFE_DESIGN_LOG_PATH, content: next };
}

/**
 * 前端“记一次月度自评”默认：插在当月尾锚点前（服务端 preview 读盘；确认前不改盘）。
 * 同月已有自评时请用 buildMonthlySelfAssessmentWriteAction(existing, …) 整节替换。
 */
export function buildMonthlySelfAssessmentAppendAction(month: string, lineNames: string[] = []): WriteAction {
  const section = buildMonthlySelfAssessmentSection(month, lineNames);
  const anchor = monthTailAnchor(month);
  return {
    kind: "editFile",
    path: LIFE_DESIGN_LOG_PATH,
    oldText: anchor,
    newText: `${section}\n${anchor}`,
  };
}
