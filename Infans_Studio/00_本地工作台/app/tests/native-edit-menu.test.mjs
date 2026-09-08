import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nativeSourceUrl = new URL("../native/SecretaryApp.swift", import.meta.url);

test("native workbench exposes standard macOS editing commands to the WKWebView responder chain", async () => {
  const source = await readFile(nativeSourceUrl, "utf8");

  assert.match(source, /let editMenu = NSMenu\(title: "编辑"\)/u);
  assert.match(source, /item\.target = nil/u);
  assert.match(source, /addResponderItem\("撤销", action: Selector\(\("undo:"\)\), key: "z"\)/u);
  assert.match(source, /addResponderItem\("重做", action: Selector\(\("redo:"\)\), key: "z", modifiers: \[\.command, \.shift\]\)/u);
  assert.match(source, /addResponderItem\("剪切", action: #selector\(NSText\.cut\(_:\)\), key: "x"\)/u);
  assert.match(source, /addResponderItem\("复制", action: #selector\(NSText\.copy\(_:\)\), key: "c"\)/u);
  assert.match(source, /addResponderItem\("粘贴", action: #selector\(NSText\.paste\(_:\)\), key: "v"\)/u);
  assert.match(source, /addResponderItem\("全选", action: #selector\(NSText\.selectAll\(_:\)\), key: "a"\)/u);
});

test("native workbench forwards global Command shortcuts to the shared web command bridge", async () => {
  const source = await readFile(nativeSourceUrl, "utf8");

  assert.match(source, /let navigationMenu = NSMenu\(title: "导航"\)/u);
  assert.match(source, /for slot in 1\.\.\.6/u);
  assert.match(source, /command: "bookmark-\\\(slot\)"/u);
  assert.match(source, /command: "history-back"/u);
  assert.match(source, /command: "history-forward"/u);
  assert.match(source, /command: "toggle-sidebar"/u);
  assert.doesNotMatch(source, /enable-display-mode|开启展示模式/u);
  assert.match(source, /CustomEvent\('infans:workbench-shortcut'/u);
  assert.doesNotMatch(source, /disable-display-mode/u);
});
