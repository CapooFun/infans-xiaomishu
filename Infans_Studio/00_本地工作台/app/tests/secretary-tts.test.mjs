import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getSecretarySpeechRatePreset,
  getSecretarySpeechState,
  isAutoplayBlockedError,
  isSecretarySpeechBlocked,
  isNativeSecretaryTalking,
  SECRETARY_SPEECH_STATE_EVENT,
  onSecretarySpeechState,
  onSecretarySpeechFallback,
  secretarySpeechFallbackMessage,
  prepareSecretarySpeechText,
  pickSecretaryVoice,
  publishSecretarySpeechState,
  speakAsSecretary,
  speakSecretaryTurns,
  setSecretarySpeechRatePreset,
  stopSecretarySpeech,
  takeHybridSpeechChunks,
} from "../src/secretary-tts.ts";
import {
  adjustSecretaryEdgeSpeechRate,
  adjustSecretaryWebSpeechRate,
  normalizeSecretarySpeechRatePreset,
} from "../src/secretary-speech-rate.mjs";
import {
  SECRETARY_EDGE_VOICE,
  prepareSecretarySpeechText as prepareServer,
  synthesizeSecretaryEdgeSpeech,
} from "../src/server/workbench-tts.mjs";
import {
  detectSpeechLang,
  edgeVoiceForSecretary,
  segmentSpeechByLang,
  prosodyForSecretary,
  stripErhuaForSpeech,
  voiceForSpeechLang,
} from "../src/secretary-speech-lang.mjs";

const routesSource = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");

test("prepareSecretarySpeechText strips fences and actions json", () => {
  const text = prepareSecretarySpeechText('嗨呀公子～\n```json\n{"actions":[{"kind":"addTodo"}]}\n```');
  assert.match(text, /嗨呀公子/);
  assert.doesNotMatch(text, /actions/);
});

test("prepareSecretarySpeechText smooths choppy ellipses for TTS", () => {
  const text = prepareSecretarySpeechText("唔……先等等……咕咚。嗯……哈啊……");
  assert.doesNotMatch(text, /…|\.\.\./);
  assert.match(text, /唔，先等等，咕咚/);
  assert.equal(prepareServer("唔……先等等……咕咚。"), prepareSecretarySpeechText("唔……先等等……咕咚。"));
});

test("hybrid speech chunker releases natural sentences early and flushes the tail", () => {
  const first = takeHybridSpeechChunks("先说完整的第一句。第二句还在生成");
  assert.deepEqual(first.chunks, ["先说完整的第一句。"]);
  assert.equal(first.remainder, "第二句还在生成");
  const flushed = takeHybridSpeechChunks(first.remainder, true);
  assert.deepEqual(flushed.chunks, ["第二句还在生成"]);
  assert.equal(flushed.remainder, "");
});

test("stripErhuaForSpeech removes spoken erhua but keeps real 儿 words", () => {
  assert.equal(stripErhuaForSpeech("过来坐会儿，这儿有点儿意思。"), "过来坐会，这里有点意思。");
  assert.equal(stripErhuaForSpeech("女儿在幼儿园等一会儿。"), "女儿在幼儿园等一会。");
  assert.equal(prepareSecretarySpeechText("待会儿一块儿干活儿。"), prepareServer("待会儿一块儿干活儿。"));
  assert.match(prepareSecretarySpeechText("待会儿一块儿干活儿。"), /待会一块干活/);
});

test("server prepareSecretarySpeechText matches client cleaning", () => {
  const raw = '人家来啦～\n```json\n{"actions":[]}\n```';
  assert.equal(prepareServer(raw), prepareSecretarySpeechText(raw));
  assert.equal(SECRETARY_EDGE_VOICE, "zh-CN-XiaoxiaoNeural");
});

test("detectSpeechLang covers zh ja en la", () => {
  assert.equal(detectSpeechLang("公子，人家来了。"), "zh");
  assert.equal(detectSpeechLang("今日はとても良い天気ですね。"), "ja");
  assert.equal(detectSpeechLang("Hello, how are you today?"), "en");
  assert.equal(detectSpeechLang("Amor vincit omnia. Vita brevis est."), "la");
  assert.equal(voiceForSpeechLang("ja"), "ja-JP-NanamiNeural");
  assert.equal(voiceForSpeechLang("la"), "it-IT-ElsaNeural");
});

