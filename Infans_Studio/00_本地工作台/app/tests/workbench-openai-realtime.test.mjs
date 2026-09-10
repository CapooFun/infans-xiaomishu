import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_CHARACTER_REGISTRY } from "../src/secretary-characters.mjs";
import {
  OPENAI_REALTIME_API_URL,
  OPENAI_REALTIME_MODEL,
  OPENAI_REALTIME_MODELS,
  buildOpenAIRealtimeSessionConfig,
  createOpenAIRealtimeCall,
  openAIRealtimeStatus,
  readOpenAIRealtimeApiKey,
} from "../src/server/workbench-openai-realtime.mjs";

test("OpenAI Realtime key stays in Keychain and status exposes safe metadata only", async () => {
  const execFileImpl = async (file, args) => {
    assert.equal(file, "/usr/bin/security");
    assert.deepEqual(args, [
      "find-generic-password",
      "-a", "Infans",
      "-s", "Infans OpenAI API",
      "-w",
    ]);
    return { stdout: "test-openai-secret\n" };
  };
  assert.equal(await readOpenAIRealtimeApiKey({ execFileImpl }), "test-openai-secret");
  const status = await openAIRealtimeStatus({ execFileImpl });
  assert.equal(status.available, true);
  assert.equal(status.model, OPENAI_REALTIME_MODEL);
  assert.deepEqual(status.models.map((item) => item.id), Object.keys(OPENAI_REALTIME_MODELS));
  assert.doesNotMatch(JSON.stringify(status), /test-openai-secret|Authorization|Bearer/);
});

test("missing OpenAI Realtime key reports unavailable without making a paid probe", async () => {
  const status = await openAIRealtimeStatus({ execFileImpl: async () => { throw new Error("missing"); } });
  assert.equal(status.available, false);
  assert.equal(status.health, "missing");
  assert.match(status.label, /没有配置/);
});

