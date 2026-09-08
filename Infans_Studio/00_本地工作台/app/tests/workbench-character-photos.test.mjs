import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createCharacterPhotoService } from '../src/server/workbench-character-photos.mjs';
import { SECRETARY_CHARACTER_PHOTOS_DIR } from '../src/server/vault-paths.mjs';

async function fixture(t, patch = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secretary-appearance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = await sharp({ create: { width: 24, height: 32, channels: 3, background: '#7ec9c0' } }).png().toBuffer();
  return {
    root,
    data,
    service: createCharacterPhotoService(root),
    body: {
      assetId: `photo-${crypto.randomUUID()}`,
      subject: 'yinyue',
      slot: 'avatar',
      data: data.toString('base64'),
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      expectedRevision: 0,
      source: { kind: 'photos' },
      ...patch,
    },
  };
}

test('read does not write; importing immediately replaces one secretary avatar', async t => {
  const { root, data, service, body } = await fixture(t);
  assert.equal((await service.list()).revision, 0);
  await assert.rejects(fs.stat(path.join(root, SECRETARY_CHARACTER_PHOTOS_DIR)));
  const result = await service.import(body);
  assert.equal(result.selections['yinyue:avatar'], body.assetId);
  assert.equal(result.assets[0].subject, 'yinyue');
  assert.deepEqual(result.assets[0].uses, ['avatar']);
  assert.equal(result.assets[0].stage, 'private-override');
  assert.equal(result.assets[0].publishable, false);
  assert.equal(result.assets[0].file, undefined);
  assert.deepEqual((await service.content(body.assetId)).data, data);
  assert.equal((await service.import(body)).revision, 1);
  assert.equal((await fs.stat(path.join(root, SECRETARY_CHARACTER_PHOTOS_DIR, 'catalog.json'))).mode & 0o777, 0o600);
});

test('appearance slots have secretary-specific selections', async t => {
  const { service, body } = await fixture(t);
  await service.import(body);
  const second = await fixture(t, {
    subject: 'meining',
    slot: 'background',
    expectedRevision: 1,
  });
  second.body.data = body.data;
  second.body.sha256 = body.sha256;
  await service.import(second.body);
  const result = await service.list();
  assert.equal(result.selections['yinyue:avatar'], body.assetId);
  assert.equal(result.selections['meining:background'], second.body.assetId);
  await assert.rejects(service.import({ ...body, assetId: `photo-${crypto.randomUUID()}`, expectedRevision: 2, slot: 'speech' }));
  await assert.rejects(service.import({ ...body, assetId: `photo-${crypto.randomUUID()}`, expectedRevision: 2, subject: '../guest' }));
  await assert.rejects(service.import({ ...body, assetId: `photo-${crypto.randomUUID()}`, expectedRevision: 2, subject: 'guest-alpha' }));
});

test('replacing or restoring retires the superseded private override but keeps bytes recoverable', async t => {
  const { root, service, body } = await fixture(t);
  await service.import(body);
  const replacement = { ...body, assetId: `photo-${crypto.randomUUID()}`, expectedRevision: 1 };
  await service.import(replacement);
  const afterReplace = await service.list();
  assert.equal(afterReplace.assets.length, 1);
  assert.equal(afterReplace.selections['yinyue:avatar'], replacement.assetId);
  await assert.rejects(service.content(body.assetId), error => error.status === 404);
  assert.ok(await fs.stat(path.join(root, SECRETARY_CHARACTER_PHOTOS_DIR, `${body.assetId}.original`)));
  await service.reset({ expectedRevision: 2, subject: 'yinyue', slot: 'avatar' });
  const restored = await service.list();
  assert.deepEqual(restored.selections, {});
  assert.equal(restored.assets.length, 0);
  assert.ok(await fs.stat(path.join(root, SECRETARY_CHARACTER_PHOTOS_DIR, `${replacement.assetId}.original`)));
});