test("edgeVoiceForSecretary only uses available Edge voices and keeps two secretaries distinct", () => {
  assert.equal(edgeVoiceForSecretary("meining", "zh"), "zh-CN-XiaoxiaoNeural");
  assert.equal(edgeVoiceForSecretary("yinyue", "zh"), "zh-CN-XiaoxiaoNeural");
  assert.equal(edgeVoiceForSecretary("yinyue", "ja"), "zh-CN-XiaoxiaoNeural");
  assert.equal(edgeVoiceForSecretary("meining", "ja"), "ja-JP-NanamiNeural");
  assert.notDeepEqual(prosodyForSecretary("yinyue", "zh"), prosodyForSecretary("meining", "zh"));
});

test("segmentSpeechByLang splits mixed zh/ja sentences", () => {
  const segments = segmentSpeechByLang("先听这句日语。こんにちは。再回中文。");
  assert.ok(segments.some((item) => item.lang === "ja"));
  assert.ok(segments.some((item) => item.lang === "zh"));
});

test("pickSecretaryVoice prefers Chinese female-like names", () => {
  const voices = [
    { name: "Alex", lang: "en-US", localService: true, default: false, voiceURI: "a" },
    { name: "Tingting", lang: "zh-CN", localService: true, default: false, voiceURI: "b" },
    { name: "Daniel", lang: "zh-CN", localService: true, default: false, voiceURI: "c" },
  ];
  const picked = pickSecretaryVoice(voices);
  assert.equal(picked?.name, "Tingting");
});

test("speech state publishes DOM and native bridge events for real playback boundaries", () => {
  const originalWindow = globalThis.window;
  const bridgeMessages = [];
  const domEvents = [];
  const listenerStates = [];
  globalThis.window = {
    dispatchEvent(event) {
      domEvents.push({ type: event.type, detail: event.detail });
      return true;
    },
    speechSynthesis: { cancel() {} },
    webkit: {
      messageHandlers: {
        secretaryPet: { postMessage(payload) { bridgeMessages.push(payload); } },
      },
    },
  };
  const unsubscribe = onSecretarySpeechState((state) => listenerStates.push(state));
  try {
    publishSecretarySpeechState(true, "meining");
    assert.deepEqual(getSecretarySpeechState(), { active: true, speaker: "meining" });
    assert.equal(isNativeSecretaryTalking(), false);
    stopSecretarySpeech();
    assert.equal(getSecretarySpeechState().active, false);
    assert.equal(domEvents[0].type, SECRETARY_SPEECH_STATE_EVENT);
    assert.deepEqual(bridgeMessages[0], { type: "speech-state", active: true, speaker: "meining" });
    assert.deepEqual(bridgeMessages.at(-1), { type: "speech-state", active: false, speaker: "meining" });
    assert.deepEqual(listenerStates, [
      { active: true, speaker: "meining" },
      { active: false, speaker: "meining" },
    ]);
  } finally {
    unsubscribe();
    globalThis.window = originalWindow;
  }
});

test("native talking animation stays off unless the current speaker is 银月", () => {
  publishSecretarySpeechState(true, "meining");
  assert.equal(isNativeSecretaryTalking(), false);
  publishSecretarySpeechState(true, "yinyue");
  assert.equal(isNativeSecretaryTalking(), true);
  publishSecretarySpeechState(false, "yinyue");
  assert.equal(isNativeSecretaryTalking(), false);
});

test("autoplay block recognition covers browser rejection shapes", () => {
  assert.equal(isAutoplayBlockedError(Object.assign(new Error("autoplay blocked"), { name: "NotAllowedError" })), true);
  assert.equal(isAutoplayBlockedError(new Error("play() failed because the user didn't interact")), true);
  assert.equal(isAutoplayBlockedError(new Error("network failed")), false);
});

