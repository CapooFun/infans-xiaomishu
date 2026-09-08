import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {createArtIntakeService,summarizeManifest} from "../src/server/workbench-art-intake.mjs";
import {createArtLibraryService} from "../src/server/workbench-art-library.mjs";
import {loadSecretaryVisualAssetCatalog,SECRETARY_VISUAL_ASSET_ROOT as ROOT} from "../src/server/workbench-secretary-visual-assets.mjs";
const projectId="secretary-visual-assets";
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"art-intake-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const base=path.join(root,ROOT);await fs.mkdir(base,{recursive:true});
  const m={schemaVersion:1,snapshotDate:"2026-09-06",phase:"pre-migration",project:{id:projectId,name:"小秘书"},assets:[]};summarizeManifest(m);
  await fs.writeFile(path.join(base,"asset-manifest.v1.json"),JSON.stringify(m));
  await fs.writeFile(path.join(base,"curation.v1.json"),JSON.stringify({schemaVersion:1,snapshotDate:m.snapshotDate,decisions:[],amendments:[]}));
  return {root,base,service:createArtIntakeService({vaultRoot:root}),library:createArtLibraryService({vaultRoot:root,sources:{},cacheDir:path.join(root,"cache")})};
}
const spec={projectId,batchId:"batch-example",subject:"银月",purpose:"聊天头像候选",count:2,width:64,height:64,prompt:"保持身份与发型，柔和自然表情",source:"Codex"};
const png=color=>sharp({create:{width:64,height:64,channels:3,background:color}}).png().toBuffer();
test("制作单必填、不可改写、完整批次入库，重复同步不重复登记",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.createBrief({...spec,subject:""}));
  await assert.rejects(f.service.createBrief({...spec,subject:"../银月"}));
  const made=await f.service.createBrief(spec);assert.equal(made.brief.purpose,"头像");
  await assert.rejects(f.service.createBrief({...spec,prompt:"改了"}),e=>e.status===409);
  await fs.writeFile(path.join(made.directory,"one.png"),await png("red"));
  assert.equal((await f.service.sync({projectId})).results[0].status,"waiting");
  await fs.writeFile(path.join(made.directory,"two.png"),await png("blue"));
  assert.equal((await f.service.sync({projectId})).results[0].count,2);
  const loaded=await loadSecretaryVisualAssetCatalog(f.root);assert.equal(loaded.manifest.assets.length,2);
  assert.ok(loaded.manifest.assets.every(a=>a.subject==="银月"&&a.kind==="头像"&&a.stage==="candidate"&&a.consumers.length===0));
  assert.deepEqual((await f.service.sync({projectId})).results,[]);
  assert.equal((await fs.readdir(made.directory)).filter(n=>n.endsWith(".png")).length,0);
  const semantic=await f.library.semantic({projectId,category:"secretaries"});
  assert.equal(semantic.entities[0].assetRelations.length,2);
  assert.ok(semantic.entities[0].assetRelations.every(r=>r.confidence==="declared-purpose"));
  assert.ok(semantic.assets.every(a=>a.usageStatus!=="used"));
});
test("明确晋升实际移动、保持ID/说明，拒绝过期状态和有引用的图片",async t=>{
  const f=await fixture(t),made=await f.service.createBrief({...spec,count:1});
  await fs.writeFile(path.join(made.directory,"one.png"),await png("red"));await f.service.sync({projectId});
  let a=(await loadSecretaryVisualAssetCatalog(f.root)).manifest.assets[0],id=a.assetId,old=a.canonicalPath;
  await f.library.appendAnnotation({projectId,assetId:id,expectedPurpose:"",purpose:"本人测试说明"});
  const input={projectId,assetIds:[id],targetRootId:"secretary-formal",expected:{[id]:{hash:a.hash,path:old,zone:"candidate"}}};
  assert.equal((await f.library.moveAssets(input)).count,1);
  a=(await loadSecretaryVisualAssetCatalog(f.root)).manifest.assets[0];
  assert.equal(a.assetId,id);assert.equal(a.stage,"approved");assert.equal(a.consumers.length,0);
  await assert.rejects(fs.access(path.join(f.root,old)));await fs.access(path.join(f.root,a.canonicalPath));
  assert.equal((await f.library.resolveItem(projectId,id)).item.annotation.purpose,"本人测试说明");
  await assert.rejects(f.library.moveAssets(input),e=>e.code==="ART_MOVE_STALE");
  const m=JSON.parse(await fs.readFile(path.join(f.base,"asset-manifest.v1.json")));m.assets[0].referenceStatus="referenced";summarizeManifest(m);await fs.writeFile(path.join(f.base,"asset-manifest.v1.json"),JSON.stringify(m));
  await assert.rejects(f.library.moveAssets({...input,targetRootId:"secretary-archive",expected:{[id]:{hash:a.hash,path:a.canonicalPath,zone:"formal"}}}),e=>e.code==="ART_MOVE_REFERENCED");
});
test("收件拒绝符号链接、不完整图片与制作单伪造项目",async t=>{
  const f=await fixture(t),made=await f.service.createBrief({...spec,count:1});
  const outside=path.join(f.root,"outside.png");await fs.writeFile(outside,await png("red"));
  await fs.symlink(outside,path.join(made.directory,"one.png"));
  await assert.rejects(f.service.sync({projectId}),e=>e.code==="ART_INTAKE_PATH_DENIED");
  await fs.unlink(path.join(made.directory,"one.png"));await fs.writeFile(path.join(made.directory,"one.png"),"not an image");
  await assert.rejects(f.service.sync({projectId}));
  const brief=JSON.parse(await fs.readFile(path.join(made.directory,"brief.json")));brief.projectId="another";await fs.writeFile(path.join(made.directory,"brief.json"),JSON.stringify(brief));
  await assert.rejects(f.service.sync({projectId}));
  assert.equal((await loadSecretaryVisualAssetCatalog(f.root)).manifest.assets.length,0);
});
test("同摘要重复交付不增加素材；并发写入失败关闭",async t=>{
  const f=await fixture(t),data=await png("red");
  await f.service.receiveFiles({...spec,count:1,files:[{name:"one.png",data}]});
  await f.service.receiveFiles({...spec,batchId:"batch-another",count:1,files:[{name:"one.png",data}]});
  assert.equal((await loadSecretaryVisualAssetCatalog(f.root)).manifest.assets.length,1);
  await fs.writeFile(path.join(f.base,".infans/art-intake.lock"),"test");
  await assert.rejects(f.service.createBrief({...spec,batchId:"batch-blocked"}),e=>e.code==="ART_INTAKE_BUSY");
});

