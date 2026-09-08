import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { SECRETARY_RUNTIME_DIR } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { MONITOR_ID, MONITOR_LIMITS, validateMonitorURL, validateMonitorSpec, parseMonitorRequest, monitorConfirmationSummary } from "./secretary-monitor-contract.mjs";

const BLOCKED = new net.BlockList();
for (const [ip, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",3]]) BLOCKED.addSubnet(ip, prefix, "ipv4");
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
BLOCKED.addSubnet("2001::", 23, "ipv6");
BLOCKED.addSubnet("2001:db8::", 32, "ipv6");
BLOCKED.addSubnet("2002::", 16, "ipv6");
BLOCKED.addSubnet("3fff::", 20, "ipv6");
BLOCKED.addSubnet("192.88.99.0", 24, "ipv4");
const MAX_BYTES = 1024 * 1024;
const TERMINAL = new Set(["cancelled", "expired", "notification_queued", "notification_failed"]);
const STATES = new Set(["active", "matched", ...TERMINAL]);
const errorOf = (message, code = "SECRETARY_MONITOR_FAILED") => new WorkbenchWriteError(message, 400, code);

export function isPublicMonitorAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !BLOCKED.check(address, "ipv4")
    : family === 6 && GLOBAL_V6.check(address, "ipv6") && !BLOCKED.check(address, "ipv6");
}

/** DNS is checked AND pinned in the TLS connection. No redirects, cookies or credentials. */
export async function fetchMonitorPage(rawURL, { lookup = dns.lookup, request = https.request } = {}) {
  const url = new URL(validateMonitorURL(rawURL));
  let dnsTimer;
  const addresses = await Promise.race([
    Promise.resolve().then(() => lookup(url.hostname, { all: true, verbatim: true })),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(errorOf("来源域名解析超时。")), 10000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicMonitorAddress(address))) throw errorOf("来源解析到非公开网络，已阻止请求。", "SECRETARY_MONITOR_PRIVATE_ADDRESS");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    let timer;
    const req = request(url, {
      method: "GET", agent: false,
      headers: { "User-Agent": "Yinyue-Explicit-Monitor/1.0", Accept: "text/html,text/plain", "Accept-Encoding": "identity" },
      lookup: (_host, opts, callback) => opts.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, (response) => {
      const type = String(response.headers["content-type"] || "");
      if (response.statusCode !== 200 || !/^text\/(?:html|plain)(?:;|$)/iu.test(type) || /charset=(?!["']?utf-8\b|["']?us-ascii\b)/iu.test(type)) {
        response.destroy();
        reject(errorOf(`来源不可直接读取（HTTP ${response.statusCode}；仅支持 UTF-8 静态 HTML／纯文字，不跟随跳转）。`));
        return;
      }
      const parts = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(errorOf("页面超过 1 MiB，已停止读取。")); return; }
        parts.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        try {
          const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
          resolve({ body, html: /^text\/html/iu.test(type) });
        } catch { reject(errorOf("页面编码不是有效 UTF-8。")); }
      });
      response.on("error", reject);
    });
    timer = setTimeout(() => req.destroy(errorOf("来源读取超过 15 秒，已停止。")), 15000);
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

export function monitorPageText({ body, html = true }) {
  let text = String(body || "");
  if (Buffer.byteLength(text) > MAX_BYTES) throw errorOf("页面超过 1 MiB。");
  if (html) text = text.replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (_, n) => { const c = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : " "; })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_, n) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[n]);
  text = text.replace(/\s+/gu, " ").trim();
  if (!text || /verify you are human|checking your browser|captcha|请完成验证|人机验证/iu.test(text)) throw errorOf("来源为空或遇到验证页，不能据此判断条件。");
  return text;
}

