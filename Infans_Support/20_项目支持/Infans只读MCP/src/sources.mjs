import { existsSync } from "node:fs";
import { createVaultReader } from "./vault.mjs";
import { VaultError } from "./errors.mjs";

export function createSourceReaders(config, env = process.env) {
  // Custom/test Vault roots do not implicitly grant access to the user's projects.
  const roots = {
    vault: config.vaultRoot,
    support: env.INFANS_SUPPORT_ROOT || null,
    games: env.INFANS_GAMES_ROOT || null,
  };
  const readers = new Map();
  for (const [source, root] of Object.entries(roots)) {
    if (root && existsSync(root)) readers.set(source, createVaultReader({ ...config, vaultRoot: root }));
  }
  return {
    sources: [...readers.keys()],
    get(source = "vault") {
      if (!readers.has(source)) throw new VaultError("UNKNOWN_SOURCE", "This source is not configured or is unavailable.");
      return readers.get(source);
    },
  };
}
