// One intake protocol for downloaded media; no network fetch or aesthetic approval.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { artPurpose } from "./art-purpose.mjs";
import { SECRETARY_VISUAL_ASSET_PROJECT_ID as SECRETARY, SECRETARY_VISUAL_ASSET_ROOT as ROOT,
  validateSecretaryVisualAssetManifest, validateSecretaryVisualAssetCuration } from "./workbench-secretary-visual-assets.mjs";

const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = (message, code = "ART_INTAKE_INVALID", status = 400) => new WorkbenchWriteError(message, status, code);
const IDs = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;
const extensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
const exists = target => fs.lstat(target).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; });
function segment(value, label) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s || s.length > 100 || /[\\/\x00-\x1f]/u.test(s) || [".", ".."].includes(s)) throw fail(`${label}不能为空或包含路径字符`);
  return s;
}
function relative(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /[\\\x00]/u.test(value) || value.split("/").some(x => x === ".." || x === ".")) throw fail("只接受登记目录内的相对路径");
  return value;
}
async function inside(root, rel, make = false) {
  const parts = relative(rel).split("/"); let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat = await fs.lstat(current).catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (!stat && make && i < parts.length - 1) { await fs.mkdir(current); stat = await fs.lstat(current); }
    if (stat?.isSymbolicLink()) throw fail("素材路径不能经过符号链接", "ART_INTAKE_PATH_DENIED", 403);
    if (stat && i < parts.length - 1 && !stat.isDirectory()) throw fail("素材目录不可用");
  }
  return current;
}
async function atomic(target, data) {
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600, flag: "wx" });
  try { await fs.rename(tmp, target); } finally { await fs.unlink(tmp).catch(() => {}); }
}
function counts(assets, key) {
  return Object.fromEntries([...new Set(assets.map(a => a[key]))].sort((a,b) => a.localeCompare(b,"zh-CN")).map(k => [k, assets.filter(a => a[key] === k).length]));
}
export function summarizeManifest(m) {
  m.summary = { assetCount:m.assets.length, fileCount:m.assets.reduce((n,a)=>n+a.currentPaths.length,0), byGovernanceStatus:counts(m.assets,"governanceStatus"),byAssetClass:counts(m.assets,"assetClass"),byReferenceStatus:counts(m.assets,"referenceStatus") };
}

