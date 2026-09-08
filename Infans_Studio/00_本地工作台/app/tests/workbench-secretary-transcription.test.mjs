import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { assertCodexCommandDeviceAccess } from "../src/server/workbench-codex-command-inbox.mjs";
import {
  SECRETARY_TRANSCRIPTION_LIMITS,
  SECRETARY_TRANSCRIPTION_PROTOCOL_ID,
  createSecretaryTranscriptionRouteHandler,
  createSecretaryTranscriptionService,
  encodeSecretaryTranscriptionHints,
} from "../src/server/workbench-secretary-transcription.mjs";

const RECORDING_ID = "voice_20260902_0001";
const TOKEN = "transcription-device-token-that-is-long-enough-0001";

async function temporaryRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function audioRequest(body = "test-audio", overrides = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const request = Readable.from([bytes]);
  request.headers = {
    "content-type": "audio/mp4",
    "content-length": String(bytes.length),
    "x-infans-recording-id": RECORDING_ID,
    "x-infans-duration-ms": "1250",
    "x-infans-language": "zh-CN",
    "x-infans-proper-noun-hints": encodeSecretaryTranscriptionHints(["银月", "Capoo", "银月"]),
    ...overrides,
  };
  return request;
}

function fakeProvider(transcribe, overrides = {}) {
  return {
    id: "fake-contract-provider",
    describe() {
      return {
        id: "fake-contract-provider",
        label: "测试 provider 已就绪",
        state: "ready",
        configured: true,
        available: true,
        model: "fake-contract-model",
        version: "test-only",
        execution: "local-library",
        capabilities: {
          properNounHints: true,
          segments: true,
          confidence: true,
          languageDetection: true,
          cancellation: true,
        },
        secretThatMustNotLeak: "never-return-this",
        ...overrides,
      };
    },
    transcribe,
  };
}

test("default provider is explicitly unconfigured and never claims a model", async (t) => {
  const service = createSecretaryTranscriptionService({ temporaryRoot: await temporaryRoot(t, "transcription-disabled") });
  const status = await service.status();
  assert.equal(status.protocol.id, SECRETARY_TRANSCRIPTION_PROTOCOL_ID);
  assert.equal(status.available, false);
  assert.equal(status.provider.id, "unconfigured");
  assert.equal(status.provider.state, "unconfigured");
  assert.equal(status.provider.model, null);
  assert.equal(status.capabilities.persistence, "none");
  assert.equal(status.capabilities.temporaryAudio, "deleted-after-request");
  assert.equal(status.capabilities.input.maximumBytes, 5 * 1024 * 1024);
  assert.equal(status.capabilities.input.maximumDurationMs, 90_000);
  assert.equal(status.capabilities.hints.encoding, "base64url-json-string-array");
  assert.doesNotMatch(JSON.stringify(status), /never-return-this|command|token|path/u);
  await assert.rejects(
    service.transcribe(audioRequest()),
    (error) => error?.status === 503 && error?.code === "TRANSCRIPTION_PROVIDER_UNCONFIGURED",
  );
});

test("an injected provider receives one private temporary file and structured hints, then the adapter removes it", async (t) => {
  const root = await temporaryRoot(t, "transcription-contract");
  let observedPath = "";
  const service = createSecretaryTranscriptionService({
    temporaryRoot: root,
    now: () => new Date("2026-09-02T12:34:56+09:00"),
    provider: fakeProvider(async (input) => {
      observedPath = input.filePath;
      assert.equal((await fs.stat(input.filePath)).isFile(), true);
      assert.equal((await fs.stat(input.filePath)).mode & 0o777, 0o600);
      assert.equal((await fs.readFile(input.filePath)).toString(), "test-audio");
      assert.equal(input.recordingId, RECORDING_ID);
      assert.equal(input.mimeType, "audio/mp4");
      assert.equal(input.durationMs, 1250);
      assert.equal(input.language, "zh-CN");
      assert.deepEqual(input.properNounHints, ["银月", "Capoo"]);
      assert.equal(input.signal.aborted, false);
      return {
        text: "银月在这里。",
        language: "zh-CN",
        confidence: 0.91,
        segments: [{ startMs: 0, endMs: 1100, text: "银月在这里。", confidence: 0.9 }],
      };
    }),
  });
  const result = await service.transcribe(audioRequest());
  assert.equal(result.recordingId, RECORDING_ID);
  assert.equal(result.duplicate, false);
  assert.equal(result.transcript.text, "银月在这里。");
  assert.equal(result.transcript.language, "zh-CN");
  assert.equal(result.transcript.segments[0].endMs, 1100);
  assert.deepEqual(result.request.properNounHints, ["银月", "Capoo"]);
  assert.equal(result.provider.id, "fake-contract-provider");
  assert.equal(result.retention.audioPersisted, false);
  assert.equal(result.retention.transcriptPersisted, false);
  assert.equal(result.completedAt, "2026-09-02T03:34:56.000Z");
  await assert.rejects(fs.stat(observedPath), (error) => error?.code === "ENOENT");
  assert.deepEqual(await fs.readdir(root), []);
});

