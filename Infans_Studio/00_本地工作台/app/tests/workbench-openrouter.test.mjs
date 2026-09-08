import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENROUTER_MODEL,
  openRouterStatus,
  parseOpenRouterSseEvent,
  readOpenRouterApiKey,
  streamOpenRouterChat,
} from "../src/server/workbench-openrouter.mjs";

test("OpenRouter key stays in Keychain reader and status never exposes it", async () => {
  const execFileImpl = async (_file, args) => {
    assert.deepEqual(args.slice(-5), ["-a", "Infans", "-s", "Infans OpenRouter API", "-w"]);
    return { stdout: "test-secret-key\n" };
  };
  assert.equal(await readOpenRouterApiKey({ execFileImpl }), "test-secret-key");
  const status = await openRouterStatus({ execFileImpl });
  assert.equal(status.available, true);
  assert.equal(status.model, OPENROUTER_MODEL);
  assert.doesNotMatch(JSON.stringify(status), /test-secret-key/);
});

test("OpenRouter live status validates key and exposes only safe limit metadata", async () => {
  const status = await openRouterStatus({
    apiKey: "test-secret-key",
    probe: true,
    cache: false,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer test-secret-key");
      return new Response(JSON.stringify({ data: { usage: 0.25, limit: 10, limit_remaining: 9.75 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(status.available, true);
  assert.equal(status.health, "ok");
  assert.equal(status.limitRemainingUsd, 9.75);
  assert.doesNotMatch(JSON.stringify(status), /test-secret-key/);
});

test("OpenRouter live status marks an exhausted key unavailable", async () => {
  const status = await openRouterStatus({
    apiKey: "test-secret-key",
    probe: true,
    cache: false,
    fetchImpl: async () => new Response(JSON.stringify({ data: { usage: 3, limit: 3, limit_remaining: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(status.available, false);
  assert.equal(status.health, "credits_required");
});

test("OpenRouter SSE parser ignores keepalive and reads chunks and errors", () => {
  assert.deepEqual(parseOpenRouterSseEvent(": OPENROUTER PROCESSING"), { ignored: true });
  assert.deepEqual(parseOpenRouterSseEvent("data: [DONE]"), { done: true });
  assert.equal(parseOpenRouterSseEvent('data: {"choices":[{"delta":{"content":"你好"}}]}').text, "你好");
  const failed = parseOpenRouterSseEvent('data: {"error":{"code":402,"message":"Insufficient credits"}}');
  assert.equal(failed.error.code, "OPENROUTER_CREDITS_REQUIRED");
});

test("OpenRouter stream helper does not hardcode the author's private model", async () => {
  const encoder = new TextEncoder();
  const chunks = [];
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer test-secret-key");
    assert.match(init.headers["X-Title"], /^[\x20-\x7e]+$/);
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, OPENROUTER_MODEL);
    assert.equal(payload.stream, true);
    assert.equal(payload.provider.data_collection, "deny");
    assert.equal(payload.provider.allow_fallbacks, false);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.temperature, 0.55);
    assert.equal(payload.max_tokens, 320);
    assert.equal(init.headers["X-Title"], "Infans Secretary Chat");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"【梅'));
        controller.enqueue(encoder.encode('凝】\\n你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "x-generation-id": "gen-test" } });
  };
  const result = await streamOpenRouterChat({
    systemPrompt: "只做一对一回答",
    question: "你好",
    apiKey: "test-secret-key",
    fetchImpl,
    onChunk: (text) => chunks.push(text),
    temperature: 0.55,
    maxTokens: 320,
    requestTitle: "Infans Secretary Chat",
  });
  assert.equal(result.answer, "【梅凝】\n你好");
  assert.deepEqual(chunks, ["【梅凝】\n你", "好"]);
  assert.equal(result.generationId, "gen-test");
});

test("OpenRouter 402 becomes a recharge message without leaking provider detail", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { code: 402, message: "Insufficient credits for test-secret-key" },
  }), { status: 402, headers: { "content-type": "application/json" } });
  await assert.rejects(
    streamOpenRouterChat({ systemPrompt: "x", question: "y", apiKey: "test-secret-key", fetchImpl }),
    (error) => error.code === "OPENROUTER_CREDITS_REQUIRED"
      && /充值/.test(error.message)
      && !/test-secret-key/.test(error.message),
  );
});
