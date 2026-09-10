import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkbenchWriteError } from "../src/server/workbench-errors.mjs";
import { readLocalActivities, readLocalActivityGuideImage, readLocalActivityPlaybook, writeLocalActivityInterest } from "../src/server/workbench-local-activities.mjs";
import { isAppleMobileBrowser, isMacDesktopBrowser } from "../src/pages/tools/guide-share-platform.mjs";

function japanCatalogMarkdown() {
  return `---\ndate: 2026-08-22\n---\n<!-- INFANS_JAPAN_ACTIVITIES_JSON_START -->\n\`\`\`json\n${JSON.stringify({
    updatedAt: "2026-08-22T09:00:00+09:00",
    scope: "东京／关东为主",
    activities: [
      { id: "trip-guide", name: "未来展", category: "动漫漫画", startDate: "2026-09-05", endDate: "2026-09-06", officialUrl: "https://example.org/official", verifiedAt: "2026-08-22T09:00:00+09:00" },
      { id: "ai", name: "AI 展", filterTag: "AI 新知", category: "生成式 AI", startDate: "2026-09-03", endDate: "2026-09-04", officialUrl: "https://example.org/ai", verifiedAt: "2026-08-22T09:00:00+09:00" },
    ],
  })}\n\`\`\`\n<!-- INFANS_JAPAN_ACTIVITIES_JSON_END -->\n`;
}

async function seedJapanCatalog(root, markdown = japanCatalogMarkdown()) {
  const dir = path.join(root, "80_生活事务", "日本游玩攻略");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "日本活动.md");
  await fs.writeFile(target, markdown, "utf8");
  return target;
}

