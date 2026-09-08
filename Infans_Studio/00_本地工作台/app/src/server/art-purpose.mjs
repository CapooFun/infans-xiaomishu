// Project-owned purposes remain independent of approval state.
export function artPurpose(value) {
  const text = String(value || "").trim().replace(/候选(?:素材)?$/u, "").trim();
  if (/^(聊天头像|秘书头像)$/u.test(text)) return "头像";
  if (/^(聊天立绘|普通立绘)$/u.test(text)) return "普通立绘";
  if (/^(便服生活照)$/u.test(text)) return "生活照";
  return text || "待分类";
}
