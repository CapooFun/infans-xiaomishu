import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

const vaultRoot = resolve(import.meta.dirname, "../../..");
const shadowRoot = resolve(vaultRoot, "40_身心健康/心理/双AI影子评估")
const completeDates = [
  "2026-08-16",
  "2026-08-17",
  "2026-08-18",
  "2026-08-19",
  "2026-08-20",
  "2026-08-21",
  "2026-08-22",
]
const cursorOnlyDates = ["2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26"]
const fileDates = (directory) => readdirSync(resolve(shadowRoot, directory))
  .filter((name) => /^20\d{2}-\d{2}-\d{2}\.md$/.test(name))
  .map((name) => name.slice(0, -3))
  .sort()
const gptDates = fileDates("GPT候选")
const closeoutDates = fileDates("收口")
const resumedDates = gptDates.filter((date) => date >= "2026-08-27")

function read(relativePath) {
  return readFileSync(resolve(shadowRoot, relativePath), "utf8")
}

test("shadow backfill keeps complete early candidates and declared later GPT gaps", () => {
  assert.deepEqual(gptDates.slice(0, completeDates.length), completeDates)
  assert.ok(cursorOnlyDates.every((date) => !gptDates.includes(date)))
  assert.deepEqual(fileDates("Cursor候选"), closeoutDates)
  assert.deepEqual(closeoutDates, [...completeDates, ...cursorOnlyDates, ...resumedDates])
})

test("GPT backfill preserves genuinely empty days and later formal candidates", () => {
  for (const date of completeDates.slice(0, 4)) {
    const source = read(`GPT候选/${date}.md`)
    assert.match(source, /writer: gpt/)
    assert.match(source, /状态为 `empty`/)
    assert.match(source, /自主／胜任／联结／好时光／整体平衡：\*\*暂不判断\*\*/)
    assert.match(source, /不得借用 Cursor 或日记补写/)
    assert.doesNotMatch(source, /工作强度 \d|恢复：|git commit|提交 \d/iu)
  }
  for (const date of completeDates.slice(4)) {
    const source = read(`GPT候选/${date}.md`)
    assert.match(source, /writer: gpt/)
    assert.match(source, /体验线索/)
    assert.match(source, /初步判断/)
    assert.match(source, /边界：/)
  }
})

test("Cursor candidates and closeouts expose provenance, judgments and dedup reasoning", () => {
  for (const date of closeoutDates) {
    const candidate = read(`Cursor候选/${date}.md`)
    const closeout = read(`收口/${date}.md`)
    assert.match(candidate, /writer: cursor/)
    assert.match(candidate, /来源：/)
    assert.match(candidate, /胜任：\*\*初步判断(?:（[^）]+）)?\*\*/)
    assert.match(candidate, /好时光[^\n]*\*\*(?:暂不判断|初步判断(?:（[^）]+）)?)\*\*/)
    assert.match(closeout, /writer: cursor-closeout/)
    assert.match(closeout, /(?:同一事实：|## 事实去重)/)
    assert.match(closeout, /(?:分领域话语权：|## 分领域收口|## 冲突与话语权)/)
    assert.match(closeout, /(?:最终：|## 分领域收口)/)
    assert.match(closeout, /(?:冲突：|## 冲突与话语权)/)
  }
})

test("user entry states the current coverage, declared GPT gaps and shadow-only boundary", () => {
  const entry = read("当前影子评估.md")
  const latestDate = closeoutDates.at(-1)
  const previousDate = closeoutDates.at(-2)
  assert.match(entry, new RegExp(`最新评估日：\\*\\*${latestDate}\\*\\*`))
  assert.match(entry, new RegExp(`历史回补仍保留：\\*\\*2026-08-16 至 ${previousDate}\\*\\*`))
  assert.match(entry, /8\/23 至 8\/26 连续四天 GPT 候选未生成/)
  assert.match(entry, /不是正式 BPNSFS、好时光或页面分数/)
  for (const date of completeDates) {
    assert.match(entry, new RegExp(`${date}.*GPT候选/${date}.*Cursor候选/${date}.*收口/${date}`))
  }
  for (const date of cursorOnlyDates) {
    assert.match(entry, new RegExp(`${date}.*缺失.*Cursor候选/${date}.*收口/${date}`))
  }
  for (const date of resumedDates) {
    assert.match(entry, new RegExp(`${date}.*GPT候选/${date}.*Cursor候选/${date}.*收口/${date}`))
  }
})

test("daily prompt keeps one formal writer and retires new shadow psychology outputs", () => {
  const promptPath = resolve(vaultRoot, "40_身心健康/状态报告/身心日评_本机定时prompt.md")
  assert.equal(existsSync(promptPath), true)
  const prompt = readFileSync(promptPath, "utf8")
  assert.match(prompt, /唯一正式日评收口者/)
  assert.match(prompt, /当前身心周报/)
  assert.match(prompt, /旧 `双AI影子评估\/`、\[\[当前心理与人生平衡\]\].*停止新增/)
  assert.match(prompt, /不得续写旧心理量表、月度自评、在推进事项或人生设计工具/)
  assert.match(prompt, /Computer History 只用于定位电脑活动候选/)
  assert.match(prompt, /解决过难事.*移到主要成果.*不再进入恢复/)
  assert.doesNotMatch(prompt, /六项均为彼此独立的 `0–10` 或 `未知`/)
})

test("weekly and monthly reports use one redacted Steam aggregate without fake daily precision", () => {
  const dailyPrompt = readFileSync(resolve(vaultRoot, "40_身心健康/状态报告/身心日评_本机定时prompt.md"), "utf8")
  const monthlyPrompt = readFileSync(resolve(vaultRoot, "00_本地工作台/10_设计/定时与自动化/月度总结_本机定时prompt.md"), "utf8")
  for (const prompt of [dailyPrompt, monthlyPrompt]) {
    assert.match(prompt, /steam-recent-summary\.mjs/)
    assert.match(prompt, /API key/)
    assert.match(prompt, /SteamID/)
    assert.match(prompt, /逐日/)
  }
})
