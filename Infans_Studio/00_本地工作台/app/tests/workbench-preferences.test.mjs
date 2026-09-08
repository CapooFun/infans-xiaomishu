import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPreferencesService } from '../src/server/workbench-preferences.mjs';
import { backgroundPosition, defaultDevice, emptyPreferences, selectedScheme } from '../src/workbench-preferences-model.mjs';
import { defaultScheme } from '../src/workbench-appearance.mjs';

const DEVICE_A = 'device-desktop-a';
const DEVICE_B = 'device-tablet-b';
const ASSETS = [{ id: 'scene-jade', name: '玉山', url: '/images/scene-jade.avif' }];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-preferences-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { statePath: 'state/preferences.json', backgrounds: async () => structuredClone(ASSETS) };
  const service = createPreferencesService(root, options);
  return { root, options, service, statePath: service.statePath };
}

function scheme(overrides = {}) {
  return {
    ...defaultScheme('day'), id: 'custom-jade', name: '我的晴岚',
    colors: { teal: '#276D66', gold: '#80612D', mark: '#8061A1' },
    backgrounds: { '/tools': { assetId: 'scene-jade', brightness: 1.1, saturation: .8, contrast: 1, blur: 1.5, veil: .9 } },
    ...overrides,
  };
}

function deviceFor(s = scheme(), overrides = {}) {
  const device = defaultDevice(s.theme);
  device.selected[s.theme] = s.id;
  return { ...device, ...overrides };
}

function saveRequest(overrides = {}) {
  return { action: 'save-scheme', expectedRevision: 0, deviceId: DEVICE_A, scheme: scheme(), device: deviceFor(), ...overrides };
}

function invalid(error) {
  return error?.status === 400 || error?.statusCode === 400;
}

async function assertNoFile(file) {
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
}

test('首次 GET 返回默认状态和图库，重复读取不创建文件或目录', async (t) => {
  const { service, root, statePath } = await fixture(t);
  assert.deepEqual(await service.read(), { state: emptyPreferences(), backgrounds: ASSETS });
  await service.read();
  await assertNoFile(statePath);
  assert.deepEqual(await fs.readdir(root), []);
});

test('个人方案、设备字号和快捷键原子保存，服务重建后可恢复', async (t) => {
  const { service, root, options, statePath } = await fixture(t);
  const device = deviceFor(scheme(), {
    textSize: 'comfortable', pageTextSizes: { '/tools/music': 'large' },
    crops: { 'custom-jade:/tools': { x: 34, y: 65 } },
  });
  device.shortcuts['bookmark-1'] = null;
  const saved = await service.write(saveRequest({ device }));
  assert.equal(saved.state.revision, 1);
  assert.equal(saved.state.schemes[0].colors.teal, '#276d66');
  assert.equal(saved.state.schemes[0].colors.mark, '#8061a1');
  assert.equal(saved.state.schemes[0].backgrounds['/tools'].assetId, 'scene-jade');
  assert.deepEqual(saved.state.devices[DEVICE_A], device);
  assert.deepEqual(await createPreferencesService(root, options).read(), saved);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), saved.state);
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(path.dirname(statePath)), ['preferences.json']);
  const before = await fs.readFile(statePath, 'utf8');
  await service.read();
  assert.equal(await fs.readFile(statePath, 'utf8'), before);
});

test('同修订号并发保存只接受一次，冲突后队列仍可保存新修订', async (t) => {
  const { service } = await fixture(t);
  const outcomes = await Promise.allSettled([
    service.write(saveRequest()),
    service.write(saveRequest({ deviceId: DEVICE_B })),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const conflict = outcomes.find(result => result.status === 'rejected');
  assert.equal(conflict.reason.code, 'PREFERENCES_CONFLICT');
  const saved = await service.read();
  assert.equal(saved.state.revision, 1);
  assert.equal(Object.keys(saved.state.devices).length, 1);
  const next = await service.write({ action: 'update-device', deviceId: DEVICE_B, expectedRevision: 1, device: defaultDevice('night') });
  assert.equal(next.state.revision, 2);
  assert.equal(Object.keys(next.state.devices).length, 2);
});

test('拒绝无效保存后不落盘，后续合法保存正常', async (t) => {
  const { service, root, statePath } = await fixture(t);
  await assert.rejects(service.write(saveRequest({ scheme: scheme({ colors: { teal: 'red' } }) })), invalid);
  await assertNoFile(statePath);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await service.write(saveRequest())).state.revision, 1);
});

