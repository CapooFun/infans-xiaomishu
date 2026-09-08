import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { deriveSchoolRestDays } from "../src/server/workbench-rest-days.mjs";

test("休息日只从周末、公休和明示请假派生，普通上课日不误报", () => {
  const dates = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-15"];
  const calendar = {
    available: true,
    events: [
      { calendar: "Holidays in Japan", title: "山の日", start: "2026-08-11T00:00:00+09:00", end: "2026-08-12T00:00:00+09:00", holiday: true },
      { calendar: "个人", title: "语言学校请假", start: "2026-08-13T09:00:00+09:00", end: "2026-08-13T12:00:00+09:00" },
    ],
  };
  const result = new Map(deriveSchoolRestDays(dates, calendar).map((day) => [day.date, day]));
  assert.equal(result.get("2026-08-10").restDay, false, "普通上课日不能因日历空白误报");
  assert.deepEqual(result.get("2026-08-11").restReasons, ["public-holiday"]);
  assert.equal(result.get("2026-08-12").restDay, false);
  assert.deepEqual(result.get("2026-08-13").restReasons, ["leave"]);
  assert.deepEqual(result.get("2026-08-15").restReasons, ["weekend"]);
});

test("训练与休息使用独立结构字段，同日可保留双标记", async () => {
  const source = await fs.readFile(new URL("../src/pages/MindPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /day\.trained \? "is-trained"/u);
  assert.match(source, /day\.restDay \? "is-rest"/u);
  assert.match(source, /黄＝训练日/u);
  assert.match(source, /绿＝休息日/u);
});
