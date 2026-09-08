import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecretaryVoicePlaybackService } from "../src/server/workbench-secretary-voice-playback.mjs";

async function tempRoot(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

test("mobile speech uses the Mac Edge voice and reuses a private cache without storing plaintext", async () => {
  const root = await tempRoot("secretary-voice-playback");
  const cacheDir = path.join(root, "cache");
  let syntheses = 0;
  const service = createSecretaryVoicePlaybackService(root, {
    cacheDir,
    synthesize: async (text, options) => {
      syntheses += 1;
      assert.equal(text, "你好，银月在这里")
      assert.equal(options.speaker, "yinyue")
      assert.equal(options.maxChars, 4_000)
      return {
        audio: Buffer.from("fake-mpeg-audio"),
        contentType: "audio/mpeg",
        voice: "zh-CN-XiaoxiaoNeural",
        voices: ["zh-CN-XiaoxiaoNeural"],
        langs: ["zh"],
        speaker: "yinyue",
      };
    },
  });

  const first = await service.synthesize({
    messageId: "reply-voice-message-0001",
    speaker: "yinyue",
    text: "你好，银月在这里。",
  });
  const second = await service.synthesize({
    messageId: "reply-voice-message-0002",
    speaker: "yinyue",
    text: "你好，银月在这里。",
  });

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(syntheses, 1);
  assert.equal(second.audio.toString(), "fake-mpeg-audio");
  assert.equal(service.status().defaultVoice, "zh-CN-XiaoxiaoNeural");
  assert.equal(service.status().deviceFallback, "none");

  const entries = await fs.readdir(cacheDir);
  assert.equal(entries.filter((name) => name.endsWith(".mp3")).length, 1);
  assert.equal(entries.filter((name) => name.endsWith(".json")).length, 1);
  const metadata = await fs.readFile(path.join(cacheDir, entries.find((name) => name.endsWith(".json"))), "utf8");
  assert.doesNotMatch(metadata, /前辈|银月在这里/u);
  const mode = (await fs.stat(cacheDir)).mode & 0o777;
  assert.equal(mode, 0o700);
});

test("mobile speech fails closed when synthesis is unavailable", async () => {
  const root = await tempRoot("secretary-voice-unavailable");
  const service = createSecretaryVoicePlaybackService(root, {
    cacheDir: path.join(root, "cache"),
    synthesize: async () => { throw new Error("network unavailable") },
  });
  await assert.rejects(
    service.synthesize({
      messageId: "reply-voice-message-0003",
      speaker: "yinyue",
      text: "文字仍然保留。",
    }),
    (error) => error?.status === 503 && error?.code === "SECRETARY_VOICE_SYNTHESIS_UNAVAILABLE",
  );
});

test("authenticated mobile route and native playback never fall back to the system voice", async () => {
  const [routes, native, playback] = await Promise.all([
    fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../native/InfansHealthSync/InfansHealthSync/SecretaryChatExperience.swift", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/server/workbench-secretary-voice-playback.mjs", import.meta.url), "utf8"),
  ]);
  const mobileBlock = routes.slice(
    routes.indexOf('router.use("/api/secretary-mobile"'),
    routes.indexOf('router.use("/api/secretary-attachments"'),
  );
  assert.match(mobileBlock, /assertCodexCommandDeviceAccess\(request, remoteWriteLogins, codexCommandToken/u);
  assert.match(mobileBlock, /sub === "\/tts"/u);
  assert.match(mobileBlock, /X-Secretary-Voice-Source", "mac-private-service"/u);
  assert.match(native, /api\/secretary-mobile\/tts/u);
  assert.match(native, /暂不可朗读，文字仍在/u);
  assert.match(native, /SecretaryVoicePlaybackBinding/u);
  assert.match(native, /AVAudioPlayer/u);
  assert.match(native, /secretary-mobile-edge-v2/u);
  assert.match(playback, /secretary-mobile-edge-v2/u);
  assert.doesNotMatch(native, /AVSpeechSynthesizer|AVSpeechUtterance|AVSpeechSynthesisVoice/u);
});