test('无效方案路径、图片、颜色与数值一律拒绝，已有保存内容保持原样', async (t) => {
  const { service, statePath } = await fixture(t);
  await service.write(saveRequest());
  const before = await fs.readFile(statePath, 'utf8');
  const cases = [
    ['默认方案不可覆盖', scheme({ id: 'default:day' })],
    ['非法主题', scheme({ theme: 'other' })],
    ['空名称', scheme({ name: '  ' })],
    ['路径穿越', scheme({ backgrounds: { '/../private': { brightness: 1 } } })],
    ['外部图片路径', scheme({ backgrounds: { '/tools': { assetId: 'https://example.invalid/image.png' } } })],
    ['未知图片标识', scheme({ backgrounds: { '/tools': { assetId: 'missing' } } })],
    ['CSS 注入颜色', scheme({ colors: { teal: 'url(https://example.invalid/a)' } })],
    ['未知颜色角色', scheme({ colors: { arbitrary: '#ffffff' } })],
    ['过亮参数', scheme({ backgrounds: { '/tools': { brightness: 99 } } })],
    ['数值字符串', scheme({ backgrounds: { '/tools': { brightness: '1.1' } } })],
    ['NaN 参数', scheme({ backgrounds: { '/tools': { brightness: NaN } } })],
    ['无穷参数', scheme({ surfaceOpacity: Infinity })],
  ];
  for (const [label, invalidScheme] of cases) {
    await t.test(label, async () => {
      await assert.rejects(service.write(saveRequest({ expectedRevision: 1, scheme: invalidScheme })), invalid);
      assert.equal(await fs.readFile(statePath, 'utf8'), before);
    });
  }
});

