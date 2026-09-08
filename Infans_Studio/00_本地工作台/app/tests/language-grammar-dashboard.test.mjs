import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../src/pages/languages/GrammarBoard.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/pages/languages/grammar-board.css", import.meta.url), "utf8");

test("文法页合并五个知识分支且保持纯看板", () => {
  for (const label of ["句型", "助词", "变形", "敬语", "表达"]) assert.match(component, new RegExp(`label: "${label}"`));
  assert.doesNotMatch(component, /label: "语用"/);
  assert.match(component, /ConjugationBoard/);
  assert.doesNotMatch(component, /知识点与学习进度|这里只汇总知识卡/);
  for (const action of ["全部勾选", "全部取消", "随机推荐", "开始专项考试", "加入下次练习"]) {
    assert.equal(component.includes(action), false, `不应保留练习启动动作：${action}`);
  }
});

test("文法卡分开显示题目表现和口语使用，缺证据时不推断", () => {
  assert.match(component, /题目表现/);
  assert.match(component, /口语使用/);
  assert.match(component, /if \(!progress\) return "未练习"/);
  assert.match(component, /oralProgress\?\: Record<string, GrammarOralProgress>/);
  assert.match(component, /目前暂无做错或标记薄弱的文法/);
  assert.doesNotMatch(component, /口语.*等级/);
});

test("文法看板保留搜索和有证据的进度筛选", () => {
  for (const label of ["全部", "薄弱", "待复习", "搜索名称、接续、含义、例句"]) assert.match(component, new RegExp(label));
  assert.match(component, /Boolean\(progress\?\.correctTotal\)/);
  assert.match(component, /isReviewDue/);
  assert.match(styles, /\.grammar-branch-tabs/);
  assert.match(styles, /\.grammar-card-evidence/);
  assert.match(styles, /width: 100%/);
  assert.doesNotMatch(styles, /width: min\(100%, 1280px\)/);
  assert.match(component, /readLanguageViewPosition\("grammar"\)/);
  assert.match(component, /writeLanguageViewPosition\("grammar"/);
});

test("文法卡默认给出接续、含义和首个例句", () => {
  assert.match(component, /className="grammar-card-guide"/);
  for (const label of ["接续", "含义", "例句"]) assert.match(component, new RegExp(`<span>${label}</span>`));
  assert.match(component, /point\.examples\[0\]/);
  assert.match(component, /point\.examples\.slice\(1\)/);
  assert.match(styles, /\.grammar-card-guide/);
  assert.match(styles, /\.grammar-dashboard \.grammar-card-guide \{[\s\S]*?width: 100%;[\s\S]*?justify-content: stretch;/);
  assert.match(styles, /\.grammar-dashboard \.grammar-card-evidence \{[\s\S]*?width: 100%;[\s\S]*?justify-content: stretch;/);
  assert.match(styles, /\.grammar-dashboard \.grammar-card-guide p \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/);
});

test("五分支只按原件组标题和显式稳定规则分类", () => {
  assert.match(component, /const GROUP_BRANCH_BY_TITLE/);
  assert.match(component, /GROUP_BRANCH_BY_TITLE\[group\.title\] !== branch/);
  assert.match(component, /PURE_CONJUGATION_POINT_IDS/);
  assert.doesNotMatch(component, /test\(group\.title\)/);
  assert.doesNotMatch(component, /honorificKind|isHonorificGroup|point\.meaning.*敬语/);
  assert.match(component, /\$\{active\.level\} 的“\$\{BRANCHES\.find/);
  assert.match(component, /分组暂无已收录文法/);
});

test("语义组标题占满整行，卡片从左侧铺满", () => {
  assert.match(styles, /\.grammar-dashboard \.grammar-group \{\s*display: block;/);
  assert.match(styles, /\.grammar-dashboard \.grammar-group > header \{[\s\S]*?width: 100%;/);
  assert.match(styles, /\.grammar-dashboard \.grammar-row \{[\s\S]*?width: 100%;/);
  assert.doesNotMatch(styles, /grid-template-columns: minmax\(220px, \.46fr\) minmax\(0, 1\.54fr\)/);
});

test("文法页不再显示底部原件链接", () => {
  assert.doesNotMatch(component, /SourceLink|grammar-source|在 Obsidian/);
});