test("Guide PDF sharing is available only on desktop Mac browsers", () => {
  assert.equal(isMacDesktopBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari", platform: "MacIntel", maxTouchPoints: 0 }), true);
  assert.equal(isMacDesktopBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Mobile Safari", platform: "MacIntel", maxTouchPoints: 5 }), false);
  assert.equal(isMacDesktopBrowser({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit Mobile Safari", platform: "iPad", maxTouchPoints: 5 }), false);
  assert.equal(isMacDesktopBrowser({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 }), false);
});

test("Apple 移动浏览器识别覆盖 iPhone、iPad 和桌面伪装的 iPadOS", () => {
  assert.equal(isAppleMobileBrowser({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Mobile Safari", platform: "iPhone", maxTouchPoints: 5 }), true);
  assert.equal(isAppleMobileBrowser({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit Mobile Safari", platform: "iPad", maxTouchPoints: 5 }), true);
  assert.equal(isAppleMobileBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Mobile Safari", platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(isAppleMobileBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari", platform: "MacIntel", maxTouchPoints: 0 }), false);
  assert.equal(isAppleMobileBrowser({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 }), false);
});

test("Native Mac workbench routes guide printing through WKWebView print operation", async () => {
  const native = await fs.readFile(new URL("../native/SecretaryApp.swift", import.meta.url), "utf8");
  assert.match(native, /if type == "print-guide"/);
  assert.match(native, /webView\.printOperation\(with: printInfo\)/);
  assert.match(native, /operation\.jobTitle = jobTitle/);
  assert.match(native, /operation\.runModal\(/);
  assert.match(native, /infans:guide-print-started/);
  assert.match(native, /infans:guide-print-finished/);
});

test("Japan activity cards show type first and language second", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/LocalActivitiesView.tsx", import.meta.url), "utf8");
  const tags = source.match(/<div className="local-activity-tags">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.ok(tags.indexOf("activity.category") >= 0);
  assert.ok(tags.indexOf("activity.category") < tags.indexOf("activity.languagePressure"));
  assert.equal(tags.includes("activity.filterTag"), false);
  assert.match(source, /<small>未过期的<\/small>/);
  assert.match(source, /<small>攻略集<\/small>/);
  assert.match(source, /<small>参加过的<\/small>/);
  assert.match(source, /data\?\.playbooks\.length/);
  assert.match(source, /data\?\.attended\.length/);
  assert.match(source, /onOpen\(playbook\.id\)/);
  assert.match(source, /showPlaybooks && data/);
  assert.match(source, /<LocalPlaybookShelf/);
  assert.match(source, /className="local-playbook-carousel"/);
  assert.match(source, /按更新时间从新到旧排列的攻略/);
  assert.match(source, /aria-expanded=\{showPlaybooks\}/);
  assert.match(source, /aria-controls="local-playbook-shelf"/);
  assert.match(source, /playbookScrollLeftRef\.current/);
  assert.match(source, /pageScrollYRef\.current/);
  assert.match(source, /window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/);
  assert.match(source, /playbookCarouselRef\.current\.scrollLeft = playbookScrollLeftRef\.current/);
  assert.match(source, /<GuideOfficialImage \{\.\.\.playbook\} guideId=\{playbook\.id\} className="is-playbook-card" \/>/);
  assert.match(source, /activity\.hasPlaybook \? <span className="is-guide-ready"/);
  assert.match(source, /activity\.hasPlaybook \? \(/);
  assert.match(source, /onClick=\{\(\) => openPlaybook\(activity\.id, "activities"\)\}/);
  assert.match(source, /guideOrigin === "attended" \? "返回本地活动"/);
  assert.match(source, /openPlaybook\(data\.attended\[0\]\.id, "attended"\)/);
  assert.match(source, /setShowPlaybooks\(true\)/);
  assert.doesNotMatch(source, /GameDungeonGuide/);
  assert.doesNotMatch(source, /showPlaybookCollection|LocalPlaybookCollection/);
  assert.match(source, /import\("\.\/LocalActivityGuide"\)/);
  assert.doesNotMatch(source, /SourceLink/);
});

test("Japan playbooks use a lightweight native horizontal shelf", async () => {
  const styles = await fs.readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const guide = await fs.readFile(new URL("../src/pages/tools/LocalActivityGuide.tsx", import.meta.url), "utf8");
  assert.match(styles, /\.local-playbook-shelf \{/);
  assert.match(styles, /\.local-playbook-shelf-shell \{ min-width:0; \}/);
  assert.match(styles, /\.local-playbook-carousel \{[^}]*overflow-x:auto;[^}]*scroll-snap-type:x mandatory;/);
  assert.match(styles, /\.local-playbook-carousel > li \{[^}]*scroll-snap-align:start;/);
  assert.match(styles, /\.local-playbook-carousel \{ grid-auto-columns:min\(82vw,340px\); \}/);
  assert.match(styles, /\.guide-official-image-frame \{[^}]*aspect-ratio:16\/10;/);
  assert.match(styles, /\.guide-official-image-frame img \{[^}]*object-fit:cover;/);
  assert.doesNotMatch(styles, /japan-playbook-collection-hero/);
  assert.match(guide, /活动纪念 · 小秘书内阅读/);
  assert.match(guide, /出发导航与取票/);
  assert.match(guide, /local-guide-departure/);
  assert.match(styles, /\.local-guide-departure \{/);
  assert.match(guide, /data\.name\.includes\("观影"\) \? "观影纪念" : "活动纪念"/);
  assert.match(guide, /分享攻略/);
  assert.match(guide, /import \{ isMacDesktopBrowser \} from "\.\/guide-share-platform\.mjs"/);
  assert.match(guide, /data && canSharePdf/);
  assert.match(guide, /PDF 分享请在 Mac 上使用/);
  assert.match(guide, /data\.shareName \|\| data\.name/);
  assert.match(guide, /root\.setAttribute\("data-theme", "day"\)/);
  assert.match(guide, /root\.style\.colorScheme = "light"/);
  assert.match(guide, /window\.addEventListener\("beforeprint", handleBeforePrint\)/);
  assert.match(guide, /window\.addEventListener\("afterprint", handleAfterPrint\)/);
  assert.match(guide, /nativePrintBridge\.postMessage\(\{ type: "print-guide", jobTitle: shareDocumentTitle\(data\) \}\)/);
  assert.match(guide, /window\.addEventListener\("infans:guide-print-started", handleNativePrintStarted\)/);
  assert.match(guide, /window\.addEventListener\("infans:guide-print-finished", handleNativePrintFinished\)/);
  assert.match(guide, /系统打印面板未能打开/);
  assert.doesNotMatch(guide, /await waitForPrintPaint\(\)/);
  assert.match(guide, /root\.setAttribute\("data-theme", previousTheme\)/);
  assert.match(guide, /window\.print\(\)/);
  assert.match(guide, /role="status" aria-live="polite"/);
  assert.match(styles, /\.local-guide-reader-grid \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*align-items:stretch;/);
  assert.match(styles, /@page \{ size:A4 portrait;margin:16mm 0 18mm;background:var\(--surface-2\); \}/);
  assert.match(styles, /@media print \{[\s\S]*?\*,\*::before,\*::after \{[^}]*animation:none!important;[^}]*transition:none!important;/);
  assert.match(styles, /@media print \{[\s\S]*?html,body \{[^}]*background-color:var\(--surface-2\)!important;[^}]*background-image:none!important;[^}]*color-scheme:light!important;/);
  assert.match(styles, /\.workspace-backdrop,\.workspace-backdrop \* \{[^}]*display:none!important;[^}]*background:none!important;/);
  assert.match(styles, /\.local-guide-reader \.museum-card \{[^}]*background-color:var\(--surface-2\)!important;[^}]*background-image:none!important;/);
  assert.match(styles, /\.local-guide-reader \.museum-card::before,\.local-guide-reader \.museum-card::after \{[^}]*content:none!important;[^}]*display:none!important;[^}]*background:none!important;/);
  assert.match(styles, /\.local-guide-reader \{[^}]*padding:0 20mm!important;[^}]*box-sizing:border-box!important;/);
  assert.match(styles, /@media print \{[\s\S]*?\.local-guide-reader-grid \{ display:block!important; \}/);
  assert.match(styles, /@media print \{[\s\S]*?\.local-guide-reader-toolbar,\.local-guide-share-status,\.local-guide-share-availability \{ display:none!important; \}/);
});

test("Workbench product contract makes in-app reading primary", async () => {
  const shared = await fs.readFile(new URL("../src/page-shared.tsx", import.meta.url), "utf8");
  assert.match(shared, /前台内容必须另有小秘书内部阅读路径/);
  assert.match(shared, /label = "在 Obsidian 编辑"/);
});

test("Japan activities separates future cards, playbooks and attended history", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-local-activities-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "80_生活事务", "日本游玩攻略");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "日本活动.md"), `---\ndate: 2026-08-22\n---\n<!-- INFANS_JAPAN_ACTIVITIES_JSON_START -->\n\`\`\`json\n${JSON.stringify({
    updatedAt: "2026-08-22T09:00:00+09:00",
    scope: "东京／关东为主",
    activities: [
      { id: "trip-guide", name: "未来展", category: "动漫漫画", startDate: "2026-09-05", endDate: "2026-09-06", officialUrl: "https://example.org/official", verifiedAt: "2026-08-22T09:00:00+09:00" },
      { id: "ai", name: "AI 展", filterTag: "AI 新知", category: "生成式 AI", startDate: "2026-09-03", endDate: "2026-09-04", officialUrl: "https://example.org/ai", verifiedAt: "2026-08-22T09:00:00+09:00" },
      { id: "expired", name: "过期展", startDate: "2026-07-01", endDate: "2026-07-02", officialUrl: "https://example.org/old", verifiedAt: "2026-08-22T09:00:00+09:00" },
      { id: "unsafe", name: "非安全链接", startDate: "2026-09-03", endDate: "2026-09-04", officialUrl: "http://example.org", verifiedAt: "2026-08-22T09:00:00+09:00" },
    ],
    playbooks: [
      { id: "older-guide", name: "旧攻略", dateLabel: "2026-08-01", status: "攻略已做", updatedAt: "2026-08-20", sourcePath: "80_生活事务/日本游玩攻略/旧攻略.md" },
      { id: "trip-guide", name: "Trip Guide", shareName: "中文出门攻略", dateLabel: "2026-09-01", status: "想去·攻略已做", updatedAt: "2026-08-23", sourcePath: "80_生活事务/日本游玩攻略/攻略.md", imageUrl: "https://official.example.org/guide.jpg", imageAlt: "官方内容图", imageSourceLabel: "主办方", imageSourceUrl: "https://official.example.org/event", imageCredit: "主办方摄影" },
    ],
    guides: [{ id: "tokyo-game-dungeon-13", name: "东京游戏地牢 13", dateLabel: "2026-08-08", status: "已参加", sourcePath: "80_生活事务/日本游玩攻略/参加过.md", imageUrl: "https://official.example.org/history.jpg", imageAlt: "官方现场图", imageSourceLabel: "主办方", imageSourceUrl: "https://official.example.org/history", imageCredit: "活动官方" }],
  })}\n\`\`\`\n<!-- INFANS_JAPAN_ACTIVITIES_JSON_END -->\n`, "utf8");
  await fs.writeFile(path.join(dir, "攻略.md"), `---\ndescription: 小秘书内攻略\ndate: 2026-08-22\nupdated: 2026-08-23\n---\n\n# 出门攻略\n\n## 路线\n\n在小秘书里阅读全文。\n`, "utf8");
  await fs.writeFile(path.join(dir, "参加过.md"), `---\ndescription: 参加过的活动攻略\ndate: 2026-08-08\nupdated: 2026-08-28\n---\n\n# 东京游戏地牢 13\n\n## 怎么逛\n\n统一使用同一套攻略阅读器。\n`, "utf8");

  const snapshot = await readLocalActivities(root, { today: "2026-08-22" });
  assert.deepEqual(snapshot.activities.map((item) => item.id), ["trip-guide", "ai"]);
  assert.deepEqual(snapshot.activities.map((item) => item.filterTag), ["ACG", "AI 新知"]);
  assert.equal(snapshot.activities[0]?.hasPlaybook, true);
  assert.equal(snapshot.activities[1]?.hasPlaybook, false);
  assert.deepEqual(snapshot.playbooks.map((item) => item.id), ["trip-guide", "older-guide"]);
  assert.equal(snapshot.playbooks[0]?.sourcePath, "80_生活事务/日本游玩攻略/攻略.md");
  assert.equal(snapshot.playbooks[0]?.shareName, "中文出门攻略");
  assert.equal(snapshot.playbooks[0]?.imageUrl, "https://official.example.org/guide.jpg");
  assert.equal(snapshot.playbooks[1]?.imageUrl, "");
  assert.equal(snapshot.attended[0]?.id, "tokyo-game-dungeon-13");
  assert.equal(snapshot.attended[0]?.sourcePath, "80_生活事务/日本游玩攻略/参加过.md");
  assert.equal(snapshot.attended[0]?.imageCredit, "活动官方");
  assert.equal(snapshot.activities[0]?.interested, false);
  const guide = await readLocalActivityPlaybook(root, "trip-guide");
  assert.equal(guide.description, "小秘书内攻略");
  assert.equal(guide.shareName, "中文出门攻略");
  assert.equal(guide.updatedAt, "2026-08-23");
  assert.equal(guide.imageSourceLabel, "主办方");
  assert.match(guide.markdown, /## 路线/);
  const attendedGuide = await readLocalActivityPlaybook(root, "tokyo-game-dungeon-13");
  assert.equal(attendedGuide.description, "参加过的活动攻略");
  assert.match(attendedGuide.markdown, /统一使用同一套攻略阅读器/);

  const image = await readLocalActivityGuideImage(root, "trip-guide", {
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://official.example.org/guide.jpg");
      assert.equal(init.headers.Referer, "https://official.example.org/event");
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg", "content-length": "3" } });
    },
  });
  assert.equal(image.contentType, "image/jpeg");
  assert.deepEqual([...image.bytes], [1, 2, 3]);

  const interested = await writeLocalActivityInterest(root, { activityId: "trip-guide", interested: true }, { now: "2026-08-22T12:00:00+09:00" });
  assert.equal(interested.activities[0]?.interested, true);
  const saved = await fs.readFile(path.join(dir, "日本活动.md"), "utf8");
  assert.match(saved, /INFANS_JAPAN_ACTIVITY_INTERESTS_JSON_START/);

  const cleared = await writeLocalActivityInterest(root, { activityId: "trip-guide", interested: false }, { today: "2026-08-22" });
  assert.equal(cleared.activities[0]?.interested, false);
  assert.match(await fs.readFile(path.join(dir, "日本活动.md"), "utf8"), /"items": \{\}/);
});

test("Local activity interest writes go through the Vault file write guard, not preview tokens", async () => {
  const writer = await fs.readFile(new URL("../src/server/workbench-local-activities.mjs", import.meta.url), "utf8");
  const view = await fs.readFile(new URL("../src/pages/tools/LocalActivitiesView.tsx", import.meta.url), "utf8");
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  assert.match(writer, /from "\.\/workbench-file-write-guard\.mjs"/);
  assert.match(writer, /withVaultFileWrite\(/);
  assert.doesNotMatch(writer, /createWriteService|writes\.preview|\/api\/write\/preview/);
  assert.match(view, /method: "PATCH"/);
  assert.doesNotMatch(view, /\/api\/write\/preview/);
  assert.match(routes, /router\.use\("\/api\/tools\/local-activities", handleLocalActivities\)/);
  assert.match(routes, /router\.use\("\/api\/tools\/japan-activities", handleLocalActivities\)/);
});

test("Japan activity interest writes reject symlink targets and keep concurrent marks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-japan-interest-guard-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedJapanCatalog(root);

  await assert.rejects(
    writeLocalActivityInterest(root, { activityId: "", interested: true }),
    (error) => error instanceof WorkbenchWriteError && error.code === "LOCAL_ACTIVITY_INTEREST_INVALID" && error.status === 400,
  );
  await assert.rejects(
    writeLocalActivityInterest(root, { activityId: "missing", interested: true }),
    (error) => error instanceof WorkbenchWriteError && error.code === "LOCAL_ACTIVITY_NOT_FOUND" && error.status === 404,
  );

  await Promise.all([
    writeLocalActivityInterest(root, { activityId: "trip-guide", interested: true }, { now: "2026-08-22T12:00:00+09:00" }),
    writeLocalActivityInterest(root, { activityId: "ai", interested: true }, { now: "2026-08-22T12:00:01+09:00" }),
  ]);
  const combined = await readLocalActivities(root, { today: "2026-08-22" });
  assert.equal(combined.activities.find((item) => item.id === "trip-guide")?.interested, true);
  assert.equal(combined.activities.find((item) => item.id === "ai")?.interested, true);

  const linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "infans-japan-interest-link-"));
  t.after(() => fs.rm(linkedRoot, { recursive: true, force: true }));
  const outside = path.join(linkedRoot, "outside.md");
  await fs.writeFile(outside, japanCatalogMarkdown(), "utf8");
  const dir = path.join(linkedRoot, "80_生活事务", "日本游玩攻略");
  await fs.mkdir(dir, { recursive: true });
  await fs.symlink(outside, path.join(dir, "日本活动.md"));
  await assert.rejects(
    writeLocalActivityInterest(linkedRoot, { activityId: "trip-guide", interested: true }),
    (error) => error instanceof WorkbenchWriteError && error.code === "PATH_SYMLINK_FORBIDDEN" && error.status === 403,
  );
});

test("open-source Japan activities stay a generic catalog shell without hosted venues", async () => {
  const view = await fs.readFile(new URL("../src/pages/tools/LocalActivitiesView.tsx", import.meta.url), "utf8");
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(view, /hosted-activities|KitchenOrders|GameDungeonGuide|活动组织/);
  assert.doesNotMatch(routes, /\/api\/tools\/hosted-activities/);
  assert.doesNotMatch(view, /orsay-tobikan|sekiro-no-defeat|madoka-walpurgisnacht/);
});
