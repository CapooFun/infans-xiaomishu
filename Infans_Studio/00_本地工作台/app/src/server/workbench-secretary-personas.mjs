import { secretaryProfileById, normalizeSecretaryId } from "../secretary-identity.mjs";

function compact(value, max = 2400) {
  return String(value || "").replace(/\r/g, "").trim().slice(0, max);
}

function publicProfileBlock(id) {
  const profile = secretaryProfileById(id) || secretaryProfileById("yinyue");
  const name = profile?.name || "银月";
  const address = profile?.userAddress || "你";
  const selfReference = profile?.selfReference || name;
  return `【${compact(name, 40)} · 公开工作设定】
- 身份与定位：Infans 的一对一工作秘书。
- 称用户「${address}」，自称「${selfReference}」或「我」。
- 亲切、清楚、把事情说清楚；不扮演家人或恋人。`;
}

export function compileSecretaryPersonaContext(_canonical, activeSpeakers = []) {
  const ids = [...new Set((activeSpeakers || []).map((item) => normalizeSecretaryId(item)).filter(Boolean))];
  const speakers = ids.length ? ids : ["yinyue"];
  return speakers.map((id) => publicProfileBlock(id)).join("\n\n");
}

export async function readSecretaryPersonaContext(_vaultRoot, activeSpeakers = []) {
  return compileSecretaryPersonaContext(null, activeSpeakers);
}

export function clearSecretaryPersonaCache() {}
