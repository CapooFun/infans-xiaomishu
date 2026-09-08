import test from 'node:test';
import assert from 'node:assert/strict';
import { collectStyleIssues, collectUndefinedVariables, checkThemeContract } from '../scripts/check-theme-contract.mjs';
import { buildThemeTokens, defaultScheme, paletteWarnings, contrastRatio, resolvedToken, TEXT_SIZES, TYPE_SCALE } from '../src/workbench-appearance.mjs';

test('new CSS and inline UI literals are rejected, semantic roles and layout dimensions are allowed',()=>{
 const css='.card {color:#112233;background:rgb(1,2,3);font-size:10px;width:10px;border-color:var(--red);box-shadow:0 2px 5px var(--shadow-soft)}';
 assert.equal(collectStyleIssues(css,'src/new.css').length,3);
 assert.equal(collectStyleIssues('.card{color:white;--private-color:#222; font:500 11px serif}','src/new.css').length,3);
 assert.equal(collectStyleIssues('const x={fontSize:9,color:"#123456"};const y=<i fill="red"/>','src/new.tsx').length,3);
 assert.equal(collectStyleIssues('const x={color:"var(--red)",fontSize:"var(--text-ui)",width:12}','src/new.tsx').length,0);
});
test('undefined theme references fail while explicit fallbacks and component variables remain valid',()=>{
 const sources={'ui.css':':root{--ink:var(--base)} .card{color:var(--ink);background:var(--missing);width:var(--progress);border-color:var(--optional,transparent)}','registry.mjs':'const t={"--base":"#123456"};','Card.tsx':'const s={["--progress" as string]:"50%"};'};
 assert.deepEqual(collectUndefinedVariables(sources),[{file:'ui.css',token:'--missing'}]);
});
test('built-in modes have complete roles, readable defaults, and the full app obeys the contract',()=>{
 assert.deepEqual(Object.keys(buildThemeTokens(defaultScheme('day'))).sort(),Object.keys(buildThemeTokens(defaultScheme('night'))).sort());
 for(const mode of ['day','night'])assert.deepEqual(paletteWarnings(defaultScheme(mode)),[]);
 checkThemeContract({quiet:true});
});
test('personal palettes derive surfaces and controls without mutating defaults, warning on unreadable choices',()=>{
 const base=defaultScheme('day'),before=buildThemeTokens(base),custom={...base,colors:{teal:'#235e74',gold:'#835638',bg:'#ebe9e1'}};
 const next=buildThemeTokens(custom);assert.notEqual(next['--surface-2'],before['--surface-2']);assert.notEqual(next['--recovery-water'],before['--recovery-water']);assert.notEqual(next['--action-bg'],before['--action-bg']);assert.deepEqual(buildThemeTokens(base),before);
 assert.ok(paletteWarnings({...base,colors:{ink:'#f8fbfa',actionInk:'#f0e8d6'}}).length>=2);
});
test('three independent reading sizes increase all registered typography roles with a readable floor',()=>{
 assert.deepEqual(TEXT_SIZES.map(x=>x.id),['standard','comfortable','large']);assert.ok(TYPE_SCALE.micro>=12);
 for(const px of Object.values(TYPE_SCALE)){const values=TEXT_SIZES.map(x=>x.scale*px);assert.ok(values[0]<values[1]&&values[1]<values[2]);}
});

test('settings background picker consumes the real visual catalog contract',async()=>{
 const {preferenceBackgrounds}=await import('../src/server/workbench-preferences.mjs');
 const {fileURLToPath}=await import('node:url');
 const assets=await preferenceBackgrounds(fileURLToPath(new URL('../../../',import.meta.url)));
 assert.ok(assets.length>0);assert.equal(new Set(assets.map(a=>a.id)).size,assets.length);
 for(const asset of assets){assert.ok(asset.url.startsWith('/theme/'));assert.ok(asset.name);assert.ok(!asset.url.includes('..'));}
});


test('manual attention keeps readable theme defaults and follows a saved personal marker color',()=>{
 for(const mode of ['day','night']) {
  const tokens=buildThemeTokens(defaultScheme(mode));
  assert.ok(contrastRatio(tokens['--mark'],resolvedToken(tokens,'--surface-2'))>=3);
  assert.ok(contrastRatio(tokens['--mark'],tokens['--mark-ink'])>=4.5);
 }
 for(const mark of ['#48265b','#f4e8ff']) {
  const tokens=buildThemeTokens({...defaultScheme('day'),colors:{mark}});
  assert.equal(resolvedToken(tokens,'--attention-bg'),mark);
  assert.equal(resolvedToken(tokens,'--attention-border'),mark);
  assert.ok(contrastRatio(mark,tokens['--mark-ink'])>=4.5);
 }
 assert.ok(paletteWarnings({...defaultScheme('day'),colors:{mark:'#f8fbfa'}}).some(w=>w.includes('标记色')));
});
