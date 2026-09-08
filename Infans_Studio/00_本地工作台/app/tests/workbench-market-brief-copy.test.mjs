import assert from "node:assert/strict";
import test from "node:test";
import { displayBriefHeadline } from "../src/market-brief-copy.mjs";
import { parseMarketBrief } from "../src/server/workbench-data.mjs";

test("brief headline keeps a short single line", () => {
  assert.equal(displayBriefHeadline("霍尔木兹再起冲突，油价待开盘验证。"), "霍尔木兹再起冲突，油价待开盘验证");
  assert.equal(displayBriefHeadline("市场暂时安静"), "市场暂时安静");
});

test("brief headline drops stacked news after the first sentence", () => {
  const dumped = "周日UKMTO确认霍尔木兹油轮遭不明投射物击中，美军打了拉拉克岛两座发射器。周末无新收盘，油价反应待验证。官方10年期仍是4.73%，纳指收26402.42。";
  const shown = displayBriefHeadline(dumped);
  assert.equal(shown.includes("4.73%"), false);
  assert.equal(shown.includes("26402"), false);
  assert.ok(shown.includes("霍尔木兹"));
  assert.ok([...shown].length <= 32);
});

test("brief events put the current track before the world picture", () => {
  const parsed = parseMarketBrief(`<!-- INFANS_MARKET_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"headline":"短标题","status":"active","events":[{"id":"world-1","category":"地缘与能源","lane":"world","title":"海峡","fact":"袭击","whyItMatters":"能源","marketReaction":"待验证","impact":"溢价","confidence":"中等","watchNext":["周报"],"sources":[{"title":"官方","url":"https://example.com/a","type":"一手"}]},{"id":"focus-1","category":"AI热点","title":"算力","fact":"财报","whyItMatters":"科技","marketReaction":"待验证","impact":"订单","confidence":"中等","watchNext":["下季"],"sources":[{"title":"官方","url":"https://example.com/b","type":"一手"}]}],"calendar":[],"note":""}
\`\`\`
<!-- INFANS_MARKET_BRIEF_JSON_END -->`);
  assert.deepEqual(parsed.events.map((event) => event.id), ["focus-1", "world-1"]);
  assert.equal(parsed.events[0].lane, "focus");
  assert.equal(parsed.events[1].lane, "world");
});

test("market brief parser serves the short headline to the workbench", () => {
  const parsed = parseMarketBrief(`<!-- INFANS_MARKET_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"generatedAt":"2026-08-31T07:20:00+09:00","asOf":"2026-08-31","headline":"周日UKMTO确认霍尔木兹油轮遭不明投射物击中，美军打了拉拉克岛两座发射器。周末无新收盘，油价反应待验证。官方10年期仍是4.73%，纳指收26402.42。","status":"active","events":[],"calendar":[],"note":"不构成投资建议"}
\`\`\`
<!-- INFANS_MARKET_BRIEF_JSON_END -->`);
  assert.equal(parsed.headline.includes("4.73%"), false);
  assert.equal(parsed.headline.includes("26402"), false);
  assert.ok([...parsed.headline].length <= 32);
});
