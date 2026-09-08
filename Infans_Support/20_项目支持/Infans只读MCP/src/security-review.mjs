import fs from "node:fs/promises";
import path from "node:path";

export const REVIEW_INTERVAL_DAYS = 90;

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function tokyoDate(isoValue) {
  if (!isoValue) return null;
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function securityReviewPath(stateDirectory) {
  return path.join(stateDirectory, "security-review.json");
}

export async function readSecurityReview(stateDirectory, now = new Date()) {
  try {
    const record = JSON.parse(await fs.readFile(securityReviewPath(stateDirectory), "utf8"));
    const nextDueAt = new Date(record.nextDueAt);
    return {
      intervalDays: REVIEW_INTERVAL_DAYS,
      lastReviewedAt: record.lastReviewedAt,
      lastReviewedDateTokyo: tokyoDate(record.lastReviewedAt),
      nextDueAt: record.nextDueAt,
      nextDueDateTokyo: tokyoDate(record.nextDueAt),
      overdue: Number.isNaN(nextDueAt.getTime()) || nextDueAt.getTime() <= now.getTime(),
      history: Array.isArray(record.history) ? record.history.slice(-10) : [],
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      intervalDays: REVIEW_INTERVAL_DAYS,
      lastReviewedAt: null,
      lastReviewedDateTokyo: null,
      nextDueAt: null,
      nextDueDateTokyo: null,
      overdue: true,
      history: [],
    };
  }
}

export async function completeSecurityReview(stateDirectory, options = {}) {
  const reviewedAt = options.reviewedAt ? new Date(options.reviewedAt) : new Date();
  if (Number.isNaN(reviewedAt.getTime())) throw new Error("Invalid reviewedAt date");
  const prior = await readSecurityReview(stateDirectory, reviewedAt);
  const checks = [
    "reviewed_audit_metadata",
    "reviewed_read_scope_and_exclusions",
    "ran_readonly_and_path_boundary_tests",
  ];
  if (options.rotatedTunnelRuntimeKey) checks.unshift("rotated_tunnel_runtime_key");
  const event = {
    reviewedAt: reviewedAt.toISOString(),
    nextDueAt: addDays(reviewedAt, REVIEW_INTERVAL_DAYS).toISOString(),
    actor: options.actor || "user",
    checks,
  };
  const record = {
    intervalDays: REVIEW_INTERVAL_DAYS,
    lastReviewedAt: event.reviewedAt,
    nextDueAt: event.nextDueAt,
    history: [...prior.history, event].slice(-10),
  };
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const target = securityReviewPath(stateDirectory);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
  return record;
}
