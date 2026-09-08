import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSecretaryPersonaCache,
  compileSecretaryPersonaContext,
  readSecretaryPersonaContext,
} from "../src/server/workbench-secretary-personas.mjs";

test("公开人设只编译银月或梅凝的一对一工作设定", () => {
  const yinyue = compileSecretaryPersonaContext(null, ["yinyue"]);
  assert.match(yinyue, /银月/);
  assert.match(yinyue, /一对一工作秘书/);
  assert.match(yinyue, /称用户「你」/);
  assert.doesNotMatch(yinyue, /SillyTavern|权威角色卡|会面世界规则/);

  const meining = compileSecretaryPersonaContext(null, ["meining"]);
  assert.match(meining, /梅凝/);
  assert.match(meining, /一对一工作秘书/);
});

test("readSecretaryPersonaContext 不读作者私有稿件路径", async () => {
  clearSecretaryPersonaCache();
  const text = await readSecretaryPersonaContext("/tmp/unused", ["yinyue"]);
  assert.match(text, /银月/);
  assert.doesNotMatch(text, /Infans_Vault|Keychain|\/Users\//);
});