test("MIME, actual bytes, declared duration, stable recordingId and hint bounds fail closed", async (t) => {
  const root = await temporaryRoot(t, "transcription-validation");
  const service = createSecretaryTranscriptionService({
    temporaryRoot: root,
    limits: { maximumBytes: 3, maximumDurationMs: 2_000, allowedMimeTypes: ["audio/mp4"] },
    provider: fakeProvider(async () => ({ text: "unused" })),
  });
  const cases = [
    [audioRequest("a", { "content-type": "application/octet-stream" }), "TRANSCRIPTION_MIME_UNSUPPORTED"],
    [audioRequest("a", { "x-infans-duration-ms": "0" }), "TRANSCRIPTION_DURATION_INVALID"],
    [audioRequest("a", { "x-infans-duration-ms": "2001" }), "TRANSCRIPTION_AUDIO_TOO_LONG"],
    [audioRequest("a", { "x-infans-recording-id": "short" }), "TRANSCRIPTION_RECORDING_ID_INVALID"],
    [audioRequest("four", { "content-length": "" }), "TRANSCRIPTION_AUDIO_TOO_LARGE"],
    [audioRequest("a", { "x-infans-proper-noun-hints": "not+base64" }), "TRANSCRIPTION_HINTS_INVALID"],
  ];
  for (const [request, code] of cases) {
    await assert.rejects(service.transcribe(request), (error) => error?.code === code, code);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("recordingId retries are memory-idempotent and conflicting content is rejected", async (t) => {
  const root = await temporaryRoot(t, "transcription-idempotency");
  let calls = 0;
  const service = createSecretaryTranscriptionService({
    temporaryRoot: root,
    provider: fakeProvider(async () => {
      calls += 1;
      return { text: "同一份转写", language: "zh-CN" };
    }),
  });
  const first = await service.transcribe(audioRequest("same-audio"));
  const retry = await service.transcribe(audioRequest("same-audio"));
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.transcript.text, first.transcript.text);
  assert.equal(calls, 1);
  await assert.rejects(
    service.transcribe(audioRequest("different-audio")),
    (error) => error?.status === 409 && error?.code === "TRANSCRIPTION_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(calls, 1);
});

test("concurrent identical retries share one provider operation", async (t) => {
  const root = await temporaryRoot(t, "transcription-concurrent");
  let calls = 0;
  let startedResolve;
  let finishResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const finish = new Promise((resolve) => { finishResolve = resolve; });
  const service = createSecretaryTranscriptionService({
    temporaryRoot: root,
    provider: fakeProvider(async () => {
      calls += 1;
      startedResolve();
      await finish;
      return { text: "并发重试" };
    }),
  });
  const first = service.transcribe(audioRequest("same-concurrent-audio"));
  await started;
  const second = service.transcribe(audioRequest("same-concurrent-audio"));
  finishResolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(firstResult.duplicate, false);
  assert.equal(secondResult.duplicate, true);
});

test("timeout aborts the provider, returns a stable error and removes temporary audio", async (t) => {
  const root = await temporaryRoot(t, "transcription-timeout");
  let aborted = false;
  let observedPath = "";
  const service = createSecretaryTranscriptionService({
    temporaryRoot: root,
    timeoutMs: 20,
    provider: fakeProvider((input) => new Promise((_resolve, reject) => {
      observedPath = input.filePath;
      input.signal.addEventListener("abort", () => {
        aborted = true;
        reject(input.signal.reason);
      }, { once: true });
    })),
  });
  await assert.rejects(
    service.transcribe(audioRequest()),
    (error) => error?.status === 504 && error?.code === "TRANSCRIPTION_TIMEOUT",
  );
  assert.equal(aborted, true);
  await assert.rejects(fs.stat(observedPath), (error) => error?.code === "ENOENT");
  assert.equal((await service.status()).runtime.activeRequests, 0);
});

test("explicit cancellation addresses the active stable recordingId and does not cache a transcript", async (t) => {
  const root = await temporaryRoot(t, "transcription-cancel");
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const service = createSecretaryTranscriptionService({
    temporaryRoot: root,
    provider: fakeProvider((input) => new Promise((_resolve, reject) => {
      startedResolve();
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    })),
  });
  const running = service.transcribe(audioRequest());
  await started;
  const receipt = service.cancel({ recordingId: RECORDING_ID });
  assert.deepEqual(receipt, { recordingId: RECORDING_ID, cancelled: true, duplicate: false, state: "cancelling" });
  await assert.rejects(running, (error) => error?.status === 499 && error?.code === "TRANSCRIPTION_CANCELLED");
  assert.equal((await service.status()).runtime.cachedResults, 0);
  assert.deepEqual(service.cancel({ recordingId: RECORDING_ID }), {
    recordingId: RECORDING_ID,
    cancelled: false,
    state: "not_found",
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

function transcriptionRoute(service) {
  return createSecretaryTranscriptionRouteHandler({
    service,
    authorize: (request, accessOptions) => assertCodexCommandDeviceAccess(request, "", TOKEN, accessOptions),
  });
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
  return {
    status: response.statusCode,
    headers: response.headers,
    body: JSON.parse(responseBody.toString("utf8") || "{}"),
  };
}

test("transcription routes reuse the mobile Bearer gate and report unconfigured without pretending success", async (t) => {
  const root = await temporaryRoot(t, "transcription-route-disabled");
  const service = createSecretaryTranscriptionService({ temporaryRoot: root });
  const route = transcriptionRoute(service);
  {
    const denied = await invokeRoute(route, "/status", {
      headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "CODEX_COMMAND_DEVICE_DENIED");

    const status = await invokeRoute(route, "/status", {
      headers: authorizedHeaders(),
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.available, false);
    assert.equal(status.body.provider.state, "unconfigured");
    assert.equal(status.headers["cache-control"], "private, no-store, max-age=0");

    const unavailable = await invokeRoute(route, "/", {
      method: "POST",
      headers: authorizedHeaders(audioRequest().headers),
      body: "test-audio",
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, "TRANSCRIPTION_PROVIDER_UNCONFIGURED");
  }
});

test("thin HTTP adapter passes raw audio and base64url proper-noun hints to an injected provider", async (t) => {
  const root = await temporaryRoot(t, "transcription-route-fake");
  const service = createSecretaryTranscriptionService({
    temporaryRoot: root,
    provider: fakeProvider(async (input) => {
      assert.deepEqual(input.properNounHints, ["银月", "Capoo"]);
      return { text: "路由契约通过", language: "zh-CN" };
    }),
  });
  const route = transcriptionRoute(service);
  {
    const request = audioRequest();
    const response = await invokeRoute(route, "/", {
      method: "POST",
      headers: authorizedHeaders(request.headers),
      body: "test-audio",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.transcript.text, "路由契约通过");
    assert.equal(response.body.recordingId, RECORDING_ID);

    const cancel = await invokeRoute(route, "/cancel", {
      method: "POST",
      headers: authorizedHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ recordingId: RECORDING_ID }),
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.state, "completed");
  }
});

test("workbench registers the specific transcription route before the shared mobile route", async () => {
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const transcriptionStart = routes.indexOf('router.use("/api/secretary-mobile/transcription"');
  const mobileStart = routes.indexOf('router.use("/api/secretary-mobile",', transcriptionStart);
  assert.ok(transcriptionStart > 0 && mobileStart > transcriptionStart);
  const block = routes.slice(transcriptionStart, mobileStart);
  assert.match(block, /createSecretaryTranscriptionRouteHandler/u);
  assert.match(block, /assertCodexCommandDeviceAccess/u);
  assert.match(block, /codexCommandToken/u);
  assert.match(routes, /secretaryTranscription\.dispose\(\)/u);
  assert.equal(SECRETARY_TRANSCRIPTION_LIMITS.allowedMimeTypes.includes("audio/mp4"), true);
});
