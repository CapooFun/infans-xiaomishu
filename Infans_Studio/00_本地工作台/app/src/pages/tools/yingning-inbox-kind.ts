export type InboxItemKind = "photo" | "file" | "bookmark";

export function isImageContentType(contentType: string) {
  return String(contentType || "").toLowerCase().startsWith("image/");
}

export function isFileContentType(contentType: string) {
  const type = String(contentType || "").toLowerCase();
  return Boolean(type) && !type.startsWith("image/");
}

export function isPlainTextFile(contentType: string) {
  const type = String(contentType || "").toLowerCase();
  return type === "text/plain" || type === "text/markdown" || type === "text/csv" || type === "application/json";
}

export function inboxItemKind(item: { attachments?: Array<{ contentType: string }> | null }): InboxItemKind {
  const list = item.attachments ?? [];
  if (!list.length) return "bookmark";
  if (list.some((row) => isFileContentType(row.contentType))) return "file";
  return "photo";
}

export function fileBadge(contentType: string, fileName = "") {
  if (contentType === "application/pdf" || /\.pdf$/iu.test(fileName)) return "PDF";
  const ext = fileName.split(".").pop()?.toUpperCase();
  if (ext && ext.length <= 5 && ext !== fileName.toUpperCase()) return ext;
  if (contentType.includes("word") || contentType.includes("document")) return "DOC";
  if (contentType.includes("sheet") || contentType.includes("excel")) return "XLS";
  if (contentType.includes("presentation") || contentType.includes("powerpoint")) return "PPT";
  return "FILE";
}
