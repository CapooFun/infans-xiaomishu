import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { assertCodexCommandDeviceAccess } from "../src/server/workbench-codex-command-inbox.mjs";
import { createSecretaryTranscriptionRouteHandler, createSecretaryTranscriptionService } from "../src/server/workbench-secretary-transcription.mjs";
import {
  WHISPERKIT_PROVIDER_ID,
  createWhisperKitSecretaryTranscriptionProvider,
  whisperKitProviderOptionsFromEnvironment,
} from "../src/server/workbench-secretary-whisperkit.mjs";

const TOKEN = "voice-input-route-token-that-is-long-enough-0001";

test("WhisperKit provider only accepts loopback and maps the local OpenAI Audio API contract", async () => {
  const calls = [];
  const provider = createWhisperKitSecretaryTranscriptionProvider({
    baseUrl: "http://127.0.0.1:50060/v1/",
    model: "large-v3-v20240930_626MB",
    readFile: async () => Buffer.from("fake-m4a"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET") {
        assert.equal(url, "http://127.0.0.1:50060/health");
        return Response.json({ status: "ok" });
      }
      assert.equal(url, "http://127.0.0.1:50060/v1/audio/transcriptions");
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("model"), "large-v3-v20240930_626MB");
      assert.equal(options.body.get("language"), "zh");
      assert.equal(options.body.get("response_format"), "verbose_json");
      assert.equal(options.body.get("timestamp_granularities[]"), "segment");
      assert.match(options.body.get("prompt"), /银月、Capoo/u);
      assert.equal(options.body.get("file").type, "audio/mp4");
      return Response.json({
        text: "银月在这里。",
        language: "zh",
        segments: [{ start: 0, end: 1.1, text: "银月在这里。" }],
      });
    },
  });
  const status = await provider.describe();
  assert.equal(status.id, WHISPERKIT_PROVIDER_ID);
  assert.equal(status.available, true);
  assert.equal((await provider.describe()).available, true);
  const controller = new AbortController();
  const result = await provider.transcribe({
    filePath: "/private/tmp/recording.m4a",
    mimeType: "audio/mp4",
    language: "zh-CN",
    properNounHints: ["银月", "Capoo"],
    signal: controller.signal,
  });
  assert.equal(result.text, "银月在这里。");
  assert.deepEqual(result.segments, [{ startMs: 0, endMs: 1100, text: "银月在这里。" }]);
  assert.equal(calls.length, 2);
  assert.throws(
    () => createWhisperKitSecretaryTranscriptionProvider({ baseUrl: "https://example.com/v1", model: "tiny" }),
    /loopback HTTP/u,
  );
});

test("WhisperKit environment opt-in never guesses a model", () => {
  assert.equal(whisperKitProviderOptionsFromEnvironment({}), null);
  assert.equal(whisperKitProviderOptionsFromEnvironment({ INFANS_SECRETARY_TRANSCRIPTION_PROVIDER: "whisperkit" }), null);
  assert.deepEqual(whisperKitProviderOptionsFromEnvironment({
    INFANS_SECRETARY_TRANSCRIPTION_PROVIDER: "whisperkit",
    INFANS_WHISPERKIT_MODEL: "small",
  }), {
    baseUrl: "http://127.0.0.1:50060/v1",
    model: "small",
  });
});

function authorizedHeaders(extra = {}) {
  return {
    host: "127.0.0.1:5173",
    origin: "http://127.0.0.1:5173",
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  };
}

async function invokeRoute(handler, pathname, options = {}) {
  const bytes = Buffer.from(options.body || "");
  const request = Readable.from(bytes.length ? [bytes] : []);
  request.url = pathname;
  request.method = options.method || "GET";
  request.headers = options.headers || {};
  request.socket = { remoteAddress: "127.0.0.1" };
  const response = new EventEmitter();
  response.headersSent = false;
  response.headers = {};
  response.setHeader = (name, value) => { response.headers[String(name).toLowerCase()] = String(value); };
  let responseBody = Buffer.alloc(0);
  response.end = (body = Buffer.alloc(0)) => {
    response.headersSent = true;
    responseBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  };
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(responseBody.toString("utf8") || "{}") };
}

test("single-recording routes keep status, transcription and cancellation while retired voice-composer routes stay absent", async () => {
  const service = createSecretaryTranscriptionService({
    provider: {
      id: "test-local-transcriber",
      describe() {
        return {
          id: "test-local-transcriber",
          label: "测试本地转写已就绪",
          state: "ready",
          configured: true,
          available: true,
          execution: "local-process",
          capabilities: { properNounHints: true, cancellation: true },
        };
      },
      async transcribe() { return { text: "普通单段原声已转写。", language: "zh" }; },
    },
  });
  const route = createSecretaryTranscriptionRouteHandler({
    service,
    authorize: (request, accessOptions) => assertCodexCommandDeviceAccess(request, "", TOKEN, accessOptions),
  });
  const denied = await invokeRoute(route, "/status", { headers: { host: "127.0.0.1:5173" } });
  assert.equal(denied.status, 403);

  const status = await invokeRoute(route, "/status", { headers: authorizedHeaders() });
  assert.equal(status.status, 200);
  assert.deepEqual(Object.keys(status.body.endpoints).sort(), ["cancel", "status", "transcribe"]);
  assert.equal(Object.hasOwn(status.body, "voiceComposer"), false);

  const transcription = await invokeRoute(route, "/", {
    method: "POST",
    headers: authorizedHeaders({
      "content-type": "audio/mp4",
      "x-infans-recording-id": "iosvoice_single_20260903",
      "x-infans-duration-ms": "3500",
      "x-infans-language": "zh-CN",
    }),
    body: Buffer.from("single-private-audio"),
  });
  assert.equal(transcription.status, 200);
  assert.equal(transcription.body.recordingId, "iosvoice_single_20260903");
  assert.equal(transcription.body.transcript.text, "普通单段原声已转写。");

  const cancel = await invokeRoute(route, "/cancel", {
    method: "POST",
    headers: authorizedHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ recordingId: "iosvoice_single_20260903" }),
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.state, "completed");

  const retired = await invokeRoute(route, "/voice/segments", {
    method: "POST",
    headers: authorizedHeaders({ "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(retired.status, 404);
  assert.equal(retired.body.code, "TRANSCRIPTION_ROUTE_NOT_FOUND");
});

test("workbench route source wires only environment-gated single-recording transcription", async () => {
  const [routes, transcription] = await Promise.all([
    fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/server/workbench-secretary-transcription.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(routes, /whisperKitProviderOptionsFromEnvironment/u);
  assert.match(routes, /createWhisperKitSecretaryTranscriptionProvider/u);
  assert.doesNotMatch(routes, /SecretaryVoiceComposer|secretaryVoiceComposer|secretaryVoiceComposerOptions/u);
  assert.doesNotMatch(transcription, /voiceComposer|\/voice\//u);
});

test("local startup enables the installed model and its LaunchAgent stays loopback-only", async () => {
  const [startup, installer] = await Promise.all([
    fs.readFile(new URL("../scripts/start-local.sh", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/install-whisperkit-local-service.sh", import.meta.url), "utf8"),
  ]);
  assert.match(startup, /INFANS_SECRETARY_TRANSCRIPTION_PROVIDER/u);
  assert.match(startup, /large-v3-v20240930_626MB/u);
  assert.match(installer, /com\.capoo\.infans-whisperkit-local/u);
  assert.match(installer, /KeepAlive/u);
  assert.match(installer, /127\.0\.0\.1/u);
  assert.doesNotMatch(installer, /0\.0\.0\.0/u);
});
