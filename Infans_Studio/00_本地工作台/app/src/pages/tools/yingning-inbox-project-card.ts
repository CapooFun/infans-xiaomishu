// 项目收件卡片：中间写关联任务，黄框只写本人要判断的事。

export type ProjectInboxCardInput = {
  title?: string | null;
  text?: string | null;
  note?: string | null;
  checkpoint?: { name?: string | null } | null;
};

export type ProjectInboxCardCopy = {
  relatedTask: string;
  judgment: string;
  checkpointLabel: string;
};

const DELIVERY_NOTE_RE = /系统分享通道|兼容接口投递/u;

const SNAPSHOT_TAIL_RE = /\s·\s(?:(?:W\d+)\s+)?(?:检查点快照|快照)$/u;

const CAVEAT_RE = /这还不是成品|不算你点头|非正式验收|工程快照/u;

export function isProjectDeliveryNote(note: string) {
  return DELIVERY_NOTE_RE.test(String(note || ""));
}

export function formatProjectRelatedTask(name: string, title = "") {
  const raw = String(name || "").trim() || String(title || "").trim();
  if (!raw) return "";
  const tailWeek = raw.match(/·\s*(W\d+)\s+(?:检查点)?快照$/u);
  const stripped = raw.replace(SNAPSHOT_TAIL_RE, "").trim();
  if (tailWeek?.[1] && stripped && !new RegExp(`\\b${tailWeek[1]}\\b`, "u").test(stripped)) {
    return `${tailWeek[1]} · ${stripped}`;
  }
  return stripped || raw;
}

function compactText(value: string) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function splitSentences(text: string) {
  const compact = compactText(text);
  if (!compact) return [];
  return compact.split(/(?<=[。！？])\s*/u).map((part) => part.trim()).filter(Boolean);
}

function judgmentSource(text: string, note: string) {
  const body = compactText(text);
  if (body) return body;
  const remark = compactText(note);
  return isProjectDeliveryNote(remark) ? "" : remark;
}

function looksEngineered(text: string) {
  return /工程快照|非正式验收|检查点|schema|build\b/u.test(text);
}

function toLookQuestion(text: string) {
  let ask = compactText(text)
    .replace(/房屋/gu, "房子")
    .replace(/可见且无([^，。；]+)遮挡/gu, "看得见吗，有没有被$1挡住")
    .replace(/身体可见/gu, "人还在画面里吗")
    .replace(/(?<!不)清楚/gu, "清不清楚")
    .replace(/(?<!不)可见/gu, "看得见吗")
    .replace(/这是工程快照[，,]?/gu, "")
    .replace(/不算你点头[。]?/gu, "")
    .replace(/非正式验收[。]?/gu, "")
    .replace(/\s{2,}/gu, " ")
    .replace(/^[，、；:\s]+/u, "")
    .replace(/[，、；\s]+$/u, "")
    .replace(/[。；]+$/u, "");
  if (!ask) return "";
  if (!/[？?]$/u.test(ask)) ask = `${ask}？`;
  return ask;
}

function humanCaveat(source: string) {
  const notApp = /不是成品|工程快照/u.test(source);
  const notYou = /不算你点头|非正式验收/u.test(source);
  if (notApp && notYou) return "这还不是给你玩的成品，也不算你点头。";
  if (notYou) return "这还不算你点头。";
  if (notApp) return "这还不是给你玩的成品。";
  return "";
}

export function humanizeProjectJudgment(raw: string) {
  const text = compactText(raw);
  if (!text) return "";
  if (!looksEngineered(text) && text.length < 80) return text;
  const ask = toLookQuestion(text) || "请看这几张图，样子对不对？";
  const caveat = humanCaveat(text);
  return compactText([ask, caveat].filter(Boolean).join(""));
}

export function projectInboxJudgment(text: string, note: string) {
  const source = judgmentSource(text, note);
  const parts = splitSentences(source).filter((part) => !isProjectDeliveryNote(part));
  if (!parts.length) return humanizeProjectJudgment(source);
  const caveats = parts.filter((part) => CAVEAT_RE.test(part));
  const primary = parts.filter((part) => !CAVEAT_RE.test(part));
  const lead = primary[0] || parts[0] || "";
  const extra = primary[1] && primary[1] !== lead ? primary[1] : "";
  const caveat = caveats.find((part) => part !== lead) || "";
  const pieces = [lead, extra, caveat].filter((part, index, all) => part && all.indexOf(part) === index);
  let result = "";
  for (const piece of pieces) {
    const next = `${result}${piece}`;
    if (result && next.length > 360) break;
    result = next;
  }
  return humanizeProjectJudgment(result || source);
}

export function projectInboxCardCopy(item: ProjectInboxCardInput): ProjectInboxCardCopy {
  const checkpointLabel = compactText(item.checkpoint?.name || "");
  return {
    relatedTask: formatProjectRelatedTask(checkpointLabel, item.title || ""),
    judgment: projectInboxJudgment(item.text || "", item.note || ""),
    checkpointLabel,
  };
}