test("公开版为银月、梅凝建立一对一可打断语音会话", () => {
  const officialVoices = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
  assert.equal(CHAT_CHARACTER_REGISTRY.length, 2);
  assert.deepEqual(CHAT_CHARACTER_REGISTRY.map((item) => item.id), ["yinyue", "meining"]);
  const config = buildOpenAIRealtimeSessionConfig({
    speaker: "yinyue",
    personaContext: "只属于银月的角色卡",
    model: "gpt-realtime-2.1-mini",
  });
  assert.equal(config.type, "realtime");
  assert.equal(config.model, "gpt-realtime-2.1-mini");
  assert.deepEqual(config.output_modalities, ["audio"]);
  assert.equal(config.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  assert.equal(config.audio.input.turn_detection.create_response, true);
  assert.ok(officialVoices.has(config.audio.output.voice));
  assert.match(config.instructions, /只扮演银月/);
  assert.match(config.instructions, /只属于银月/);
});

test("transcription is opt-in and model choice is allowlisted", () => {
  const plain = buildOpenAIRealtimeSessionConfig({ speaker: "yinyue", personaContext: "角色卡" });
  assert.equal(plain.audio.input.transcription, undefined);
  const transcribed = buildOpenAIRealtimeSessionConfig({
    speaker: "yinyue",
    personaContext: "角色卡",
    includeTranscription: true,
    model: "gpt-realtime-2.1",
  });
  assert.equal(transcribed.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(transcribed.model, "gpt-realtime-2.1");
  assert.throws(
    () => buildOpenAIRealtimeSessionConfig({ speaker: "yinyue", personaContext: "角色卡", model: "untrusted-model" }),
    (error) => error.code === "OPENAI_REALTIME_UNKNOWN_MODEL",
  );
});

test("WebRTC offer is exchanged server-side and secret is never returned", async () => {
  let capturedSession = null;
  const result = await createOpenAIRealtimeCall({
    sdp: "v=0\r\no=test-offer",
    speaker: "yinyue",
    model: "gpt-realtime-2.1-mini",
    vaultRoot: "/unused",
    apiKey: "test-openai-secret",
    personaReader: async (_root, speakers) => {
      assert.deepEqual(speakers, ["yinyue"]);
      return "银月公开工作设定";
    },
    fetchImpl: async (url, init) => {
      assert.equal(url, OPENAI_REALTIME_API_URL);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer test-openai-secret");
      assert.equal(init.body.get("sdp"), "v=0\r\no=test-offer");
      capturedSession = JSON.parse(init.body.get("session"));
      return new Response("v=0\r\no=test-answer", { status: 201, headers: { "content-type": "application/sdp" } });
    },
  });
  assert.equal(capturedSession.model, "gpt-realtime-2.1-mini");
  assert.match(capturedSession.instructions, /银月公开工作设定/);
  assert.equal(result.answerSdp, "v=0\r\no=test-answer");
  assert.doesNotMatch(JSON.stringify(result), /test-openai-secret/);
});

test("OpenAI auth and credit failures become stable local errors", async () => {
  const base = {
    sdp: "v=0\r\no=test-offer",
    speaker: "yinyue",
    vaultRoot: "/unused",
    apiKey: "test-openai-secret",
    personaReader: async () => "角色卡",
  };
  await assert.rejects(
    createOpenAIRealtimeCall({ ...base, fetchImpl: async () => new Response("no", { status: 401 }) }),
    (error) => error.code === "OPENAI_REALTIME_AUTH_FAILED" && !/test-openai-secret/.test(error.message),
  );
  await assert.rejects(
    createOpenAIRealtimeCall({ ...base, fetchImpl: async () => new Response("no", { status: 429 }) }),
    (error) => error.code === "OPENAI_REALTIME_CREDITS_OR_RATE_LIMIT",
  );
});

test("paid OpenAI Realtime UI is hidden behind one restore switch while implementation stays intact", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/components/SecretaryRealtimeVoice.tsx", import.meta.url), "utf8"));
  assert.match(source, /普通对话/);
  assert.match(source, /混合实时/);
  assert.match(source, /不是端到端实时音频模型/);
  assert.match(source, /export const OPENAI_REALTIME_UI_ENABLED = false/);
  assert.match(source, /export const HYBRID_REALTIME_UI_ENABLED = false/);
  assert.match(source, /if \(!HYBRID_REALTIME_UI_ENABLED && !OPENAI_REALTIME_UI_ENABLED\) return null/);
  assert.match(source, /OPENAI_REALTIME_UI_ENABLED \? \(/);
  assert.match(source, /HYBRID_REALTIME_UI_ENABLED \? \(/);
  assert.match(source, /OpenAI 原生实时/);
  assert.match(source, /gpt-realtime-2\.1-mini/);
  assert.match(source, /gpt-realtime-2\.1/);
});

test("hybrid voice keeps external text models and wires barge-in plus segmented TTS", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8"));
  assert.match(source, /fetch\("\/api\/ai\/query"/);
  assert.match(source, /hybrid: true/);
  assert.match(source, /controller\.current\?\.abort\(\)/);
  assert.match(source, /takeHybridSpeechChunks\(hybridSpeechBuffer/);
  assert.match(source, /speakAsSecretary\(chunk, \{ enabled: true, speaker: activeSecretaryId, append: true \}/);
});

test("native hybrid recognition finalizes a spoken phrase after silence", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../native/SecretaryApp.swift", import.meta.url), "utf8"));
  assert.match(source, /private var nativeSpeechSilenceWorkItem: DispatchWorkItem\?/);
  assert.match(source, /if transcriptChanged \{ self\.scheduleNativeSpeechFinalization\(\) \}/);
  assert.match(source, /DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ 0\.9, execute: workItem\)/);
  assert.match(source, /self\.stopNativeSpeechRecognition\(\)/);
});