test("朗读失败文案让银月和梅凝可见，不换成作者私声", () => {
  assert.equal(secretarySpeechFallbackMessage({ from: "edge", to: "stop", code: "EDGE_TTS_FAILED", speaker: "yinyue" }), "银月朗读失败，先看文字");
  assert.equal(secretarySpeechFallbackMessage({ from: "edge", to: "stop", code: "EDGE_TTS_FAILED", speaker: "meining" }), "梅凝朗读失败，先看文字");
  assert.equal(secretarySpeechFallbackMessage({ from: "edge", to: "webspeech", code: "EDGE_TTS_FAILED", speaker: "meining" }), "普通朗读失败，先改用本机声线");
  const overlays = readFileSync(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
  assert.match(overlays, /onSecretarySpeechFallback\(\(event\) => onToast\(event\.message\)\)/);
  const tts = readFileSync(new URL("../src/secretary-tts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(tts, /缨宁/);
  assert.doesNotMatch(overlays, /缨宁朗读失败/);
});

test("speech rate presets normalize, persist and keep provider fallbacks safe", () => {
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  try {
    assert.equal(getSecretarySpeechRatePreset(), "normal");
    assert.equal(setSecretarySpeechRatePreset("slow"), "slow");
    assert.equal(getSecretarySpeechRatePreset(), "slow");
    assert.equal(setSecretarySpeechRatePreset("unsupported"), "normal");
    assert.equal(getSecretarySpeechRatePreset(), "normal");
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }

  assert.equal(normalizeSecretarySpeechRatePreset("unexpected"), "normal");
  assert.equal(adjustSecretaryEdgeSpeechRate("+10%", "slow"), "-23%");
  assert.equal(adjustSecretaryEdgeSpeechRate("+10%", "normal"), "+10%");
  assert.equal(adjustSecretaryEdgeSpeechRate("+10%", "fast"), "+65%");
  assert.equal(adjustSecretaryEdgeSpeechRate("invalid", "slow"), "-30%");
  assert.equal(adjustSecretaryWebSpeechRate(1.1, "slow"), 0.77);
  assert.equal(adjustSecretaryWebSpeechRate(1.1, "fast"), 1.6500000000000001);
  assert.equal(adjustSecretaryWebSpeechRate(1.1, "veryfast"), 2);
  assert.doesNotMatch(routesSource, /requestedRatePreset/);
});

test("speech playback state covers edge start/end, queues, stop, failure fallback and autoplay block", async () => {
  const originalWindow = globalThis.window;
  const originalAudio = globalThis.Audio;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const states = [];
  const requests = [];
  const webUtterances = [];
  const fallbacks = [];

  class FakeAudio {
    static instance;
    constructor() {
      FakeAudio.instance = this;
      this.playBehavior = () => Promise.resolve();
      this.pauseCount = 0;
      this._src = "";
      this.playbackRate = 1;
      this.listeners = {};
    }
    setAttribute() {}
    removeAttribute() {}
    load() {}
    pause() { this.pauseCount += 1; }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    set src(value) {
      this._src = value;
      this.playbackRate = 1;
    }
    get src() { return this._src; }
    play() {
      for (const fn of this.listeners.playing || []) fn();
      return this.playBehavior();
    }
  }
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const speechSynthesis = {
    speaking: false,
    cancel() {},
    getVoices() {
      return [{ name: "Tingting", lang: "zh-CN", localService: true, default: false, voiceURI: "fake" }];
    },
    addEventListener() {},
    removeEventListener() {},
    speak(utterance) {
      webUtterances.push(utterance);
      utterance.onstart?.();
    },
  };
  globalThis.Audio = FakeAudio;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, blob: async () => new Blob(["fake-audio"]) };
  };
  const values = new Map([["infans-secretary-speech-rate", "slow"]]);
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  globalThis.window = {
    dispatchEvent() { return true; },
    speechSynthesis,
    setTimeout,
  };
  const unsubscribe = onSecretarySpeechState((state) => states.push(state));
  const unsubscribeFallback = onSecretarySpeechFallback((event) => fallbacks.push(event));
  const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(message);
  };

  try {
    // Edge 正常播放：play() 成功后才说话，ended 后立即待机。
    assert.equal(speakAsSecretary("第一句", { enabled: true, speaker: "meining" }), true);
    await waitFor(() => getSecretarySpeechState().active, "Edge play did not publish active state");
    assert.deepEqual(getSecretarySpeechState(), { active: true, speaker: "meining" });
    assert.equal(FakeAudio.instance.playbackRate, 0.7);
    assert.equal(setSecretarySpeechRatePreset("fast"), "fast");
    assert.equal(FakeAudio.instance.playbackRate, 1.5);
    assert.equal(setSecretarySpeechRatePreset("slow"), "slow");
    assert.equal(FakeAudio.instance.playbackRate, 0.7);
    FakeAudio.instance.onended();
    await waitFor(() => !getSecretarySpeechState().active, "Edge ended did not clear state");

    // 连续队列按 speaker 依次切换；原生梅凝只在自己的片段说话。
    assert.equal(speakSecretaryTurns([
      { speaker: "meining", content: "梅凝发言" },
      { speaker: "yinyue", content: "银月发言" },
    ], { enabled: true }), true);
    await waitFor(() => getSecretarySpeechState().active && getSecretarySpeechState().speaker === "meining", "first queue item did not start");
    assert.equal(isNativeSecretaryTalking(), false);
    FakeAudio.instance.onended();
    await waitFor(() => getSecretarySpeechState().active && getSecretarySpeechState().speaker === "yinyue", "second queue item did not start");
    assert.equal(isNativeSecretaryTalking(), true);
    FakeAudio.instance.onended();
    await waitFor(() => !getSecretarySpeechState().active, "queue did not finish");

    // 主动停止清空当前播放状态。
    assert.equal(speakAsSecretary("停止测试", { enabled: true, speaker: "meining" }), true);
    await waitFor(() => getSecretarySpeechState().active, "stop case did not start");
    stopSecretarySpeech();
    assert.equal(getSecretarySpeechState().active, false);

    // Edge 播放失败时进入 Web Speech，并以 utterance 事件界定状态。
    FakeAudio.instance.playBehavior = () => Promise.reject(new Error("audio decoder failed"));
    assert.equal(speakAsSecretary("系统语音回退", { enabled: true, speaker: "meining" }), true);
    await waitFor(() => webUtterances.length > 0, "Web Speech fallback was not used");
    assert.deepEqual(getSecretarySpeechState(), { active: true, speaker: "meining" });
    assert.equal(fallbacks.at(-1)?.to, "webspeech");
    assert.equal(fallbacks.at(-1)?.message, "普通朗读失败，先改用本机声线");
    webUtterances.at(-1).onend?.();
    assert.equal(getSecretarySpeechState().active, false);

    // 银月 Edge 播放失败时保留文字，不换成系统日语女声。
    const yinyueFallbackCount = webUtterances.length;
    assert.equal(speakAsSecretary("今日は声线を変えない。", { enabled: true, speaker: "yinyue" }), true);
    await waitFor(() => requests.at(-1)?.speaker === "yinyue", "Yinyue request was not sent");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(webUtterances.length, yinyueFallbackCount);
    assert.deepEqual(getSecretarySpeechState(), { active: false, speaker: "yinyue" });
    assert.equal(fallbacks.at(-1)?.to, "stop");
    assert.equal(fallbacks.at(-1)?.speaker, "yinyue");
    assert.equal(fallbacks.at(-1)?.message, "银月朗读失败，先看文字");

    // 自动播放阻断时不假装已开始，也不误降级为 Web Speech。
    const webFallbackCount = webUtterances.length;
    FakeAudio.instance.playBehavior = () => Promise.reject(Object.assign(new Error("play() failed because the user didn't interact"), { name: "NotAllowedError" }));
    assert.equal(speakAsSecretary("自动播放阻断", { enabled: true, speaker: "meining" }), true);
    await waitFor(() => isSecretarySpeechBlocked(), "autoplay block was not exposed");
    assert.equal(getSecretarySpeechState().active, false);
    assert.equal(webUtterances.length, webFallbackCount);
    stopSecretarySpeech();
    assert.equal(isSecretarySpeechBlocked(), false);

    assert.deepEqual(requests.map((item) => item.speaker), ["meining", "meining", "yinyue", "meining", "meining", "yinyue", "meining"]);
    assert.ok(requests.every((item) => !("ratePreset" in item)));
    assert.equal(FakeAudio.instance.playbackRate, 0.7);
    assert.equal(FakeAudio.instance.preservesPitch, true);
    assert.equal(webUtterances.at(-1).rate, 0.756);
    assert.ok(states.some((state) => state.active && state.speaker === "yinyue"));
  } finally {
    unsubscribe();
    unsubscribeFallback();
    stopSecretarySpeech();
    globalThis.window = originalWindow;
    globalThis.Audio = originalAudio;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  }
});

test("synthesizeSecretaryEdgeSpeech keeps Yinyue voice for Japanese kana", {
  timeout: 20000,
  skip: process.env.INFANS_EDGE_TTS_INTEGRATION === "1" ? false : "需要显式开启联网 Edge TTS 集成测试",
}, async () => {
  const result = await synthesizeSecretaryEdgeSpeech("こんにちは、前輩。", { speaker: "yinyue" });
  assert.ok(result);
  assert.ok(result.audio.length > 1000);
  assert.deepEqual(result.langs, ["ja"]);
  assert.equal(result.voice, "zh-CN-XiaoyiNeural");
});
