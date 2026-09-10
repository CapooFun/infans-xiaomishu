import assert from "node:assert/strict";
import test from "node:test";
import { flattenInboxImageSlides, inboxSlideStep } from "../src/pages/tools/yingning-inbox-preview.ts";

function item(id, attachments) {
  return { intakeId: id, attachments };
}

test("把当前列表里的照片按卡片顺序铺成可翻页的一条", () => {
  const slides = flattenInboxImageSlides([
    item("a", [
      { attachmentId: "a1", contentType: "image/png" },
      { attachmentId: "a2", contentType: "image/jpeg" },
    ]),
    item("b", [{ attachmentId: "b1", contentType: "application/pdf" }]),
    item("c", [{ attachmentId: "c1", contentType: "image/webp" }]),
  ]);
  assert.deepEqual(slides.map((slide) => slide.attachment.attachmentId), ["a1", "a2", "c1"]);
});

test("左右翻页会绕回，方便把图看完", () => {
  const slides = flattenInboxImageSlides([
    item("a", [{ attachmentId: "a1", contentType: "image/png" }]),
    item("b", [{ attachmentId: "b1", contentType: "image/png" }]),
  ]);
  assert.equal(inboxSlideStep(slides, "a", "a1", 1)?.attachment.attachmentId, "b1");
  assert.equal(inboxSlideStep(slides, "b", "b1", 1)?.attachment.attachmentId, "a1");
  assert.equal(inboxSlideStep(slides, "a", "a1", -1)?.attachment.attachmentId, "b1");
});
