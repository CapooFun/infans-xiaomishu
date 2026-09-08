import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseIdentityGallery } from '../src/server/workbench-identity-gallery.mjs';

const header = '## 人生长廊\n| ID | 时段 | 年代 | 标题 | 摘要 | 展开 | 来源 |\n|---|---|---|---|---|---|---|\n';
const row = '| first-work | past | 2010—2011 | 起点 | 一句话 | 原文摘要 | 20_个人档案/职业履历/经历.md |\n';
test('legacy curation remains usable without a gallery; unrelated tables are never ingested', () => {
  assert.deepEqual(parseIdentityGallery('## 过去\n' + row), []);
  assert.deepEqual(parseIdentityGallery(header + row + '## 展示边界\n' + row.replace('first-work','another-work')).map(x => x.id), ['first-work']);
});
test('curated exhibits keep stable IDs, uncertain date labels, text, and source pointers', () => {
  const [item] = parseIdentityGallery(header + row.replace('一句话','一句\\|话'));
  assert.equal(item.summary,'一句|话');
  assert.equal(item.year,'2010—2011');
  assert.equal(item.source,'20_个人档案/职业履历/经历.md');
  assert.deepEqual(parseIdentityGallery(header+row+row), [parseIdentityGallery(header+row)[0]]);
});
test('malformed rows, source traversal, and fabricated future facts cannot become gallery exhibits', () => {
  for (const bad of [row.replace('past','future'),row.replace('20_个人档案/职业履历/经历.md','../private.md'),row.replace('20_个人档案/职业履历/经历.md','https://example.com/a.md'),row.replace('原文摘要','')]) assert.deepEqual(parseIdentityGallery(header+bad),[]);
});
test('real curated entries have resolvable sources and never import source contents into the parser', () => {
  const curation = readFileSync(new URL('../../10_设计/人格与陪伴/身份策展.md', import.meta.url),'utf8');
  const gallery=parseIdentityGallery(curation); assert.ok(gallery.length>=8);
  for(const entry of gallery) assert.ok(readFileSync(new URL('../../../'+entry.source,import.meta.url),'utf8').length>0);
  const reader=readFileSync(new URL('../src/personal-gallery/PersonalGallery.tsx',import.meta.url),'utf8');
  for(const original of ['life.compass.lifeviewBody','life.compass.workviewBody','life?.odyssey?.plans','life.toolbox?.stuckNote']) assert.ok(reader.includes(original));
});
