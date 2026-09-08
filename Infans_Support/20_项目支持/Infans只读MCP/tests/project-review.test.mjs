import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createVaultReader } from '../src/vault.mjs';
import { createSourceReaders } from '../src/sources.mjs';
import { DEFAULT_LIMITS } from '../src/config.mjs';

async function fixture(t, rgExecutable) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-review-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  for (const name of ['vault','support','games']) await fs.mkdir(path.join(root,name));
  const config = {vaultRoot:path.join(root,'vault'), stateDirectory:path.join(root,'state'), limits:DEFAULT_LIMITS, rgExecutable};
  return {root, config, reader:createVaultReader(config)};
}
for (const backend of ['rg','node']) {
  test(`${backend}: source search and line citations; secret content never returned`, async t => {
    const f = await fixture(t, backend === 'node' ? false : undefined);
    await fs.writeFile(path.join(f.config.vaultRoot,'main.mjs'),'export const auditMarker = 1;\nexport const next = 2;\n');
    await fs.writeFile(path.join(f.config.vaultRoot,'unsafe.ts'), 'auditMarker\nconst password = "synthetic-canary-123";\n');
    await fs.writeFile(path.join(f.config.vaultRoot,'binary.ts'), 'auditMarker\0binary');
    await fs.mkdir(path.join(f.config.vaultRoot,'.secrets'));
    await fs.writeFile(path.join(f.config.vaultRoot,'.secrets','hidden.md'),'auditMarker');
    await fs.symlink(path.join(f.config.vaultRoot,'.secrets'),path.join(f.config.vaultRoot,'alias'));
    await fs.symlink(f.config.vaultRoot,path.join(f.config.vaultRoot,'cycle'));
    const read = await f.reader.read('main.mjs',{lineStart:2,lineCount:1});
    assert.equal(read.text,'export const next = 2;');
    assert.equal(read.lineStart,2); assert.match(read.sourceHash,/^[a-f0-9]{64}$/);
    await assert.rejects(f.reader.read('unsafe.ts',{start:0,maxChars:4}),{code:'SENSITIVE_CONTENT'});
    await assert.rejects(f.reader.read('binary.ts'),{code:'BINARY_CONTENT'});
    await assert.rejects(f.reader.read('alias/hidden.md'));
    const results = await f.reader.search('auditMarker');
    assert.deepEqual(results.results.map(x=>x.path),['main.mjs']);
    const listing = await f.reader.list('',2);
    assert.ok(!JSON.stringify(listing).includes('hidden.md'));
    assert.ok(!JSON.stringify(listing).includes('.secrets'));
  });
}
test('three configured roots remain separate and unknown roots/escapes fail', async t => {
  const f = await fixture(t,false);
  const sources=createSourceReaders(f.config,{INFANS_SUPPORT_ROOT:path.join(f.root,'support'), INFANS_GAMES_ROOT:path.join(f.root,'games')});
  assert.deepEqual(sources.sources,['vault','support','games']);
  assert.throws(()=>sources.get('disk'),{code:'UNKNOWN_SOURCE'});
  await fs.writeFile(path.join(f.root,'games','main.gd'),'extends Node\n');
  assert.equal((await sources.get('games').read('main.gd')).text,'extends Node\n');
  await assert.rejects(sources.get('vault').read('../games/main.gd'));
  await fs.symlink(path.join(f.root,'games'),path.join(f.root,'vault','outside'));
  await assert.rejects(sources.get('vault').read('outside/main.gd'),{code:'SYMLINK_ESCAPE_DENIED'});
});
test('credential paths and full source documents are withheld', async t => {
  const f=await fixture(t,false);
  for (const name of ['密码副本.md','credentials.yaml','session.json','.env.production','.npmrc']) {
    await fs.writeFile(path.join(f.config.vaultRoot,name),'harmless fixture');
    await assert.rejects(f.reader.read(name));
  }
  const secret='sk-proj-'+'z'.repeat(32);
  await fs.writeFile(path.join(f.config.vaultRoot,'ordinary.md'),'public heading\n'+secret);
  await assert.rejects(f.reader.read('ordinary.md',{lineStart:1,lineCount:1}),{code:'SENSITIVE_CONTENT'});
  assert.equal((await f.reader.search('public heading')).resultCount,0);
});
