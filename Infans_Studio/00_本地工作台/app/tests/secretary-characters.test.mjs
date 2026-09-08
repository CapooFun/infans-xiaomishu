import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CHARACTER_IDS,
  CHAT_CHARACTER_REGISTRY,
  chatCharacterById,
  secretaryDutyStage,
  normalizeChatSpeaker,
} from "../src/secretary-characters.mjs";

test("开源聊天注册表有银月、梅凝两位秘书", () => {
  assert.equal(CHAT_CHARACTER_REGISTRY.length, 2);
  assert.deepEqual([...CHAT_CHARACTER_IDS], ["yinyue", "meining"]);
  assert.equal(chatCharacterById("yinyue")?.name, "银月");
  assert.equal(chatCharacterById("yinyue")?.kind, "secretary");
  assert.equal(chatCharacterById("yinyue")?.secretaryEligible, true);
  assert.equal(chatCharacterById("meining")?.name, "梅凝");
  assert.equal(chatCharacterById("meining")?.kind, "secretary");
  assert.equal(chatCharacterById("meining")?.secretaryEligible, true);
  assert.equal(chatCharacterById("yingning"), null);
});

test("认银月、梅凝 id 与中文名，未知值 fail closed", () => {
  assert.equal(normalizeChatSpeaker("yinyue"), "yinyue");
  assert.equal(normalizeChatSpeaker("银月"), "yinyue");
  assert.equal(normalizeChatSpeaker("secretary"), "yinyue");
  assert.equal(normalizeChatSpeaker("meining"), "meining");
  assert.equal(normalizeChatSpeaker("梅凝"), "meining");
  assert.equal(normalizeChatSpeaker("陌生角色"), null);
});

test("值班立绘只给银月和梅凝", () => {
  assert.equal(secretaryDutyStage("yinyue")?.src, "/theme/avatar-yinyue-public.svg");
  assert.equal(secretaryDutyStage("meining")?.src, "/theme/avatar-meining-public.svg");
  assert.equal(secretaryDutyStage("unknown-speaker"), null);
});
