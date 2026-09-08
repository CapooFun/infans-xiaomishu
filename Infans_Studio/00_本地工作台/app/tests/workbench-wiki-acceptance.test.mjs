import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectsSource = await readFile(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("Wiki distinguishes design control cards from navigation summaries", () => {
  assert.match(projectsSource, /projectPortfolioTier\(project\.name\) === "game" \? "游戏设计控制卡" : "功能设计控制卡"/u);
  assert.match(projectsSource, /hasDesignControlCard \? designControlCardLabel : featurePointsHaveDetails\(selectedFeaturePresentationPoints\) \? "导航摘要"/u);
  assert.match(projectsSource, /改进镜像 · 待本人验收/u);
  assert.doesNotMatch(projectsSource, /\? "机制详情"/u);
  assert.match(projectsSource, /event\.key !== "Enter" && event\.key !== " "/u);
  assert.equal((projectsSource.match(/onKeyDown=\{toggleFromKeyboard\}/gu) || []).length, 1);
  assert.doesNotMatch(projectsSource, /for \(const child of children\) onToggle\(projectFeaturePointMemoryId/u);
});

test("Wiki only folds genuinely dense or nested feature groups", () => {
  assert.match(projectsSource, /const FEATURE_POINT_FOLD_LEAF_THRESHOLD = 4/u);
  assert.match(projectsSource, /children\.some\(\(child\) => Boolean\(child\.children\?\.length\)\)/u);
  assert.match(projectsSource, /featurePointLeafCount\(point\) >= FEATURE_POINT_FOLD_LEAF_THRESHOLD/u);
  assert.match(projectsSource, /project-feature-point-leaf has-detail is-static/u);
  assert.match(projectsSource, /if \(!featurePointShouldFold\(point\)\)/u);
  assert.match(projectsSource, /project-feature-point-group is-foldable/u);
  assert.match(stylesSource, /\.project-feature-point-static-heading/u);
});

test("empty project states are toned down without typography overrides", () => {
  assert.match(projectsSource, /project-feature-tasks\$\{relatedTasks\.length \? "" : " is-empty"\}/u);
  assert.match(projectsSource, /quiet=\{!visibleBlockers\.length\}/u);
  assert.match(projectsSource, /project-hub-detail-block\$\{selectedRecent\.length \? "" : " is-empty"\}/u);

  const emptyStateCss = stylesSource.match(/\.project-feature-tasks\.is-empty \{[\s\S]*?\.project-hub-detail-block\.is-empty \.empty svg \{[^}]+\}/u)?.[0] || "";
  assert.match(emptyStateCss, /color:var\(--quiet\)/u);
  assert.match(emptyStateCss, /opacity:\.55/u);
  assert.doesNotMatch(emptyStateCss, /font(?:-size|-weight)?:/u);
});

test("Wiki acceptance waits for refresh and exposes clear touch feedback", () => {
  assert.match(projectsSource, /pending \? "验收中" : "验收"/u);
  assert.match(projectsSource, /kind: "acceptProductFeature"/u);
  assert.match(projectsSource, /selectedFeature\?\.summaryPoints\?\.length/u);
  assert.doesNotMatch(projectsSource, /className="project-feature-progress"/u);
  assert.match(stylesSource, /\.project-feature-accept \{[^}]*min-width:58px[^}]*touch-action:manipulation/u);
});

test("iPad Wiki tree reserves a right-aligned status column", () => {
  assert.match(stylesSource, /\.project-feature-module \{ display:grid !important;grid-template-columns:14px 15px minmax\(0,1fr\) auto; \}/u);
  assert.match(stylesSource, /\.project-feature-leaf \{ display:grid !important;grid-template-columns:14px minmax\(0,1fr\) auto; \}/u);
  assert.match(stylesSource, /\.project-feature-status \{[^}]*min-width:max-content[^}]*justify-self:end/u);
  assert.match(stylesSource, /span:not\(\.project-feature-status\)[^}]*text-overflow:ellipsis/u);
});

test("Wiki detail keeps the same surface color when the tree changes height", () => {
  const detailCss = stylesSource.match(/\.project-feature-detail \{[^}]+\}/u)?.[0] || "";
  assert.match(detailCss, /background:var\(--surface-2\)/u);
  assert.doesNotMatch(detailCss, /radial-gradient/u);
});
