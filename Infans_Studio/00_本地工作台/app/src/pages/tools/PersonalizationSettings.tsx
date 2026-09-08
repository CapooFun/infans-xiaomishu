import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Copy, Moon, Play, RotateCcw, Sun, Trash2 } from 'lucide-react';
import { useWorkbenchPreferences, typographyTokens } from '../../workbench-preferences';
import { buildThemeTokens, COLOR_ROLES, DEFAULT_SCENE_ADJUSTMENTS, SCENE_CONTROLS, SCENE_ROUTES, TEXT_SIZES, defaultScheme, paletteWarnings, resolvedToken, type AppearanceScheme, type TextSize } from '../../workbench-appearance.mjs';
import { backgroundPosition, selectedScheme, type SceneCrop } from '../../workbench-preferences-model.mjs';
import { getPageScene } from '../../workbench-theme';
import { ACTIVE_SECRETARY_CHANGE_EVENT, SECRETARY_PROFILES, readActiveSecretaryId, writeActiveSecretaryId } from '../../secretary-identity.mjs';
import { jsonFetch } from '../../page-shared';
import { ShortcutSettings } from './ShortcutSettings';
import { AttentionMark } from '../../components/AttentionMark';
import { COMPUTER_SHORTCUT_COMMANDS, presentComputerShortcuts, shortcutBindingSignature } from '../../computer-shortcuts.mjs';

const PAGE_NAMES:Record<string,string>={'/':'首页','/schedule':'日程安排','/projects':'事业顺利','/health':'身心健康','/languages':'语言学习','/topics':'专题研究','/library':'艺术馆藏','/markets':'世界资讯','/markets/assets':'资产管理','/tools':'实用工具'};
const clone=(s:AppearanceScheme)=>structuredClone(s);
function personal(s:AppearanceScheme):AppearanceScheme {return {...clone(s),id:`custom-${crypto.randomUUID()}`,name:`${s.theme==='day'?'晴岚':'玄夜'} · 我的方案`};}
const EMPTY_COMPUTER=presentComputerShortcuts({});
type ComputerShortcutSnapshot=ReturnType<typeof presentComputerShortcuts>&{warnings?:string[]};
function settingsTabFromLocation(){
  const section=new URLSearchParams(window.location.search).get('section');
  return section==='shortcuts'||section==='reading'||section==='secretary'?section:'appearance';
}

