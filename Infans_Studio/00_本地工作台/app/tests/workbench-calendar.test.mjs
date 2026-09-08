import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCalendarWriteService,
  invalidateAppleCalendarCache,
  isCreatableEventCalendar,
  isEditableWorkCalendar,
  preferredEventCalendar,
  readAppleCalendar as readCalendar,
  readDiskCalendarSnapshot,
  resolveCreatableEventCalendar,
} from "../src/server/workbench-calendar.mjs";

// Reuse command-shaped fixture builders while exercising the native snapshot reader API.
function readAppleCalendar(from, to, options = {}) {
  const { runner, ...rest } = options;
  return readCalendar(from, to, {
    osEnabled: true,
    ...rest,
    ...(runner ? { reader: async () => {
      const { stdout } = await runner();
      return { available: true, permission: "granted", backend: "eventkit", ...JSON.parse(stdout) };
    } } : {}),
  });
}

async function withTempCache(run) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-cal-cache-"));
  try {
    await invalidateAppleCalendarCache(cacheDir);
    return await run(cacheDir);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
    await invalidateAppleCalendarCache(cacheDir);
  }
}

function mockEvents(title = "事项") {
  return {
    calendars: ["个人"],
    events: [{ id: "e1", calendar: "个人", title, start: "2026-08-01T00:00:00.000Z", end: "2026-08-01T01:00:00.000Z", allDay: false, recurring: false, editable: true }],
  };
}

test("calendar display policy keeps every editable calendar except birthdays and holidays", () => {
  assert.equal(isEditableWorkCalendar("个人", true), true);
  assert.equal(isEditableWorkCalendar("计划的提醒事项", true), true);
  assert.equal(isEditableWorkCalendar("Google", true), true);
  assert.equal(isEditableWorkCalendar("工作", true), true);
  assert.equal(isEditableWorkCalendar("生日", true), false);
  assert.equal(isEditableWorkCalendar("Birthdays", true), false);
  assert.equal(isEditableWorkCalendar("中国大陆节假日", true), false);
  assert.equal(isEditableWorkCalendar("Holidays in Japan", true), false);
  assert.equal(isEditableWorkCalendar("个人", false), false);
});

test("creatable event calendars exclude reminder lists and prefer 个人", () => {
  assert.equal(isCreatableEventCalendar("个人"), true);
  assert.equal(isCreatableEventCalendar("计划的提醒事项"), false);
  assert.equal(preferredEventCalendar(["工作", "计划的提醒事项", "个人"]), "个人");
  assert.equal(resolveCreatableEventCalendar("计划的提醒事项", ["工作", "个人", "计划的提醒事项"]), "个人");
  assert.equal(resolveCreatableEventCalendar("工作", ["工作", "个人"]), "工作");
});

test("calendar create rejects reminder calendar lists before JXA", () => {
  const service = createCalendarWriteService({ osEnabled: true, cacheDir: "/tmp/infans-cal-unused" });
  assert.throws(
    () => service.preview({ kind: "create", calendar: "计划的提醒事项", title: "喝水", start: "2026-08-01T09:00:00+09:00", end: "2026-08-01T09:15:00+09:00" }),
    /普通日历|提醒事项/,
  );
});

