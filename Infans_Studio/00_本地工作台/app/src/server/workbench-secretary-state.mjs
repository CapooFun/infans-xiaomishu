import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_SECRETARY_ID,
  normalizeSecretaryId,
  secretaryProfileById,
} from "../secretary-identity.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { ACTIVE_SECRETARY_STATE_PATH } from "./vault-paths.mjs";

function publicState(activeSecretaryId, updatedAt = null) {
  const profile = secretaryProfileById(activeSecretaryId) || secretaryProfileById(DEFAULT_SECRETARY_ID);
  return {
    schemaVersion: 1,
    activeSecretaryId: profile.id,
    profile,
    updatedAt: updatedAt || null,
  };
}

async function atomicWrite(target, body) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export function createSecretaryStateService(vaultRoot, options = {}) {
  const statePath = path.resolve(vaultRoot, options.statePath || ACTIVE_SECRETARY_STATE_PATH);
  let serial = Promise.resolve();

  async function read() {
    try {
      const stored = JSON.parse(await fs.readFile(statePath, "utf8"));
      return publicState(normalizeSecretaryId(stored?.activeSecretaryId) || DEFAULT_SECRETARY_ID, stored?.updatedAt);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return publicState(DEFAULT_SECRETARY_ID);
      throw error;
    }
  }

  async function write(raw, now = new Date()) {
    const activeSecretaryId = normalizeSecretaryId(raw);
    const profile = activeSecretaryId ? secretaryProfileById(activeSecretaryId) : null;
    if (!profile?.secretaryEligible) {
      throw new WorkbenchWriteError("这个人物不能成为当前秘书", 400, "SECRETARY_INVALID");
    }
    const operation = serial.then(async () => {
      const updatedAt = now.toISOString();
      await atomicWrite(statePath, { schemaVersion: 1, activeSecretaryId, updatedAt });
      return publicState(activeSecretaryId, updatedAt);
    });
    serial = operation.catch(() => {});
    return operation;
  }

  return { read, write, statePath };
}
