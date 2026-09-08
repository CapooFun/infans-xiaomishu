import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanCursorWorkload } from "../scripts/cursor-workload-summary.mjs";

function message(role, text) {
  return JSON.stringify({ role, message: { content: [{ type: "text", text }] } });
}

test("Cursor adapter emits the shared read-only workload schema and removes copied or automated activity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "infans-cursor-workload-"));
  try {
    const directory = path.join(root, "project", "agent-transcripts");
    fs.mkdirSync(directory, { recursive: true });
    const first = [
      message("user", "<timestamp>Thursday, Aug 27, 2026, 9:00 AM (UTC+9)</timestamp>\n开始实际讨论"),
      message("user", "<timestamp>Thursday, Aug 27, 2026, 9:20 AM (UTC+9)</timestamp>\n继续纠偏"),
      message("user", "<timestamp>Thursday, Aug 27, 2026, 9:40 AM (UTC+9)</timestamp>\n<automation>后台任务"),
      message("user", "<timestamp>Thursday, Aug 27, 2026, 10:30 AM (UTC+9)</timestamp>\n回来验收"),
      message("assistant", "【身心日评交接】\n归属日：2026-08-27\n活跃时段：约 09:00–10:30\n工作性质：讨论 / 审阅\n状态：已验证"),
    ].join("\n");
    fs.writeFileSync(path.join(directory, "root-a.jsonl"), `${first}\n`);
    fs.writeFileSync(path.join(directory, "copied-context.jsonl"), `${message("user", "<timestamp>Thursday, Aug 27, 2026, 9:00 AM (UTC+9)</timestamp>\n开始实际讨论")}\n`);
    const legacyScheduled = [
      message("user", "<timestamp>Thursday, Aug 27, 2026, 6:45 AM (UTC+9)</timestamp>\n<user_query>\n今天是日本时间 2026-08-27。请先完整阅读规则，然后严格执行任务说明文件：40_身心健康/状态报告/身心日评_本机定时prompt.md。只允许写入白名单路径。\n</user_query>"),
      message("user", "<timestamp>Thursday, Aug 27, 2026, 6:51 AM (UTC+9)</timestamp>\nBriefly inform the user about the task result."),
    ].join("\n");
    fs.writeFileSync(path.join(directory, "legacy-scheduled.jsonl"), `${legacyScheduled}\n`);

    const [result] = scanCursorWorkload(["2026-08-27"], { projectRoot: root });
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.source, "cursor");
    assert.deepEqual(result.activeWindows, [
      { start: "09:00", end: "09:20" },
      { start: "10:30", end: "10:30" },
    ]);
    assert.equal(result.rootTaskCount, 2);
    assert.equal(result.handoffs.length, 1);
    assert.equal(result.handoffs[0].status, "已验证");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
