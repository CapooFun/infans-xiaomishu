import test from "node:test";
import assert from "node:assert/strict";
import { parseWorldLaneBrief, displayWorldHeadline, rubyHtmlToSpeechText, sanitizeRubyHtml, parseWorldEventLane } from "../src/server/workbench-world-brief.mjs";

test("sanitizeRubyHtml keeps ruby and strips scripts", () => {
  const html = `<p><ruby>東京<rt>とうきょう</rt></ruby></p><script>alert(1)</script><a href="javascript:alert(1)">x</a>`;
  const cleaned = sanitizeRubyHtml(html);
  assert.match(cleaned, /<ruby>東京<rt>とうきょう<\/rt><\/ruby>/);
  assert.equal(/<script/i.test(cleaned), false);
  assert.equal(/javascript:/i.test(cleaned), false);
  assert.equal(/<a\b/i.test(cleaned), false);
});

test("parseWorldLaneBrief reads quiet japan lane and drops unsafe reading html", () => {
  const parsed = parseWorldLaneBrief(`<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"lane":"japan","generatedAt":"2026-09-02T21:00:00+09:00","asOf":"2026-09-02","headline":"安静日","status":"quiet","events":[{"id":"visa","category":"签证","title":"在留手续","fact":"官网更新了说明","whyItMatters":"会影响续签","watchNext":["再看一次官网"],"sources":[{"title":"入管","url":"https://www.moj.go.jp/isa/","type":"一手"}]}],"calendar":[],"readings":[{"id":"n5","level":"N5","title":"やさしいニュース","date":"2026-09-02","sourceName":"NHK","sourceUrl":"https://news.web.nhk/news/easy/","rubyHtml":"<p>今日は<ruby>雨<rt>あめ</rt></ruby>です。<script>bad()</script></p>","vocab":[{"word":"雨","reading":"あめ","meaning":"雨","note":"天气词"}],"furiganaSource":"original"}],"note":"测试"}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->`, "japan");
  assert.equal(parsed.status, "quiet");
  assert.equal(parsed.events[0].title, "在留手续");
  assert.equal(parsed.events[0].category, "签证");
  assert.equal(parsed.readings[0].level, "N5");
  assert.match(parsed.readings[0].rubyHtml, /<ruby>雨<rt>あめ<\/rt><\/ruby>/);
  assert.equal(parsed.readings[0].rubyHtml.includes("script"), false);
});

test("parseWorldLaneBrief stays quiet when the marker is missing", () => {
  const parsed = parseWorldLaneBrief("# 没有结构化数据", "ai");
  assert.equal(parsed.status, "quiet");
  assert.equal(parsed.lane, "ai");
  assert.equal(parsed.events.length, 0);
});

test("rubyHtmlToSpeechText drops furigana and keeps the spoken sentence", () => {
  const spoken = rubyHtmlToSpeechText("<p>今日は<ruby>雨<rt>あめ</rt></ruby>です。</p>");
  assert.equal(spoken, "今日は雨です");
});

test("parseWorldLaneBrief keeps one N5 to N2 reading and drops extras", () => {
  const parsed = parseWorldLaneBrief(`<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"lane":"japan","generatedAt":"2026-09-02T21:00:00+09:00","asOf":"2026-09-02","headline":"安静日","status":"quiet","events":[],"calendar":[],"readings":[
  {"id":"n3","level":"N3","title":"更新","date":"2026-09-02","sourceName":"入管","sourceUrl":"https://www.moj.go.jp/isa/applications/procedures/16-3.html","rubyHtml":"<p>更新です。</p>","vocab":[],"furiganaSource":"added"},
  {"id":"n5","level":"N5","title":"届出","date":"2026-09-02","sourceName":"入管","sourceUrl":"https://www.moj.go.jp/isa/support/guidance/index.html","rubyHtml":"<p>届出です。</p>","vocab":[],"furiganaSource":"added"},
  {"id":"n2","level":"N2","title":"手数料","date":"2026-09-02","sourceName":"入管","sourceUrl":"https://www.moj.go.jp/isa/01_00644.html","rubyHtml":"<p>改定されます。</p>","vocab":[],"furiganaSource":"added","audioFile":"../secret.mp3"},
  {"id":"n4","level":"N4","title":"期限","date":"2026-09-02","sourceName":"入管","sourceUrl":"https://www.moj.go.jp/isa/support/guidance/index.html","rubyHtml":"<p>期限です。</p>","vocab":[],"furiganaSource":"added"},
  {"id":"n1","level":"N1","title":"不应出现","date":"2026-09-02","sourceName":"入管","sourceUrl":"https://www.moj.go.jp/isa/","rubyHtml":"<p>N1</p>","vocab":[],"furiganaSource":"added"}
],"note":"测试"}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->`, "japan");
  assert.deepEqual(parsed.readings.map((item) => item.level), ["N5", "N4", "N3", "N2"]);
  assert.equal(parsed.readings.length, 4);
  assert.equal(parsed.readings.at(-1).audioFile, "");
});

