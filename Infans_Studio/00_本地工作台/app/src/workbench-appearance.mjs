import { BASE_THEME_TOKENS } from './workbench-theme-tokens.mjs';

export const TEXT_SIZES = [{ id: 'standard', name: '标准', scale: 1 }, { id: 'comfortable', name: '舒适', scale: 1.14 }, { id: 'large', name: '大字', scale: 1.28 }];
export const TYPE_SCALE = { micro: 12, meta: 13, ui: 14, body: 15, 'title-sm': 18, title: 22, page: 28, display: 42, metric: 46 };
export const SCENE_ROUTES = [ '/', '/schedule', '/projects', '/health', '/languages', '/topics', '/library', '/markets', '/markets/assets', '/tools' ];
export const COLOR_ROLES = [
  { id: 'teal', label: '玉青', token: '--teal' }, { id: 'gold', label: '金色', token: '--gold' },
  { id: 'bg', label: '底色', token: '--bg' }, { id: 'mark', label: '标记色', token: '--mark' },
  { id: 'ink', label: '正文', token: '--ink' },
  { id: 'actionBg', label: '按钮底色', token: '--action-bg' }, { id: 'actionInk', label: '按钮文字', token: '--action-ink' },
  { id: 'usagePrimary', label: '图表第一色', token: '--usage-primary' }, { id: 'usageSecondary', label: '图表第二色', token: '--usage-secondary' },
];
export const DEFAULT_SCENE_ADJUSTMENTS = { brightness: 1, saturation: 1, contrast: 1, blur: 0, veil: 1 };
export const SCENE_CONTROLS = [
  { key: 'brightness', label: '亮度', min: .6, max: 1.4, step: .02 },
  { key: 'saturation', label: '饱和度', min: 0, max: 1.6, step: .02 },
  { key: 'contrast', label: '对比度', min: .7, max: 1.3, step: .02 },
  { key: 'blur', label: '模糊', min: 0, max: 12, step: .5 },
  { key: 'veil', label: '遮罩', min: .3, max: 1, step: .02 },
];
export function hexColor(value) { return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value); }
export function mix(a, b, fraction) {
  const channels = [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i,i+2),16)*(1-fraction)+parseInt(b.slice(i,i+2),16)*fraction));
  return `#${channels.map(v=>v.toString(16).padStart(2,'0')).join('')}`;
}
export function alpha(hex, amount) { return `rgba(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(',')},${amount})`; }
export function contrastRatio(a,b) {
  const luminance = (hex) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
export function defaultScheme(theme = 'night') { return { id: `default:${theme}`, name: theme === 'day' ? '默认晴岚' : '默认玄夜', theme, colors: {}, surfaceOpacity: .9, backgrounds: {} }; }
export function buildThemeTokens(scheme) {
  const theme=scheme.theme==='day'?'day':'night', base=BASE_THEME_TOKENS[theme], tokens={...base};
  const colors=scheme.colors || {}, light=theme==='day';
  const gold=hexColor(colors.gold)?colors.gold:base['--gold'], teal=hexColor(colors.teal)?colors.teal:base['--teal'];
  const bg=hexColor(colors.bg)?colors.bg:base['--bg'], ink=hexColor(colors.ink)?colors.ink:base['--ink'];
  const paper=light?mix(bg,'#ffffff',.75):mix(bg,teal,.07);
  const mark=hexColor(colors.mark)?colors.mark:base['--mark'];
  // Related roles are derived together. Explicit advanced overrides apply last.
  Object.assign(tokens, {
    '--gold':gold,'--teal':teal,'--bg':bg,'--bg-2':mix(bg,teal,.06),'--ink':ink,
    '--surface':alpha(paper,scheme.surfaceOpacity ?? .9),'--surface-2':paper,
    '--gold-soft':alpha(gold,.11),'--teal-soft':alpha(teal,.10),'--line':alpha(ink,.14),'--line-strong':alpha(gold,.3),
    '--control-bg':paper,'--control-bg-hover':mix(paper,teal,.06),'--control-border':alpha(ink,.2),
    '--control-border-focus':teal,'--focus-ring':alpha(teal,.22),
    '--muted':mix(ink,paper,.26),'--quiet':mix(ink,paper,.28),'--text-placeholder':mix(ink,paper,.30),
    '--text-disabled':mix(ink,paper,.49),'--progress-track':mix(paper,ink,.12),'--progress-idle':mix(paper,ink,.48),
    '--media-card-bg':paper,'--book-cover-paper':paper,'--writing-cover-paper':paper,
    '--recovery-cell-bg':paper,'--recovery-water':`linear-gradient(180deg,${mix(paper,teal,.43)},${mix(paper,teal,.22)})`,
    '--recovery-wave':teal,'--recovery-wave-opacity':'.9',
    '--investment-scope-bg':`linear-gradient(120deg,${paper},${mix(paper,teal,.10)})`,
    '--investment-account-surface':mix(paper,teal,.12),'--investment-overview-bg':paper,
    '--action-ink':gold,'--action-bg':colors.gold||colors.bg?mix(paper,gold,light?.16:.19):base['--action-bg'],
    '--action-border':colors.gold||colors.bg?mix(paper,gold,.48):base['--action-border'],
    '--record-ring':mix(paper,gold,.62),
    '--mark':mark,'--mark-soft':alpha(mark,.12),
    '--mark-ink':contrastRatio(mark,'#ffffff')>=contrastRatio(mark,'#10191b')?'#ffffff':'#10191b',
  });
  if(colors.teal||colors.bg) {
    tokens['--raised-edge']=alpha(light?ink:teal,.24);
    tokens['--raised-glint']=alpha(light?mix(paper,'#ffffff',.8):mix(paper,teal,.7),light?.92:.3);
    tokens['--raised-contact']=alpha(light?mix(bg,ink,.7):'#000000',light?.16:.30);
    tokens['--raised-shadow']=alpha(light?mix(bg,ink,.7):'#000000',light?.22:.44);
    tokens['--record-body']=`conic-gradient(from 42deg,${mix(paper,teal,.2)},${paper},${mix(paper,teal,.4)},${mix(paper,gold,.1)},${mix(paper,teal,.2)})`;
    tokens['--record-label']=`radial-gradient(circle at 35% 25%,${paper},${mix(paper,teal,.2)} 78%)`;
  }
  for(const role of COLOR_ROLES) if(hexColor(colors[role.id])) tokens[role.token]=colors[role.id];
  if(!light) { tokens['--usage-primary']=colors.usagePrimary || teal; tokens['--usage-secondary']=colors.usageSecondary || gold; }
  return tokens;
}
export function resolvedToken(tokens,key) {
  const value=tokens[key]; return /^var\(--[\w-]+\)$/.test(value||'')?resolvedToken(tokens,value.slice(4,-1)):value;
}
export function paletteWarnings(scheme) {
  const t=buildThemeTokens(scheme), pairs=[['正文','--ink','--surface-2',4.5],['辅助文字','--quiet','--surface-2',4.5],['按钮文字','--action-ink','--action-bg',4.5],['青色操作','--teal','--surface-2',3],['金色标题','--gold','--surface-2',3],['图表第一色','--usage-primary','--progress-track',3],['图表第二色','--usage-secondary','--progress-track',3]];
  pairs.push(['标记色','--mark','--surface-2',3],['标记内文字','--mark-ink','--mark',4.5]);
  return pairs.flatMap(([name,a,b,min])=>{ const x=resolvedToken(t,a),y=resolvedToken(t,b); if(!hexColor(x)||!hexColor(y)) return []; const ratio=contrastRatio(x,y);return ratio<min?[`${name}辨识度偏低（${ratio.toFixed(1)}:1），可恢复推荐配色。`]:[]; });
}