test('simultaneous edits cannot overwrite the same revision', async t => {
  const { service, body } = await fixture(t);
  const results = await Promise.allSettled([
    service.import(body),
    service.import({ ...body, assetId: `photo-${crypto.randomUUID()}`, slot: 'background' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await service.list()).revision, 1);
});

test('invalid source, path, bytes and digest do not mutate authority', async t => {
  const { service, body } = await fixture(t);
  for (const patch of [
    { assetId: '../photo' },
    { sha256: 'wrong' },
    { source: { kind: 'chat' } },
    { data: 'not an image' },
  ]) await assert.rejects(service.import({ ...body, ...patch }));
  assert.equal((await service.list()).revision, 0);
  await assert.rejects(service.content('../catalog.json'));
});

test('private thumbnails are bounded and cannot expose an arbitrary original', async t => {
  const { service, body } = await fixture(t);
  await service.import(body);
  const thumbnail = await service.content(body.assetId, true);
  const info = await sharp(thumbnail.data).metadata();
  assert.equal(thumbnail.mime, 'image/jpeg');
  assert.ok(info.width <= 480 && info.height <= 480);
});

test('actual mobile handler authenticates every appearance route before access', async t => {
  const { service } = await fixture(t);
  const { default: vm } = await import('node:vm');
  const { assertCodexCommandDeviceAccess } = await import('../src/server/workbench-codex-command-inbox.mjs');
  const { WorkbenchWriteError } = await import('../src/server/workbench-errors.mjs');
  const source = await fs.readFile(new URL('../src/server/workbench-routes.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  router.use("/api/secretary-mobile",'), source.indexOf('  router.use("/api/secretary-attachments",'));
  let handler;
  let reads = 0;
  vm.runInNewContext(block, {
    router: { use: (_, fn) => { handler = fn; } },
    characterPhotos: { ...service, list: async () => { reads += 1; return service.list(); } },
    WorkbenchWriteError,
    protectAssetResponse: response => response.setHeader('Cache-Control', 'private, no-store, max-age=0'),
    assertCodexCommandDeviceAccess,
    remoteWriteLogins: '',
    codexCommandToken: 'character-route-test-token-012345678901234567890',
    readJson: async request => request.body,
    send: (response, data, status = 200) => { response.status = status; response.data = data; },
    sendError: (response, error) => { response.status = error.status || 400; },
  });
  const requests = [
    ['GET', '/character-photos'],
    ['POST', '/character-photos/import'],
    ['POST', '/character-photos/reset'],
    ['GET', '/character-photos/photo-00000000-0000-0000-0000-000000000000/content'],
  ];
  for (const [method, url] of requests) {
    const response = { setHeader() {} };
    await handler({ method, url, headers: { host: '127.0.0.1:5173', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }, response);
    assert.equal(response.status, 403);
  }
  assert.equal(reads, 0);
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(data) { this.data = data; } };
  await handler({ method: 'GET', url: '/character-photos', headers: { host: '127.0.0.1:5173', authorization: 'Bearer character-route-test-token-012345678901234567890' }, socket: { remoteAddress: '127.0.0.1' } }, response);
  assert.equal(response.status, 200);
  assert.equal(response.data.revision, 0);
  assert.match(response.headers['Cache-Control'], /no-store/);
  for (const url of ['/character-photos/select', '/character-photos/remove']) {
    const legacyResponse = { setHeader() {} };
    await handler({ method: 'POST', url, body: {}, headers: { host: '127.0.0.1:5173', authorization: 'Bearer character-route-test-token-012345678901234567890', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }, legacyResponse);
    assert.equal(legacyResponse.status, 410);
  }
});

test('native UI exposes appearance slots without a gallery', async () => {
  const [appearance, settings, attachment] = await Promise.all([
    fs.readFile(new URL('../native/InfansHealthSync/InfansHealthSync/SecretaryCharacterPhotos.swift', import.meta.url), 'utf8'),
    fs.readFile(new URL('../native/InfansHealthSync/InfansHealthSync/SecretarySettingsView.swift', import.meta.url), 'utf8'),
    fs.readFile(new URL('../native/InfansHealthSync/InfansHealthSync/SecretaryAttachmentView.swift', import.meta.url), 'utf8'),
  ]);
  assert.match(settings, /SecretaryAppearancePhotosView/);
  assert.match(settings, /秘书形象/);
  assert.match(appearance, /case avatar[\s\S]*case background/);
  assert.match(appearance, /case shareBackground/);
  assert.doesNotMatch(appearance, /case speech|SecretaryCharacterAlbum|删除素材|保存到角色图片/);
  assert.doesNotMatch(attachment, /SecretaryCharacterPhoto|保存到.*角色图片/);
});


test('share background persists independently and reset preserves avatar', async t => {
  const { root, service, body } = await fixture(t);
  await service.import(body);
  const shared = { ...body, assetId: `photo-${crypto.randomUUID()}`, expectedRevision: 1, slot: 'shareBackground' };
  const result = await service.import(shared);
  assert.equal(result.selections['yinyue:avatar'], body.assetId);
  assert.equal(result.selections['yinyue:shareBackground'], shared.assetId);
  const reopened = createCharacterPhotoService(root);
  assert.equal((await reopened.list()).selections['yinyue:shareBackground'], shared.assetId);
  await assert.rejects(reopened.reset({ subject: 'yinyue', slot: 'shareBackground', expectedRevision: 1 }), /另一台设备/);
  await reopened.reset({ subject: 'yinyue', slot: 'shareBackground', expectedRevision: 2 });
  assert.deepEqual((await reopened.list()).selections, { 'yinyue:avatar': body.assetId });
  await assert.rejects(reopened.import({ ...shared, assetId: `photo-${crypto.randomUUID()}`, expectedRevision: 3, subject: 'meining' }), /分享页背景/);
});