test("游戏沿用自身目录，制作对象与已用引用分开，移动后保持入库素材ID",async t=>{
  const {root}=await fixture(t),game=path.join(root,"game");await fs.mkdir(path.join(game,".infans"),{recursive:true});
  await fs.mkdir(path.join(game,"assets"));await fs.mkdir(path.join(game,"candidates"));await fs.mkdir(path.join(game,"archive"));await fs.mkdir(path.join(game,"scenes"));
  await fs.writeFile(path.join(game,".infans/art-library.v1.json"),JSON.stringify({schemaVersion:1,project:{id:"test-game",name:"测试游戏"},scanRoots:[{id:"formal",zone:"formal",role:"runtime",path:"assets"},{id:"candidate",zone:"candidate",path:"candidates"},{id:"archive",zone:"archive",path:"archive"}],referenceScan:{roots:["scenes"],completeForZones:["formal","candidate","archive"]}}));
  await fs.writeFile(path.join(game,".infans/art-semantic-catalog.v1.json"),JSON.stringify({schemaVersion:1,project:{id:"test-game"},categoryTree:[],entities:[],assets:[]}));
  const sources={"test-game":{root:game}},intake=createArtIntakeService({vaultRoot:root,sources}),lib=createArtLibraryService({vaultRoot:root,sources,cacheDir:path.join(root,"cache-game")});
  await intake.receiveFiles({...spec,projectId:"test-game",count:1,files:[{name:"one.png",data:await png("green")}]});
  let snap=await lib.snapshot({projectId:"test-game",view:"files",refresh:true}),id=snap.items[0].id;
  let semantic=await lib.semantic({projectId:"test-game"});assert.equal(semantic.entities[0].assetRelations[0].assetId,id);
  assert.equal(semantic.assets[0].libraryItem.zone,"candidate");
  await lib.moveAssets({projectId:"test-game",assetIds:[id],targetRootId:"formal",targetSubdirectory:"银月/头像"});
  snap=await lib.snapshot({projectId:"test-game",view:"files",refresh:true});assert.equal(snap.items[0].id,id);assert.equal(snap.items[0].zone,"formal");
  semantic=await lib.semantic({projectId:"test-game"});assert.equal(semantic.assets[0].libraryItem.zone,"formal");
});
