import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SECRETARY_ID,
  ACTIVE_SECRETARY_STORAGE_KEY,
  APP_SWITCHABLE_IDS,
  SECRETARY_CAST_IDS,
  SECRETARY_IDS,
  SECRETARY_PRODUCT_BRAND,
  PUBLIC_USER_DISPLAY_NAME,
  extractSecretarySwitchIntent,
  interpretSecretaryDictation,
  normalizeSecretaryId,
  readActiveSecretaryId,
  secretaryRefreshPortraitSrc,
  secretaryDutyPortrait,
  secretaryChatAtmosphere,
  secretaryLifeCoreById,
  secretaryProfileById,
  writeActiveSecretaryId,
} from "../src/secretary-identity.mjs";

test("公开版有银月、梅凝两位秘书，默认银月，用户显示名为「我」", () => {
  assert.equal(SECRETARY_PRODUCT_BRAND, "小秘书");
  assert.equal(PUBLIC_USER_DISPLAY_NAME, "我");
  assert.equal(DEFAULT_SECRETARY_ID, "yinyue");
  assert.deepEqual([...SECRETARY_IDS], ["yinyue", "meining"]);
  assert.deepEqual([...APP_SWITCHABLE_IDS], ["yinyue", "meining"]);
  assert.deepEqual([...SECRETARY_CAST_IDS], ["yinyue", "meining"]);

  const yinyue = secretaryProfileById(DEFAULT_SECRETARY_ID);
  assert.equal(yinyue?.name, "银月");
  assert.equal(yinyue?.fullName, "银月");
  assert.equal(yinyue?.avatarSrc, "/theme/avatar-yinyue-public.svg");
  assert.equal(yinyue?.chatAvatarSrc, "/theme/avatar-yinyue-public.svg");
  assert.equal(yinyue?.refreshPortraitSrc, "/theme/avatar-yinyue-public.svg");
  assert.equal(yinyue?.chatBackgroundSrc, "/theme/avatar-yinyue-public.svg");
  assert.equal(secretaryRefreshPortraitSrc(yinyue), "/theme/avatar-yinyue-public.svg");
  assert.deepEqual(secretaryDutyPortrait("yinyue"), { src: "/theme/avatar-yinyue-public.svg", fit: "cover" });
  assert.equal(yinyue?.petId, null);
  assert.equal(yinyue?.userAddress, "你");
  assert.equal(yinyue?.notificationTitle, "银月");
  assert.equal(yinyue?.memoryAuthorityPath, null);
  assert.equal(yinyue?.lifeCore?.manifestPath, "00_本地工作台/10_设计/人格与陪伴/银月公开工作设定.md");
  assert.equal(yinyue?.lifeCore?.lifecycleStage, "established");
  assert.equal(secretaryLifeCoreById("银月"), yinyue?.lifeCore);
  assert.equal(yinyue?.subtitle, "把事办清楚");
  assert.deepEqual([...yinyue.subtitleLines], ["把事办清楚", "你来决定"]);
  assert.equal(yinyue?.roleTier, "secretary");

  const meining = secretaryProfileById("meining");
  assert.equal(meining?.name, "梅凝");
  assert.equal(meining?.roleTier, "secretary");
  assert.equal(meining?.userAddress, "你");
  assert.equal(meining?.avatarSrc, "/theme/avatar-meining-public.svg");
  assert.equal(meining?.chatBackgroundSrc, "/theme/avatar-meining-public.svg");
  assert.deepEqual(secretaryDutyPortrait("meining"), { src: "/theme/avatar-meining-public.svg", fit: "cover" });
  assert.equal(meining?.memoryAuthorityPath, null);
  assert.equal(meining?.lifeCore?.manifestPath, "00_本地工作台/10_设计/人格与陪伴/梅凝公开工作设定.md");
  assert.equal(secretaryProfileById("yingning"), null);
  assert.equal(secretaryDutyPortrait(null), null);
  assert.equal(secretaryChatAtmosphere("yinyue"), null);
  assert.equal(secretaryChatAtmosphere("meining"), null);
  assert.equal(secretaryChatAtmosphere(null), null);
});

test("值班秘书持久化默认是银月，可切到梅凝，未知值回退", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readActiveSecretaryId(storage), "yinyue");
  assert.equal(writeActiveSecretaryId(storage, "银月"), "yinyue");
  assert.equal(values.get(ACTIVE_SECRETARY_STORAGE_KEY), "yinyue");
  assert.equal(writeActiveSecretaryId(storage, "梅凝"), "meining");
  assert.equal(readActiveSecretaryId(storage), "meining");
  values.set(ACTIVE_SECRETARY_STORAGE_KEY, "unknown");
  assert.equal(readActiveSecretaryId(storage), "yinyue");
});

test("认公开秘书 id 与中文名，未知值 fail closed", () => {
  assert.equal(normalizeSecretaryId("yinyue"), "yinyue");
  assert.equal(normalizeSecretaryId("银月"), "yinyue");
  assert.equal(normalizeSecretaryId("meining"), "meining");
  assert.equal(normalizeSecretaryId("梅凝"), "meining");
  assert.equal(normalizeSecretaryId("yingning"), null);
  assert.equal(normalizeSecretaryId(""), null);
});

test("公开版不剥听写称呼，完整换班命令可以切银月或梅凝", () => {
  assert.equal(interpretSecretaryDictation("银月，今天提醒我"), "银月，今天提醒我");
  assert.deepEqual(extractSecretarySwitchIntent("切换到银月"), {
    type: "switch-secretary",
    secretaryId: "yinyue",
    trigger: "switch",
  });
  assert.deepEqual(extractSecretarySwitchIntent("切换到梅凝"), {
    type: "switch-secretary",
    secretaryId: "meining",
    trigger: "switch",
  });
  assert.deepEqual(extractSecretarySwitchIntent("今天让 梅凝 值班。"), {
    type: "switch-secretary",
    secretaryId: "meining",
    trigger: "duty",
  });
  assert.equal(extractSecretarySwitchIntent("梅凝今天在吗"), null);
});
