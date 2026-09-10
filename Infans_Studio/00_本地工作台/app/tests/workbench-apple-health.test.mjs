import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  appleHealthDerivedPath,
  appleHealthXmlExtraction,
  createAppleHealthImportService,
  deriveStretchDays,
  parseAppleHealthMarkdown,
  parseAppleHealthStream,
  readAppleHealthData,
  renderAppleHealthMarkdown,
} from "../src/server/workbench-apple-health.mjs";

test("Apple Health 确认框同时展示来源时间和实际数据覆盖日", () => {
  const overlays = readFileSync(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
  assert.match(overlays, /导出文件生成时间/);
  assert.match(overlays, /state\.preview\.sourceFile/);
  assert.match(overlays, /数据覆盖到/);
  assert.match(overlays, /healthDates\.at\(-1\)/);
  assert.match(overlays, /日期过早就取消，不写入/);
});

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="示例用户的 iPhone" unit="count" startDate="2026-07-31 08:00:00 +0900" endDate="2026-07-31 09:00:00 +0900" value="1000"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="示例用户的 Apple Watch" unit="count" startDate="2026-07-31 08:00:00 +0900" endDate="2026-07-31 09:00:00 +0900" value="500"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="示例用户的 Apple Watch" unit="count" startDate="2026-07-31 09:00:00 +0900" endDate="2026-07-31 10:00:00 +0900" value="600"/>
  <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="示例用户的 Apple Watch" unit="kcal" startDate="2026-07-31 08:00:00 +0900" endDate="2026-07-31 09:00:00 +0900" value="234.5"/>
  <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="示例用户的 Apple Watch" unit="count/min" startDate="2026-07-31 07:00:00 +0900" endDate="2026-07-31 07:00:00 +0900" value="58"/>
  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="体脂秤" unit="lb" startDate="2026-07-31 07:30:00 +0900" endDate="2026-07-31 07:30:00 +0900" value="165.3467"/>
  <Record type="HKQuantityTypeIdentifierWaistCircumference" sourceName="健康" unit="m" startDate="2026-07-31 07:31:00 +0900" endDate="2026-07-31 07:31:00 +0900" value="0.8"/>
  <Record type="HKQuantityTypeIdentifierBodyFatPercentage" sourceName="体脂秤" unit="count" startDate="2026-07-31 07:32:00 +0900" endDate="2026-07-31 07:32:00 +0900" value="0.2"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="42" durationUnit="min" totalEnergyBurned="260" totalEnergyBurnedUnit="kcal" sourceName="示例用户的 Apple Watch" startDate="2026-07-31 18:00:00 +0900" endDate="2026-07-31 18:42:00 +0900"/>
</HealthData>`;

test("accepts localized Apple Health XML names while excluding export_cda.xml", () => {
  assert.deepEqual(appleHealthXmlExtraction([
    "apple_health_export/export_cda.xml",
    "apple_health_export/导�?�.xml",
  ]), ["-p", "apple_health_export/*.xml", "-x", "apple_health_export/export_cda.xml"]);
  assert.deepEqual(appleHealthXmlExtraction(["apple_health_export/export.xml"]), ["-p", "apple_health_export/export.xml"]);
  assert.throws(() => appleHealthXmlExtraction(["apple_health_export/export_cda.xml"]), /唯一的 Apple Health 主导出 XML/);
});

test("rejects export_cda.xml with a human-readable correction", async () => {
  await assert.rejects(
    () => parseAppleHealthStream(Readable.from(["<?xml version=\"1.0\"?><ClinicalDocument/>"]), { fileName: "export_cda.xml" }),
    /不要选择 export_cda\.xml/,
  );
  const service = createAppleHealthImportService(os.tmpdir());
  const request = Readable.from(["not read"]); request.headers = { "x-infans-filename": encodeURIComponent("export_cda.xml") };
  await assert.rejects(() => service.preview(request), /返回上一级选择“导出\.zip”/);
});

test("parses SleepAnalysis Category into daily asleep minutes without inventing", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="示例用户的 Apple Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-08-04 23:00:00 +0900" endDate="2026-08-05 02:00:00 +0900"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="示例用户的 Apple Watch" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-08-05 02:00:00 +0900" endDate="2026-08-05 04:00:00 +0900"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="示例用户的 Apple Watch" value="HKCategoryValueSleepAnalysisAsleepREM" startDate="2026-08-05 04:00:00 +0900" endDate="2026-08-05 06:30:00 +0900"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="示例用户的 Apple Watch" value="HKCategoryValueSleepAnalysisInBed" startDate="2026-08-04 22:30:00 +0900" endDate="2026-08-05 06:45:00 +0900"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="示例用户的 Apple Watch" value="HKCategoryValueSleepAnalysisAwake" startDate="2026-08-05 03:00:00 +0900" endDate="2026-08-05 03:10:00 +0900"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="示例用户的 Apple Watch" unit="count" startDate="2026-08-05 08:00:00 +0900" endDate="2026-08-05 09:00:00 +0900" value="800"/>
</HealthData>`;
  const data = await parseAppleHealthStream(Readable.from([xml]), { fileName: "export.xml" });
  const day = data.daily.find((row) => row.date === "2026-08-05");
  assert.ok(day);
  // Core 180 + Deep 120 + REM 150 = 450；InBed/Awake 不计
  assert.equal(day.sleepMinutes, 450);
  assert.equal(day.asleepMinutes, 450);
  assert.match(day.sources.sleepMinutes, /Apple Watch/);
  assert.match(data.note, /客观睡眠/);
  const md = renderAppleHealthMarkdown(data);
  assert.match(md, /最近客观睡眠/);
  assert.match(md, /7\.5 h/);

  const noSleep = await parseAppleHealthStream(Readable.from([SAMPLE]), { fileName: "export.xml" });
  assert.equal(noSleep.daily.every((row) => row.sleepMinutes == null && row.asleepMinutes == null), true);
});

