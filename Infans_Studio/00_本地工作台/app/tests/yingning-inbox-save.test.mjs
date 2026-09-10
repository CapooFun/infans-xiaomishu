import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  bytesToHex,
  canShareFileSafely,
  checkOriginalIntegrity,
  classifyShareError,
  decodeTextFileBytes,
  downloadNameFor,
  isAbortError,
  magicMatches,
  pruneTempSaveState,
  saveButtonLabel,
} from "../src/pages/tools/yingning-inbox-save.ts";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngBytes(extra = 16) {
  return new Uint8Array([...PNG_SIG, ...Array.from({ length: extra }, (_, i) => i & 0xff)]);
}
function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

test("checkOriginalIntegrity：正常 PNG 原字节通过并回真实类型", () => {
  const bytes = pngBytes();
  const out = checkOriginalIntegrity({
    bytes,
    headerType: "image/png",
    attachmentContentType: "image/png",
    attachmentByteCount: bytes.byteLength,
    attachmentSha256: sha256Hex(bytes),
    actualSha256: sha256Hex(bytes),
  });
  assert.equal(out.type, "image/png");
});

test("checkOriginalIntegrity：伪装成 PNG 的 HTML 被魔数拦下", () => {
  const html = new TextEncoder().encode("<!doctype html><html>login</html>");
  assert.throws(() => checkOriginalIntegrity({
    bytes: html,
    headerType: "image/png",
    attachmentContentType: "image/png",
    attachmentByteCount: html.byteLength,
  }), /不是有效原图/u);
});

test("checkOriginalIntegrity：响应类型与登记不一致直接拒绝", () => {
  const bytes = pngBytes();
  assert.throws(() => checkOriginalIntegrity({
    bytes,
    headerType: "text/html",
    attachmentContentType: "image/png",
  }), /类型和记录不一致/u);
});

test("checkOriginalIntegrity：非图片类型拒绝", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.throws(() => checkOriginalIntegrity({
    bytes,
    headerType: "application/octet-stream",
    attachmentContentType: "",
  }), /不是有效附件|不是图片/u);
});

test("checkOriginalIntegrity：合法 PDF 通过", () => {
  const bytes = new TextEncoder().encode("%PDF-1.4 test");
  const out = checkOriginalIntegrity({
    bytes,
    headerType: "application/pdf",
    attachmentContentType: "application/pdf",
    attachmentByteCount: bytes.byteLength,
  });
  assert.equal(out.type, "application/pdf");
});

test("saveButtonLabel：文件用保存文件，图片默认不变", () => {
  assert.equal(saveButtonLabel("armed", false, "file"), "保存文件");
  assert.equal(saveButtonLabel("fallback", true, "file"), "下载文件");
});

test("downloadNameFor：PDF 跟随 MIME 扩展名", () => {
  assert.equal(downloadNameFor({ contentType: "application/pdf", fileName: "notes.bin" }), "notes.pdf");
});

test("checkOriginalIntegrity：字节数不符拒绝", () => {
  const bytes = pngBytes();
  assert.throws(() => checkOriginalIntegrity({
    bytes,
    headerType: "image/png",
    attachmentContentType: "image/png",
    attachmentByteCount: bytes.byteLength + 1,
  }), /大小和记录不一致/u);
});

test("checkOriginalIntegrity：sha256 不符拒绝", () => {
  const bytes = pngBytes();
  assert.throws(() => checkOriginalIntegrity({
    bytes,
    headerType: "image/png",
    attachmentContentType: "image/png",
    attachmentByteCount: bytes.byteLength,
    attachmentSha256: sha256Hex(bytes),
    actualSha256: sha256Hex(pngBytes(8)),
  }), /校验没通过/u);
});

test("magicMatches：JPEG/WebP/HEIC 正反例", () => {
  assert.equal(magicMatches(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"), true);
  assert.equal(magicMatches(new Uint8Array([0x00, 0xd8, 0xff]), "image/jpeg"), false);
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(magicMatches(webp, "image/webp"), true);
  const heic = new Uint8Array(12);
  heic.set([0x66, 0x74, 0x79, 0x70], 4);
  assert.equal(magicMatches(heic, "image/heic"), true);
});

test("取消判定：仅 AbortError 算取消，NotAllowedError 归为 blocked", () => {
  const abort = new DOMException("cancel", "AbortError");
  const denied = new DOMException("no", "NotAllowedError");
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(denied), false);
  assert.equal(classifyShareError(abort), "aborted");
  assert.equal(classifyShareError(denied), "blocked");
  assert.equal(classifyShareError(new Error("boom")), "blocked");
});

test("canShareFileSafely：false / 抛错 / 缺失都当作不支持", () => {
  const file = new File([pngBytes()], "a.png", { type: "image/png" });
  assert.equal(canShareFileSafely(() => true, file), true);
  assert.equal(canShareFileSafely(() => false, file), false);
  assert.equal(canShareFileSafely(() => { throw new TypeError("bad"); }, file), false);
  assert.equal(canShareFileSafely(undefined, file), false);
});

test("pruneTempSaveState：清 preparing/armed/sharing/fallback，保留结束态", () => {
  const before = { a: "preparing", b: "armed", c: "downloaded", d: "opened", e: "error", f: "sharing", g: "fallback" };
  const after = pruneTempSaveState(before);
  assert.deepEqual(after, { c: "downloaded", d: "opened", e: "error" });
  const stable = { c: "downloaded" };
  assert.equal(pruneTempSaveState(stable), stable);
});

test("saveButtonLabel：fallback 显示下载原图，armed 分享显示再点一次", () => {
  assert.equal(saveButtonLabel("fallback", true), "下载原图");
  assert.equal(saveButtonLabel("armed", true), "再点一次·打开面板");
  assert.equal(saveButtonLabel("armed", false), "保存图片");
  assert.equal(saveButtonLabel("downloaded", false), "已开始下载");
});

test("downloadNameFor：有编号用编号，否则沿用原名并跟 MIME", () => {
  assert.equal(downloadNameFor({ contentType: "image/png", fileName: "shot.heic", evidenceId: "example_A01" }), "example_A01.png");
  assert.equal(downloadNameFor({ contentType: "image/heic", fileName: "IMG_0001.HEIC" }), "IMG_0001.heic");
});

test("bytesToHex：稳定小写十六进制", () => {
  assert.equal(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff])), "000fff");
});

test("decodeTextFileBytes：UTF-8、BOM 和 UTF-16 都能还原正文", () => {
  assert.equal(decodeTextFileBytes(new TextEncoder().encode("date,amount\n1,2\n")), "date,amount\n1,2\n");
  assert.equal(decodeTextFileBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42])), "AB");
  assert.equal(decodeTextFileBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])), "AB");
});

