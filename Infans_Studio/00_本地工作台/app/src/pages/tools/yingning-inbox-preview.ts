// 收件箱全图：把当前列表里的照片铺成一条，方便左右翻。

export type InboxPreviewHost = {
  intakeId: string;
  attachments?: Array<{ attachmentId: string; contentType: string }> | null;
};

function isImageContentType(contentType: string) {
  return String(contentType || "").toLowerCase().startsWith("image/");
}

export function flattenInboxImageSlides<T extends InboxPreviewHost>(items: readonly T[]) {
  const slides: Array<{ item: T; attachment: NonNullable<T["attachments"]>[number] }> = [];
  for (const item of items) {
    for (const attachment of item.attachments ?? []) {
      if (isImageContentType(attachment.contentType)) slides.push({ item, attachment });
    }
  }
  return slides;
}

export function inboxSlideIndex<T extends InboxPreviewHost>(
  slides: readonly { item: T; attachment: { attachmentId: string } }[],
  itemId: string,
  attachmentId: string,
) {
  return slides.findIndex((slide) => slide.item.intakeId === itemId && slide.attachment.attachmentId === attachmentId);
}

export function inboxSlideStep<T extends InboxPreviewHost>(
  slides: readonly { item: T; attachment: { attachmentId: string } }[],
  itemId: string,
  attachmentId: string,
  delta: number,
) {
  if (!slides.length) return null;
  const index = inboxSlideIndex(slides, itemId, attachmentId);
  const from = index < 0 ? 0 : index;
  const next = (from + delta % slides.length + slides.length) % slides.length;
  return slides[next] ?? null;
}
