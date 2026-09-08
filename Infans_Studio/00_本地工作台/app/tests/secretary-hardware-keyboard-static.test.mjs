import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const appRoot = path.resolve(import.meta.dirname, "..");

test("iOS 原生输入框保留最小硬件键盘契约", async () => {
  const [composer, project] = await Promise.all([
    fs.readFile(
      path.join(appRoot, "native/InfansHealthSync/InfansHealthSync/SecretaryMessageComposer.swift"),
      "utf8",
    ),
    fs.readFile(
      path.join(appRoot, "native/InfansHealthSync/InfansHealthSync.xcodeproj/project.pbxproj"),
      "utf8",
    ),
  ]);

  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 17\.0/u);
  assert.match(composer, /\.onKeyPress\(\.return, phases: \.down\) \{ keyPress in[\s\S]*keyPress\.modifiers\.contains\(\.shift\)[\s\S]*keyPress\.modifiers\.contains\(\.option\)[\s\S]*return \.ignored[\s\S]*store\.sendDraft\(\)[\s\S]*return \.handled/u);
  assert.match(composer, /\.onKeyPress\(\.escape, phases: \.down\) \{ _ in[\s\S]*focused = false[\s\S]*return \.handled/u);
  assert.doesNotMatch(composer, /\.onKeyPress\(\.space|KeyEquivalent\.space/u);
});
