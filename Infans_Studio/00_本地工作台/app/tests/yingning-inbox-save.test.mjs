import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  bytesToHex,
  canShareFileSafely,
  checkOriginalIntegrity,
  classifyShareError,
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

test("取消判定：仅 AbortError 算取消，NotAllowedError 归为 blocked", () => {
  const abort = new DOMException("cancel", "AbortError");
  const denied = new DOMException("no", "NotAllowedError");
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(denied), false);
  assert.equal(classifyShareError(abort), "aborted");
  assert.equal(classifyShareError(denied), "blocked");
});

test("canShareFileSafely：false / 抛错 / 缺失都当作不支持", () => {
  const file = new File([pngBytes()], "a.png", { type: "image/png" });
  assert.equal(canShareFileSafely(() => true, file), true);
  assert.equal(canShareFileSafely(() => false, file), false);
  assert.equal(canShareFileSafely(() => { throw new TypeError("bad"); }, file), false);
  assert.equal(canShareFileSafely(undefined, file), false);
});

test("pruneTempSaveState：清临时态，保留结束态", () => {
  const after = pruneTempSaveState({ a: "preparing", b: "armed", c: "downloaded", d: "opened", e: "error" });
  assert.deepEqual(after, { c: "downloaded", d: "opened", e: "error" });
});

test("saveButtonLabel：armed 分享显示再点一次", () => {
  assert.equal(saveButtonLabel("armed", true), "再点一次·打开面板");
  assert.equal(saveButtonLabel("idle", false), "保存图片");
});

test("downloadNameFor：有编号用编号，否则沿用原名并跟 MIME", () => {
  assert.equal(downloadNameFor({ contentType: "image/png", fileName: "shot.heic", evidenceId: "example_A01" }), "example_A01.png");
  assert.equal(downloadNameFor({ contentType: "image/heic", fileName: "IMG_0001.HEIC" }), "IMG_0001.heic");
});

test("bytesToHex：稳定小写十六进制", () => {
  assert.equal(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff])), "000fff");
});

test("magicMatches：JPEG 正反例", () => {
  assert.equal(magicMatches(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"), true);
  assert.equal(magicMatches(new Uint8Array([0x00, 0xd8, 0xff]), "image/jpeg"), false);
});
