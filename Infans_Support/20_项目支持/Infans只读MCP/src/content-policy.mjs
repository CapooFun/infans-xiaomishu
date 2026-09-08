import { VaultError } from "./errors.mjs";

// Reject the complete document before slicing. Patterns supplement path isolation;
// they do not certify arbitrary encoded or disguised secrets as safe.
export function assertSafeContent(content) {
  if (content.includes("\0")) throw new VaultError("BINARY_CONTENT", "Binary content is not supported.");
  const patterns = [
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u,
    /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,})\b/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
    /(?:authorization\s*[:=]\s*["']?\s*bearer|bearer)\s+[A-Za-z0-9._~+\/-]{12,}/iu,
    /(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s/:]+:[^\s/@]+@/iu,
    /(?:["']?(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|密码|密钥|恢复码|助记词)["']?)\s*[:=：]\s*["'][^"'\r\n]{4,}["']/iu,
    /^\s*(?:[-*]\s*)?(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|密码|密钥|恢复码|助记词)\s*[:=：]\s*(?!process\.|os\.|\$|<|\[|null\b|undefined\b)[^\s]{4,}\s*$/imu,
  ];
  if (patterns.some((pattern) => pattern.test(content))) {
    throw new VaultError("SENSITIVE_CONTENT", "Potential credentials detected; document content is withheld.");
  }
  return content;
}
