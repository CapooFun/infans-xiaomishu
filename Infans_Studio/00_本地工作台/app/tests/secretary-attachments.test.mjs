import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { saveSecretaryAttachment, resolveSecretaryAttachments, readSecretaryAttachment } from "../src/server/workbench-secretary-attachments.mjs";

function fakeRequest(body, headers = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.headers = headers;
  return stream;
}

test("saveSecretaryAttachment stores image and resolves by id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-attach-"));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const saved = await saveSecretaryAttachment(root, fakeRequest(png, {
      "content-type": "image/png",
      "x-infans-filename": encodeURIComponent("测.png"),
    }));
    assert.equal(saved.kind, "image");
    assert.ok(saved.id);
    assert.match(saved.path, /派生数据\/secretary-runtime\/attachments\//);
    assert.match(saved.id, /^[a-z0-9]+_[a-f0-9]{8}$/);
    assert.match(saved.path, /\.png$/);
    const disk = await fs.readFile(path.join(root, saved.path));
    assert.deepEqual(disk, png);
    assert.equal((await fs.stat(path.dirname(path.join(root, saved.path)))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(root, saved.path))).mode & 0o777, 0o600);
    const resolved = await resolveSecretaryAttachments(root, [saved.id]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, saved.id);
    assert.equal(resolved[0].size, png.length);
    assert.match(resolved[0].sha256, /^[a-f0-9]{64}$/u);
    const file = await readSecretaryAttachment(root, saved.id);
    assert.equal(file.data.length, png.length);
    assert.deepEqual(file.data, png);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a client-stable attachment id retries idempotently and never overwrites different bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-attach-idempotent-"));
  const headers = {
    "content-type": "image/png",
    "x-infans-filename": encodeURIComponent("稳定图片.png"),
    "x-infans-attachment-id": "native_asset_00000001",
  };
  const first = await saveSecretaryAttachment(root, fakeRequest("same-image", headers));
  assert.equal(first.id, "native_asset_00000001");
  assert.equal(first.created, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.size, 10);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);

  const retry = await saveSecretaryAttachment(root, fakeRequest("same-image", headers));
  assert.equal(retry.created, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.sha256, first.sha256);

  await assert.rejects(
    () => saveSecretaryAttachment(root, fakeRequest("different-image", headers)),
    (error) => error?.status === 409 && error?.code === "ATTACHMENT_IDEMPOTENCY_CONFLICT",
  );
  const stored = await readSecretaryAttachment(root, first.id);
  assert.equal(stored.data.toString(), "same-image");
});

test("unsupported and oversized mobile uploads leave no attachment directory behind", async () => {
  for (const [name, body, headers, code] of [
    ["unsupported", "binary", { "content-type": "application/octet-stream", "x-infans-attachment-id": "native_bad_00000001" }, "ATTACHMENT_TYPE_UNSUPPORTED"],
    ["oversized", Buffer.alloc(8 * 1024 * 1024 + 1), { "content-type": "image/png", "x-infans-attachment-id": "native_big_00000001" }, "ATTACHMENT_TOO_LARGE"],
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `infans-attach-${name}-`));
    await assert.rejects(() => saveSecretaryAttachment(root, fakeRequest(body, headers)), (error) => error?.code === code);
    const dir = path.join(root, "00_本地工作台", "派生数据", "secretary-runtime", "attachments");
    await assert.rejects(() => fs.access(dir), (error) => error?.code === "ENOENT");
  }
});

test("attachment GET failure has no filesystem side effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-attach-readonly-"));
  const dir = path.join(root, "00_本地工作台", "派生数据", "secretary-runtime", "attachments");
  await assert.rejects(
    () => readSecretaryAttachment(root, "missing_12345678"),
    (error) => error?.code === "ATTACHMENT_NOT_FOUND",
  );
  await assert.rejects(() => fs.access(dir), (error) => error?.code === "ENOENT");
});

test("audio longer than 90 seconds is rejected before its body is persisted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-attach-duration-"));
  await assert.rejects(
    () => saveSecretaryAttachment(root, fakeRequest(Buffer.from("audio"), {
      "content-type": "audio/webm",
      "x-infans-filename": encodeURIComponent("过长.webm"),
      "x-infans-duration-ms": "90001",
    })),
    (error) => error?.code === "ATTACHMENT_AUDIO_TOO_LONG",
  );
  const dir = path.join(root, "00_本地工作台", "派生数据", "secretary-runtime", "attachments");
  await assert.rejects(() => fs.access(dir), (error) => error?.code === "ENOENT");
});
