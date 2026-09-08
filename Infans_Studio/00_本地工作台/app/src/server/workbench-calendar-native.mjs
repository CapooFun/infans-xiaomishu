import fs from "node:fs/promises";
import { watch } from "node:fs";
import net from "node:net";
import path from "node:path";

export const NATIVE_CALENDAR_STATUS = "calendar-eventkit-status.json";

export async function readNativeCalendarStatus(cacheDir) {
  try {
    if (!(await fs.stat(path.join(cacheDir, "calendar-eventkit.sock"))).isSocket()) return null;
    const value = JSON.parse(await fs.readFile(path.join(cacheDir, NATIVE_CALENDAR_STATUS), "utf8"));
    if (value.schemaVersion !== 1 || value.backend !== "eventkit" || typeof value.revision !== "string") return null;
    return value;
  } catch { return null; }
}

export function streamNativeCalendarChanges(response, cacheDir, onChange = () => {}) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive",
  });
  response.write("retry: 2000\n\n");
  const stop = watchNativeCalendarStatus(cacheDir, () => {
    onChange();
    response.write('data: {"changed":true}\n\n');
  });
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15000);
  heartbeat.unref?.();
  response.on("close", () => { stop(); clearInterval(heartbeat); });
}

export function readNativeCalendar(from, to, { cacheDir, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(cacheDir, "calendar-eventkit.sock"));
    let body = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("原生日历读取超时")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ operation: "events", from: from.toISOString(), to: to.toISOString() })}\n`));
    socket.on("error", () => finish(new Error("请打开 Mac 小秘书以连接原生日历。")));
    socket.on("end", () => finish(new Error("原生日历连接提前结束")));
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) return finish(new Error("日历窗口数据过大"));
      if (!body.includes("\n")) return;
      try {
        const result = JSON.parse(body.split("\n")[0]);
        if (result.backend !== "eventkit" || typeof result.available !== "boolean"
          || !["granted", "denied", "unknown"].includes(result.permission)
          || !Array.isArray(result.events) || !Array.isArray(result.calendars)) throw new Error("原生日历响应无效");
        finish(null, result);
      } catch (error) { finish(error); }
    });
  });
}

// Only revision/permission changes are broadcast; event contents stay in the existing API.
export function watchNativeCalendarStatus(cacheDir, changed) {
  let closed = false;
  let revision;
  const check = async () => {
    const value = await readNativeCalendarStatus(cacheDir);
    const next = value ? `${value.revision}:${value.permission}` : "offline";
    if (!closed && next !== revision) { revision = next; changed(); }
  };
  let watcher;
  try {
    watcher = watch(cacheDir, (_event, filename) => {
      if (!filename || String(filename) === NATIVE_CALENDAR_STATUS) void check();
    });
    watcher.on("error", () => { watcher.close(); });
  } catch { /* Startup before native cache creation: the bounded status poll recovers. */ }
  const timer = setInterval(() => { void check(); }, 5000);
  timer.unref?.();
  void check();
  return () => { closed = true; watcher?.close(); clearInterval(timer); };
}
