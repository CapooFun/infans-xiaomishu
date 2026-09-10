import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("mainline progress puts weekly view first and opens it by default", async () => {
  const source = await fs.readFile(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<TimelineMode>\("weeks"\)/);
  const switchGroup = source.match(/className="gantt-view-switch"[\s\S]*?<\/div>/)?.[0] || "";
  assert.ok(switchGroup.indexOf("周排期") < switchGroup.indexOf("路线图"));
  assert.match(switchGroup, /aria-pressed=\{timelineMode === "weeks"\}[\s\S]*周排期/);
  assert.match(switchGroup, /aria-pressed=\{timelineMode === "roadmap"\}[\s\S]*路线图/);
});

test("schedule exposes four stable time sections and keeps their URL state", async () => {
  const source = await fs.readFile(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const label of ["今日事项", "主线进度", "本地活动", "新品发售"]) assert.match(source, new RegExp(label));
  const sectionDefinitions = source.match(/const SCHEDULE_SECTIONS = \[[\s\S]*?\n\] as const;/)?.[0] || "";
  assert.ok(sectionDefinitions.indexOf('id: "roadmap"') < sectionDefinitions.indexOf('id: "today"'));
  assert.match(source, /canonicalizeScheduleView/);
  assert.match(source, /raw === "japan" \? "local"/);
  assert.match(source, /type ScheduleSectionId = "today" \| "roadmap" \| "local" \| "releases"/);
  assert.match(source, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(source, /params\.get\("view"\)/);
  assert.match(source, /params\.get\("view"\) !== "japan"/);
  assert.match(source, /activeSection === "local" \? <LocalActivitiesView active homeRequest=\{localHomeRequest\} openGuideId=\{scheduleGuide\} \/>/);
  assert.match(source, /activeSection === "releases" \? <ReleaseWatchView active focusQuery=\{releaseQuery\} \/>/);
  assert.match(styles, /\.schedule-todo-board \{[^}]*width: min\(1120px, 100%\);[^}]*margin: 0 auto;/);
  assert.match(styles, /@media \(min-width:901px\) and \(max-width:1366px\) \{\s*\.schedule-todo-board,\.local-activities,\.renewal-expiry \{ width:100%; \}/);
});

test("today copy and AI tasks use the full row before falling back on narrow screens", async () => {
  const source = await fs.readFile(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.schedule-todo-head p \{[^}]*max-width: none;/);
  assert.match(styles, /\.schedule-ai-queue > div \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /\.schedule-ai-queue > div > button,[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\) auto auto;/);
  assert.match(styles, /\.schedule-ai-queue \.ai-task-copy > span \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(styles, /@media \(max-width: 560px\) \{[\s\S]*?\.schedule-ai-queue > div > button,[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?\.schedule-ai-queue \.ai-task-copy \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?grid-row: 2;[\s\S]*?\.schedule-ai-queue \.ai-task-copy > span,[\s\S]*?white-space: normal;/);
  assert.match(source, /dateKey === todayKey \? "今天"/);
  assert.match(source, /`\$\{dayLabel\} \$\{read\("hour"\)\}:\$\{read\("minute"\)\} 更新`/);
  assert.match(source, /原定 \{dateLabel\}/);
  assert.match(source, /未通过 · 已有下一步/);
  assert.match(source, /需要你授权/);
});

test("local activities can open a guide from the schedule URL", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/LocalActivitiesView.tsx", import.meta.url), "utf8");
  const schedule = await fs.readFile(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  assert.match(source, /openGuideId = ""/);
  assert.match(source, /openPlaybook\(openGuideId, "playbooks"\)/);
  assert.match(schedule, /params.delete\("guide"\)/);
});

test("local activity is absent from tools and its old route redirects to schedule", async () => {
  const source = await fs.readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const toolDefinitions = source.match(/const TOOLS:[\s\S]*?\n\];/)?.[0] || "";
  assert.doesNotMatch(toolDefinitions, /game-dungeon|日本活动|本地活动/);
  assert.doesNotMatch(source, /import LocalActivitiesView/);
  assert.match(source, /window\.location\.pathname === "\/tools\/game-dungeon"/);
  assert.match(source, /window\.history\.replaceState\(\{\}, "", "\/schedule\?view=local"\)/);
});

test("release watch separates certainty and never turns wishlisted games into todos", async () => {
  const source = await fs.readFile(new URL("../src/pages/schedule/ReleaseWatchView.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /确定日期/);
  assert.match(source, /时间范围/);
  assert.match(source, /等待定档/);
  assert.match(source, /先收好期待，不把它们变成待办/);
  assert.match(source, /\/api\/schedule\/releases/);
  assert.match(source, /<ol className="release-watch-timeline"/);
  assert.match(source, /className="release-watch-time"/);
  assert.match(source, /className="release-watch-media"/);
  assert.match(source, /item\.imageUrl \? <img/);
  assert.match(source, /width="460" height="215"/);
  assert.match(source, /期待多久/);
  assert.match(source, /wishlistAddedLabel\(item\.addedAt\)/);
  assert.match(source, /focusQuery = ""/);
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /releaseWatchCacheState/);
  assert.match(source, /if \(releaseWatchCacheState\.data && !force\) return Promise\.resolve/);
  assert.match(source, /loadReleaseWatch\(true\)/);
  assert.match(styles, /\.schedule-section-tabs \{/);
  assert.match(styles, /\.release-watch-timeline::before \{/);
  assert.match(styles, /\.release-watch-entry \{[^}]*grid-template-columns:140px minmax\(0,1fr\)/);
  assert.match(styles, /\.release-watch-cover \{[^}]*aspect-ratio:460\/215/);
  assert.match(styles, /\.release-watch-card \{[^}]*grid-template-columns:minmax\(180px,38%\) minmax\(0,1fr\)/);
  assert.match(styles, /\.release-watch-entry \{ grid-template-columns:1fr;gap:7px;/);
  assert.match(styles, /\.release-watch-card \{ min-height:0;grid-template-columns:1fr;/);
  assert.match(styles, /\.release-watch-timeline::before \{ display:none; \}/);
  assert.doesNotMatch(styles, /\.release-watch-grid \{/);
});