test("parses Apple Health XML with units and one preferred source per day", async () => {
  const data = await parseAppleHealthStream(Readable.from([SAMPLE]), { fileName: "export.xml" });
  assert.equal(data.recordCount, 8);
  assert.equal(data.daily[0].steps, 1100);
  assert.equal(data.daily[0].sources.steps, "示例用户的 Apple Watch");
  assert.equal(data.daily[0].activeEnergy, 234.5);
  assert.equal(data.latestBody.weightKg.value, 75);
  assert.equal(data.latestBody.waistCm.value, 80);
  assert.equal(data.latestBody.bodyFatPercent.value, 20);
  assert.equal(data.workouts[0].type, "传统力量训练");
  assert.equal(data.workouts[0].durationMinutes, 42);
});

test("整理放松按东京日期汇总去重，并区分完成、部分完成与未知", async () => {
  const xml = `<?xml version="1.0"?><HealthData>
    <Workout workoutActivityType="HKWorkoutActivityTypeCooldown" duration="6.2" durationUnit="min" sourceName="Apple Watch" startDate="2026-08-05 23:55:00 +0900" endDate="2026-08-06 00:01:12 +0900"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeCooldown" duration="4.1" durationUnit="min" sourceName="Apple Watch" startDate="2026-08-05 12:00:00 +0900" endDate="2026-08-05 12:04:06 +0900"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeCooldown" duration="4.1" durationUnit="min" sourceName="Apple Watch" startDate="2026-08-05 12:00:00 +0900" endDate="2026-08-05 12:04:06 +0900"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeCooldown" duration="7" durationUnit="min" sourceName="Apple Watch" startDate="2026-08-06 00:05:00 +0900" endDate="2026-08-06 00:12:00 +0900"/>
  </HealthData>`;
  const data = await parseAppleHealthStream(Readable.from([xml]), { fileName: "export.xml" });
  assert.equal(data.workouts.every((item) => item.type === "整理放松"), true);
  assert.deepEqual(data.stretch.days.map(({ date, durationMinutes, status, workoutCount }) => ({ date, durationMinutes, status, workoutCount })), [
    { date: "2026-08-05", durationMinutes: 10.3, status: "complete", workoutCount: 2 },
    { date: "2026-08-06", durationMinutes: 7, status: "partial", workoutCount: 1 },
  ]);
  assert.equal(data.stretch.missingMeans, "unknown");
  assert.equal(data.stretch.days.some((item) => item.date === "2026-08-04"), false);
  assert.match(renderAppleHealthMarkdown(data), /每日 10 分钟/);
});

