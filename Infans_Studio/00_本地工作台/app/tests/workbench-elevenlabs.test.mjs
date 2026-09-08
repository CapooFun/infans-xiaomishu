import test from "node:test";
import assert from "node:assert/strict";
import { elevenLabsVoiceStatus, synthesizeSecretaryElevenLabsSpeech } from "../src/server/workbench-elevenlabs.mjs";

test("ElevenLabs status exposes empty public secretary slots only", async () => {
  const status = await elevenLabsVoiceStatus();
  assert.equal(status.provider, "elevenlabs");
  assert.equal(status.optional, true);
  assert.equal(typeof status.keyConfigured, "boolean");
  assert.deepEqual(Object.keys(status.roles), ["yinyue", "meining"]);
  assert.equal(status.roles.yinyue.configured, false);
  assert.equal(status.roles.meining.configured, false);
  assert.doesNotMatch(JSON.stringify(status), /xi-api-key|find-generic-password|-w/);
  assert.match(status.privacy, /发送给 ElevenLabs/);
});

test("ElevenLabs synthesis fails closed for roles outside the optional preview roster", async () => {
  await assert.rejects(
    () => synthesizeSecretaryElevenLabsSpeech("测试", { speaker: "unknown-role" }),
    (error) => error?.code === "ELEVENLABS_ROLE_UNAVAILABLE",
  );
  await assert.rejects(
    () => synthesizeSecretaryElevenLabsSpeech("测试", { speaker: "meining" }),
    (error) => error?.code === "ELEVENLABS_VOICE_NOT_CONFIGURED",
  );
});
