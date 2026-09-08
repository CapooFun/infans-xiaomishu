import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import ts from 'typescript';
import { BASE_THEME_TOKENS } from '../src/workbench-theme-tokens.mjs';
import { buildThemeTokens, defaultScheme, TYPE_SCALE, paletteWarnings } from '../src/workbench-appearance.mjs';

const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baselineFile=path.join(appDir,'scripts/theme-legacy-exceptions.json');
const normalize=(s)=>s.replace(/\s+/g,' ').trim();
const id=(s)=>crypto.createHash('sha256').update(s).digest('hex').slice(0,20);
const colorProperty=/^(?:--[\w-]+|color|background(?:-color|-image)?|(?:border|outline)(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow|text-shadow|fill|stroke|accent-color|caret-color)$/;
const literalColor=/(#[\da-f]{3,8})\b|(?:rgba?|hsla?|oklch|oklab)\s*\(|(?<![\w-])(?:white|black|red|green|blue|yellow|pink|purple|gray|grey|orange)(?![\w-])/i;
const fixedFont=/\d+(?:\.\d+)?px/;

export function collectStyleIssues(source,file) {
  const issues=[];
  const add=(property,value,offset,selector='')=>{
    const normalized=normalize(value),p=property.replace(/[A-Z]/g,v=>`-${v.toLowerCase()}`);
    const kind=colorProperty.test(p)&&literalColor.test(normalized)?'fixed-color':(p==='font-size'||p==='font')&&(fixedFont.test(normalized)||/^\d+(\.\d+)?$/.test(normalized)&&Number(normalized)>0)?'fixed-font':null;
    if(!kind)return;
    const key=id(`${file}|${normalize(selector)}|${p}|${normalized}|${kind}`);
    issues.push({key,file,kind,property:p,value:normalized,selector:normalize(selector).slice(0,180),line:source.slice(0,offset).split('\n').length});
  };
  if(file.endsWith('.css')) {
    // Retain string length so line numbers still identify the real declaration.
    const clean=source.replace(/\/\*[\s\S]*?\*\//g,s=>s.replace(/[^\n]/g,' '));
    const stack=[];let start=0;
    for(let i=0;i<clean.length;i++) {
      if(clean[i]==='{') {stack.push(clean.slice(start,i).trim());start=i+1;}
      else if(clean[i]===';'||clean[i]==='}') {
        const piece=clean.slice(start,i),match=/^\s*([\w-]+)\s*:\s*([\s\S]*)$/.exec(piece);
        if(match) {
          const property=match[1],selector=stack.join(' ');
          // Only authority-generated root declarations are exempt, never arbitrary local variables.
          const root=stack.length===1&&[':root',':root[data-theme="day"]'].includes(stack[0]);
          const generated=root&&(Object.hasOwn(BASE_THEME_TOKENS.night,property)||property.startsWith('--text-')&&Object.hasOwn(TYPE_SCALE,property.slice(7)));
          if(!generated)add(property,match[2],start,selector);
        }
        if(clean[i]==='}')stack.pop();start=i+1;
      }
    }
  } else {
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const visit=n=>{
      if(ts.isPropertyAssignment(n)) {
        const property=n.name.getText(ast).replace(/^['"]|['"]$/g,'');
        if(ts.isStringLiteral(n.initializer)||ts.isNumericLiteral(n.initializer)||ts.isNoSubstitutionTemplateLiteral(n.initializer)) add(property,n.initializer.text,n.getStart(ast));
      } else if(ts.isJsxAttribute(n)&&n.initializer) {
        if(ts.isStringLiteral(n.initializer))add(n.name.getText(ast),n.initializer.text,n.getStart(ast));
        else if(ts.isJsxExpression(n.initializer)&&n.initializer.expression&&ts.isNumericLiteral(n.initializer.expression))add(n.name.getText(ast),n.initializer.expression.text,n.getStart(ast));
      }
      ts.forEachChild(n,visit);
    };visit(ast);
  }
  return issues;
}
export function themeSourceFiles() {
  const files=[];function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())visit(p);else if(/\.(css|tsx|ts)$/.test(e.name)&&!e.name.endsWith('.d.ts'))files.push(p);}}visit(path.join(appDir,'src'));return files;
}
export function collectUndefinedVariables(sources) {
  const declared=new Set(),uses=[];
  for(const [file,source]of Object.entries(sources)) {
    const clean=source.replace(/\/\*[\s\S]*?\*\//g,'');
    for(const m of clean.matchAll(/(--[a-z\d-]+)(?:['"](?:\s+as\s+\w+)?\]?)?\s*:/ig))declared.add(m[1]);
    for(const m of clean.matchAll(/setProperty\(\s*['"](--[a-z\d-]+)/g))declared.add(m[1]);
    // An explicit fallback is valid; an undefined role with no fallback is not.
    for(const m of clean.matchAll(/var\((--[a-z\d-]+)\s*\)/ig))uses.push({file,token:m[1]});
  }
  return [...new Map(uses.filter(u=>!declared.has(u.token)).map(u=>[`${u.file}:${u.token}`,u])).values()];
}
export function generatedThemeSources() {
  const sources={};
  for(const theme of ['night','day']) {
    const file=path.join(appDir,'src',theme==='night'?'styles.css':'theme.css');let s=fs.readFileSync(file,'utf8');
    const tokens=buildThemeTokens(defaultScheme(theme));
    const declarations=Object.entries(tokens).map(([k,v])=>`  ${k}: ${v};`).join('\n');
    const marker='  /* Generated theme roles. Edit workbench-theme-tokens.mjs / workbench-appearance.mjs. */';
    if(theme==='night')s=s.replace(/^:root \{[\s\S]*?(?=  --serif:)/,`:root {\n  color-scheme: dark;\n${marker}\n${declarations}\n`);
    else s=s.replace(/:root\[data-theme="day"\] \{[\s\S]*?\n\}/,`:root[data-theme="day"] {\n  color-scheme: light;\n${marker}\n${declarations}\n}`);
    if(theme==='night')for(const [role,px]of Object.entries(TYPE_SCALE))s=s.replace(new RegExp(`(--text-${role}:)[^;]+;`),`$1 ${px}px;`);
    sources[file]=s;
  }
  return sources;
}
export function checkThemeContract({quiet=false}={}) {
  const errors=[];
  const sources=Object.fromEntries(themeSourceFiles().map(file=>[path.relative(appDir,file),fs.readFileSync(file,'utf8')]));
  sources['src/workbench-theme-tokens.mjs']=fs.readFileSync(path.join(appDir,'src/workbench-theme-tokens.mjs'),'utf8');
  for(const issue of collectUndefinedVariables(sources))errors.push(`${issue.file} 引用了未定义的 ${issue.token}`);
  for(const [file,expected]of Object.entries(generatedThemeSources()))if(fs.readFileSync(file,'utf8')!==expected)errors.push(`${path.relative(appDir,file)} 默认主题与注册表不一致，请运行 node scripts/check-theme-contract.mjs --write-tokens`);
  for(const theme of ['night','day']) {
    const tokens=buildThemeTokens(defaultScheme(theme));
    for(const token of Object.keys(BASE_THEME_TOKENS.night))if(!tokens[token])errors.push(`${theme} 缺少 ${token}`);
    for(const warning of paletteWarnings(defaultScheme(theme)))errors.push(`${theme} 默认方案：${warning}`);
  }
  const baseline=JSON.parse(fs.readFileSync(baselineFile,'utf8'));
  const allowed=new Map(baseline.entries.map(e=>[e.key,e]));const counts=new Map();let legacy=0;
  for(const file of themeSourceFiles()) {
    const relative=path.relative(appDir,file).split(path.sep).join('/');
    for(const issue of collectStyleIssues(fs.readFileSync(file,'utf8'),relative)) {
      const count=(counts.get(issue.key)||0)+1;counts.set(issue.key,count);
      const entry=allowed.get(issue.key);
      if(!entry||count>entry.count||!baseline.reasons[entry.reason])errors.push(`${relative}:${issue.line} ${issue.kind==='fixed-color'?'固定颜色':'固定字号'} ${issue.property}: ${issue.value}`);
      else legacy++;
    }
  }
  if(errors.length)throw new Error(`主题契约检查失败（${errors.length}）\n${errors.slice(0,35).join('\n')}`);
  if(!quiet)console.log(`主题契约通过：默认方案、颜色与字号；${legacy} 条已登记独立场景/插画/固定设计画布例外，禁止自动扩充清单。`);
  return {legacy};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--write-tokens')){for(const [file,s]of Object.entries(generatedThemeSources()))fs.writeFileSync(file,s);console.log('已从统一注册表生成默认主题。');}
  else checkThemeContract();
}
