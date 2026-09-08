#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const label = "com.infans.readonly-mcp-security-review";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildPlist({ nodePath, reminderScript }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(reminderScript)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const reminderScript = path.join(projectRoot, "scripts", "security-reminder.mjs");
  const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgents, `${label}.plist`);
  const plist = buildPlist({ nodePath: process.execPath, reminderScript });

  if (process.argv.includes("--dry-run")) {
    process.stdout.write(plist);
  } else {
    await fs.mkdir(launchAgents, { recursive: true, mode: 0o700 });
    await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: 0o600 });
    await execFileAsync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
    console.log(JSON.stringify({ installed: true, label, plistPath, schedule: "每天 09:00 检查；仅逾期时通知" }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
