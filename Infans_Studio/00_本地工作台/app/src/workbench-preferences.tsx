import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { applyWorkbenchTheme, readInitialTheme } from './workbench-theme';
import { buildThemeTokens, TEXT_SIZES, TYPE_SCALE, type AppearanceScheme, type TextSize, type ThemeId } from './workbench-appearance.mjs';
import { defaultDevice, emptyPreferences, selectedScheme, validDeviceId, type DevicePreferences, type PreferencesSnapshot } from './workbench-preferences-model.mjs';
import { jsonFetch } from './page-shared';
import { transitionAppearance } from './interaction-motion';

function deviceIdentity() {
  try {const old=localStorage.getItem('infans-preferences-device-v1');if(validDeviceId(old)) return old!;} catch { /* Storage is optional for this session. */ }
  const id=`device-${crypto.randomUUID()}`;
  try {localStorage.setItem('infans-preferences-device-v1',id);}catch { /* Server still stores explicit saves. */ }
  return id;
}
export function typographyTokens(size:TextSize):CSSProperties {
  const scale=TEXT_SIZES.find(s=>s.id===size)?.scale || 1;
  const tokens:Record<string,string>={};
  for(const [role,px] of Object.entries(TYPE_SCALE)) tokens[`--text-${role}`]=`${Math.round(px*scale*100)/100}px`;
  for(const [alias,role] of Object.entries({'label':'micro','meta':'meta','body':'body','card-title':'title-sm','card-title-lead':'title','page-title':'page'})) tokens[`--type-${alias}-size`]=tokens[`--text-${role}`];
  return tokens as CSSProperties;
}
interface PreferenceContext {
  snapshot:PreferencesSnapshot;device:DevicePreferences;deviceId:string;loaded:boolean;error:string;saving:boolean;
  theme:ThemeId;appearance:AppearanceScheme;preview:AppearanceScheme|null;
  setPreview:(scheme:AppearanceScheme|null)=>void;previewCrops:DevicePreferences["crops"];setPreviewCrops:(value:DevicePreferences["crops"])=>void;reload:()=>Promise<void>;
  updateDevice:(next:DevicePreferences)=>Promise<void>;
  saveScheme:(scheme:AppearanceScheme,device:DevicePreferences)=>Promise<void>;
  deleteScheme:(id:string)=>Promise<void>;switchTheme:(theme:ThemeId)=>Promise<void>;
  temporarySize:{route:string;size:TextSize}|null;setTemporarySize:(value:{route:string;size:TextSize}|null)=>void;
}
const Context=createContext<PreferenceContext|null>(null);
export function WorkbenchPreferencesProvider({children}:{children:ReactNode}) {
  const [deviceId]=useState(deviceIdentity);
  const [initialTheme]=useState(readInitialTheme);
  const [snapshot,setSnapshot]=useState<PreferencesSnapshot>(()=>({state:emptyPreferences(),backgrounds:[]}));
  const [loaded,setLoaded]=useState(false),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const [preview,setPreview]=useState<AppearanceScheme|null>(null);
  const [previewCrops,setPreviewCrops]=useState<DevicePreferences["crops"]>({});
  const [temporarySize,setTemporarySize]=useState<{route:string;size:TextSize}|null>(null);
  const stateRef=useRef(snapshot);stateRef.current=snapshot;
  const busy=useRef(false);
  const reload=useCallback(async()=>{
    try {const next=await jsonFetch<PreferencesSnapshot>('/api/workbench-preferences');setSnapshot(next);setLoaded(true);setError('');}
    catch(e) {setError(e instanceof Error?e.message:'设置暂时无法读取');}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  const device=snapshot.state.devices[deviceId] || defaultDevice(initialTheme);
  const theme=preview?.theme || device.theme;
  const appearance=preview || selectedScheme(snapshot.state,device);
  useLayoutEffect(()=>{
    applyWorkbenchTheme(theme);
    const root=document.documentElement;
    const colors=buildThemeTokens(appearance);
    for(const [key,value] of Object.entries(colors)) root.style.setProperty(key,value);
    root.dataset.textSize=device.textSize;
    for(const [key,value] of Object.entries(typographyTokens(device.textSize))) root.style.setProperty(key,String(value));
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content',colors['--bg']);
  },[theme,appearance,device.textSize]);
  const commit=async(payload:Record<string,unknown>,animateTheme=false)=>{
    if(!loaded) throw new Error('请先重新读取设置');
    if(busy.current) throw new Error('正在保存上一项设置，请稍候');
    busy.current=true;setSaving(true);setError('');
    try {
      const next=await jsonFetch<PreferencesSnapshot>('/api/workbench-preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,deviceId,expectedRevision:stateRef.current.state.revision})});
      stateRef.current=next;
      if(animateTheme) await transitionAppearance(()=>{setSnapshot(next);setPreview(null);}, {kind:"theme"});
      else setSnapshot(next);
    } catch(e) {setError(e instanceof Error?e.message:'没有保存成功');throw e;}
    finally {busy.current=false;setSaving(false);}
  };
  const updateDevice=async(next:DevicePreferences)=>{await commit({action:'update-device',device:next});};
  const saveScheme=async(scheme:AppearanceScheme,next:DevicePreferences)=>{await commit({action:'save-scheme',scheme,device:next});setPreview(null);};
  const deleteScheme=async(id:string)=>{await commit({action:'delete-scheme',schemeId:id});setPreview(null);};
  const switchTheme=async(next:ThemeId)=>{await commit({action:'update-device',device:{...device,theme:next}},true);};
  return <Context.Provider value={{snapshot,device,deviceId,loaded,error,saving,theme,appearance,preview,setPreview,previewCrops,setPreviewCrops,reload,updateDevice,saveScheme,deleteScheme,switchTheme,temporarySize,setTemporarySize}}>{children}</Context.Provider>;
}
export function useWorkbenchPreferences() {const value=useContext(Context);if(!value) throw new Error('缺少工作台设置上下文');return value;}

export function ReadingSizeControl({route}:{route:string}) {
  const prefs=useWorkbenchPreferences();
  const [message,setMessage]=useState('');
  useEffect(()=>setMessage(''),[route]);
  const rememberedSize=prefs.device.pageTextSizes[route];
  const rememberedName=TEXT_SIZES.find(s=>s.id===rememberedSize)?.name;
  const size=prefs.temporarySize?.route===route?prefs.temporarySize.size:prefs.device.pageTextSizes[route] || prefs.device.textSize;
  const remember=async()=>{
    try {await prefs.updateDevice({...prefs.device,pageTextSizes:{...prefs.device.pageTextSizes,[route]:size}});setMessage('已记住本页字号');}
    catch(e){setMessage(e instanceof Error?e.message:'未能保存');}
  };
  return <details className="reading-size-control" onKeyDown={e=>{if(e.key==='Escape') e.currentTarget.open=false;}}>
    <summary aria-label="调整本页字号">Aa</summary>
    <div className="reading-size-menu">
      <strong>本页字号</strong>
      <div className="reading-size-options">{TEXT_SIZES.map(s=><button key={s.id} type="button" aria-pressed={size===s.id} onClick={()=>{prefs.setTemporarySize({route,size:s.id});setMessage('本次阅读生效');}}>{s.name}</button>)}</div>
      <button className="reading-remember-button" type="button" disabled={prefs.saving||!prefs.loaded} onClick={()=>void remember()}>记住本页<span className="reading-saved-state">{rememberedName?`已记住 · ${rememberedName}`:'未单独设置'}</span></button>
      <button type="button" disabled={prefs.saving||!prefs.loaded} onClick={()=>{const pages={...prefs.device.pageTextSizes};delete pages[route];prefs.setTemporarySize(null);void prefs.updateDevice({...prefs.device,pageTextSizes:pages}).then(()=>setMessage('已恢复默认字号')).catch(e=>setMessage(e.message));}}>跟随默认字号</button>
      <small role="status">{message || '临时调整不改变其他页面。'}</small>
    </div>
  </details>;
}