test("旧 Cooldown 派生数据可据实回填，同一运动不重复计时", () => {
  const workout = { type: "Cooldown", day: "2026-06-26", date: "2026-06-26T02:18:10.000Z", end: "2026-06-26T02:24:59.000Z", durationMinutes: 6.8, source: "Apple Watch" };
  assert.deepEqual(deriveStretchDays([workout, workout]).map(({ durationMinutes, status, workoutCount }) => ({ durationMinutes, status, workoutCount })), [
    { durationMinutes: 6.8, status: "partial", workoutCount: 1 },
  ]);
});

test("拉伸跟踪并入本周安排的每日薄格", () => {
  const bodyPanel = readFileSync(new URL("../src/pages/BodyPanel.tsx", import.meta.url), "utf8");
  assert.match(bodyPanel, /week-plan-stretch/);
  assert.match(bodyPanel, /aria-label={`\$\{day\.weekday\}拉伸/);
  assert.match(bodyPanel, />\s*拉伸\s*<\/div>/);
  assert.doesNotMatch(bodyPanel, /function StretchTracker|\/ 7 天|每日十分钟拉伸/);
});

test("normalizes fractional Apple body-fat values even when the unit is percent", async () => {
  const data = await parseAppleHealthStream(Readable.from([`<HealthData><Record type="HKQuantityTypeIdentifierBodyFatPercentage" sourceName="TANITA Record" unit="%" startDate="2026-07-31 07:32:00 +0900" endDate="2026-07-31 07:32:00 +0900" value="0.19"/></HealthData>`]), { fileName: "export.xml" });
  assert.equal(data.latestBody.bodyFatPercent.value, 19);
});

test("renders a readable S2 Markdown summary without embedded JSON", async () => {
  const data = await parseAppleHealthStream(Readable.from([SAMPLE]), { fileName: "export.xml" });
  const markdown = renderAppleHealthMarkdown(data);
  assert.match(markdown, /sensitivity: S2/);
  assert.match(markdown, /原始 ZIP\/XML 未保存在 Vault/);
  assert.equal(markdown.includes("INFANS_APPLE_HEALTH_JSON_START"), false);
  assert.equal(parseAppleHealthMarkdown(markdown), null);
});

test("falls back to legacy Markdown JSON without mutating files during a read", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-health-migrate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = await parseAppleHealthStream(Readable.from([SAMPLE]), { fileName: "export.xml" });
  const target = path.join(root, "40_身心健康/体魄/Apple健康导入摘要.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${renderAppleHealthMarkdown(data)}\n## 工作台结构化数据\n\n<!-- INFANS_APPLE_HEALTH_JSON_START -->\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n<!-- INFANS_APPLE_HEALTH_JSON_END -->\n`, "utf8");
  const loaded = await readAppleHealthData(root);
  assert.equal(loaded.latestBody.weightKg.value, 75);
  await assert.rejects(() => fs.readFile(appleHealthDerivedPath(root), "utf8"), { code: "ENOENT" });
  const markdown = await fs.readFile(target, "utf8");
  assert.equal(markdown.includes("INFANS_APPLE_HEALTH_JSON_START"), true);
});

test("Apple Health import requires preview and stops on an external edit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-health-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createAppleHealthImportService(root, { now: () => new Date("2026-08-01T00:00:00+09:00") });
  const request = Readable.from([SAMPLE]); request.headers = { "x-infans-filename": encodeURIComponent("export.xml") };
  const preview = await service.preview(request);
  assert.equal(preview.after.includes("8 条健康记录"), true);
  const target = path.join(root, preview.targetPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "外部修改", "utf8");
  await assert.rejects(() => service.commit(preview.token), /外部修改/);
});

