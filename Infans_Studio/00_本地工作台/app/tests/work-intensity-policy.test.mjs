import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const vaultRoot = new URL("../../../", import.meta.url);

async function read(relativePath) {
  return fs.readFile(new URL(relativePath, vaultRoot), "utf8");
}

test("工作强度统一为 0–10 本人负荷，并由 Cursor 合并多 AI 证据后单写", async () => {
  const [skill, policy, prompt, integration] = await Promise.all([
    read(".cursor/skills/human-care-pulse/SKILL.md"),
    read("40_身心健康/心理/2026-08-13_工作强度识别口径.md"),
    read("40_身心健康/状态报告/身心日评_本机定时prompt.md"),
    read("40_身心健康/状态报告/身心日评_AI窗口工作量接入与交接_操作说明.md"),
  ]);

  for (const source of [policy, prompt, integration]) {
    assert.match(source, /S = 0\.65T \+ 0\.25P \+ 0\.10C/u);
    assert.match(source, /0[^\n]*(确认本人没干活|只用于确认本人没干活)/u);
    assert.match(source, /(取并集|时段取并集)/u);
    assert.match(source, /(稳定工作 ID|工作 ID)/u);
  }

  assert.match(skill, /本 Skill 只负责触发和路由/u);
  assert.match(skill, /2026-08-13_工作强度识别口径\.md/u);
  assert.doesNotMatch(skill, /S = 0\.65T \+ 0\.25P \+ 0\.10C/u);
  assert.doesNotMatch(skill, /第二个 AI 收的硬活算进当天/u);
  assert.doesNotMatch(skill, /硬结果[^\n]*起点[^\n]*8/u);
  assert.match(prompt, /禁止把各 AI 的分数、时长或成果数量相加／平均/u);
  assert.match(policy, /N = floor\(S \+ 0\.5\)/u);
  assert.match(policy, /开口时段只证明本人当时介入/u);
  assert.match(policy, /本人对某日有效工作时长的直接回忆权重最高/u);
  assert.match(prompt, /禁止把开口分钟数并集直接写成有效工时/u);
  assert.match(prompt, /T \/ P \/ C \/ S \/ 置信度/u);
  assert.match(integration, /并集是工作片段锚点，不是有效工时本身/u);
  assert.match(integration, /AI 昨天生成、Capoo 今天验收，产出负担记今天/u);
});

test("恢复四项支持逐项未知，缺证据不折算为真放松 0", async () => {
  const [prompt, boundary, product, moduleDoc] = await Promise.all([
    read("40_身心健康/状态报告/身心日评_本机定时prompt.md"),
    read("40_身心健康/心理/人文关怀_AI执行边界与模板.md"),
    read("40_身心健康/身心健康_产品说明.md"),
    read("00_本地工作台/10_设计/身心健康/小秘书模块_身心健康.md"),
  ]);

  assert.match(prompt, /0 \/ 50 \/ 100 \/ 未知/u);
  assert.match(prompt, /没有写到散步、泡澡、放空等不能自动等于“真放松 0”/u);
  assert.match(prompt, /工作强度低也不能单独自动等于 100/u);
  assert.match(prompt, /本人直接说[^\n]*权重最高/u);
  assert.match(boundary, /未知不进入该维度平均/u);
  assert.match(product, /各维度只对有据日平均并显示样本天数/u);
  assert.match(moduleDoc, /`0` 只代表明确的反向证据/u);
});