test("Apple Calendar read sorts events and preserves all-day and recurring flags", async () => {
  await withTempCache(async (cacheDir) => {
    const runner = async () => ({ stdout: JSON.stringify({ calendars: ["个人"], events: [
      { id: "later", calendar: "个人", title: "第二件事", start: "2026-08-01T03:00:00.000Z", end: "2026-08-01T04:00:00.000Z", allDay: false, recurring: true, editable: false },
      { id: "first", calendar: "个人", title: "全天事项", start: "2026-08-01T00:00:00.000Z", end: "2026-08-02T00:00:00.000Z", allDay: true, recurring: false, editable: true },
    ] }) });
    const result = await readAppleCalendar(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-08T00:00:00Z"), { runner, cacheDir });
    assert.equal(result.available, true);
    assert.equal(result.events[0].id, "first");
    assert.equal(result.events[0].allDay, true);
    assert.equal(result.events[1].editable, false);
    assert.equal(result.backend, "eventkit");
    assert.equal(result.stale, false);
  });
});

test("日历读取保留只读日本公休事件，但不把公休日历暴露为可写目标", async () => {
  await withTempCache(async (cacheDir) => {
    const runner = async () => ({ stdout: JSON.stringify({
      calendars: ["个人"],
      events: [{ id: "holiday", calendar: "Holidays in Japan", title: "山の日", start: "2026-08-11T00:00:00.000+09:00", end: "2026-08-12T00:00:00.000+09:00", allDay: true, recurring: false, editable: false, holiday: true }],
    }) });
    const result = await readAppleCalendar(new Date("2026-08-10T15:00:00Z"), new Date("2026-08-12T15:00:00Z"), { runner, cacheDir });
    assert.deepEqual(result.calendars, ["个人"]);
    assert.equal(result.events[0].holiday, true);
    assert.equal(result.events[0].editable, false);
  });
});

test("Apple Calendar permission denial degrades without affecting other modules", async () => {
  await withTempCache(async (cacheDir) => {
    const runner = async () => { const error = new Error("Not authorized to send Apple events. (-1743)"); error.stderr = "permission denied"; throw error; };
    const result = await readAppleCalendar(new Date(), new Date(Date.now() + 86_400_000), { runner, cacheDir });
    assert.equal(result.available, false);
    assert.equal(result.permission, "denied");
    assert.equal(result.events.length, 0);
  });
});

test("successful calendar read persists to disk with mode 0600", async () => {
  await withTempCache(async (cacheDir) => {
    const runner = async () => ({ stdout: JSON.stringify(mockEvents("落盘")) });
    const from = new Date("2026-08-01T00:00:00Z");
    const to = new Date("2026-08-09T00:00:00Z");
    await readAppleCalendar(from, to, { runner, cacheDir });
    const disk = await readDiskCalendarSnapshot(cacheDir);
    assert.equal(disk.value.events[0].title, "落盘");
    const stat = await fs.stat(path.join(cacheDir, "calendar-window.json"));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("same Tokyo day disk cache returns without calling runner again", async () => {
  await withTempCache(async (cacheDir) => {
    const from = new Date("2026-08-01T15:00:00Z"); // 东京 8/2 00:00
    const to = new Date("2026-08-09T15:00:00Z");
    const now = new Date("2026-08-02T03:00:00Z"); // 东京 8/2 12:00
    await readAppleCalendar(from, to, {
      runner: async () => ({ stdout: JSON.stringify(mockEvents("当日首读")) }),
      cacheDir,
      now,
    });

    let calls = 0;
    const again = await readAppleCalendar(from, to, {
      runner: async () => {
        calls += 1;
        return { stdout: JSON.stringify(mockEvents("不应调用")) };
      },
      cacheDir,
      now: new Date("2026-08-02T10:00:00Z"),
    });
    assert.equal(again.events[0].title, "当日首读");
    assert.equal(again.stale, false);
    assert.equal(again.stale, false);
    assert.equal(calls, 0);
  });
});

test("optional calendar read returns unknown before a stalled cold read, then reuses its saved result", async () => {
  await withTempCache(async (cacheDir) => {
    const from = new Date("2026-08-01T15:00:00Z");
    const to = new Date("2026-08-09T15:00:00Z");
    const now = new Date("2026-08-02T03:00:00Z");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const runner = async () => {
      calls += 1;
      await gate;
      return { stdout: JSON.stringify(mockEvents("恢复读取")) };
    };
    try {
      const result = await readAppleCalendar(from, to, { runner, cacheDir, now, maxWaitMs: 10 });
      assert.equal(result.available, false);
      assert.equal(result.permission, "unknown");
      assert.equal(result.stale, true);
      assert.deepEqual(result.events, []);
      assert.equal(await readDiskCalendarSnapshot(cacheDir), null);

      // 另一时间窗交错读取后，重试同一时间窗也不能重复拉起 JXA。
      await readAppleCalendar(from, new Date("2026-08-10T15:00:00Z"), { runner, cacheDir, now, maxWaitMs: 10 });
      await readAppleCalendar(from, to, { runner, cacheDir, now, maxWaitMs: 10 });
      assert.equal(calls, 2);
    } finally {
      release();
      await Promise.all([
        readAppleCalendar(from, to, { runner, cacheDir, now, force: true, maxWaitMs: 0 }),
        readAppleCalendar(from, new Date("2026-08-10T15:00:00Z"), { runner, cacheDir, now, force: true }),
      ]);
    }
    const fresh = await readAppleCalendar(from, to, { runner, cacheDir, now, maxWaitMs: 0 });
    assert.equal(fresh.available, true);
    assert.equal(fresh.events[0].title, "恢复读取");
    assert.equal(calls, 2);
  });
});

test("optional calendar reads preserve fast success and actual permission denial", async () => {
  await withTempCache(async (cacheDir) => {
    const from = new Date("2026-08-01T00:00:00Z");
    const to = new Date("2026-08-09T00:00:00Z");
    const denied = await readAppleCalendar(from, to, {
      runner: async () => { throw new Error("Not authorized (-1743)"); }, cacheDir, maxWaitMs: 1000,
    });
    assert.equal(denied.permission, "denied");
    assert.equal(denied.available, false);
    const success = await readAppleCalendar(from, to, {
      runner: async () => ({ stdout: JSON.stringify(mockEvents()) }), cacheDir, maxWaitMs: 1000,
    });
    assert.equal(success.available, true);
    assert.equal(success.events.length, 1);
    assert.equal(success.stale, false);
  });
});

test("force=true ignores same-day cache and sync-reads", async () => {
  await withTempCache(async (cacheDir) => {
    const from = new Date("2026-08-01T15:00:00Z");
    const to = new Date("2026-08-09T15:00:00Z");
    const now = new Date("2026-08-02T03:00:00Z");
    await readAppleCalendar(from, to, {
      runner: async () => ({ stdout: JSON.stringify(mockEvents("旧快照")) }),
      cacheDir,
      now,
    });

    const forced = await readAppleCalendar(from, to, {
      runner: async () => ({ stdout: JSON.stringify(mockEvents("手动同步")) }),
      cacheDir,
      now,
      force: true,
    });
    assert.equal(forced.events[0].title, "手动同步");
    assert.equal(forced.stale, false);
    assert.equal(forced.stale, false);
  });
});

test("cross-day read serves stale cache immediately and refreshes in background", async () => {
  await withTempCache(async (cacheDir) => {
    const day1From = new Date("2026-08-01T15:00:00Z");
    const day1To = new Date("2026-08-09T15:00:00Z");
    await readAppleCalendar(day1From, day1To, {
      runner: async () => ({ stdout: JSON.stringify(mockEvents("昨天")) }),
      cacheDir,
      now: new Date("2026-08-02T03:00:00Z"),
    });

    const day2From = new Date("2026-08-02T15:00:00Z");
    const day2To = new Date("2026-08-10T15:00:00Z");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const slowRunner = async () => {
      calls += 1;
      await gate;
      return { stdout: JSON.stringify(mockEvents("跨日后")) };
    };

    const stale = await readAppleCalendar(day2From, day2To, {
      runner: slowRunner,
      cacheDir,
      now: new Date("2026-08-03T03:00:00Z"),
    });
    assert.equal(stale.events[0].title, "昨天");
    assert.equal(stale.stale, true);
    assert.equal(calls, 1);

    const pending = readAppleCalendar(day2From, day2To, {
      runner: slowRunner,
      cacheDir,
      now: new Date("2026-08-03T03:00:00Z"),
      force: true,
    });
    release();
    const fresh = await pending;
    assert.equal(fresh.events[0].title, "跨日后");
    assert.equal(fresh.stale, false);
    assert.equal(calls, 1);
    const disk = await readDiskCalendarSnapshot(cacheDir);
    assert.equal(disk.from, day2From.toISOString());
  });
});

test("cross-day background refresh failure keeps previous disk snapshot", async () => {
  await withTempCache(async (cacheDir) => {
    const day1From = new Date("2026-08-01T15:00:00Z");
    const day1To = new Date("2026-08-09T15:00:00Z");
    await readAppleCalendar(day1From, day1To, {
      runner: async () => ({ stdout: JSON.stringify(mockEvents("保留跨日")) }),
      cacheDir,
      now: new Date("2026-08-02T03:00:00Z"),
    });

    const day2From = new Date("2026-08-02T15:00:00Z");
    const day2To = new Date("2026-08-10T15:00:00Z");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const failing = async () => {
      await gate;
      throw new Error("calendar boom");
    };

    const stale = await readAppleCalendar(day2From, day2To, {
      runner: failing,
      cacheDir,
      now: new Date("2026-08-03T03:00:00Z"),
    });
    assert.equal(stale.available, true);
    assert.equal(stale.stale, true);

    const pending = readAppleCalendar(day2From, day2To, {
      runner: failing,
      cacheDir,
      now: new Date("2026-08-03T03:00:00Z"),
      force: true,
    });
    release();
    const forced = await pending;
    assert.equal(forced.available, false);

    const again = await readAppleCalendar(day2From, day2To, {
      runner: async () => { throw new Error("still down"); },
      cacheDir,
      now: new Date("2026-08-03T04:00:00Z"),
    });
    assert.equal(again.available, true);
    assert.equal(again.events[0].title, "保留跨日");
    assert.equal(again.stale, true);
  });
});

test("native read failure returns immediately and the next request can recover", async () => {
  await withTempCache(async (cacheDir) => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary calendar glitch");
      return { stdout: JSON.stringify(mockEvents("重试成功")) };
    };
    const result = await readAppleCalendar(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-09T00:00:00Z"), {
      runner,
      cacheDir,
    });
    assert.equal(result.available, false);
    assert.equal(calls, 1);
    const recovered = await readAppleCalendar(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-09T00:00:00Z"), { runner, cacheDir });
    assert.equal(recovered.events[0].title, "重试成功");
    assert.equal(calls, 2);
  });
});

test("refresh failure during force keeps previous disk snapshot on next non-force read", async () => {
  await withTempCache(async (cacheDir) => {
    const from = new Date("2026-08-01T15:00:00Z");
    const to = new Date("2026-08-09T15:00:00Z");
    const now = new Date("2026-08-02T03:00:00Z");
    await readAppleCalendar(from, to, {
      runner: async () => ({ stdout: JSON.stringify(mockEvents("保留")) }),
      cacheDir,
      now,
    });

    const failing = async () => { throw new Error("calendar boom"); };
    const forced = await readAppleCalendar(from, to, { runner: failing, cacheDir, now, force: true });
    assert.equal(forced.available, false);

    const again = await readAppleCalendar(from, to, {
      runner: failing,
      cacheDir,
      now: new Date("2026-08-02T10:00:00Z"),
    });
    assert.equal(again.available, true);
    assert.equal(again.events[0].title, "保留");
  });
});

test("concurrent same-window sync reads share one runner call", async () => {
  await withTempCache(async (cacheDir) => {
    const from = new Date("2026-08-01T15:00:00Z");
    const to = new Date("2026-08-09T15:00:00Z");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const slowRunner = async () => {
      calls += 1;
      await gate;
      return { stdout: JSON.stringify(mockEvents("合并")) };
    };

    const first = readAppleCalendar(from, to, { runner: slowRunner, cacheDir, now: new Date("2026-08-02T03:00:00Z") });
    const second = readAppleCalendar(from, to, { runner: slowRunner, cacheDir, now: new Date("2026-08-02T03:00:00Z") });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.events[0].title, "合并");
    assert.equal(b.events[0].title, "合并");
    assert.equal(calls, 1);
  });
});

test("corrupt cache schema is discarded and rebuilt", async () => {
  await withTempCache(async (cacheDir) => {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "calendar-window.json"), '{"schemaVersion":999}\n', { mode: 0o600 });
    const result = await readAppleCalendar(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-09T00:00:00Z"), {
      runner: async () => ({ stdout: JSON.stringify(mockEvents("重建")) }),
      cacheDir,
    });
    assert.equal(result.events[0].title, "重建");
    const disk = await readDiskCalendarSnapshot(cacheDir);
    assert.equal(disk.schemaVersion, 1);
  });
});