export default function PersonalizationSettings({active=true}:{active?:boolean}) {
  const prefs=useWorkbenchPreferences();
  const [tab,setTab]=useState(settingsTabFromLocation);
  const [draft,setDraft]=useState(()=>clone(prefs.appearance));
  const [appearanceDirty,setAppearanceDirty]=useState(false),[readingDirty,setReadingDirty]=useState(false),[shortcutDirty,setShortcutDirty]=useState(false);
  const [computerSnapshot,setComputerSnapshot]=useState<ComputerShortcutSnapshot>(EMPTY_COMPUTER);
  const [computerDraft,setComputerDraft]=useState(EMPTY_COMPUTER.bindings);
  const [computerLoaded,setComputerLoaded]=useState(false);
  const computerDirty=COMPUTER_SHORTCUT_COMMANDS.some(({id})=>shortcutBindingSignature(computerDraft[id])!==shortcutBindingSignature(computerSnapshot.bindings[id]));
  const computerDirtyRef=useRef(false);
  computerDirtyRef.current=computerDirty;
  const shortcutTabDirty=shortcutDirty||computerDirty;
  const dirty=tab==='appearance'?appearanceDirty:tab==='reading'?readingDirty:tab==='shortcuts'?shortcutTabDirty:false;
  const setDirty=(value:boolean)=>{if(tab==='appearance')setAppearanceDirty(value);else if(tab==='reading')setReadingDirty(value);else if(tab==='shortcuts')setShortcutDirty(value);};
  const [live,setLive]=useState(false),[message,setMessage]=useState('');
  const [route,setRoute]=useState('/tools');
  const [cropDrafts,setCropDrafts]=useState<Record<string,SceneCrop>>({});
  const cropKey=`${draft.id}:${route}`;
  const [size,setSize]=useState<TextSize>(prefs.device.textSize);
  const [shortcuts,setShortcuts]=useState(prefs.device.shortcuts);
  const [secretary,setSecretary]=useState(()=>readActiveSecretaryId(window.localStorage));
  const [secretaryBusy,setSecretaryBusy]=useState(false),[deleteConfirm,setDeleteConfirm]=useState(false);
  const [previewDevice,setPreviewDevice]=useState('desktop');
  useEffect(()=>{if(!appearanceDirty)setDraft(clone(selectedScheme(prefs.snapshot.state,prefs.device)));},[prefs.snapshot,appearanceDirty]);
  useEffect(()=>{if(!readingDirty)setSize(prefs.device.textSize);},[prefs.snapshot,readingDirty]);
  useEffect(()=>{if(!shortcutDirty)setShortcuts(prefs.device.shortcuts);},[prefs.snapshot,shortcutDirty]);
  useEffect(()=>{prefs.setPreview(active&&tab==='appearance'&&live?draft:null);return ()=>prefs.setPreview(null);},[active,tab,live,draft,prefs.setPreview]);
  useEffect(()=>{prefs.setPreviewCrops(active&&tab==='appearance'&&live?cropDrafts:{});return ()=>prefs.setPreviewCrops({});},[active,tab,live,cropDrafts,prefs.setPreviewCrops]);
  useEffect(()=>{if(!active) {setLive(false);setAppearanceDirty(false);setReadingDirty(false);setShortcutDirty(false);setComputerDraft(computerSnapshot.bindings);setCropDrafts({});setMessage('');}},[active,computerSnapshot.bindings]);
  useEffect(()=>{if(active) void jsonFetch<{activeSecretaryId:string}>('/api/secretary').then(s=>setSecretary(s.activeSecretaryId)).catch(()=>{});},[active]);
  useEffect(()=>{
    if(!active) return;
    let cancelled=false;
    void jsonFetch<ComputerShortcutSnapshot>('/api/tools/computer-shortcuts').then(next=>{
      if(cancelled) return;
      setComputerSnapshot(next);
      if(!computerDirtyRef.current) setComputerDraft(next.bindings);
      setComputerLoaded(true);
    }).catch(()=>{if(!cancelled) setMessage('暂时读不到本机快捷键。');});
    return ()=>{cancelled=true;};
  },[active]);
  const edit=(patch:Partial<AppearanceScheme>)=>{
    const next=draft.id.startsWith('default:')?personal(draft):draft;
    if(next.id!==draft.id) setCropDrafts(Object.fromEntries(Object.entries({...prefs.device.crops,...cropDrafts}).filter(([key])=>key.startsWith(`${draft.id}:`)).map(([key,value])=>[key.replace(`${draft.id}:`,`${next.id}:`),value])));
    setDraft({...next,...patch});setAppearanceDirty(true);setLive(true);setMessage('');return next.id;
  };
  const run=async(action:()=>Promise<void|string>,success:string)=>{setMessage('');try{const result=await action();setMessage(typeof result==='string'&&result?result:success);setDirty(false);setLive(false);}catch(e){setMessage(e instanceof Error?e.message:'没有保存成功');}};
  const saveAppearance=()=>run(async()=>{
    const device={...prefs.device,theme:draft.theme,selected:{...prefs.device.selected,[draft.theme]:draft.id},crops:{...prefs.device.crops,...cropDrafts}};
    if(draft.id.startsWith('default:')) await prefs.updateDevice(device);else await prefs.saveScheme(draft,device);
    setCropDrafts({});
  },'方案已保存并应用');
  const saveShortcuts=()=>run(async()=>{
    if(shortcutDirty) await prefs.updateDevice({...prefs.device,shortcuts});
    if(computerDirty){
      const next=await jsonFetch<ComputerShortcutSnapshot>('/api/tools/computer-shortcuts',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:computerSnapshot.revision,bindings:computerDraft})});
      setComputerSnapshot(next);
      setComputerDraft(next.bindings);
      if(next.warnings?.length) return next.warnings.join(' ');
    }
  },'设置已保存');
  const adjustments=draft.backgrounds[route] || DEFAULT_SCENE_ADJUSTMENTS;
  const picked=prefs.snapshot.backgrounds.find(a=>a.id===adjustments.assetId);
  const defaultScene=getPageScene(draft.theme,route,secretary);
  const sceneImage=(picked?.url || defaultScene.image).split('?')[0];
  const savedCrop=cropDrafts[cropKey] || prefs.device.crops[cropKey];
  const crop=savedCrop?.image===sceneImage?savedCrop:{x:50,y:50,image:sceneImage};
  const tokens=buildThemeTokens(draft);
  const previewStyle={...tokens,...typographyTokens(size),'--preview-image':`url("${picked?.url || defaultScene.image}")`,'--preview-position':backgroundPosition(crop,sceneImage),'--preview-filter':`brightness(${adjustments.brightness}) saturate(${adjustments.saturation}) contrast(${adjustments.contrast}) blur(${adjustments.blur}px)`} as CSSProperties;
  const choose=(scheme:AppearanceScheme)=>{setDraft(clone(scheme));setCropDrafts({});setAppearanceDirty(true);setLive(true);setDeleteConfirm(false);setMessage('');};
  const restoreDefault=()=>{
    const base=defaultScheme(draft.theme);
    choose(base);
    setCropDrafts(Object.fromEntries(SCENE_ROUTES.map(r=>[`${base.id}:${r}`,{x:50,y:50,image:getPageScene(base.theme,r,secretary).image.split('?')[0]}])));
    setMessage(`正在预览默认${base.theme==='day'?'晴岚':'玄夜'}，保存后应用。个人方案仍保留。`);
  };
  const warnings=paletteWarnings(draft);
  return <section className="personalization-settings" aria-label="个性化设置">
    <header className="personalization-heading"><div><span>系统设置</span><h2>把小秘书调成喜欢的样子</h2><p>从玄夜与晴岚出发，留住自己的配色与习惯。</p></div><span className="preference-save-state" role="status">{prefs.saving?'正在保存…':live?'正在预览，尚未保存':dirty?'有未保存的修改':'已应用保存的设置'}</span></header>
    {prefs.error?<div className="preference-error" role="alert">{prefs.error}<button type="button" disabled={prefs.saving} onClick={()=>void prefs.reload()}>重新读取</button></div>:null}
    <fieldset className="preference-edit-fields" disabled={prefs.saving}>
    <nav className="settings-section-tabs" aria-label="设置分类">{[['appearance','外观与背景'],['reading','字号与阅读'],['shortcuts','快捷键'],['secretary','秘书席']].map(([id,name])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>{setTab(id);setMessage('');}}>{name}</button>)}</nav>
    {tab==='appearance'?<div className="appearance-editor">
      <div className="appearance-controls">
        <section className="preference-section"><h3>主题方案</h3><div className="scheme-picker">{[defaultScheme('night'),defaultScheme('day'),...prefs.snapshot.state.schemes].map(s=><button key={s.id} type="button" className={draft.id===s.id?'is-selected':''} onClick={()=>choose(s)}>{s.theme==='day'?<Sun size={17}/>:<Moon size={17}/>}<span>{s.name}</span>{draft.id===s.id&&live?<small className="scheme-state">预览中</small>:prefs.device.selected[prefs.device.theme]===s.id?<small className="scheme-state">已应用</small>:null}</button>)}</div>
          <p className="preference-hint">默认方案始终保留。修改会另建个性化方案，可以放心尝试。</p><button type="button" className="preference-text-button" onClick={restoreDefault}><RotateCcw size={15}/>恢复默认{draft.theme==='day'?'晴岚':'玄夜'}</button>
          <div className="scheme-name"><label>方案名称<input value={draft.name} maxLength={40} readOnly={draft.id.startsWith('default:')} onChange={e=>edit({name:e.target.value})}/></label><button type="button" onClick={()=>{const next=personal(draft);setCropDrafts(Object.fromEntries(Object.entries({...prefs.device.crops,...cropDrafts}).filter(([key])=>key.startsWith(`${draft.id}:`)).map(([key,value])=>[key.replace(`${draft.id}:`,`${next.id}:`),value])));setDraft(next);setAppearanceDirty(true);setLive(true);}}><Copy size={15}/>另存一份</button></div>
        </section>
        <section className="preference-section"><h3>配色与材质</h3><div className="color-role-grid is-primary">{COLOR_ROLES.slice(0,4).map(role=><label key={role.id}><input type="color" aria-label={role.label} value={resolvedToken(tokens,role.token)} onInput={e=>edit({colors:{...draft.colors,[role.id]:e.currentTarget.value}})} onChange={e=>edit({colors:{...draft.colors,[role.id]:e.target.value}})}/><span>{role.label}</span></label>)}</div><p className="preference-hint">青、金与底色会带着按钮、边框和卡片一起调整；标记色用于手动关注。</p>
          <label className="preference-slider"><span>卡片实心程度 <output>{Math.round(draft.surfaceOpacity*100)}%</output></span><input type="range" min=".6" max="1" step=".02" value={draft.surfaceOpacity} onChange={e=>edit({surfaceOpacity:Number(e.target.value)})}/></label>
          <details><summary>分别微调文字、按钮与图表</summary><div className="color-role-grid">{COLOR_ROLES.slice(4).map(role=><label key={role.id}><input type="color" aria-label={role.label} value={resolvedToken(tokens,role.token)} onInput={e=>edit({colors:{...draft.colors,[role.id]:e.currentTarget.value}})} onChange={e=>edit({colors:{...draft.colors,[role.id]:e.target.value}})}/><span>{role.label}</span></label>)}</div></details>
          <button type="button" className="preference-text-button" onClick={()=>edit({colors:{},surfaceOpacity:.9})}><RotateCcw size={14}/>恢复推荐配色</button>
        </section>
        <section className="preference-section"><h3>页面背景</h3><label className="preference-field">应用页面<select value={route} onChange={e=>setRoute(e.target.value)}>{SCENE_ROUTES.map(r=><option key={r} value={r}>{PAGE_NAMES[r]}</option>)}</select></label><label className="preference-field">背景图片<select value={adjustments.assetId || ''} onChange={e=>edit({backgrounds:{...draft.backgrounds,[route]:{...adjustments,assetId:e.target.value||undefined}}})}><option value="">跟随默认场景{route==='/'?'与当前秘书':''}</option>{prefs.snapshot.backgrounds.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <div className="background-thumbnails">{prefs.snapshot.backgrounds.map(a=><button type="button" key={a.id} aria-label={a.name} aria-pressed={adjustments.assetId===a.id} title={a.name} onClick={()=>edit({backgrounds:{...draft.backgrounds,[route]:{...adjustments,assetId:a.id}}})}><img src={a.url} alt="" loading="lazy"/><span>{a.name}</span></button>)}</div>
          <details><summary>画面与构图</summary><p className="preference-hint">构图只记住当前设备的这张图，换图会回到居中。</p>{SCENE_CONTROLS.map(c=><label className="preference-slider" key={c.key}><span>{c.label}<output>{c.key==='blur'?`${adjustments[c.key]} px`:`${Math.round(adjustments[c.key]*100)}%`}</output></span><input type="range" aria-label={`背景${c.label}`} min={c.min} max={c.max} step={c.step} value={adjustments[c.key]} onChange={e=>edit({backgrounds:{...draft.backgrounds,[route]:{...adjustments,[c.key]:Number(e.target.value)}}})}/></label>)}
            {(['x','y'] as const).map(axis=><label className="preference-slider" key={axis}><span>{axis==='x'?'水平位置':'垂直位置'} · 当前设备<output>{crop[axis]}%</output></span><input aria-label={axis==='x'?'背景水平位置':'背景垂直位置'} type="range" min="0" max="100" value={crop[axis]} onChange={e=>{const nextId=edit({});const value=Number(e.target.value);setCropDrafts(current=>({...current,[`${nextId}:${route}`]:{...crop,[axis]:value}}));}}/></label>)}
            <button type="button" className="preference-text-button" onClick={()=>edit({backgrounds:{...draft.backgrounds,[route]:{...DEFAULT_SCENE_ADJUSTMENTS,assetId:adjustments.assetId}}})}><RotateCcw size={14}/>恢复画面参数</button>
          </details>
        </section>
      </div>
      <aside className="appearance-preview-column"><div className="preview-size-switch" aria-label="预览尺寸">{[['desktop','Mac'],['tablet','iPad'],['phone','手机']].map(([id,name])=><button key={id} type="button" aria-pressed={previewDevice===id} onClick={()=>setPreviewDevice(id)}>{name}</button>)}</div>
        <div className={`appearance-preview is-${previewDevice}`} style={previewStyle}><div className="appearance-preview-scene"/><div className="appearance-preview-veil" style={{opacity:adjustments.veil}}/><div className="appearance-preview-content"><span className="preview-eyebrow">{draft.theme==='day'?'晴岚 · 云白玉青':'玄夜 · 玉夜冷青'}</span><h3>{PAGE_NAMES[route]}</h3><p>山色入窗，案头有光。</p><article><span>阅读与卡片</span><h4>给日常留一点从容</h4><p>正文、辅助信息与数字，各自清楚，也彼此协调。长一点的文字会自然换行。</p><small>辅助文字 · 最近更新</small></article><article className="preview-player"><button type="button" aria-label="播放按钮外观预览"><Play size={23} fill="currentColor"/></button><div><strong>山海之间</strong><span className="preview-progress"><i/></span><small>02:36 / 04:18</small></div></article><article><span>关注标记</span><div className="preview-marks"><span><AttentionMark marked={false}/>未标记</span><span><AttentionMark marked/>已标记</span><span><AttentionMark marked={false} partial count={3}/>部分标记</span></div></article><article><span>图表辨识度</span><div className="preview-chart"><i/><b/></div><div className="preview-chart-labels"><span>自己使用 68%</span><span>子任务 32%</span></div></article></div></div>
        <div className="preview-contrast" role="status">{warnings.length?warnings.map(w=><p key={w}>{w}</p>):<p><Check size={15}/>当前文字与主要控件对比检查通过</p>}<small>实际背景与透明叠加仍以页面观感为准。</small></div>
        <button type="button" className="preference-text-button" onClick={()=>setLive(!live)}>{live?'查看已保存的页面效果':'在页面中预览此方案'}</button>
      </aside>
    </div>:null}
    {tab==='reading'?<section className="preference-section reading-settings"><h3>常用字号</h3><p>在当前设备保存，切换主题时继续使用。</p><div className="reading-size-options">{TEXT_SIZES.map(s=><button key={s.id} type="button" aria-pressed={size===s.id} onClick={()=>{setSize(s.id);setDirty(true);}}>{s.name}</button>)}</div><article className="reading-sample" style={typographyTokens(size)}><h4>读得清楚，也保留从容</h4><p>这里预览正文、标签和辅助说明。字号变大时，行高和内容空间一起适应。</p><small>辅助信息 12:30 · 今日记录</small></article><p className="preference-hint">偶尔看小字，可以用页面顶部的 Aa 临时放大，或单独记住该页。</p></section>:null}
    {tab==='shortcuts'?<ShortcutSettings value={shortcuts} onChange={next=>{setShortcuts(next);setShortcutDirty(true);}} computerValue={computerDraft} onComputerChange={next=>setComputerDraft(next)} computerLoaded={computerLoaded} disabled={prefs.saving}/>:null}
    {tab==='secretary'?<section className="preference-section"><h3>当前秘书席</h3><p>选择谁来值班。配色、字号和各页背景保留你的设置。</p><div className="secretary-settings-grid">{SECRETARY_PROFILES.filter(profile=>profile.secretaryEligible).map(profile=>{const id=profile.id;return <button type="button" key={id} aria-pressed={secretary===id} disabled={secretaryBusy} onClick={()=>{if(id===secretary)return;setSecretaryBusy(true);void jsonFetch<{activeSecretaryId:string}>('/api/secretary',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({activeSecretaryId:id})}).then(saved=>{writeActiveSecretaryId(localStorage,saved.activeSecretaryId);setSecretary(saved.activeSecretaryId);window.dispatchEvent(new Event(ACTIVE_SECRETARY_CHANGE_EVENT));setMessage(`${profile.name}已就位`);}).catch(e=>setMessage(e.message)).finally(()=>setSecretaryBusy(false));}}><img src={profile.avatarSrc} alt=""/><strong>{profile.name}</strong><span>{secretary===id?'正在值班':'请她值班'}</span></button>;})}</div></section>:null}
    </fieldset>
    <footer className="preference-actions"><span role="status">{message || (dirty?'修改还没有保存':'随时可以恢复默认方案。')}</span>{tab!=='secretary'?<div><button type="button" disabled={prefs.saving} onClick={()=>{if(tab==='appearance'){setDraft(clone(selectedScheme(prefs.snapshot.state,prefs.device)));setCropDrafts({});}else if(tab==='reading')setSize(prefs.device.textSize);else {setShortcuts(prefs.device.shortcuts);setComputerDraft(computerSnapshot.bindings);}setDirty(false);setLive(false);setMessage('已取消本次修改');}}>取消修改</button>{tab==='appearance'&&!draft.id.startsWith('default:')&&prefs.snapshot.state.schemes.some(s=>s.id===draft.id)?<button type="button" aria-label="删除个人方案" disabled={prefs.saving} onClick={()=>setDeleteConfirm(true)}><Trash2 size={16}/></button>:null}<button className="preference-save-button" type="button" disabled={!prefs.loaded||prefs.saving||(tab==='shortcuts'&&!computerLoaded&&!shortcutDirty)} onClick={()=>void(tab==='appearance'?saveAppearance():tab==='shortcuts'?saveShortcuts():run(()=>prefs.updateDevice({...prefs.device,textSize:size}),'设置已保存'))}>{prefs.saving?'正在保存…':tab==='appearance'?'保存并应用':'保存设置'}</button></div>:null}</footer>
    {deleteConfirm?<div className="preference-delete-confirm" role="alert"><span>删除「{draft.name}」？使用它的设备会恢复对应默认主题。</span><button type="button" onClick={()=>setDeleteConfirm(false)}>保留</button><button type="button" disabled={prefs.saving} onClick={()=>void run(async()=>{await prefs.deleteScheme(draft.id);setDraft(defaultScheme(draft.theme));setDeleteConfirm(false);},'个人方案已删除')}>确认删除</button></div>:null}
  </section>;
}
