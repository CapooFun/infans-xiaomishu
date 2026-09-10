import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HOME_PINS_PATH, GANTT_HIDDEN_PATH, PROJECT_TASK_FOLLOWS_PATH, JP_MISTAKE_STATE } from "../src/server/vault-paths.mjs";
import { WorkbenchWriteError } from "../src/server/workbench-errors.mjs";
import { writeHomePins } from "../src/server/workbench-home-pins.mjs";
import { writeGanttHidden } from "../src/server/workbench-gantt-hidden.mjs";
import { writeProjectTaskFollow } from "../src/server/workbench-project-task-follows.mjs";
import { saveMistakeState } from "../src/server/workbench-japanese-exam-modes.mjs";
import { createPreferencesService } from "../src/server/workbench-preferences.mjs";

const DEDICATED_WRITERS = [
  "../src/server/workbench-home-pins.mjs",
  "../src/server/workbench-gantt-hidden.mjs",
  "../src/server/workbench-project-task-follows.mjs",
  "../src/server/workbench-video-favorites.mjs",
  "../src/server/workbench-music-playlists.mjs",
  "../src/server/workbench-food-map.mjs",
  "../src/server/workbench-world-news-favorites.mjs",
  "../src/server/workbench-secretary-chats.mjs",
  "../src/server/workbench-secretary-attachments.mjs",
  "../src/server/workbench-character-photos.mjs",
  "../src/server/workbench-japanese-exam.mjs",
  "../src/server/workbench-japanese-exam-modes.mjs",
  "../src/server/workbench-preferences.mjs",
  "../src/server/workbench-sidebar-bookmarks.mjs",
  "../src/server/workbench-domain-research-progress.mjs",
  "../src/server/workbench-computer-shortcuts.mjs",
  "../src/server/workbench-language-reactor.mjs",
  "../src/server/workbench-apple-health.mjs",
  "../src/server/workbench-topic-quiz.mjs",
];

const SKIP_VAULT_GATE = [
  "../src/server/workbench-calendar.mjs",
  "../src/server/workbench-media-directory-cache.mjs",
  "../src/server/workbench-frontend-refresh.mjs",
  "../src/server/workbench-proactive-interactions.mjs",
];

async function readSource(relative) {
  return fs.readFile(new URL(relative, import.meta.url), "utf8");
}

test("dedicated notebook writers go through the Vault file write guard and skip preview tokens", async () => {
  for (const relative of DEDICATED_WRITERS) {
    const source = await readSource(relative);
    assert.match(source, /from ["']\.\/workbench-file-write-guard\.mjs["']/, relative);
    assert.match(source, /withVaultFileWrite\(/, relative);
    assert.doesNotMatch(source, /createWriteService/, relative);
  }
  const writeService = await readSource("../src/server/workbench-write.mjs");
  const memory = await readSource("../src/server/workbench-relationship-memory.mjs");
  const japan = await readSource("../src/server/workbench-local-activities.mjs");
  assert.match(writeService, /withVaultFileWrite\(/);
  assert.match(writeService, /preview\(/);
  assert.match(memory, /RELATIONSHIP_EXCLUDED/);
  assert.doesNotMatch(memory, /withVaultFileWrite\(/);
  assert.match(japan, /withVaultFileWrite\(/);
  assert.doesNotMatch(japan, /createWriteService/);
  for (const relative of SKIP_VAULT_GATE) {
    const source = await readSource(relative);
    assert.doesNotMatch(source, /withVaultFileWrite\(/, relative);
  }
  const schedule = await readSource("../src/pages/SchedulePage.tsx");
  const video = await readSource("../src/pages/tools/VideoLibraryView.tsx");
  const food = await readSource("../src/pages/tools/FoodMapView.tsx");
  assert.doesNotMatch(schedule, /\/api\/write\/preview/);
  assert.doesNotMatch(video, /\/api\/write\/preview/);
  assert.doesNotMatch(food, /\/api\/write\/preview/);
});

test("home pins, gantt hide, task follow and Japanese mistake state reject symlink targets", async (t) => {
  const linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "infans-dedicated-guard-"));
  t.after(() => fs.rm(linkedRoot, { recursive: true, force: true }));
  const outside = path.join(linkedRoot, "outside.json");
  await fs.writeFile(outside, "{\"topicIds\":[]}\n", "utf8");

  async function plant(relative) {
    const absolute = path.join(linkedRoot, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.symlink(outside, absolute);
  }

  await plant(HOME_PINS_PATH);
  await plant(GANTT_HIDDEN_PATH);
  await plant(PROJECT_TASK_FOLLOWS_PATH);
  await plant(JP_MISTAKE_STATE);

  await assert.rejects(
    writeHomePins(linkedRoot, { topicIds: ["zztj"] }),
    (error) => error instanceof WorkbenchWriteError && error.code === "PATH_SYMLINK_FORBIDDEN",
  );
  await assert.rejects(
    writeGanttHidden(linkedRoot, { texts: ["hidden"] }),
    (error) => error instanceof WorkbenchWriteError && error.code === "PATH_SYMLINK_FORBIDDEN",
  );
  await assert.rejects(
    writeProjectTaskFollow(linkedRoot, { taskKey: "game-a:task-1", followed: true }),
    (error) => error instanceof WorkbenchWriteError && error.code === "PATH_SYMLINK_FORBIDDEN",
  );
  await assert.rejects(
    saveMistakeState(linkedRoot, { items: {} }),
    (error) => error instanceof WorkbenchWriteError && error.code === "PATH_SYMLINK_FORBIDDEN",
  );
});

test("dedicated notebook writes still persist without preview tokens", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-dedicated-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pins = await writeHomePins(root, { topicIds: ["zztj"] });
  assert.deepEqual(pins.topicIds, ["zztj"]);
  const hidden = await writeGanttHidden(root, { texts: ["约会"] });
  assert.deepEqual(hidden.texts, ["约会"]);
  const follows = await writeProjectTaskFollow(root, { taskKey: "game-a:task-1", followed: true });
  assert.deepEqual(follows.taskKeys, ["game-a:task-1"]);
  await saveMistakeState(root, { items: { "N2:grammar:x": { streak: 0, status: "active" } } });
  const saved = JSON.parse(await fs.readFile(path.join(root, JP_MISTAKE_STATE), "utf8"));
  assert.equal(saved.items["N2:grammar:x"].status, "active");
  const preferences = createPreferencesService(root, { backgrounds: async () => [] });
  const first = await preferences.write({
    action: "update-device",
    expectedRevision: 0,
    deviceId: "device-desktop-a",
  });
  assert.equal(first.state.revision, 1);
});
