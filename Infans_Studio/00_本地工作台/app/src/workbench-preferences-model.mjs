import { COLOR_ROLES, DEFAULT_SCENE_ADJUSTMENTS, SCENE_CONTROLS, SCENE_ROUTES, TEXT_SIZES, defaultScheme, hexColor } from './workbench-appearance.mjs';
import { normalizeShortcutBindings, validateShortcutBindings } from './workbench-shortcut-bindings.mjs';

const fail=(message)=>{ throw Object.assign(new Error(message), {status:400,code:'PREFERENCES_INVALID'}); };
const plain=(value)=>value!==null && typeof value==='object' && !Array.isArray(value);
const fields=(value,allowed,label)=>{if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(`${label}包含未知设置`);};
const finite=(v,min,max,label)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:fail(`${label}超出范围`);
export function validDeviceId(id) { return typeof id==='string' && /^[a-zA-Z0-9][\w-]{7,79}$/.test(id); }
export function emptyPreferences() { return {schemaVersion:1,revision:0,schemes:[],devices:{}}; }
export function defaultDevice(theme='night') { return {theme:theme==='day'?'day':'night',selected:{night:'default:night',day:'default:day'},textSize:'standard',shortcuts:normalizeShortcutBindings({}),crops:{},pageTextSizes:{}}; }
// A crop belongs to one image version, never to whatever happens to occupy its page next.
export function backgroundPosition(crop,image) {
  return crop?.image===image.split('?')[0]?`${crop.x}% ${crop.y}%`:'50% 50%';
}
export function normalizeScheme(raw,allowedAssets) {
  fields(raw,['id','name','theme','colors','surfaceOpacity','backgrounds'],'方案');
  if(!plain(raw)||typeof raw.id!=='string'||!/^custom-[a-zA-Z0-9-]{1,72}$/.test(raw.id)) fail('个人方案标识无效');
  if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.trim().length>40) fail('请填写 1—40 字的方案名称');
  if(!['night','day'].includes(raw.theme)) fail('请选择玄夜或晴岚');
  if(!plain(raw.colors)||!plain(raw.backgrounds)) fail('方案内容无效');
  const colors={};
  for(const [key,value] of Object.entries(raw.colors)) {
    if(!COLOR_ROLES.some(role=>role.id===key)||!hexColor(value)) fail('配色格式无效');
    colors[key]=value.toLowerCase();
  }
  const backgrounds={};
  for(const [route,value] of Object.entries(raw.backgrounds)) {
    if(!SCENE_ROUTES.includes(route)||!plain(value)) fail('页面背景范围无效');
    fields(value,['assetId',...SCENE_CONTROLS.map(c=>c.key)],'背景');
    const scene={...DEFAULT_SCENE_ADJUSTMENTS};
    if(value.assetId) {
      if(typeof value.assetId!=='string'||!allowedAssets.has(value.assetId)) fail('这张背景已不在可选图库中，请重新选择');
      scene.assetId=value.assetId;
    }
    for(const c of SCENE_CONTROLS) if(Object.hasOwn(value,c.key)) scene[c.key]=finite(value[c.key],c.min,c.max,c.label);
    backgrounds[route]=scene;
  }
  return {id:raw.id,name:raw.name.trim(),theme:raw.theme,colors,surfaceOpacity:finite(raw.surfaceOpacity,.6,1,'卡片通透度'),backgrounds};
}
export function normalizeDevice(raw,schemes) {
  fields(raw,['theme','selected','textSize','shortcuts','crops','pageTextSizes'],'设备设置');
  fields(raw.selected,['night','day'],'所选方案');
  const device=defaultDevice(raw.theme);
  if(!['night','day'].includes(raw.theme)) fail('主题无效');
  for(const theme of ['night','day']) {
    const id=raw.selected?.[theme] || `default:${theme}`;
    if(id!==`default:${theme}`&&!schemes.some(s=>s.id===id&&s.theme===theme)) fail('所选方案不存在或明暗模式不匹配');
    device.selected[theme]=id;
  }
  if(!TEXT_SIZES.some(s=>s.id===raw.textSize)) fail('字号档位无效');
  device.textSize=raw.textSize;
  // Validate before normalizing: malformed or conflicting submitted bindings must not silently change.
  if(!plain(raw.shortcuts)) fail('快捷键设置无效');
  const shortcutErrors=validateShortcutBindings(raw.shortcuts);
  if(shortcutErrors.length) fail(shortcutErrors[0].message || '快捷键有冲突，请重新设置');
  device.shortcuts=normalizeShortcutBindings(raw.shortcuts);
  if(!plain(raw.crops)||Object.keys(raw.crops).length>160) fail('背景构图设置无效');
  for(const [key,crop] of Object.entries(raw.crops)) {
    if(!/^(?:default:(?:night|day)|custom-[a-zA-Z0-9-]{1,72}):\/(?:[a-z/-]*)$/.test(key)||!plain(crop)) fail('背景构图范围无效');
    fields(crop,['x','y','image'],'背景构图');
    if(crop.image!==undefined && (typeof crop.image!=='string'||!/^\/theme\/[a-zA-Z0-9._/-]+\.(?:avif|png|webp|jpe?g)$/.test(crop.image)||crop.image.includes('..'))) fail('背景构图素材无效');
    const boundary=key.indexOf(':/'),schemeId=key.slice(0,boundary),route=key.slice(boundary+1);
    if(!SCENE_ROUTES.includes(route)||!['default:night','default:day'].includes(schemeId)&&!schemes.some(s=>s.id===schemeId)) fail('背景构图对应方案或页面不存在');
    device.crops[key]={x:finite(crop.x,0,100,'水平位置'),y:finite(crop.y,0,100,'垂直位置')};
    if(crop.image) device.crops[key].image=crop.image;
  }
  if(!plain(raw.pageTextSizes)||Object.keys(raw.pageTextSizes).length>100) fail('页面字号设置无效');
  for(const [route,size] of Object.entries(raw.pageTextSizes)) {
    if(!/^\/[a-zA-Z0-9/_-]{0,140}$/.test(route)||!TEXT_SIZES.some(s=>s.id===size)) fail('页面字号范围无效');
    device.pageTextSizes[route]=size;
  }
  return device;
}
export function selectedScheme(state,device,theme=device.theme) {
  return state.schemes.find(s=>s.id===device.selected[theme]&&s.theme===theme) || defaultScheme(theme);
}