test("parseWorldLaneBrief keeps up to eight events", () => {
  const events = Array.from({ length: 9 }, (_, index) => ({
    id: `e${index}`,
    title: `事件${index}`,
    fact: "事实",
    whyItMatters: "原因",
    watchNext: [],
    sources: [{ title: "官方", url: "https://example.com/", type: "一手" }],
  }));
  const parsed = parseWorldLaneBrief(`<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
${JSON.stringify({
    schemaVersion: 1,
    lane: "ai",
    generatedAt: "2026-09-02T21:00:00+09:00",
    asOf: "2026-09-02",
    headline: "测试",
    status: "active",
    events,
    calendar: [],
    readings: [],
    note: "测试",
  })}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->`, "ai");
  assert.equal(parsed.events.length, 8);
  assert.equal(parsed.events[7].id, "e7");
});

test("parseWorldLaneBrief keeps japan category and caps japan news at eight", () => {
  const events = Array.from({ length: 9 }, (_, index) => ({
    id: `j${index}`,
    category: index === 0 ? "签证" : "社会",
    title: `新闻${index}`,
    fact: "事实",
    whyItMatters: "原因",
    watchNext: [],
    sources: [{ title: "官方", url: "https://example.com/", type: "一手" }],
  }));
  const parsed = parseWorldLaneBrief(`<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
${JSON.stringify({
    schemaVersion: 1,
    lane: "japan",
    generatedAt: "2026-09-02T21:00:00+09:00",
    asOf: "2026-09-02",
    headline: "测试",
    status: "active",
    events,
    calendar: [],
    readings: [],
    note: "测试",
  })}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->`, "japan");
  assert.equal(parsed.events.length, 8);
  assert.equal(parsed.events[0].category, "签证");
  assert.equal(parsed.events[1].category, "社会");
  const dropped = parseWorldLaneBrief(`<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
${JSON.stringify({
    schemaVersion: 1,
    lane: "ai",
    generatedAt: "2026-09-02T21:00:00+09:00",
    asOf: "2026-09-02",
    headline: "测试",
    status: "active",
    events: [{ id: "x", category: "股价", title: "不收", fact: "x", whyItMatters: "x", watchNext: [], sources: [{ title: "官方", url: "https://example.com/", type: "一手" }] }],
    calendar: [],
    readings: [],
    note: "测试",
  })}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->`, "ai");
  assert.equal(dropped.events[0].category, "");
});

test("displayWorldHeadline drops padding process talk", () => {
  assert.equal(displayWorldHeadline("Google 发布 Gemini 3.8 Flash；昨天三条官方页仍有效"), "Google 发布 Gemini 3.8 Flash");
  const parsed = parseWorldLaneBrief(`<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"lane":"ai","generatedAt":"2026-09-03T06:50:00+09:00","asOf":"2026-09-03 日本时间","headline":"Google 发布 Gemini 3.8 Flash；昨天三条官方页仍有效","status":"active","events":[{"id":"g","category":"大模型","title":"Gemini 3.8 Flash 上线","fact":"官方博客","whyItMatters":"会改模型","watchNext":[],"sources":[{"title":"Google","url":"https://blog.google/","type":"一手"}]}],"calendar":[],"readings":[],"note":"测试"}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->`, "ai");
  assert.equal(parsed.headline, "Google 发布 Gemini 3.8 Flash");
});

test("parseWorldLaneBrief keeps now before ahead and optional impact", () => {
  const parsed = parseWorldLaneBrief(`<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"lane":"games","generatedAt":"2026-09-07T06:20:00+09:00","asOf":"2026-09-07 日本时间","headline":"电玩展下周开幕","status":"active","events":[
  {"id":"nextfest","category":"平台","lane":"ahead","title":"9月8日抽预告片","fact":"官方文档","whyItMatters":"窗口到了","impact":"这周把预告片备好","watchNext":["8日是否抽出"],"sources":[{"title":"Steamworks","url":"https://partner.steamgames.com/","type":"一手"}]},
  {"id":"tgs","category":"展会","title":"电玩展五天","fact":"官方 Overview","whyItMatters":"够得着独立区","watchNext":["名单"],"sources":[{"title":"TGS","url":"https://tgs.cesa.or.jp/","type":"一手"}]}
],"calendar":[],"readings":[],"note":"测试"}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->`, "games");
  assert.equal(parseWorldEventLane(undefined), "now");
  assert.equal(parsed.events[0].id, "tgs");
  assert.equal(parsed.events[0].lane, "now");
  assert.equal(parsed.events[1].id, "nextfest");
  assert.equal(parsed.events[1].lane, "ahead");
  assert.equal(parsed.events[1].impact, "这周把预告片备好");
});
