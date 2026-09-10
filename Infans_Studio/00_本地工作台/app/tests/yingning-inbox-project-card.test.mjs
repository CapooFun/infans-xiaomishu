import assert from "node:assert/strict";
import test from "node:test";
import {
  formatProjectRelatedTask,
  isProjectDeliveryNote,
  projectInboxCardCopy,
  projectInboxJudgment,
} from "../src/pages/tools/yingning-inbox-project-card.ts";

const DELIVERY_NOTE = "通过系统分享通道投递。兼容接口投递。";

test("投递通道套话不算本人备注", () => {
  assert.equal(isProjectDeliveryNote(DELIVERY_NOTE), true);
  assert.equal(isProjectDeliveryNote("晚上帮我看一眼封面"), false);
});

test("关联任务去掉快照尾巴，W 号提到前面", () => {
  assert.equal(
    formatProjectRelatedTask("封面检查 · W02 检查点快照"),
    "W02 · 封面检查",
  );
  assert.equal(
    formatProjectRelatedTask("W06 封面与标题排版 · 检查点快照"),
    "W06 封面与标题排版",
  );
  assert.equal(
    formatProjectRelatedTask("角色站位 · 快照"),
    "角色站位",
  );
  assert.equal(formatProjectRelatedTask("", "封面检查"), "封面检查");
});

test("黄框用普通人听得懂的判断句，不写投递通道术语", () => {
  const copy = projectInboxCardCopy({
    title: "封面检查",
    text: "封面颜色清楚。角色看得见吗，可见且无房屋遮挡。这是工程快照，不算你点头。",
    note: DELIVERY_NOTE,
    checkpoint: { name: "封面检查 · W02 检查点快照" },
  });
  assert.equal(copy.relatedTask, "W02 · 封面检查");
  assert.equal(copy.checkpointLabel, "封面检查 · W02 检查点快照");
  assert.match(copy.judgment, /清不清楚/u);
  assert.match(copy.judgment, /看得见吗/u);
  assert.match(copy.judgment, /有没有被房子挡住/u);
  assert.match(copy.judgment, /也不算你点头/u);
  assert.doesNotMatch(copy.judgment, /Chrome/u);
  assert.doesNotMatch(copy.judgment, /Godot/u);
  assert.doesNotMatch(copy.judgment, /系统分享通道/u);
  assert.doesNotMatch(copy.relatedTask, /rtc3d/u);
  assert.doesNotMatch(`${copy.relatedTask}\n${copy.judgment}\n${copy.checkpointLabel}`, /水箭|3D辞职修仙传/u);
});

test("没有视觉提要时仍有一句人话，不要空黄框", () => {
  const judgment = projectInboxJudgment(
    "浅石深木青瓦青布，复用草矿。",
    DELIVERY_NOTE,
  );
  assert.match(judgment, /浅石深木青瓦青布/u);
  assert.doesNotMatch(judgment, /Chrome/u);
  assert.doesNotMatch(judgment, /Godot/u);
});

test("只有本人备注、没有工程介绍时，黄框用备注", () => {
  assert.equal(projectInboxJudgment("", "晚上帮我看一眼封面"), "晚上帮我看一眼封面");
  assert.equal(projectInboxJudgment("", DELIVERY_NOTE), "");
});
