#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { completeSecurityReview, readSecurityReview } from "../src/security-review.mjs";

const config = loadConfig();
const command = process.argv[2] || "status";

if (command === "status") {
  console.log(JSON.stringify(await readSecurityReview(config.stateDirectory), null, 2));
} else if (command === "complete") {
  const actorIndex = process.argv.indexOf("--actor");
  const actor = actorIndex >= 0 ? process.argv[actorIndex + 1] : "user";
  const rotatedTunnelRuntimeKey = process.argv.includes("--rotated-tunnel-key");
  console.log(JSON.stringify(await completeSecurityReview(config.stateDirectory, { actor, rotatedTunnelRuntimeKey }), null, 2));
} else {
  console.error("Usage: node scripts/security-review.mjs [status|complete] [--actor user] [--rotated-tunnel-key]");
  process.exitCode = 2;
}
