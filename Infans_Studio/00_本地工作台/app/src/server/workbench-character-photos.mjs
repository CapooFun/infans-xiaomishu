/** Private per-secretary avatar/background overrides. No gallery, chat scans or public derivatives. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { secretaryProfileById } from '../secretary-identity.mjs';
import { SECRETARY_CHARACTER_PHOTOS_DIR } from './vault-paths.mjs';
import { WorkbenchWriteError } from './workbench-errors.mjs';
import { withSecretaryArchiveMutation } from './workbench-secretary-attachments.mjs';

const slots = ['avatar', 'background', 'shareBackground'];
const subjectPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const fail = (message, status = 400) => { throw new WorkbenchWriteError(message, status); };
const initial = () => ({ schemaVersion: 1, revision: 0, assets: [], selections: {} });
const selectionKey = (subject, slot) => `${subject}:${slot}`;
function validateTarget(body) {
  if (!body.subject && !body.slot) fail('旧版角色图片相册已停用，请更新小秘书', 410);
  if (!subjectPattern.test(body.subject || '') || !secretaryProfileById(body.subject)?.secretaryEligible) {
    fail('只能更换正式秘书的图片');
  }
  if (!slots.includes(body.slot)) fail('请选择头像、聊天背景或分享页背景');
  if (body.slot === 'shareBackground' && body.subject !== 'yinyue') fail('分享页背景用于银月收件入口');
}
function retireIfUnused(catalog, assetId) {
  if (!assetId || Object.values(catalog.selections).includes(assetId)) return;
  const asset = catalog.assets.find(candidate => candidate.assetId === assetId && !candidate.deletedAt);
  if (asset) asset.deletedAt = new Date().toISOString();
}
export function createCharacterPhotoService(root) {
  const directory = path.resolve(root, SECRETARY_CHARACTER_PHOTOS_DIR);
  const catalogPath = path.join(directory, 'catalog.json');
  async function read() {
    try {
      const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
      if (catalog.schemaVersion !== 1 || !Number.isSafeInteger(catalog.revision) || !Array.isArray(catalog.assets)) fail('秘书外观图片配置需要恢复', 503);
      return catalog;
    } catch (error) { if (error.code === 'ENOENT') return initial(); throw error; }
  }
  function publicView(catalog) {
    return { ...catalog, assets: catalog.assets.filter(a => !a.deletedAt).map(({ file, ...asset }) => asset) };
  }
  async function persist(catalog) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.catalog-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(catalog), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, catalogPath);
    } finally { await fs.rm(temporary, { force: true }); }
    return publicView(await read());
  }
  async function mutate(body, operation) {
    return withSecretaryArchiveMutation(root, async () => {
      const catalog = await read();
      if (body.expectedRevision !== catalog.revision) fail('另一台设备已更新图片，请刷新后重试', 409);
      await operation(catalog);
      catalog.revision += 1;
      return persist(catalog);
    });
  }
  return {
    list: async () => publicView(await read()),
    import: async body => {
      validateTarget(body);
      if (!/^photo-[a-f0-9-]{36}$/.test(body.assetId || '')) fail('图片编号不合法');
      if (body.source?.kind !== 'photos') fail('请从系统照片中选择图片');
      if (typeof body.data !== 'string' || body.data.length > 34 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) fail('图片过大或无法读取');
      const data = Buffer.from(body.data, 'base64');
      if (!data.length || data.length > 24 * 1024 * 1024) fail('请选择小于 24 MB 的图片');
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      if (body.sha256 !== hash) fail('图片传输不完整，请重试');
      let info;
      try { info = await sharp(data, { limitInputPixels: 40_000_000 }).metadata(); } catch { fail('无法读取这张图片，请选择 JPEG、PNG 或兼容照片'); }
      const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/heic' }[info.format];
      if (!mime || !info.width || !info.height || (info.pages || 1) > 1) fail('请选择一张静态照片');
      // A retry after a lost response returns the existing immutable import, even if revision advanced.
      return withSecretaryArchiveMutation(root, async () => {
        const catalog = await read();
        const existing = catalog.assets.find(a => a.assetId === body.assetId);
        if (existing) {
          if (existing.sha256 !== hash || existing.deletedAt) fail('这张图片已变更，请重新选择', 409);
          return publicView(catalog);
        }
        if (catalog.revision !== body.expectedRevision) fail('另一台设备已更新图片，请刷新后重试', 409);
        if (catalog.assets.filter(a => !a.deletedAt).length >= 100) fail('可用图片记录过多，请先恢复不再使用的默认图片');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const file = `${body.assetId}.original`;
        // Immutable content-address-checked retry handles interruption between original and catalog writes.
        const destination = path.join(directory, file);
        try { await fs.writeFile(destination, data, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (crypto.createHash('sha256').update(await fs.readFile(destination)).digest('hex') !== hash) fail('原件冲突，请重新选择', 409);
        }
        const key = selectionKey(body.subject, body.slot);
        const previous = catalog.selections[key] || (body.subject === 'yinyue' ? catalog.selections[body.slot] : undefined);
        delete catalog.selections[body.slot];
        catalog.assets.push({ assetId: body.assetId, subject: body.subject, stage: 'private-override', privacy: 'private-local', publishable: false,
          source: { kind: 'photos' }, uses: [body.slot], width: info.width, height: info.height, bytes: data.length, sha256: hash, mime, file, createdAt: new Date().toISOString() });
        catalog.selections[key] = body.assetId;
        retireIfUnused(catalog, previous);
        catalog.revision += 1;
        return persist(catalog);
      });
    },
    reset: body => mutate(body, catalog => {
      validateTarget(body);
      const key = selectionKey(body.subject, body.slot);
      const previous = catalog.selections[key] || (body.subject === 'yinyue' ? catalog.selections[body.slot] : undefined);
      delete catalog.selections[key];
      if (body.subject === 'yinyue') delete catalog.selections[body.slot];
      retireIfUnused(catalog, previous);
    }),
    content: async (id, thumbnail = false) => {
      const catalog = await read();
      const asset = catalog.assets.find(a => a.assetId === id && !a.deletedAt);
      if (!asset || !/^photo-[a-f0-9-]{36}$/.test(id)) fail('图片不可用', 404);
      const data = await fs.readFile(path.join(directory, `${id}.original`));
      if (crypto.createHash('sha256').update(data).digest('hex') !== asset.sha256) fail('图片原件需要恢复', 503);
      if (thumbnail) return { data: await sharp(data).rotate().resize(480, 480, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(), mime: "image/jpeg" };
      return { data, mime: asset.mime };
    },
  };
}