test('未知字段不静默丢弃，明确拒绝并保留原配置', async (t) => {
  const cases = [
    ['请求字段', request => { request.unregistered = true; }],
    ['方案字段', request => { request.scheme.secretaryId = 'someone'; }],
    ['背景字段', request => { request.scheme.backgrounds['/tools'].url = '/unregistered.png'; }],
    ['设备字段', request => { request.device.unsupported = true; }],
    ['主题选择字段', request => { request.device.selected.extra = 'default:day'; }],
    ['构图字段', request => { request.device.crops['custom-jade:/tools'] = { x: 50, y: 50, extra: 3 }; }],
    ['未知快捷键命令', request => { request.device.shortcuts['unknown-command'] = null; }],
    ['快捷键字段', request => { request.device.shortcuts['bookmark-1'].scope = 'system'; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async (st) => {
    const { service, statePath } = await fixture(st);
    await service.write(saveRequest());
    const before = await fs.readFile(statePath, 'utf8');
    const request = saveRequest({ expectedRevision: 1 });
    mutate(request);
    await assert.rejects(service.write(request), invalid);
    assert.equal(await fs.readFile(statePath, 'utf8'), before);
  });
});

test('设备 ID 和设备内路径、字号、快捷键结构必须有效', async (t) => {
  const cases = [
    ['短标识', request => { request.deviceId = 'bad'; }],
    ['路径标识', request => { request.deviceId = '../device-desktop'; }],
    ['非法字号', request => { request.device.textSize = 'huge'; }],
    ['非法本页路径', request => { request.device.pageTextSizes = { '/../private': 'large' }; }],
    ['非法本页字号', request => { request.device.pageTextSizes = { '/tools': 'unknown' }; }],
    ['非法构图路径', request => { request.device.crops = { 'custom-jade:/../private': { x: 50, y: 50 } }; }],
    ['不存在方案的构图', request => { request.device.crops = { 'custom-missing:/tools': { x: 50, y: 50 } }; }],
    ['不登记页面的构图', request => { request.device.crops = { 'custom-jade:/unknown-route': { x: 50, y: 50 } }; }],
    ['越界构图', request => { request.device.crops = { 'custom-jade:/tools': { x: 200, y: 50 } }; }],
    ['快捷键非对象', request => { request.device.shortcuts = 'bad'; }],
    ['非法组合键', request => { request.device.shortcuts['bookmark-1'] = { code: 'KeyK' }; }],
    ['保留组合键', request => { request.device.shortcuts['bookmark-1'] = { code: 'KeyQ', meta: true, ctrl: false, alt: false, shift: false }; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async (st) => {
    const { service, statePath } = await fixture(st);
    const request = saveRequest();
    mutate(request);
    await assert.rejects(service.write(request), invalid);
    await assertNoFile(statePath);
  });
});

test('损坏 JSON 读取和写入均失败，原文件不被覆盖', async (t) => {
  const { service, statePath } = await fixture(t);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const original = '{"schemaVersion":1,"unfinished":';
  await fs.writeFile(statePath, original);
  await assert.rejects(service.read(), { code: 'PREFERENCES_READ_FAILED' });
  await assert.rejects(service.write(saveRequest()), { code: 'PREFERENCES_READ_FAILED' });
  assert.equal(await fs.readFile(statePath, 'utf8'), original);
});

test('结构损坏的已保存配置不得被下一次修改静默覆盖', async (t) => {
  const cases = [
    ['设备集合是数组', state => { state.devices = []; }],
    ['负修订号', state => { state.revision = -1; }],
    ['设备内容损坏', state => { state.devices[DEVICE_A] = { theme: 'day' }; }],
    ['方案内容损坏', state => { state.schemes = [{ id: 'custom-broken' }]; }],
    ['重复方案标识', state => { state.schemes = [scheme(), scheme()]; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async (st) => {
    const { service, statePath } = await fixture(st);
    const state = emptyPreferences();
    mutate(state);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const original = JSON.stringify(state);
    await fs.writeFile(statePath, original);
    await assert.rejects(service.read(), { code: 'PREFERENCES_READ_FAILED' });
    await assert.rejects(service.write(saveRequest({ expectedRevision: state.revision })), { code: 'PREFERENCES_READ_FAILED' });
    assert.equal(await fs.readFile(statePath, 'utf8'), original);
  });
});

test('切换主题和设备字号不修改其他设备、方案和独立使用习惯', async (t) => {
  const { service } = await fixture(t);
  const deviceA = deviceFor(scheme(), { textSize: 'large', pageTextSizes: { '/tools/music': 'comfortable' } });
  deviceA.shortcuts['bookmark-1'] = null;
  await service.write(saveRequest({ device: deviceA }));
  const second = await service.write({ action: 'update-device', expectedRevision: 1, deviceId: DEVICE_B, device: deviceFor(scheme(), { textSize: 'standard' }) });
  const switched = await service.write({ action: 'update-device', expectedRevision: 2, deviceId: DEVICE_A, device: { ...deviceA, theme: 'night' } });
  assert.deepEqual(switched.state.devices[DEVICE_B], second.state.devices[DEVICE_B]);
  assert.deepEqual(switched.state.schemes, second.state.schemes);
  assert.equal(switched.state.devices[DEVICE_A].textSize, 'large');
  assert.equal(switched.state.devices[DEVICE_A].pageTextSizes['/tools/music'], 'comfortable');
  assert.equal(switched.state.devices[DEVICE_A].shortcuts['bookmark-1'], null);
  assert.equal(switched.state.devices[DEVICE_A].selected.day, 'custom-jade');
  assert.equal(selectedScheme(switched.state, switched.state.devices[DEVICE_A]).id, 'default:night');
  assert.deepEqual(defaultScheme('day').colors, {});
});

test('删除个人方案只恢复引用它的主题，并保留其他方案和设备习惯', async (t) => {
  const { service } = await fixture(t);
  const crops = { 'custom-jade:/tools': { x: 30, y: 70 }, 'default:night:/tools': { x: 45, y: 55 } };
  const deviceA = deviceFor(scheme(), { textSize: 'comfortable', crops, pageTextSizes: { '/health': 'large' } });
  deviceA.shortcuts['bookmark-2'] = null;
  await service.write(saveRequest({ device: deviceA }));
  const extra = scheme({ id: 'custom-another', name: '另一方案' });
  await service.write(saveRequest({ expectedRevision: 1, deviceId: DEVICE_B, scheme: extra, device: deviceFor(extra, { textSize: 'large' }) }));
  const before = await service.read();
  const deleted = await service.write({ action: 'delete-scheme', expectedRevision: 2, deviceId: DEVICE_A, schemeId: 'custom-jade' });
  assert.deepEqual(deleted.state.schemes.map(s => s.id), ['custom-another']);
  assert.deepEqual(deleted.state.devices[DEVICE_B], before.state.devices[DEVICE_B]);
  const restored = deleted.state.devices[DEVICE_A];
  assert.equal(restored.selected.day, 'default:day');
  assert.equal(restored.textSize, 'comfortable');
  assert.equal(restored.shortcuts['bookmark-2'], null);
  assert.equal(restored.pageTextSizes['/health'], 'large');
  assert.deepEqual(restored.crops, { 'default:night:/tools': { x: 45, y: 55 } });
});

test('默认方案不能删除，未知方案不能被应用', async (t) => {
  const { service, statePath } = await fixture(t);
  await service.write(saveRequest());
  const before = await fs.readFile(statePath, 'utf8');
  await assert.rejects(service.write({ action: 'delete-scheme', expectedRevision: 1, deviceId: DEVICE_A, schemeId: 'default:day' }));
  await assert.rejects(service.write({ action: 'update-device', expectedRevision: 1, deviceId: DEVICE_A, device: deviceFor(scheme({ id: 'custom-unknown' })) }), invalid);
  assert.equal(await fs.readFile(statePath, 'utf8'), before);
});

test('个人方案更新保留稳定 ID，不能变更明暗类型使其他设备引用失效', async (t) => {
  const { service, statePath } = await fixture(t);
  await service.write(saveRequest());
  await service.write({ action: 'update-device', expectedRevision: 1, deviceId: DEVICE_B, device: deviceFor() });
  const renamed = scheme({ name: '午后晴岚' });
  const updated = await service.write(saveRequest({ expectedRevision: 2, scheme: renamed }));
  assert.equal(updated.state.schemes.length, 1);
  assert.equal(updated.state.devices[DEVICE_B].selected.day, renamed.id);
  assert.equal(selectedScheme(updated.state, updated.state.devices[DEVICE_B]).name, '午后晴岚');
  const before = await fs.readFile(statePath, 'utf8');
  const changedTheme = scheme({ theme: 'night' });
  await assert.rejects(service.write(saveRequest({ expectedRevision: 3, scheme: changedTheme, device: deviceFor(changedTheme) })), invalid);
  assert.equal(await fs.readFile(statePath, 'utf8'), before);
});


test('背景构图绑定素材版本，换素材、换秘书或更新图时不继承偏移', () => {
  const crop={x:78,y:24,image:'/theme/scene-a.v1.avif'};
  assert.equal(backgroundPosition(crop,'/theme/scene-a.v1.avif?rev=3'),'78% 24%');
  assert.equal(backgroundPosition(crop,'/theme/scene-b.v1.avif'),'50% 50%');
  assert.equal(backgroundPosition(crop,'/theme/scene-a.v2.avif'),'50% 50%');
  assert.equal(backgroundPosition({x:78,y:24},'/theme/scene-a.v1.avif'),'50% 50%');
});

test('恢复默认主题后个人方案仍可切回，带素材的设备构图能够持久化', async t => {
  const {service,root,options}=await fixture(t);
  const device=deviceFor(scheme(),{crops:{'custom-jade:/tools':{x:80,y:35,image:'/theme/jade.v1.avif'}}});
  const saved=await service.write(saveRequest({device}));
  const restored=await service.write({action:'update-device',deviceId:DEVICE_A,expectedRevision:saved.state.revision,device:{...device,selected:{...device.selected,day:'default:day'}}});
  assert.equal(selectedScheme(restored.state,restored.state.devices[DEVICE_A]).id,'default:day');
  assert.equal(restored.state.schemes.length,1);
  const reloaded=await createPreferencesService(root,options).read();
  assert.deepEqual(reloaded.state.devices[DEVICE_A].crops,device.crops);
  const back=await service.write({action:'update-device',deviceId:DEVICE_A,expectedRevision:reloaded.state.revision,device});
  assert.equal(selectedScheme(back.state,back.state.devices[DEVICE_A]).id,'custom-jade');
});
