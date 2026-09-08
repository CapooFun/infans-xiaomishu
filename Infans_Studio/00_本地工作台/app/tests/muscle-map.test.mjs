import assert from "node:assert/strict";
import test from "node:test";
import { buildMuscleStates } from "../src/muscle-map.ts";

test("buildMuscleStates classifies recovery from training hits", () => {
  const states = buildMuscleStates(
    [
      {
        date: "2026-07-22",
        title: "热身",
        status: "ok",
        exercises: [
          { name: "杠铃卧推", topSet: "60 kg×12×2" },
          { name: "划船", topSet: "40×12×4" },
          { name: "保加利亚分腿蹲", topSet: "28 kg×12×3" },
        ],
      },
      {
        date: "2026-06-11",
        title: "上肢",
        status: "ok",
        exercises: [{ name: "龙门架侧平举", topSet: "轻" }],
      },
    ],
    "2026-08-01",
  );

  const byId = Object.fromEntries(states.map((item) => [item.id, item]));
  assert.equal(byId.chest.status, "overdue");
  assert.equal(byId.chest.daysSince, 10);
  assert.equal(byId.back.status, "overdue");
  assert.equal(byId.quads.status, "due");
  assert.equal(byId.shoulders.status, "overdue");
  assert.equal(byId.arms.status, "unknown");
  assert.equal(byId.core.status, "unknown");
  assert.match(byId.chest.hits[0].exercise, /卧推/);
});

test("buildMuscleStates marks recovering within recovery window", () => {
  const states = buildMuscleStates(
    [{ date: "2026-07-31", title: "上肢", status: "ok", exercises: [{ name: "杠铃卧推", topSet: "55×8" }] }],
    "2026-08-01",
  );
  assert.equal(states.find((item) => item.id === "chest")?.status, "recovering");
});

test("toMuscleMapValues maps zones onto MuscleMap groups", async () => {
  const { buildMuscleStates, toMuscleMapValues } = await import("../src/muscle-map.ts");
  const values = toMuscleMapValues(buildMuscleStates(
    [{ date: "2026-07-22", title: "t", status: "ok", exercises: [{ name: "杠铃卧推", topSet: "60" }] }],
    "2026-08-01",
  ));
  assert.equal(values.CHEST?.score, 50);
  assert.ok(values.LATS);
});

test("exercise recommendations expose local media ids", async () => {
  const { zoneById, exerciseMediaUrls } = await import("../src/muscle-map.ts");
  const chest = zoneById("chest").recommendations[0];
  assert.equal(chest?.mediaId, "0025-EIeI8Vf");
  assert.equal(exerciseMediaUrls(chest.mediaId).gif, "/api/exercises/0025-EIeI8Vf.gif");
});

test("paintColorForMuscleLabel follows safety-first discrete colors", async () => {
  const { buildMuscleStates, buildPartGroupIndex, paintColorForMuscleLabel, STATUS_COLORS } = await import("../src/muscle-map.ts");
  const { MUSCLE_GROUP_PARTS } = await import("@musclemap/assets");
  const states = buildMuscleStates(
    [{ date: "2026-07-31", title: "t", status: "ok", exercises: [{ name: "杠铃卧推", topSet: "55" }] }],
    "2026-08-01",
  );
  const index = buildPartGroupIndex(MUSCLE_GROUP_PARTS);
  assert.equal(paintColorForMuscleLabel("CHEST", states, index), STATUS_COLORS.recovering);
  assert.equal(paintColorForMuscleLabel("LATS", states, index), STATUS_COLORS.unknown);
});
