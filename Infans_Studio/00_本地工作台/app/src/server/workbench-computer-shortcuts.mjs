import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { COMPUTER_SHORTCUTS_PATH } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import {
  CURSOR_VOICE_COMMAND,
  cursorSettingsUnbindNeeded,
  cursorVoiceShortcutKey,
  normalizeComputerShortcutBindings,
  presentComputerShortcuts,
  screenshotHotKeyPayload,
  validateComputerShortcutBindings,
} from "../computer-shortcuts.mjs";

const CURSOR_UNBIND = Object.freeze({
  key: "cmd+,",
  command: "-workbench.action.openSettings",
});

const CURSOR_SETTINGS_UNBINDS = Object.freeze([
  CURSOR_UNBIND,
  Object.freeze({ key: "cmd+,", command: "-aiSettings.action.open" }),
  Object.freeze({ key: "cmd+,", command: "-workbench.action.openSettings2" }),
]);

function statePath(root) {
  return path.resolve(root, COMPUTER_SHORTCUTS_PATH);
}

function emptyState() {
  return { schemaVersion: 1, revision: 0, bindings: normalizeComputerShortcutBindings({}) };
}

async function readState(root) {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(root), "utf8"));
    if (!raw || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0) {
      throw new Error("INVALID");
    }
    const issues = validateComputerShortcutBindings(raw.bindings);
    if (issues.length) throw new Error("INVALID");
    return {
      schemaVersion: 1,
      revision: raw.revision,
      bindings: normalizeComputerShortcutBindings(raw.bindings),
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    if (error.message === "INVALID") return emptyState();
    throw new WorkbenchWriteError("本机快捷键暂时无法读取，原文件已保留", 500, "COMPUTER_SHORTCUTS_READ_FAILED");
  }
}

function snapshot(state) {
  return presentComputerShortcuts(state.bindings, { revision: state.revision });
}

function runPython(script, payload) {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (code !== 0) return resolve({ ok: false, error: stderr || `python exited ${code}` });
      resolve({ ok: true, output: Buffer.concat(chunks).toString("utf8").trim() });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

const SCREENSHOT_SCRIPT = `
import json, plistlib, subprocess, sys
from pathlib import Path
payload = json.load(sys.stdin)
plist_path = Path.home() / "Library/Preferences/com.apple.symbolichotkeys.plist"
data = {}
if plist_path.exists() and plist_path.stat().st_size:
    with plist_path.open("rb") as handle:
        data = plistlib.load(handle)
hotkeys = data.get("AppleSymbolicHotKeys")
if not isinstance(hotkeys, dict):
    hotkeys = {}
    data["AppleSymbolicHotKeys"] = hotkeys
for item in payload["items"]:
    key = str(item["id"])
    if item["enabled"]:
        hotkeys[key] = {
            "enabled": True,
            "value": {
                "parameters": [int(item["ascii"]), int(item["keyCode"]), int(item["modifiers"])],
                "type": "standard",
            },
        }
    elif key in hotkeys and isinstance(hotkeys[key], dict):
        hotkeys[key]["enabled"] = False
with plist_path.open("wb") as handle:
    plistlib.dump(data, handle, sort_keys=False)
subprocess.run(["/usr/bin/defaults", "read", "com.apple.symbolichotkeys"], check=False, capture_output=True)
activator = "/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings"
if Path(activator).exists():
    subprocess.run([activator, "-u"], check=False)
print("ok")
`;

async function applyScreenshotHotkeys(bindings) {
  const screenshots = screenshotHotKeyPayload(bindings);
  const result = await runPython(SCREENSHOT_SCRIPT, {
    items: Object.values(screenshots).filter((item) => !item.enabled || Number.isInteger(item.keyCode)),
  });
  if (!result.ok) return `截屏快捷键没有写进系统：${result.error}`;
  return "";
}

function parseJsoncArray(raw) {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("INVALID");
  return {
    prefix: raw.slice(0, start),
    items: JSON.parse(raw.slice(start, end + 1)),
    suffix: raw.slice(end + 1),
  };
}

function isCursorSettingsUnbind(item) {
  return CURSOR_SETTINGS_UNBINDS.some((unbind) => item && item.key === unbind.key && item.command === unbind.command);
}

function isManagedCursorBinding(item, voiceKey) {
  if (isCursorSettingsUnbind(item)) return true;
  if (!item || item.command !== CURSOR_VOICE_COMMAND) return false;
  return item.key === voiceKey || item.key === "cmd+,";
}

async function applyCursorSettingsConflict(bindings) {
  const file = path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "keybindings.json");
  let raw = "[\n]\n";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return `使用者自己的 Cursor 键位文件暂时无法读取：${error.message}`;
  }
  let parsed;
  try {
    parsed = parseJsoncArray(raw);
  } catch {
    return "使用者自己的 Cursor 键位文件不是可编辑的列表，已跳过让键。";
  }
  if (!Array.isArray(parsed.items)) return "使用者自己的 Cursor 键位文件不是可编辑的列表，已跳过让键。";
  const voiceKey = cursorVoiceShortcutKey(bindings);
  const needed = cursorSettingsUnbindNeeded(bindings);
  const without = parsed.items.filter((item) => !isManagedCursorBinding(item, voiceKey));
  const next = [...without];
  if (needed) next.push(...CURSOR_SETTINGS_UNBINDS.map((item) => ({ ...item })));
  if (voiceKey) {
    next.push({
      key: voiceKey,
      command: CURSOR_VOICE_COMMAND,
      when: "!terminalFocus",
    });
  }
  if (JSON.stringify(next) === JSON.stringify(parsed.items)) return "";
  const body = `${parsed.prefix}${JSON.stringify(next, null, 4)}${parsed.suffix || "\n"}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
  if (needed && voiceKey) {
    return "已取消使用者自己的 Cursor 的 Command+, 设置键，并改为打开听写；打开设置请改用菜单。";
  }
  if (voiceKey) return "已把当前听写键写进使用者自己的 Cursor 的听写开关。";
  return "";
}

async function applyComputerShortcutEffects(bindings) {
  const warnings = [];
  const screenshot = await applyScreenshotHotkeys(bindings);
  if (screenshot) warnings.push(screenshot);
  const cursor = await applyCursorSettingsConflict(bindings);
  if (cursor) warnings.push(cursor);
  return warnings;
}

export async function readComputerShortcuts(root) {
  return snapshot(await readState(root));
}

export async function writeComputerShortcuts(root, body) {
  const current = await readState(root);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WorkbenchWriteError("保存请求无效", 400, "COMPUTER_SHORTCUTS_INVALID");
  }
  if (body.expectedRevision !== current.revision) {
    throw new WorkbenchWriteError("快捷键已在另一处更新，请重新读取后再保存", 409, "COMPUTER_SHORTCUTS_CONFLICT");
  }
  const issues = validateComputerShortcutBindings(body.bindings);
  if (issues.length) throw new WorkbenchWriteError(issues[0].message, 400, "COMPUTER_SHORTCUTS_INVALID");
  const next = {
    schemaVersion: 1,
    revision: current.revision + 1,
    bindings: normalizeComputerShortcutBindings(body.bindings),
  };
  const file = statePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  const warnings = await applyComputerShortcutEffects(next.bindings);
  return { ...snapshot(next), warnings };
}

export async function applyStoredComputerShortcuts(root) {
  const state = await readState(root);
  const warnings = await applyComputerShortcutEffects(state.bindings);
  return { ...snapshot(state), warnings };
}
