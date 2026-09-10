import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKBENCH_PREFERENCES_PATH, DIR_WORKBENCH } from './vault-paths.mjs';
import { loadSecretaryVisualAssetCatalog } from './workbench-secretary-visual-assets.mjs';
import { emptyPreferences, defaultDevice, normalizeScheme, normalizeDevice, validDeviceId } from '../workbench-preferences-model.mjs';
import { WorkbenchWriteError } from './workbench-errors.mjs';
import { withVaultFileWrite } from './workbench-file-write-guard.mjs';

export async function preferenceBackgrounds(root) {
  const {catalog}=await loadSecretaryVisualAssetCatalog(root,{requireFiles:false});
  const prefix=`${DIR_WORKBENCH}/app/public/`;
  const assets=catalog.assets.flatMap(asset=>{
    if(asset.originalKind!=='页面背景与场景'||!(/壁纸|页面背景与场景/.test(asset.kind))||['retired','archive'].includes(asset.curationState)) return [];
    const file=asset.currentPaths.find(p=>p.startsWith(prefix)&&/\.(avif|webp|png|jpe?g)$/.test(p));
    if(!file) return [];
    const revisionLabel=asset.provenance?.origin==='ai-generated'&&asset.derivedFrom?' · 新构图':'';
    return [{id:asset.assetId,name:`${asset.subject} · ${file.includes('-day.')?'日景':'场景'}${revisionLabel}`,url:`/${file.slice(prefix.length)}`}];
  });
  const totals=new Map(),seen=new Map();
  for(const a of assets) totals.set(a.name,(totals.get(a.name)||0)+1);
  return assets.map(a=>{if(totals.get(a.name)===1)return a;const n=(seen.get(a.name)||0)+1;seen.set(a.name,n);return {...a,name:`${a.name} ${n}`};});
}
export function createPreferencesService(root,options={}) {
  const relativeStatePath=options.statePath || WORKBENCH_PREFERENCES_PATH;
  const statePath=path.resolve(root,relativeStatePath);
  const backgrounds=options.backgrounds || (()=>preferenceBackgrounds(root));
  async function readState() {
    try {
      const raw=JSON.parse(await fs.readFile(statePath,'utf8'));
      if(!raw||Object.keys(raw).some(k=>!['schemaVersion','revision','schemes','devices'].includes(k))||raw.schemaVersion!==1||!Number.isSafeInteger(raw.revision)||raw.revision<0||!Array.isArray(raw.schemes)||raw.schemes.length>24||!raw.devices||typeof raw.devices!=='object'||Array.isArray(raw.devices)||Object.keys(raw.devices).length>64) throw new Error('INVALID');
      const existingAssets=new Set(raw.schemes.flatMap(s=>Object.values(s.backgrounds||{}).map(b=>b.assetId).filter(Boolean)));
      raw.schemes=raw.schemes.map(s=>normalizeScheme(s,existingAssets));
      if(new Set(raw.schemes.map(s=>s.id)).size!==raw.schemes.length) throw new Error('INVALID');
      for(const [id,device]of Object.entries(raw.devices)) {if(!validDeviceId(id))throw new Error('INVALID');raw.devices[id]=normalizeDevice(device,raw.schemes);}
      return raw;
    } catch(error) {
      if(error.code==='ENOENT') return emptyPreferences();
      throw new WorkbenchWriteError('设置文件暂时无法读取，原文件已保留',500,'PREFERENCES_READ_FAILED');
    }
  }
  async function read() { const [state,assets]=await Promise.all([readState(),backgrounds()]);return {state,backgrounds:assets}; }
  async function write(body) {
    return withVaultFileWrite(root,relativeStatePath,async(target)=>{
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','deviceId','expectedRevision','device','scheme','schemeId'].includes(k))) throw new WorkbenchWriteError('保存请求包含未知设置',400,'PREFERENCES_INVALID');
      const snapshot=await read(),state=snapshot.state;
      if(!body||body.expectedRevision!==state.revision) throw new WorkbenchWriteError('设置已在另一处更新，请重新读取后再保存',409,'PREFERENCES_CONFLICT');
      if(!validDeviceId(body.deviceId)) throw new WorkbenchWriteError('当前设备标识无效',400,'PREFERENCES_DEVICE_INVALID');
      if(!Object.hasOwn(state.devices,body.deviceId)&&Object.keys(state.devices).length>=64) throw new WorkbenchWriteError('已保存设备达到上限',400,'PREFERENCES_LIMIT');
      if(body.action==='save-scheme') {
        const scheme=normalizeScheme(body.scheme,new Set(snapshot.backgrounds.map(a=>a.id)));
        const at=state.schemes.findIndex(s=>s.id===scheme.id);
        if(at>=0&&state.schemes[at].theme!==scheme.theme) throw new WorkbenchWriteError('明暗模式不同，请另存为新方案',400,'PREFERENCES_THEME_IMMUTABLE');
        if(at<0) {if(state.schemes.length>=24) throw new WorkbenchWriteError('最多保存 24 个个人方案',400,'PREFERENCES_LIMIT');state.schemes.push(scheme);} else state.schemes[at]=scheme;
      } else if(body.action==='delete-scheme') {
        if(!state.schemes.some(s=>s.id===body.schemeId)) throw new WorkbenchWriteError('个人方案不存在',404,'PREFERENCES_NOT_FOUND');
        state.schemes=state.schemes.filter(s=>s.id!==body.schemeId);
        for(const device of Object.values(state.devices)) {
          for(const theme of ['day','night']) if(device.selected[theme]===body.schemeId) device.selected[theme]=`default:${theme}`;
          for(const key of Object.keys(device.crops||{})) if(key.startsWith(`${body.schemeId}:`)) delete device.crops[key];
        }
      } else if(body.action!=='update-device') throw new WorkbenchWriteError('设置操作无效',400,'PREFERENCES_ACTION_INVALID');
      if(body.device) state.devices[body.deviceId]=normalizeDevice(body.device,state.schemes);
      else if(!Object.hasOwn(state.devices,body.deviceId)) state.devices[body.deviceId]=defaultDevice();
      state.revision+=1;
      await fs.mkdir(path.dirname(target),{recursive:true});
      const temporary=`${target}.${crypto.randomUUID()}.tmp`;
      try {await fs.writeFile(temporary,`${JSON.stringify(state,null,2)}\n`,{flag:'wx',mode:0o600});await fs.rename(temporary,target);}
      finally {await fs.unlink(temporary).catch(()=>{});}
      return {state,backgrounds:snapshot.backgrounds};
    });
  }
  return {read,write,statePath};
}
