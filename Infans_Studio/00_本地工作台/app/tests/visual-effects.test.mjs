import test from 'node:test';
import assert from 'node:assert/strict';
import { atmosphereResolution } from '../src/visual-effects/motion-geometry.ts';

test('Canvas pixel budget stays bounded across desktop, portrait, and zero-size mounts', () => {
  for (const coarse of [true, false]) for (const [w,h] of [[3840,2160],[2560,1440],[1180,820],[834,1194],[390,844],[0,0]]) {
    const size = atmosphereResolution(w,h,coarse);
    assert.ok(size.width >= 1 && size.height >= 1);
    assert.ok(size.width * size.height <= (coarse ? 280000 : 720000));
  }
});