test("write invalidation preserves last success and refreshes without blanking the page", async () => {
  await withTempCache(async (cacheDir) => {
    const from = new Date("2026-08-01T00:00:00Z");
    const to = new Date("2026-08-09T00:00:00Z");
    await readAppleCalendar(from, to, { runner: async () => ({ stdout: JSON.stringify(mockEvents("保留旧快照")) }), cacheDir });
    await invalidateAppleCalendarCache(cacheDir);
    const disk = await readDiskCalendarSnapshot(cacheDir);
    assert.equal(disk.invalidated, true);
    assert.equal(disk.value.events[0].title, "保留旧快照");
    const runner = async () => ({ stdout: JSON.stringify(mockEvents("写入后刷新")) });
    const old = await readAppleCalendar(from, to, { runner, cacheDir });
    assert.equal(old.stale, true);
    assert.equal(old.events[0].title, "保留旧快照");
    const fresh = await readAppleCalendar(from, to, { runner, cacheDir, force: true });
    assert.equal(fresh.events[0].title, "写入后刷新");
    assert.equal((await readDiskCalendarSnapshot(cacheDir)).invalidated, undefined);
  });
});

test("calendar mutations require preview and reject stale tokens", async () => {
  let now = Date.parse("2026-07-31T10:00:00Z");
  const calls = [];
  await withTempCache(async (cacheDir) => {
    const service = createCalendarWriteService({ now: () => now, runner: async (script) => { calls.push(script); return { stdout: '{"ok":true,"id":"created"}' }; }, cacheDir, osEnabled: true });
    const preview = service.preview({ kind: "create", calendar: "个人", title: "日语复习", start: "2026-08-01T09:00:00+09:00", end: "2026-08-01T10:00:00+09:00" });
    assert.equal(preview.summary, "新建日程");
    assert.equal(calls.length, 0);
    const committed = await service.commit(preview.token);
    assert.equal(committed.id, "created");
    assert.equal(calls.length, 1);
    const expired = service.preview({ kind: "delete", id: "e1", expected: mockEvents().events[0] });
    now += 11 * 60 * 1000;
    await assert.rejects(() => service.commit(expired.token), /预览已过期/);
  });
});

test("calendar rejects invalid and incomplete changes", () => {
  const service = createCalendarWriteService({ osEnabled: true, cacheDir: "/tmp/infans-cal-unused" });
  assert.throws(() => service.preview({ kind: "create", calendar: "个人", title: "倒置时间", start: "2026-08-01T11:00:00+09:00", end: "2026-08-01T10:00:00+09:00" }), /结束时间/);
  assert.throws(() => service.preview({ kind: "update", title: "缺少 UID" }), /不能为空|标识缺失/);
});
