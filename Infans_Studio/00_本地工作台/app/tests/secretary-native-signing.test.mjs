import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateSecretaryRuntimeData } from "../scripts/migrate-secretary-runtime-data.mjs";

const scriptPath = new URL("../scripts/build-secretary-native-app.sh", import.meta.url);
const launcherPath = new URL("../../启动Infans本地工作台.command", import.meta.url);
const nativeSourcePath = new URL("../native/SecretaryApp.swift", import.meta.url);

test("Mac 小秘书构建必须使用稳定签名，无证书时失败关闭", async () => {
  const script = await fs.readFile(scriptPath, "utf8");
  assert.match(script, /BUNDLE_ID="com\.ifans\.secretary\.workbench"/);
  assert.match(script, /security find-identity -v -p codesigning/);
  assert.match(script, /codesign[\s\\]+--force[\s\\]+--sign/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /designated => cdhash/);
  assert.match(script, /没有找到可用的 Mac 代码签名身份/);
  assert.doesNotMatch(script, /--sign\s+["']?-["']?/);
  assert.match(script, /TEMP_EXECUTABLE="\$\{TEMP_ROOT\}\/build\/小秘书"/);
});

test("原生小秘书持续持有后台服务，让网络宗卷权限沿稳定签名身份生效", async () => {
  const nativeSource = await fs.readFile(nativeSourcePath, "utf8");
  assert.match(nativeSource, /INFANS_WORKBENCH_FOREGROUND=1/u);
  assert.match(nativeSource, /self\?\.serverProcess = nil/u);

  let launcher;
  try {
    launcher = await fs.readFile(launcherPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.match(launcher, /INFANS_WORKBENCH_FOREGROUND:-0/u);
  assert.match(launcher, /foreground_service_pid=\$!/u);
  assert.match(launcher, /wait "\$\{foreground_service_pid\}"/u);
  assert.match(launcher, /else\s+nohup "\$\{APP_DIR\}\/scripts\/start-local\.sh"/u);
});

test("启动脚本若存在，不得写死作者 NAS 主机名", async () => {
  let launcher;
  try {
    launcher = await fs.readFile(launcherPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.doesNotMatch(launcher, /Capoo_Nas/u);
  assert.doesNotMatch(launcher, /smb:\/\/100\./u);
  assert.doesNotMatch(launcher, /smb:\/\/192\.168\./u);
});

test("迁移聊天和附件时保留内容并收紧权限", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-runtime-migration-"));
  try {
    const workbench = path.join(root, "00_本地工作台");
    const legacyChats = path.join(workbench, "小秘书.app", "对话记录");
    const legacyAttachments = path.join(workbench, "小秘书.app", "附件");
    await fs.mkdir(legacyChats, { recursive: true });
    await fs.mkdir(legacyAttachments, { recursive: true });
    await fs.writeFile(path.join(legacyChats, "chat_test.json"), "{\"ok\":true}\n");
    await fs.writeFile(path.join(legacyAttachments, "att_test.bin"), Buffer.from([1, 2, 3]));

    const results = await migrateSecretaryRuntimeData(workbench);
    assert.equal(results.reduce((sum, item) => sum + item.copied, 0), 2);
    const currentRoot = path.join(workbench, "派生数据", "secretary-runtime");
    assert.equal(await fs.readFile(path.join(currentRoot, "chats", "chat_test.json"), "utf8"), "{\"ok\":true}\n");
    assert.deepEqual(await fs.readFile(path.join(currentRoot, "attachments", "att_test.bin")), Buffer.from([1, 2, 3]));
    assert.equal((await fs.stat(path.join(currentRoot, "chats"))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(currentRoot, "chats", "chat_test.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("迁移遇到同名不同内容时停止，不覆盖旧数据", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-runtime-conflict-"));
  try {
    const workbench = path.join(root, "00_本地工作台");
    const legacy = path.join(workbench, "小秘书.app", "对话记录");
    const current = path.join(workbench, "派生数据", "secretary-runtime", "chats");
    await fs.mkdir(legacy, { recursive: true });
    await fs.mkdir(current, { recursive: true });
    await fs.writeFile(path.join(legacy, "chat_test.json"), "old\n");
    await fs.writeFile(path.join(current, "chat_test.json"), "new\n");

    await assert.rejects(() => migrateSecretaryRuntimeData(workbench), /内容冲突/);
    assert.equal(await fs.readFile(path.join(current, "chat_test.json"), "utf8"), "new\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