export function createSecretaryMonitorService(root, options = {}) {
  const directory = options.directory || path.join(root, SECRETARY_RUNTIME_DIR, "monitors");
  const file = path.join(directory, "state.v1.json");
  const now = options.now || (() => new Date());
  const fetchPage = options.fetchPage || fetchMonitorPage;
  const notify = options.notify || (async () => { throw errorOf("通知执行器尚未接通。"); });
  const deliveryItems = options.deliveryItems || (async () => []);
  let serial = Promise.resolve();
  let timer;
  let ticking = false;
  let stopped = false;
  let serviceError = null;
  function exclusive(work) { const result = serial.then(work); serial = result.catch(() => {}); return result; }
  async function read() {
    let data;
    try { data = await fs.readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, items: [] }; throw error; }
    const state = JSON.parse(data);
    if (state.schemaVersion !== 1 || !Array.isArray(state.items)) throw errorOf("监控账本格式损坏，已停止写入。");
    for (const item of state.items) {
      if (!MONITOR_ID.test(item.id) || !STATES.has(item.state) || !item.owner) throw errorOf("监控记录损坏，已停止执行。");
      validateMonitorSpec(item.spec, now(), { registering: false });
      if (!TERMINAL.has(item.state) && !Number.isFinite(Date.parse(item.nextCheckAt))) throw errorOf("监控检查时间损坏，已停止执行。");
    }
    return state;
  }
  async function save(state) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  function audit(item, event, details = {}) {
    item.updatedAt = now().toISOString();
    item.history = [...(item.history || []), { at: item.updatedAt, event, ...details }].slice(-100);
  }
  function publicItem(item, deliveries) {
    const delivery = deliveries.find((entry) => entry.interactionId === item.interactionId);
    return { ...item, ...(delivery ? { deliveryState: delivery.state } : {}) };
  }
  async function list(owner) {
    const [state, deliveries] = await Promise.all([read(), deliveryItems()]);
    return { ok: true, serviceError, items: state.items.filter((item) => !owner || item.owner === owner).map((item) => publicItem(item, deliveries)) };
  }
  const register = (specInput, { owner, actionID } = {}) => exclusive(async () => {
    if (!owner || !actionID || String(actionID).length > 160) throw errorOf("缺少已确认的设备与稳定动作 ID。");
    const state = await read();
    const id = `monitor-${crypto.createHash("sha256").update(`${owner}\0${actionID}`).digest("hex").slice(0, 32)}`;
    const existing = state.items.find((item) => item.id === id);
    const spec = validateMonitorSpec(specInput, now(), { registering: !existing });
    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw errorOf("同一动作 ID 的监控边界已变化，请重新确认。");
      return { ok: true, duplicate: true, item: existing };
    }
    if (state.items.filter((item) => !TERMINAL.has(item.state) && Date.parse(item.spec.deadline) > now().getTime()).length >= MONITOR_LIMITS.maxActive) throw errorOf("已有 20 个活跃监控，请先取消不再需要的项目。");
    const at = now().toISOString();
    const item = { id, owner, actionID, spec, state: "active", createdAt: at, updatedAt: at, nextCheckAt: at, checks: 0, failures: 0, authorization: { at, source: "explicit-confirmation", actionID }, history: [] };
    audit(item, "registered"); state.items.push(item); await save(state);
    return { ok: true, duplicate: false, item };
  });
  const cancel = (id, owner) => exclusive(async () => {
    const state = await read();
    const item = state.items.find((entry) => entry.id === id && entry.owner === owner);
    if (!item) throw errorOf("找不到该设备所属的监控。");
    if (item.state === "notification_queued") throw errorOf("命中通知已经排队，不能撤回已交给设备的通知；网页检查已停止。");
    if (item.state !== "cancelled") { item.state = "cancelled"; item.nextCheckAt = null; audit(item, "cancelled"); await save(state); }
    return { ok: true, item };
  });
  const tick = () => exclusive(async () => {
    const state = await read();
    for (const item of state.items) {
      if (stopped) break;
      if (TERMINAL.has(item.state)) continue;
      if (now().getTime() >= Date.parse(item.spec.deadline)) {
        item.state = item.state === "matched" ? "notification_failed" : "expired";
        item.nextCheckAt = null; audit(item, item.state); await save(state); continue;
      }
      if (Date.parse(item.nextCheckAt) > now().getTime()) continue;
      item.nextCheckAt = new Date(now().getTime() + item.spec.intervalMinutes * 60000).toISOString();
      // Persist the attempt before network access, preventing restart retry storms.
      audit(item, item.state === "matched" ? "notification_attempt" : "check_started"); await save(state);
      if (item.state === "active") {
        try {
          const text = monitorPageText(await fetchPage(item.spec.url));
          item.checks += 1; item.failures = 0; item.lastError = null; item.lastCheckedAt = now().toISOString();
          item.lastContentHash = crypto.createHash("sha256").update(text).digest("hex");
          if (now().getTime() >= Date.parse(item.spec.deadline)) { item.state = "expired"; item.nextCheckAt = null; audit(item, "expired_during_check"); }
          else if (text.includes(item.spec.contains.replace(/\s+/gu, " "))) { item.state = "matched"; item.matchedAt = now().toISOString(); audit(item, "matched", { contentHash: item.lastContentHash }); }
          else audit(item, "not_matched", { contentHash: item.lastContentHash });
        } catch (error) {
          item.failures += 1; item.lastError = String(error.message || "检查失败").slice(0, 240);
          audit(item, "check_failed", { error: item.lastError });
        }
        await save(state);
      }
      if (item.state !== "matched" || stopped) continue;
      try {
        const receipt = await notify({ kind: "event", triggerRef: `monitor:${item.id}`, topicKey: `monitor:${item.id}`, plannedAt: item.matchedAt,
          expiresAt: new Date(Date.parse(item.matchedAt) + 86400000).toISOString(), delivery: "banner",
          text: `监控命中：页面已出现「${item.spec.contains}」。\n来源：${item.spec.url}\n这是文字条件命中，不代表已购票／已预约；本次监控已停止。` });
        if (!receipt?.queued && receipt?.reason !== "duplicate") throw errorOf(`通知尚未排队：${receipt?.reason || "无有效回执"}`);
        item.interactionId = receipt.interaction?.interactionId || receipt.interactionId;
        if (!item.interactionId) throw errorOf("通知没有稳定回执 ID。");
        item.state = "notification_queued"; item.nextCheckAt = null; item.lastError = null; audit(item, "notification_queued", { interactionId: item.interactionId });
      } catch (error) { item.lastError = String(error.message || "通知失败").slice(0, 240); audit(item, "notification_failed", { error: item.lastError }); }
      await save(state);
    }
    serviceError = null;
    return { ok: true, items: state.items };
  });
  async function replyForCommand(command) {
    const parsed = parseMonitorRequest(command.text, now());
    if (!parsed) return null;
    if (parsed.missing?.length) return { text: `还没有建立或修改监控。请补充：${parsed.missing.join("；")}。\n首版只判断公开静态网页中的明确文字；请把完整条件放在同一条消息里。` };
    if (parsed.operation === "list") {
      const result = await list(command.deviceId);
      return { text: result.items.length ? result.items.slice(-20).map((item) => `${item.id}\n${item.spec.title}：${item.state}${item.deliveryState ? `／${item.deliveryState}` : ""}${item.lastError ? `；${item.lastError}` : ""}`).join("\n\n") : "这个设备目前没有已登记的监控。" };
    }
    if (parsed.operation === "cancel") {
      const target = (await list(command.deviceId)).items.find((item) => item.id === parsed.id);
      if (!target) return { text: "找不到这个设备所属的监控，请先说“查看监控”。" };
      return { text: "请确认取消这项监控。已送出的通知不能撤回。", pendingAction: { kind: "secretaryMonitor", operation: "cancel", monitorID: parsed.id, actionID: command.commandId, label: "取消持续监控", summary: `${parsed.id}\n${target.spec.title}` } };
    }
    const summary = monitorConfirmationSummary(parsed.spec);
    // Existing Watch confirmation cards cap summaries at 320 chars: never approve truncated boundaries.
    if (summary.length > 320) return { text: "监控边界太长，手表确认卡无法完整展示。请使用官方公开页面的更短直达网址或简短文字条件；未登记、未启动检查。" };
    return { text: "请核对来源、文字条件、频率和截止时间。确认后由 Mac 在线检查；命中只通知一次。还没有开始监控。", pendingAction: { kind: "secretaryMonitor", operation: "create", actionID: command.commandId, spec: parsed.spec, label: "确认建立持续监控", summary } };
  }
  async function applyAction(action, command) {
    if (action.kind !== "secretaryMonitor") throw errorOf("监控动作类型不符。");
    if (action.operation === "cancel") { await cancel(action.monitorID, command.deviceId); return { summary: `已取消监控：${action.monitorID}` }; }
    if (action.operation !== "create" || action.actionID !== command.commandId) throw errorOf("监控动作与来源不符。");
    if (action.summary !== monitorConfirmationSummary(action.spec) || action.summary.length > 320) throw errorOf("确认卡与实际监控边界不一致，请重新确认。");
    const result = await register(action.spec, { owner: command.deviceId, actionID: command.commandId });
    return { summary: `监控已登记：${result.item.id}；状态：${result.item.state}。不代表已命中或已通知。` };
  }
  function start() {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      tick().catch((error) => { serviceError = String(error.message || "监控服务失败").slice(0, 240); }).finally(() => { ticking = false; });
    }, 15000);
    timer.unref?.();
  }
  return { list, register, cancel, tick, replyForCommand, applyAction, start, stop() { stopped = true; clearInterval(timer); timer = undefined; } };
}
