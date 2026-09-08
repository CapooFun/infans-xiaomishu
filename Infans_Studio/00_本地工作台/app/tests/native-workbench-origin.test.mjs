import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nativeSourceUrl = new URL("../native/SecretaryApp.swift", import.meta.url);

test("native workbench uses localhost so WebAuthn is not rejected only because of the 127 origin", async () => {
  const source = await readFile(nativeSourceUrl, "utf8");

  assert.match(source, /private let workbenchURL = URL\(string: "http:\/\/localhost:5173\/"\)!/u);
  assert.match(source, /private let healthURL = URL\(string: "http:\/\/127\.0\.0\.1:5173\/api\/health"\)!/u);
});

test("native origin migration preserves display mode before revealing localhost", async () => {
  const source = await readFile(nativeSourceUrl, "utf8");

  assert.match(source, /private let legacyWorkbenchURL = URL\(string: "http:\/\/127\.0\.0\.1:5173\/"\)!/u);
  assert.match(source, /webView\.isHidden = true[\s\S]*webView\.load\(URLRequest\(url: legacyWorkbenchURL\)\)/u);
  assert.match(source, /return JSON\.stringify\(\{ local: copy\(localStorage\), session: copy\(sessionStorage\) \}\)/u);
  assert.match(source, /atob\("\\\(encoded\)"\)/u);
  assert.match(source, /if \(key === "\\\(displayModeStorageKey\)"\)/u);
  assert.match(source, /if \(current === "on" \|\| value === "on"\) storage\.setItem\(key, "on"\)/u);
  assert.match(source, /WKUserScript\(source: source, injectionTime: \.atDocumentStart, forMainFrameOnly: true\)/u);
  assert.match(source, /UserDefaults\.standard\.set\(true, forKey: workbenchOriginMigrationKey\)[\s\S]*webView\.isHidden = false/u);
  assert.match(source, /legacy origin unavailable; preserving display mode/u);
});