export function createArtIntakeService({ vaultRoot, sources = {} }) {
  async function owner(projectId) {
    if (!IDs.test(projectId || "")) throw fail("项目编号无效");
    const secretary = projectId === SECRETARY;
    const configured = secretary ? path.join(vaultRoot, ROOT) : sources[projectId]?.root;
    if (!configured) throw fail("项目尚未登记", "ART_INTAKE_PROJECT_MISSING", 404);
    const root = await fs.realpath(configured);
    let candidate = "候选", formal = "角色", archive = "归档";
    if (!secretary) {
      const config = JSON.parse(await fs.readFile(await inside(root,".infans/art-library.v1.json"),"utf8"));
      const roots = config.scanRoots || [];
      candidate = roots.find(r => r.zone === "candidate" && r.movable !== false)?.path;
      formal = roots.find(r => r.zone === "formal")?.path;
      archive = roots.find(r => r.zone === "archive")?.path;
      if (!candidate) throw fail("项目未登记可写候选目录");
    }
    for (const dir of [candidate,formal,archive].filter(Boolean)) relative(dir);
    return { projectId,root,secretary,candidate,formal,archive };
  }
  async function locked(o, fn) {
    const lock = await inside(o.root,".infans/art-intake.lock",true);
    const handle = await fs.open(lock,"wx",0o600).catch(e => { if(e.code === "EEXIST") throw fail("素材库正在整理，请稍后重试；异常退出请先核对入库回执", "ART_INTAKE_BUSY",409); throw e; });
    await handle.writeFile(json({pid:process.pid,at:new Date().toISOString()}));
    try { return await fn(); } finally { await handle.close(); await fs.unlink(lock); }
  }
  async function readRegistry(o) {
    const target = await inside(o.root,".infans/art-intake-records.v1.json");
    try { return JSON.parse(await fs.readFile(target,"utf8")); } catch(e) { if(e.code !== "ENOENT") throw e; return {schemaVersion:1,description:"已接收素材的制作单及来源关联",tags:["美术","入库"],batches:[]}; }
  }
  async function createBrief(input) {
    const o = await owner(input.projectId);
    const batchId = input.batchId || `art-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
    if (!IDs.test(batchId)) throw fail("批次编号无效");
    const brief = {schemaVersion:1,description:"不可变美术制作单",tags:["美术","制作单"],batchId,projectId:o.projectId,
      subject:segment(input.subject,"对象"),purpose:artPurpose(segment(input.purpose,"用途")),
      count:Number(input.count),width:Number(input.width),height:Number(input.height),
      prompt:typeof input.prompt === "string" ? input.prompt.trim().slice(0,16000) : "",
      source:segment(input.source || "本地下载","来源"),createdAt:new Date().toISOString()};
    if (!Number.isInteger(brief.count) || brief.count<1 || brief.count>100 || [brief.width,brief.height].some(n => !Number.isInteger(n)||n<32||n>16384) || !brief.prompt) throw fail("开工前请明确张数（1—100）、尺寸和制作要求");
    return locked(o,async()=>{
      const rel = `${o.candidate}/_待分类/${batchId}`;
      const target = await inside(o.root,`${rel}/brief.json`,true);
      if (await exists(target)) {
        const old = JSON.parse(await fs.readFile(target,"utf8"));
        if (["subject","purpose","count","width","height","prompt","source"].some(k=>old[k]!==brief[k])) throw fail("同批次制作单不可改写，请创建新批次", "ART_BRIEF_CONFLICT",409);
        return {brief:old,directory:path.dirname(target),relativeDirectory:rel};
      }
      await fs.writeFile(target,json(brief),{flag:"wx",mode:0o600});
      return {brief,directory:path.dirname(target),relativeDirectory:rel};
    });
  }
  async function snapshot(projectId) {
    const o = await owner(projectId); const registry = await readRegistry(o);
    const inbox = await inside(o.root,`${o.candidate}/_待分类`);
    const folders = await fs.readdir(inbox,{withFileTypes:true}).catch(e=>{if(e.code === "ENOENT")return [];throw e;});
    const batches=[],unclassified=[];
    for(const entry of folders.slice(0,200)) {
      if(!entry.isDirectory() || !IDs.test(entry.name)) continue;
      const target=await inside(o.root,`${o.candidate}/_待分类/${entry.name}/brief.json`);
      try {
        const brief=JSON.parse(await fs.readFile(target,"utf8"));
        const files=(await fs.readdir(path.dirname(target))).filter(n=>extensions.has(path.extname(n).toLowerCase()));
        const completed=registry.batches.find(b=>b.batchId===entry.name);
        batches.push({brief,directory:path.dirname(target),received:completed?.assets.length || 0,pendingFiles:files.length,status:completed?"received":files.length?"ready":"waiting"});
      } catch(e) { if(e.code !== "ENOENT") throw e;
        const names=await fs.readdir(path.dirname(target));
        unclassified.push({batchId:entry.name,directory:path.dirname(target),count:names.filter(n=>extensions.has(path.extname(n).toLowerCase())).length});
      }
    }
    const loose=folders.filter(e=>e.isFile()&&extensions.has(path.extname(e.name).toLowerCase())).length;
    if(loose)unclassified.push({batchId:null,directory:inbox,count:loose});
    return {projectId,inbox,roots:{formal:o.formal,candidate:o.candidate,archive:o.archive},batches,unclassified};
  }
  async function registerSecretary(o, records, brief) {
    const mp=await inside(o.root,"asset-manifest.v1.json"), cp=await inside(o.root,"curation.v1.json");
    const beforeM=await fs.readFile(mp),beforeC=await fs.readFile(cp),m=JSON.parse(beforeM),c=JSON.parse(beforeC);
    for(const row of records) {
      const duplicate=m.assets.find(a=>a.hash===`sha256:${row.sha256}` && a.subject===brief.subject && artPurpose(a.kind)===brief.purpose);
      if(duplicate) {row.assetId=duplicate.assetId;row.duplicate=true;row.canonicalPath=duplicate.canonicalPath;continue;}
      const assetId=`secvis-intake-${hash(`${brief.batchId}/${row.name}`).slice(0,12)}-${row.sha256.slice(0,12)}`;
      const rel=path.posix.join(ROOT,row.path); row.assetId=assetId;
      m.assets.push({assetId,subject:brief.subject,kind:brief.purpose,assetClass:"source",stage:"candidate",governanceStatus:"candidate",canonicalPath:rel,plannedCanonicalPath:null,currentPaths:[rel],
        files:[{path:rel,bytes:row.bytes,format:row.format,width:row.width,height:row.height,hasAlpha:row.hasAlpha,hash:row.sha256,gitStatus:"untracked"}],derivatives:[],derivedFrom:null,consumers:[],referenceStatus:"unreferenced",hash:`sha256:${row.sha256}`,
        provenance:{origin:brief.source,aiGenerated:true,reviewStatus:"pending-capoo",briefPath:path.posix.join(ROOT,o.candidate,"_待分类",brief.batchId,"brief.json"),generationRecord:path.posix.join(ROOT,".infans/art-intake-records.v1.json"),batchId:brief.batchId},
        privacy:{level:"private-local",containsPrivatePhoto:false,publishable:false},review:{needsCapoo:true,decision:null},lastVerified:m.snapshotDate});
      c.decisions.push({assetId,state:"selected",useClass:brief.purpose,reason:"制作单明确对象用途；入库不代表本人认可"});
    }
    summarizeManifest(m);
    await commitManifest(o,{mp,cp,beforeM,beforeC,m,c,reason:`intake-${brief.batchId}`});
  }
  async function commitManifest(o,{mp,cp,beforeM,beforeC,m,c,reason}) {
    const v=await validateSecretaryVisualAssetManifest(m,{vaultRoot}),cv=validateSecretaryVisualAssetCuration(c,m);
    if(!v.ok||!cv.ok)throw fail(`素材清单校验失败：${[...v.errors,...cv.errors].join("；")}`,"ART_MANIFEST_INVALID",409);
    if(hash(await fs.readFile(mp))!==hash(beforeM)||hash(await fs.readFile(cp))!==hash(beforeC))throw fail("清单被其他任务更新，请重新读取","ART_MANIFEST_CONFLICT",409);
    const dir=await inside(o.root,`.infans/art-transactions/${Date.now()}-${crypto.randomUUID()}/receipt.json`,true);
    await fs.writeFile(path.join(path.dirname(dir),"manifest-before.json"),beforeM);
    await fs.writeFile(path.join(path.dirname(dir),"curation-before.json"),beforeC);
    await fs.writeFile(dir,json({description:"素材清单写回及恢复记录",tags:["美术","事务"],reason,state:"prepared"}));
    try {await atomic(mp,json(m));await atomic(cp,json(c));}
    catch(e) {await atomic(mp,beforeM);await atomic(cp,beforeC);throw e;}
    await atomic(dir,json({description:"素材清单写回及恢复记录",tags:["美术","事务"],reason,state:"committed",at:new Date().toISOString()})).catch(()=>{});
  }
  async function sync(input) {
    const o=await owner(input.projectId);
    return locked(o,async()=>{
      const state=await snapshot(o.projectId),registry=await readRegistry(o),results=[];
      for(const batch of state.batches.filter(b=>b.pendingFiles>0 && (!input.batchId||b.brief.batchId===input.batchId))) {
        const {brief}=batch;
        if(brief.schemaVersion!==1 || brief.projectId!==o.projectId||!IDs.test(brief.batchId)||path.basename(batch.directory)!==brief.batchId||!brief.prompt||!Number.isInteger(brief.count)||brief.count<1||brief.count>100||[brief.width,brief.height].some(n=>!Number.isInteger(n)||n<32||n>16384))throw fail("收件制作单不完整或项目不符");
        segment(brief.subject,"对象"); segment(brief.purpose,"用途");
        const filenames=(await fs.readdir(batch.directory)).filter(n=>extensions.has(path.extname(n).toLowerCase()));
        // Commit only a complete batch. Partial downloads retain their original location.
        const prior=registry.batches.find(b=>b.batchId===brief.batchId);
        if(!prior && filenames.length<brief.count){results.push({batchId:brief.batchId,status:"waiting",received:filenames.length,expected:brief.count});continue;}
        if(filenames.length>100)throw fail("单批最多处理100张");
        const rows=[],copied=[];
        try {
          for(const name of filenames) {
            const source=await inside(o.root,`${o.candidate}/_待分类/${brief.batchId}/${name}`);
            const stat=await fs.stat(source);if(!stat.isFile()||stat.size>80*1024*1024)throw fail("图片必须是80MB以内的完整文件");
            const data=await fs.readFile(source),meta=await sharp(data,{limitInputPixels:100000000}).metadata();
            await sharp(data,{limitInputPixels:100000000,failOn:"warning"}).resize(1,1).toBuffer();
            const sha256=hash(data), ext=path.extname(name).toLowerCase();
            const destRel=`${o.candidate}/${brief.subject}/${brief.purpose}/${brief.batchId}/${sha256.slice(0,16)}${ext}`;
            const dest=await inside(o.root,destRel,true);
            if(await exists(dest)){if(hash(await fs.readFile(dest))!==sha256)throw fail("候选文件冲突");}
            else {await fs.copyFile(source,dest,fs.constants.COPYFILE_EXCL);copied.push(dest);}
            rows.push({name,path:destRel,sourcePath:path.relative(o.root,source),sha256,bytes:data.length,width:meta.width,height:meta.height,hasAlpha:meta.hasAlpha,format:meta.format?.toUpperCase(),sizeMatches:meta.width===brief.width&&meta.height===brief.height,assetId:`intake-${hash(`${brief.batchId}/${brief.subject}/${brief.purpose}/${sha256}`).slice(0,20)}`});
          }
          if(o.secretary)await registerSecretary(o,rows,brief);
          const record={batchId:brief.batchId,brief,assets:rows,importedAt:new Date().toISOString()};
          const i=registry.batches.findIndex(b=>b.batchId===brief.batchId);if(i>=0)registry.batches[i]=record;else registry.batches.push(record);
          await atomic(await inside(o.root,".infans/art-intake-records.v1.json",true),json(registry));
        } catch(e) { // Keep copies if a manifest already owns them; retries are idempotent.
          if(!o.secretary)for(const dest of copied)await fs.unlink(dest).catch(()=>{});
          throw e;
        }
        for(const row of rows) {
          await fs.unlink(await inside(o.root,row.sourcePath));
          if(row.duplicate && row.canonicalPath!==path.posix.join(ROOT,row.path))await fs.unlink(await inside(o.root,row.path)).catch(()=>{});
        }
        results.push({batchId:brief.batchId,status:"received",count:rows.length,sizeWarnings:rows.filter(r=>!r.sizeMatches).length});
      }
      return {ok:true,results};
    });
  }
  async function moveSecretary(input) {
    const o=await owner(input.projectId);if(!o.secretary)throw fail("只接受小秘书清单素材");
    const zone=String(input.targetRootId||"").replace(/^secretary-/u,"");
    if(!["formal","candidate","archive"].includes(zone))throw fail("目标状态无效");
    const ids=[...new Set(input.assetIds||[])];if(!ids.length||ids.length>100)throw fail("每次选择1—100张素材");
    return locked(o,async()=>{
      const mp=await inside(o.root,"asset-manifest.v1.json"),cp=await inside(o.root,"curation.v1.json"),beforeM=await fs.readFile(mp),beforeC=await fs.readFile(cp),m=JSON.parse(beforeM),c=JSON.parse(beforeC),plans=[];
      for(const id of ids) {
        const a=m.assets.find(a=>a.assetId===id),decision=c.decisions.find(d=>d.assetId===id);
        if(!a||!decision)throw fail("素材已变化，请刷新","ART_MOVE_STALE",409);
        const current=decision.state==="archive"||decision.state==="retired"?"archive":a.governanceStatus==="formal"?"formal":"candidate";
        if(input.expected?.[id]?.hash!==a.hash || input.expected?.[id]?.path!==a.canonicalPath || input.expected?.[id]?.zone!==current)throw fail("素材状态已改变，请刷新后再选择","ART_MOVE_STALE",409);
        if(current===zone)throw fail("素材已在目标区域");
        if(a.referenceStatus!=="unreferenced"||a.consumers.length)throw fail("这张图仍在使用或引用未核清，请先处理使用位置","ART_MOVE_REFERENCED",409);
        const sourceRel=path.posix.relative(ROOT,a.canonicalPath);relative(sourceRel);
        const source=await inside(o.root,sourceRel),bytes=await fs.readFile(source);
        if(`sha256:${hash(bytes)}`!==a.hash)throw fail("原图内容已变，请重新核对","ART_MOVE_STALE",409);
        const purpose=segment(artPurpose(a.kind),"用途"),subject=segment(a.subject,"对象");
        const destinationRel=`${zone==="formal"?o.formal:zone==="candidate"?o.candidate:o.archive}/${subject}/${purpose}/${path.basename(source)}`;
        const destination=await inside(o.root,destinationRel,true);
        if(await exists(destination))throw fail("目标已有同名图，未覆盖","ART_MOVE_COLLISION",409);
        const newPath=path.posix.join(ROOT,destinationRel);
        plans.push({id,source,destination,sourcePath:a.canonicalPath,targetPath:newPath,hash:a.hash});
        const old=a.canonicalPath;a.canonicalPath=newPath;a.currentPaths=a.currentPaths.map(p=>p===old?newPath:p);a.files=a.files.map(f=>f.path===old?{...f,path:newPath}:f);
        a.kind=purpose;a.assetClass=zone==="formal"?"master":"source";a.stage=zone==="formal"?"approved":zone==="archive"?"deprecated":"candidate";a.governanceStatus=zone==="formal"?"formal":zone==="archive"?"legacy-reference":"candidate";a.plannedCanonicalPath=zone==="formal"?newPath:null;
        a.review={...a.review,needsCapoo:zone==="candidate",decision:zone,decidedAt:new Date().toISOString(),method:"capoo-explicit-library-action"};
        a.provenance={...a.provenance,reviewStatus:zone==="formal"?"confirmed":"pending-capoo"};
        a.locationHistory=[...(a.locationHistory||[]),{from:old,to:newPath,at:new Date().toISOString()}];
        if(zone==="formal")a.migration={status:"formal-baseline-migrated",oldToNewVerified:true,consumersUpdated:false,consumerStatus:"explicit-exception",consumerExceptions:["本人收入正式素材库，尚未选择为App当前使用素材"]};
        decision.state=zone==="archive"?"archive":"selected";decision.useClass=purpose;decision.reason="本人在素材库明确选择状态";
      }
      const copied=[];
      try {for(const p of plans){await fs.copyFile(p.source,p.destination,fs.constants.COPYFILE_EXCL);copied.push(p.destination);}summarizeManifest(m);await commitManifest(o,{mp,cp,beforeM,beforeC,m,c,reason:`move-${zone}`});}
      catch(e){for(const dest of copied)await fs.unlink(dest).catch(()=>{});throw e;}
      const cleanupPending=[];for(const p of plans)try{await fs.unlink(p.source);}catch{cleanupPending.push(p.sourcePath);}
      return {ok:true,count:plans.length,targetZone:zone,assetIds:ids,cleanupPending,consumerChanges:0};
    });
  }
  async function receiveFiles(input) {
    const o=await owner(input.projectId),registry=await readRegistry(o);
    if(registry.batches.some(b=>b.batchId===input.batchId))return {ok:true,alreadyReceived:true};
    const created=await createBrief(input);
    await locked(o,async()=>{
      for(const file of input.files) {
        const name=segment(file.name,"文件名");
        if(!extensions.has(path.extname(name).toLowerCase()) || !Buffer.isBuffer(file.data) || file.data.length>80*1024*1024)throw fail("原图格式或大小无效");
        const target=await inside(o.root,`${created.relativeDirectory}/${name}`,true);
        if(await exists(target)){if(hash(await fs.readFile(target))!==hash(file.data))throw fail("同名原图内容不同");continue;}
        await atomic(target,file.data);
      }
    });
    return sync({projectId:o.projectId,batchId:input.batchId});
  }
  return {owner,createBrief,snapshot,sync,moveSecretary,readRegistry,receiveFiles};
}
