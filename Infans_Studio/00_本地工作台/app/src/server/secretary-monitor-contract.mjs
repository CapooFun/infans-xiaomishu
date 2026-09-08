import { WorkbenchWriteError } from "./workbench-errors.mjs";

export const MONITOR_LIMITS = Object.freeze({ minMinutes: 5, maxMinutes: 1440, maxDays: 30, maxActive: 20 });
export const MONITOR_ID = /^monitor-[a-f0-9]{32}$/u;
const fail = (message) => { throw new WorkbenchWriteError(message, 400, "SECRETARY_MONITOR_INVALID"); };

export function validateMonitorURL(input) {
  let url;
  try { url = new URL(String(input)); } catch { fail("请提供完整的官方 HTTPS 网址。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.href.length > 1000) {
    fail("首版只接受无账号密码、非自定义端口、无锚点的 HTTPS 网址（最多 1000 字符）。");
  }
  if (!url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname)) {
    fail("不能监控本机或内部网络地址。");
  }
  if (/(?:token|secret|password|api[_-]?key|authorization|signature|credential|session)/iu.test(url.search)) {
    fail("网址含疑似凭据参数，请换用无需登录的官方公开页面。");
  }
  return url.href;
}

export function validateMonitorSpec(input, now = new Date(), { registering = true } = {}) {
  const url = validateMonitorURL(input?.url);
  const contains = String(input?.contains || "").trim();
  if (!contains || contains.length > 120 || /[\r\n\x00-\x1f]/u.test(contains)) fail("请明确页面出现的文字条件（1 至 120 字）。");
  const intervalMinutes = Number(input?.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < MONITOR_LIMITS.minMinutes || intervalMinutes > MONITOR_LIMITS.maxMinutes) {
    fail("首版检查频率为 5 至 1440 分钟，请明确选择，不会自动替你改频率。");
  }
  const deadline = String(input?.deadline || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(deadline)) fail("截止时间需要完整日期、时间和时区。");
  const end = new Date(deadline);
  if (!Number.isFinite(end.getTime())) fail("截止时间无效。");
  if (Number(deadline.slice(11, 13)) > 23 || Number(deadline.slice(14, 16)) > 59) fail("截止时间无效。");
  // Reject Date's silent rollover (for example February 30).
  const localDay = deadline.slice(0, 10);
  const day = new Date(`${localDay}T12:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== localDay) fail("截止日期不存在。");
  if (registering && (end <= now || end - now > MONITOR_LIMITS.maxDays * 86400000)) fail("截止必须晚于现在，且不超过 30 天。");
  const title = String(input?.title || `页面出现「${contains}」`).trim();
  if (!title || title.length > 160) fail("监控标题最多 160 字。");
  return { url, contains, intervalMinutes, deadline: end.toISOString(), title };
}

function chineseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  if (value === "半") return 0.5;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes("十")) {
    const [a, b] = value.split("十");
    return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0);
  }
  return digits[value];
}

/** Deterministic first edition: no model may invent a source, condition or deadline. */
export function parseMonitorRequest(input, now = new Date()) {
  const text = String(input || "").trim();
  if (/^(?:请)?(?:查看|列出|看看)(?:我的|当前|全部|所有)?监控[。！？!？]?$/u.test(text)) return { operation: "list" };
  if (/^(?:请)?(?:取消|停止|关闭)监控/u.test(text)) {
    const id = text.match(/\bmonitor-[a-f0-9]{32}\b/u)?.[0];
    return id ? { operation: "cancel", id } : { operation: "cancel", missing: ["监控 ID（先说“查看监控”）"] };
  }
  if (/什么是.*监控|监控.*(?:是什么意思|是什么功能|什么原理|怎么使用)/u.test(text)) return null;
  if (!/监控|盯着|持续(?:看|查|关注)|有票就|一(?:开卖|开售|公布|发布)|公布后提醒/u.test(text)) return null;
  const urls = text.match(/https:\/\/[^\s<>「」“”"，。；]+/gu) || [];
  const conditions = [...text.matchAll(/(?:出现|包含)(?:文字)?\s*[「“"]([^」”"\r\n]+)[」”"]/gu)];
  if (conditions.length > 1 || /(?:不|未|没|没有|不再)(?:出现|包含)(?:文字)?\s*[「“"]/u.test(text)) {
    return { operation: "create", missing: ["首版只支持单一“出现某段文字”条件，暂不支持否定或组合条件"] };
  }
  if (/北京时间|上海时间|UTC|GMT|美东时间|纽约时间/iu.test(text)) return { operation: "create", missing: ["请用 ISO 时区偏移（例如 +08:00）明确截止时间，不猜测其他时区"] };
  const condition = conditions[0]?.[1];
  if ([...text.matchAll(/每(?:隔)?\s*(\d+|[一二两三四五六七八九十半]+)\s*(分钟|小时|天)/gu)].length > 1
      || [...text.matchAll(/(?:截止|截至|直到|到期)\s*\d{4}-/gu)].length > 1) {
    return { operation: "create", missing: ["只提供一个检查频率和一个截止时间，避免边界歧义"] };
  }
  const cadence = text.match(/每(?:隔)?\s*(\d+|[一二两三四五六七八九十半]+)\s*(分钟|小时|天)/u);
  const ending = text.match(/(?:截止|截至|直到|到期)\s*(\d{4}-\d{2}-\d{2})[ T日]\s*(\d{2}:\d{2})(:\d{2})?\s*(Z|[+-]\d{2}:\d{2}|东京时间|日本时间)?/u);
  const missing = [
    ...(urls.length !== 1 ? ["一个官方 HTTPS 网址"] : []),
    ...(!condition ? ["明确文字条件，例如：出现「已开放预约」"] : []),
    ...(!cadence ? ["检查频率，例如：每 30 分钟"] : []),
    ...(!ending ? ["截止日期和时间，例如：截止 2026-09-04 18:00 东京时间"] : []),
  ];
  if (missing.length) return { operation: "create", missing };
  const zone = !ending[4] || /东京|日本/u.test(ending[4]) ? "+09:00" : ending[4];
  try {
    return { operation: "create", spec: validateMonitorSpec({
      url: urls[0], contains: condition,
      intervalMinutes: chineseNumber(cadence[1]) * ({ 分钟: 1, 小时: 60, 天: 1440 })[cadence[2]],
      deadline: `${ending[1]}T${ending[2]}${ending[3] || ":00"}${zone}`,
    }, now) };
  } catch (error) { return { operation: "create", missing: [error.message] }; }
}

export function monitorConfirmationSummary(spec) {
  const end = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(spec.deadline));
  return `来源：${spec.url}\n条件：页面文字包含「${spec.contains}」\n每 ${spec.intervalMinutes} 分钟检查；截止 ${end}（东京）\n命中通知一次并停止；请确认这是你指定的官方公开来源。`;
}
