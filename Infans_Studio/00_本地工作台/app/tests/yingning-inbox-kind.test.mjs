import assert from "node:assert/strict";
import test from "node:test";
import { fileBadge, inboxItemKind, isFileContentType, isImageContentType, isPlainTextFile } from "../src/pages/tools/yingning-inbox-kind.ts";

test("inboxItemKind：按 MIME 把照片、文件和书签分开", () => {
  assert.equal(inboxItemKind({}), "bookmark");
  assert.equal(inboxItemKind({ attachments: [{ contentType: "image/heic" }] }), "photo");
  assert.equal(inboxItemKind({ attachments: [{ contentType: "application/pdf" }] }), "file");
  assert.equal(inboxItemKind({ attachments: [{ contentType: "image/png" }, { contentType: "application/pdf" }] }), "file");
  assert.equal(isImageContentType("image/jpeg"), true);
  assert.equal(isFileContentType("application/pdf"), true);
  assert.equal(fileBadge("application/pdf", "notes.pdf"), "PDF");
});

test("isPlainTextFile：txt／md／csv／json 算正文，PDF 不算", () => {
  assert.equal(isPlainTextFile("text/plain"), true);
  assert.equal(isPlainTextFile("text/csv"), true);
  assert.equal(isPlainTextFile("application/json"), true);
  assert.equal(isPlainTextFile("application/pdf"), false);
  assert.equal(isPlainTextFile("image/png"), false);
});
