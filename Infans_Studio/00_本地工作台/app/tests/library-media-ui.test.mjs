import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const pageUrl = new URL("../src/pages/LibraryPage.tsx", import.meta.url);
const stylesUrl = new URL("../src/styles.css", import.meta.url);
const studioRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

test("动漫馆藏使用固定卡片横向馆藏架", async () => {
  const [page, styles] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.doesNotMatch(page, /label: "影响我的"/);
  assert.doesNotMatch(page, /label: "我的推荐"/);
  assert.match(page, /className="media-poster-strip"/);
  assert.match(page, /className="media-poster-shelf media-decade-shelf"/);
  assert.match(page, /animePeriodGroups\.map/);
  assert.match(page, /Math\.floor\(year \/ 5\) \* 5/);
  assert.match(page, /`\$\{start\}—\$\{start \+ 4\}`/);
  assert.doesNotMatch(page, /Math\.floor\(\(item\.releaseYear \?\? 0\) \/ 10\) \* 10/);
  assert.doesNotMatch(page, /<Heart\b/);
  assert.doesNotMatch(page, /screen-library-head/);
  const cardSource = page.slice(page.indexOf("function MediaPosterCard"), page.indexOf("const animeGenreOrder"));
  assert.doesNotMatch(cardSource, /item\.viewingStatus/);
  assert.match(styles, /\.media-poster-strip\s*\{[^}]*overflow-x:auto/);
  assert.match(styles, /\.media-poster-strip \.anime-poster-card\s*\{[^}]*flex:0 0 164px/);
  assert.match(page, /function ScrollingPosterTitle/);
  assert.match(page, /text\.scrollWidth > viewport\.clientWidth \+ 1/);
  assert.match(styles, /@keyframes anime-title-marquee/);
  assert.match(styles, /@media \(prefers-reduced-motion:reduce\)/);
});

test("游戏名称与动漫名称共用单行溢出滚动", async () => {
  const [page, styles] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  const collectionCardSource = page.slice(page.indexOf("function CollectionCard"), page.indexOf("function ScrollingPosterTitle"));
  assert.match(collectionCardSource, /item\.kind === "game"\s*\? <ScrollingPosterTitle title=\{item\.title\} \/>/);
  assert.match(styles, /\.anime-poster-title\s*\{[^}]*overflow:hidden;white-space:nowrap/);
  assert.match(styles, /\.collection-item\.kind-game:hover \.anime-poster-title-track/);
});

test("开源馆藏用虚构演示短篇保留写作入口", async () => {
  const [page, main] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const kindOrder: LibraryKind\[\] = \["game", "animation", "book", "writing"\]/);
  assert.match(page, /writing: "写作"/);
  assert.doesNotMatch(page, /我的写作/);
  assert.doesNotMatch(page, /label: "影响我的"/);
  assert.match(page, /一篇标明虚构演示的短篇/);
  assert.match(main, /<LibraryRoute displayMode=\{displayMode\}\/>/);
});

test("开源资产页固定使用一千万虚构演示", async () => {
  const page = await readFile(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(page, /const useDemoPortfolio = true/);
  assert.match(page, /虚构演示/);
  assert.match(main, /净资产约一千万/);
  assert.match(main, /示例待办，不是作者当天真事/);
  assert.match(main, /体魄示意，不是真实健康记录/);
});

test("开源日程、体魄和协作记录都有标明虚构演示的样稿", async () => {
  const todo = await readFile(path.join(studioRoot, "待办事项与长期规划.md"), "utf8");
  const plan = await readFile(path.join(studioRoot, "40_身心健康/体魄/训练计划.md"), "utf8");
  const log = await readFile(path.join(studioRoot, "40_身心健康/体魄/训练日志.md"), "utf8");
  const body = await readFile(path.join(studioRoot, "40_身心健康/体魄/三维记录.md"), "utf8");
  const work = await readFile(path.join(studioRoot, "10_日志记录/工作日志/2026-08-20.md"), "utf8");
  const tools = await readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  for (const text of [todo, plan, log, body, work]) {
    assert.match(text, /虚构演示/);
    assert.match(text, /demo: true/);
  }
  assert.match(todo, /## 最近两天/);
  assert.match(plan, /上肢日 A/);
  assert.match(log, /2026-09-04（周五）｜上肢日 B/);
  assert.match(body, /体重（斤）/);
  assert.match(tools, /四类各一篇标明虚构演示的样稿/);
});

test("开源得到课清单只留课名日期，不含姓名账号", async () => {
  const archive = await readFile(path.join(studioRoot, "70_专题研究/课程资料/得到/得到课程档案.md"), "utf8");
  assert.match(archive, /薛兆丰的经济学课/);
  assert.match(archive, /共 \*\*61\*\* 门/);
  assert.doesNotMatch(archive, /学习与求职/);
  assert.doesNotMatch(archive, /证书姓名/);
});

test("开源示例写作和电子书单标明虚构演示", async () => {
  const story = await readFile(path.join(studioRoot, "60_艺术馆藏/写作/糖霜与晨雾.md"), "utf8");
  const weread = await readFile(path.join(studioRoot, "60_艺术馆藏/书籍/微信读书.md"), "utf8");
  const dialogue = await readFile(path.join(studioRoot, "10_日志记录/对话日志/2026-08-20.md"), "utf8");
  const meeting = await readFile(path.join(studioRoot, "10_日志记录/会议纪要/2026-08-20_示例周末读书会.md"), "utf8");
  const discussion = await readFile(path.join(studioRoot, "85_收藏夹/技术讨论/2026-08-20_示例本地书目页.md"), "utf8");
  assert.match(story, /虚构演示/);
  assert.match(story, /demo: true/);
  assert.match(weread, /虚构演示/);
  assert.match(weread, /没有微信读书账号/);
  assert.match(dialogue, /虚构演示/);
  assert.match(meeting, /虚构演示/);
  assert.match(discussion, /虚构演示/);
  assert.match(discussion, /讨论稿/);
});
