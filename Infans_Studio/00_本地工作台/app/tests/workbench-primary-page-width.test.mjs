import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function ruleFor(selector) {
  const match = styles.match(new RegExp(`\\${selector} \\{([^}]+)\\}`));
  assert.ok(match, `找不到 ${selector} 的基础样式`);
  return match[1];
}

test("领域研究、艺术馆藏和语言学习沿用一级页面共用版心", () => {
  for (const selector of [".library-page", ".language-hub"]) {
    const rule = ruleFor(selector);
    assert.match(rule, /width:\s*100%/);
    assert.doesNotMatch(rule, /max-width|margin:\s*0 auto/);
  }
});
