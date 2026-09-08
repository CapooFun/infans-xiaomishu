import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(fs.readFileSync(new URL('../src/visual-effects/SceneAtmosphere.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function mount(active=true){
 const layer={dataset:{}},media=new EventTarget(),document=new EventTarget(),exports={};let cleanup;
 media.matches=false;document.hidden=false;
 vm.runInNewContext(source,{exports,document,matchMedia:()=>media,requestAnimationFrame:()=>{throw new Error('Background must not schedule JS drawing');},require:id=>id==='react'?{useRef:()=>({current:layer}),useEffect:fn=>{cleanup=fn();}}:id.includes('jsx-runtime')?{jsx:()=>null}:{} });
 exports.SceneAtmosphere({active}); return {layer,document,media,unmount:()=>cleanup?.()};
}
test('stationary breath pauses when hidden or reduced, resumes without a frame loop',()=>{
 const s=mount();assert.equal(s.layer.dataset.motion,'running');
 s.document.hidden=true;s.document.dispatchEvent(new Event('visibilitychange'));assert.equal(s.layer.dataset.motion,'paused');
 s.document.hidden=false;s.document.dispatchEvent(new Event('visibilitychange'));assert.equal(s.layer.dataset.motion,'running');
 s.media.matches=true;s.media.dispatchEvent(new Event('change'));assert.equal(s.layer.dataset.motion,'paused');
 s.unmount();s.media.matches=false;s.media.dispatchEvent(new Event('change'));assert.equal(s.layer.dataset.motion,'paused');
});
test('inactive workbench breath stays paused when overlays are open',()=>{const s=mount(false);assert.equal(s.layer.dataset.motion,'paused');s.document.dispatchEvent(new Event('visibilitychange'));assert.equal(s.layer.dataset.motion,'paused');s.unmount();});
