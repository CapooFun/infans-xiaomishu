import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);

async function pngSize(relativePath) {
  const data = await readFile(new URL(relativePath, appRoot));
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

test("网页主屏图标使用本人指定源图及独立缓存版本", async () => {
  const config = JSON.parse(await readFile(new URL("scripts/secretary-webapp-icon.json", appRoot), "utf8"));
  const source = await readFile(new URL(`../../${config.source}`, appRoot));
  assert.equal(createHash("sha256").update(source).digest("hex"), config.sha256);
  const version = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const index = await readFile(new URL("index.html", appRoot), "utf8");
  const manifest = JSON.parse(await readFile(new URL("public/site.webmanifest", appRoot), "utf8"));

  assert.match(index, new RegExp(`/site\\.webmanifest\\?v=${version}`));
  assert.match(index, new RegExp(`/apple-touch-icon\\.png\\?v=${version}`));
  assert.match(index, new RegExp(`/favicon-32\\.png\\?v=${version}`));
  assert.match(index, new RegExp(`/favicon-16\\.png\\?v=${version}`));
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
    [
      {
        src: `/secretary-icon-192.png?v=${version}`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `/secretary-icon-512.png?v=${version}`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  );
});

test("iOS、PWA 与浏览器图标尺寸完整", async () => {
  assert.deepEqual(await pngSize("public/apple-touch-icon.png"), [180, 180]);
  assert.deepEqual(await pngSize("public/secretary-icon-192.png"), [192, 192]);
  assert.deepEqual(await pngSize("public/secretary-icon-512.png"), [512, 512]);
  assert.deepEqual(await pngSize("public/favicon-32.png"), [32, 32]);
  assert.deepEqual(await pngSize("public/favicon-16.png"), [16, 16]);
});
