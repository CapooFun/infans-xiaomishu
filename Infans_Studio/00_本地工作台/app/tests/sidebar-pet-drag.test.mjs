import assert from "node:assert/strict";
import test from "node:test";
import {
  createSidebarPetDragController,
  createSidebarVisibilityGate,
  readSidebarPetPosition,
  sidebarPetPixels,
  writeSidebarPetPosition,
} from "../src/sidebar-pet-drag.ts";

const pointer = (clientX, clientY, extras = {}) => ({
  pointerId: 1, isPrimary: true, button: 0, clientX, clientY,
  viewportWidth: 1024, viewportHeight: 768, ...extras,
});

test("轻点恢复侧栏，拖动后只保存位置且不会误恢复", () => {
  const calls = [];
  const controller = createSidebarPetDragController({
    onActivate: () => calls.push("restore"),
    onMove: (position) => calls.push(["move", position]),
    onCommit: (position) => calls.push(["commit", position]),
  });
  controller.pointerDown(pointer(28, 384));
  controller.pointerUp(pointer(30, 386));
  assert.deepEqual(calls, ["restore"]);

  calls.length = 0;
  controller.pointerDown(pointer(28, 384));
  controller.pointerMove(pointer(240, 500));
  controller.pointerUp(pointer(240, 500));
  assert.equal(calls[0][0], "move");
  assert.equal(calls[1][0], "commit");
  assert.equal(calls.includes("restore"), false);
});

test("快速连点头像只改变一次侧栏，冷却后才能再次切换", () => {
  const calls = [];
  let now = 100;
  const changeVisibility = createSidebarVisibilityGate({
    onChange: (hidden) => calls.push(hidden),
    now: () => now,
  });
  assert.equal(changeVisibility(true), true);
  now = 260;
  assert.equal(changeVisibility(false), false);
  now = 580;
  assert.equal(changeVisibility(true), false);
  assert.deepEqual(calls, [true]);
  now = 801;
  assert.equal(changeVisibility(false), true);
  assert.deepEqual(calls, [true, false]);
});

test("保存归一化位置后，旋转与分屏都重新落在可见视口内", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  writeSidebarPetPosition({ x: 0.82, y: 0.73 }, storage);
  const saved = readSidebarPetPosition(storage);
  assert.deepEqual(saved, { x: 0.82, y: 0.73 });
  assert.deepEqual(sidebarPetPixels(saved, 1366, 1024), { left: 1074, top: 707 });
  const split = sidebarPetPixels(saved, 700, 1024);
  assert.ok(split.left >= 0 && split.left <= 644);
  assert.ok(split.top >= 0 && split.top <= 968);
});
