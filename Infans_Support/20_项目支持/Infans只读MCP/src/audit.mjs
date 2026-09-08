import fs from "node:fs/promises";
import path from "node:path";

const RETENTION_DAYS = 100;

function tokyoDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function createAuditLogger({ stateDirectory, now = () => new Date() }) {
  const auditDirectory = path.join(stateDirectory, "audit");

  async function prune() {
    await fs.mkdir(auditDirectory, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(auditDirectory, { withFileTypes: true });
    const cutoff = now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) return;
      const fullPath = path.join(auditDirectory, entry.name);
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs < cutoff) await fs.unlink(fullPath);
    }));
  }

  async function record(event) {
    const at = now();
    await fs.mkdir(auditDirectory, { recursive: true, mode: 0o700 });
    const output = {
      at: at.toISOString(),
      timezone: "Asia/Tokyo",
      client: "local-or-openai-tunnel",
      tool: String(event.tool || "unknown"),
      path: event.path ? String(event.path) : null,
      status: String(event.status || "unknown"),
      bytes: Number.isFinite(event.bytes) ? event.bytes : 0,
      elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : 0,
    };
    const filePath = path.join(auditDirectory, `${tokyoDate(at)}.jsonl`);
    await fs.appendFile(filePath, `${JSON.stringify(output)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  return { record, prune, retentionDays: RETENTION_DAYS, auditDirectory };
}
