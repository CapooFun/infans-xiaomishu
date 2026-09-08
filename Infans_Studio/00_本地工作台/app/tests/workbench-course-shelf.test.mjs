import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCourseShelf, streamCourseArtifact } from "../src/server/workbench-course-shelf.mjs";
import { courseLibrarySupportDir } from "../src/server/vault-paths.mjs";

const courseUi = readFileSync(new URL("../src/pages/topics/CourseShelf.tsx", import.meta.url), "utf8");
const courseStyles = readFileSync(new URL("../src/pages/topics/course-shelf.css", import.meta.url), "utf8");
const readerUi = readFileSync(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const readerStyles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

async function writeCourse(root, overrides = {}) {
  const courseDir = path.join(root, "形象管理", "男生日常自然妆入门");
  await fs.mkdir(path.join(courseDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(courseDir, "course.pdf"), "0123456789");
  await fs.writeFile(path.join(courseDir, "assets", "cover.png"), "cover");
  const manifest = {
    schemaVersion: 1,
    courseId: "image-management.mens-natural-makeup-basics",
    topicId: "image-management",
    title: "男生日常自然妆入门",
    subtitle: "看不出明显妆感，但更干净、更精神",
    status: "trial",
    version: "1.0",
    createdAt: "2026-08-21",
    topics: ["男士 BB", "自然眉毛", "局部遮瑕"],
    sourceReferences: ["private/source.md"],
    artifacts: [
      { type: "application/pdf", path: "course.pdf", role: "reading" },
      { type: "image/png", path: "assets/cover.png", role: "cover" },
    ],
    ...overrides,
  };
  await fs.writeFile(path.join(courseDir, "课件清单.json"), JSON.stringify(manifest));
  return courseDir;
}

test("课程书架目录固定落在 Vault 同级支持库学习资料", () => {
  assert.equal(
    courseLibrarySupportDir("/Users/test/Infans_Vault"),
    "/Users/test/Infans_Support/10_学习资料",
  );
});

test("课件图标直接下载，不再跳出小秘书或生成额外选择框", () => {
  assert.match(readerStyles, /@media \(min-width:1101px\) and \(max-width:1366px\)[\s\S]*?\.reader-layout\s*\{[\s\S]*?width:100%;[\s\S]*?grid-template-columns:minmax\(220px,260px\) minmax\(0,1fr\)/);
  assert.ok((readerStyles.match(/width:min\(960px,100%\);grid-template-columns:1fr/g) ?? []).length >= 1);
  assert.match(courseStyles, /\.topic-course-shelf\{align-self:start;height:max-content;min-height:0/);
  assert.match(courseStyles, /\.reader aside:has\(\.topic-course-shelf\).*height:max-content.*max-height:none/);
  assert.match(readerUi, /关闭阅读/);
  assert.match(courseUi, /className="topic-course-open" href=\{course\.pdfUrl\} download/);
  assert.match(courseUi, /aria-label=\{`下载课件：\$\{course\.title\}`\}/);
  assert.equal(courseUi.includes("<iframe"), false);
  assert.equal(courseUi.includes("CourseLaunchDialog"), false);
  assert.equal(courseUi.includes("googlechrome"), false);
  assert.equal(courseUi.includes('<article className="topic-course-card"'), false);
  assert.equal(courseUi.includes('target="_blank"'), false);
  assert.equal(courseUi.includes(">在新页面打开"), false);
});

test("课件清单只返回书架所需字段，不泄露来源路径", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-course-shelf-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeCourse(root);
  const shelf = await readCourseShelf(root);
  assert.equal(shelf.available, true);
  assert.equal(shelf.courses.length, 1);
  assert.equal(shelf.courses[0].title, "男生日常自然妆入门");
  assert.equal(shelf.courses[0].topicId, "image-management");
  assert.equal(shelf.courses[0].pdfUrl, "/api/course-shelf/image-management.mens-natural-makeup-basics/pdf");
  assert.equal(shelf.courses[0].coverUrl, "/api/course-shelf/image-management.mens-natural-makeup-basics/cover");
  assert.equal("sourceReferences" in shelf.courses[0], false);
});

test("没有专题归属的课件不会成为孤立书架条目", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-course-orphan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeCourse(root, { topicId: "" });
  const shelf = await readCourseShelf(root);
  assert.equal(shelf.courses.length, 0);
  assert.match(shelf.warnings[0], /topicId/);
});

test("损坏清单和越界 PDF 只产生局部警告", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-course-bad-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const brokenDir = path.join(root, "损坏课程");
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(path.join(brokenDir, "课件清单.json"), "{broken");
  await writeCourse(root, {
    courseId: "unsafe-course",
    artifacts: [{ type: "application/pdf", path: "../outside.pdf", role: "reading" }],
  });
  await fs.writeFile(path.join(root, "形象管理", "outside.pdf"), "outside");
  const shelf = await readCourseShelf(root);
  assert.equal(shelf.available, false);
  assert.equal(shelf.courses.length, 0);
  assert.equal(shelf.warnings.length, 2);
  assert.match(shelf.warnings.join("\n"), /有效 JSON/);
  assert.match(shelf.warnings.join("\n"), /越过/);
});

test("PDF 分段 HEAD 请求按课程编号返回精确范围", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-course-range-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeCourse(root);
  const headers = new Map();
  const response = {
    statusCode: 0,
    ended: false,
    setHeader(name, value) { headers.set(name, String(value)); },
    end() { this.ended = true; },
  };
  await streamCourseArtifact(
    { method: "HEAD", headers: { range: "bytes=2-5" } },
    response,
    root,
    "image-management.mens-natural-makeup-basics",
    "pdf",
  );
  assert.equal(response.statusCode, 206);
  assert.equal(headers.get("Content-Type"), "application/pdf");
  assert.equal(headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(headers.get("Content-Length"), "4");
  assert.equal(response.ended, true);
});

test("课件 PDF 符号链接不会进入书架", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-course-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.pdf");
  await fs.writeFile(outside, "outside");
  const courseDir = await writeCourse(root, {
    courseId: "linked-course",
    artifacts: [{ type: "application/pdf", path: "linked.pdf", role: "reading" }],
  });
  await fs.symlink(outside, path.join(courseDir, "linked.pdf"));
  const shelf = await readCourseShelf(root);
  assert.equal(shelf.courses.length, 0);
  assert.match(shelf.warnings[0], /符号链接/);
});
