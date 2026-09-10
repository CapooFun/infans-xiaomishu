import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackInboxSection,
  inboxLocationForSection,
  parseInboxSection,
  resolveInboxSection,
} from "../src/pages/tools/yingning-inbox-section.ts";

test("网址里的分类优先，没有网址时沿用上次记住的标签", () => {
  assert.equal(parseInboxSection("projects"), "projects");
  assert.equal(parseInboxSection("nope"), null);
  assert.equal(resolveInboxSection(""), "photos");
  assert.equal(resolveInboxSection("", "projects"), "projects");
  assert.equal(resolveInboxSection("?section=projects", "photos"), "projects");
  assert.equal(resolveInboxSection("?section=nope", "files"), "files");
  assert.equal(resolveInboxSection("?section=photos", "projects"), "photos");
});

test("照片是默认分类，不写进网址；项目收件会写进网址", () => {
  assert.equal(inboxLocationForSection("/tools/inbox", "", "projects"), "/tools/inbox?section=projects");
  assert.equal(inboxLocationForSection("/tools/inbox", "?section=projects", "photos"), "/tools/inbox");
  assert.equal(inboxLocationForSection("/tools/inbox", "?section=bookmarks", "files"), "/tools/inbox?section=files");
  assert.equal(inboxLocationForSection("/tools/music", "?path=a", "projects"), "/tools/music?path=a");
});

test("项目收件还有来件时不要被日常照片挤走", () => {
  const counts = { photos: 51, bookmarks: 6, files: 2, projects: 36, trash: 71 };
  assert.equal(fallbackInboxSection("projects", counts), "projects");
  assert.equal(fallbackInboxSection("projects", { ...counts, projects: 0 }), "photos");
  assert.equal(fallbackInboxSection("photos", { photos: 0, bookmarks: 1, files: 0, projects: 0, trash: 0 }), "bookmarks");
  assert.equal(fallbackInboxSection("trash", { photos: 1, bookmarks: 0, files: 0, projects: 0, trash: 0 }), "trash");
});
