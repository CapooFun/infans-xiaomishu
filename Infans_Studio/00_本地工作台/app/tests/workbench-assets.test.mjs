import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSET_SOURCE, FIXED_EXPENSES_FILE, createAssetAccessService, hashAssetPassword, parseAssetMarkdown, resolveAssetPasswordHash, writeAssetPasswordHash } from "../src/server/workbench-assets.mjs";

const assetMarkdown = `---\ndescription: test\ntags: [test]\nsensitivity: S2\n---\n<!-- INFANS_ASSET_SNAPSHOT_JSON_START -->\n\`\`\`json\n{"schemaVersion":1,"source":{"title":"资产","url":"https://docs.google.com/spreadsheets/d/test"},"snapshots":[{"date":"2026-05-10","sheet":"may","items":[{"category":"存款","name":"账户代称","currency":"CNY","amount":120,"rateToCny":1,"cnyValue":120},{"category":"负债","name":"账单代称","currency":"CNY","amount":-20,"rateToCny":1,"cnyValue":-20}]},{"date":"2026-06-10","sheet":"jun","items":[{"category":"存款","name":"账户代称","currency":"CNY","amount":150,"rateToCny":1,"cnyValue":150}]}]}\n\`\`\`\n<!-- INFANS_ASSET_SNAPSHOT_JSON_END -->`;

test("asset parser derives totals and trend from allowlisted snapshots", () => {
  const data = parseAssetMarkdown(assetMarkdown);
  assert.equal(data.snapshots[0].totalAssets, 120);
  assert.equal(data.snapshots[0].totalLiabilities, 20);
  assert.equal(data.snapshots[0].netAssets, 100);
  assert.deepEqual(data.trend.map((item) => item.netAssets), [100, 150]);
});

test("asset access requires the password and expires the in-memory session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, ASSET_SOURCE);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, assetMarkdown, "utf8");
  let clock = 1000;
  const service = createAssetAccessService(root, {
    passwordHash: hashAssetPassword("test-pass"),
    ttlMs: 500,
    now: () => clock,
    openAccess: false,
  });
  assert.throws(() => service.unlock("wrong"), /密码不正确/);
  const session = service.unlock("test-pass");
  const data = await service.read(session.token);
  assert.equal(data.snapshots.at(-1).netAssets, 150);
  clock += 501;
  await assert.rejects(() => service.read(session.token), /已经锁上了/);
});

test("temporary open access allows reading assets without a password", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-assets-open-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, ASSET_SOURCE);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, assetMarkdown, "utf8");
  const fixedSource = path.join(root, FIXED_EXPENSES_FILE);
  await fs.mkdir(path.dirname(fixedSource), { recursive: true });
  await fs.writeFile(fixedSource, JSON.stringify({ items: [{ id: "unknown", name: "金额待确认", kind: "monthly", amount: null, currency: "JPY" }] }), "utf8");
  const service = createAssetAccessService(root, { openAccess: true });
  assert.equal(service.openAccess, true);
  const data = await service.read("");
  assert.equal(data.openAccess, true);
  assert.equal(data.snapshots.at(-1).netAssets, 150);
  assert.equal(data.sessionExpiresAt, null);
  assert.equal(data.fixedExpenses.items[0].amount, null);
});

test("asset password configuration is fail-closed and written with mode 0600", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "infans-asset-secret-"));
  const passwordFilePath = path.join(directory, "asset-password.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = process.env.INFANS_ASSET_PASSWORD_HASH;
  delete process.env.INFANS_ASSET_PASSWORD_HASH;
  t.after(() => {
    if (previous === undefined) delete process.env.INFANS_ASSET_PASSWORD_HASH;
    else process.env.INFANS_ASSET_PASSWORD_HASH = previous;
  });
  assert.equal(resolveAssetPasswordHash({ passwordFilePath }), null);
  const service = createAssetAccessService(directory, { passwordFilePath, openAccess: false });
  assert.throws(() => service.unlock("anything"), /还没设解锁码|已撤销/);
  const hash = writeAssetPasswordHash(hashAssetPassword("new-test-password"), { passwordFilePath });
  const saved = JSON.parse(await fs.readFile(passwordFilePath, "utf8"));
  assert.equal(saved.hash, hash);
  assert.equal((await fs.stat(passwordFilePath)).mode & 0o777, 0o600);
  assert.equal(resolveAssetPasswordHash({ passwordFilePath }), hash);
});

test("a valid explicitly configured asset verifier remains usable", () => {
  const configured = hashAssetPassword("existing-view-password");
  assert.equal(resolveAssetPasswordHash({ passwordHash: configured }), configured);
});

test("asset parser never accepts a non-Google source link", () => {
  const unsafe = assetMarkdown.replace("https://docs.google.com/spreadsheets/d/test", "javascript:alert(1)");
  assert.equal(parseAssetMarkdown(unsafe).source.url, "");
});