test("confirmed Apple Health import writes markdown summary and derived JSON", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-health-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createAppleHealthImportService(root, { now: () => new Date("2026-08-01T00:00:00+09:00") });
  const request = Readable.from([SAMPLE]); request.headers = { "x-infans-filename": encodeURIComponent("export.xml") };
  const preview = await service.preview(request);
  await service.commit(preview.token);
  const content = await fs.readFile(path.join(root, preview.targetPath), "utf8");
  assert.equal(content.includes("<HealthData"), false);
  assert.equal(content.includes("传统力量训练"), true);
  assert.equal(content.includes("INFANS_APPLE_HEALTH_JSON_START"), false);
  const derived = JSON.parse(await fs.readFile(appleHealthDerivedPath(root), "utf8"));
  assert.equal(derived.latestBody.weightKg.value, 75);
  assert.equal((await fs.readdir(path.dirname(path.join(root, preview.targetPath)))).length, 1);
});

test("previews a whitelisted Downloads export without browser upload", async (t) => {
  const { formatFileCreatedAt } = await import("../src/server/workbench-wechat-bills.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-health-import-"));
  const download = path.join(root, "导出.xml");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(download, SAMPLE, "utf8");
  const stamped = new Date("2026-08-09T22:15:30+09:00");
  await fs.utimes(download, stamped, stamped);
  const expectedStamp = formatFileCreatedAt(await fs.stat(download)).createdAt;
  const service = createAppleHealthImportService(root, { localCandidates: [download], now: () => new Date("2026-08-01T00:00:00+09:00") });
  const preview = await service.previewFromDownloads();
  assert.match(preview.after, /8 条健康记录/);
  assert.equal(preview.sourceFile?.name, "导出.xml");
  assert.equal(preview.sourceFile?.createdAt, expectedStamp);
  assert.equal(await fs.stat(download).then((stat) => stat.isFile()), true);
  assert.equal(await fs.access(path.join(root, preview.targetPath)).then(() => true, () => false), false);
});

test("picks the newest numbered 导出 N.zip from Downloads", async (t) => {
  const { listAppleHealthDownloadCandidates, pickNewestAppleHealthDownload } = await import("../src/server/workbench-apple-health.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-health-dl-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const oldZip = path.join(dir, "导出.zip");
  const newZip = path.join(dir, "导出 3.zip");
  await fs.writeFile(oldZip, "old");
  await fs.writeFile(newZip, "new");
  const oldTime = new Date("2026-08-01T01:00:00+09:00");
  const newTime = new Date("2026-08-06T00:04:00+09:00");
  await fs.utimes(oldZip, oldTime, oldTime);
  await fs.utimes(newZip, newTime, newTime);
  const picked = pickNewestAppleHealthDownload(await listAppleHealthDownloadCandidates(dir));
  assert.equal(picked?.filePath, newZip);
});

test("日常页不再挂 ZIP 导入入口，恢复实现仍留在后端", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const importer = readFileSync(new URL("../src/server/workbench-apple-health.mjs", import.meta.url), "utf8");
  const body = readFileSync(new URL("../src/pages/BodyPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(main, /requestAppleHealthPreview/);
  assert.doesNotMatch(main, /requestAppleHealthFromDownloads/);
  assert.doesNotMatch(main, /healthImporting/);
  assert.match(importer, /export function createAppleHealthImportService/);
  assert.match(routes, /assertAppleHealthZipOps\(request\)/);
  assert.match(routes, /\/api\/apple-health\/device-sync/);
  assert.doesNotMatch(body, /type="file"/);
  assert.match(body, /手工 ZIP 恢复只允许在这台 Mac 本机执行/);
});
