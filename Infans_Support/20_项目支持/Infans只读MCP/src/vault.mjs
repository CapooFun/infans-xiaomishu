import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertSafeContent } from "./content-policy.mjs";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  PDF_EXTENSION,
  TEXT_EXTENSIONS,
  isExcludedComponent,
  isExcludedFileName,
  isSupportedFileName,
  isTextFileName,
} from "./config.mjs";
import { VaultError } from "./errors.mjs";
import { extractPdfPages } from "./pdf.mjs";

function normalizeRelative(input = "") {
  const raw = String(input || "").normalize("NFC");
  if (path.isAbsolute(raw)) throw new VaultError("ABSOLUTE_PATH_DENIED", "Only Vault-relative paths are allowed.");
  const normalized = path.normalize(raw || ".");
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new VaultError("PATH_ESCAPE_DENIED", "The requested path leaves the Vault.");
  }
  return normalized === "." ? "" : normalized;
}

function checkComponents(relativePath) {
  const components = relativePath.split(path.sep).filter(Boolean);
  for (const component of components) {
    if (isExcludedComponent(component)) {
      throw new VaultError("EXCLUDED_PATH", "This path is excluded from the read-only Vault service.");
    }
  }
  for (const component of components.slice(0, -1)) {
    if (isExcludedFileName(component)) throw new VaultError("EXCLUDED_PATH", "Credential-related paths are excluded.");
  }
  const name = components.at(-1);
  if (name && isExcludedFileName(name)) {
    throw new VaultError("EXCLUDED_FILE", "This file type is excluded from the read-only Vault service.");
  }
}

async function resolveExisting(config, input = "") {
  const relativePath = normalizeRelative(input);
  checkComponents(relativePath);
  const candidate = path.resolve(config.vaultRoot, relativePath);
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") throw new VaultError("NOT_FOUND", "The requested Vault path does not exist.");
    throw error;
  }
  const relativeReal = path.relative(config.vaultRoot, real);
  if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
    throw new VaultError("SYMLINK_ESCAPE_DENIED", "A symbolic link leaves the Vault and was denied.");
  }
  checkComponents(relativeReal);
  return { absolutePath: real, relativePath: relativeReal || "" };
}

function publicEntry(name, stat) {
  return {
    name,
    type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    size: stat.isFile() ? stat.size : null,
    modifiedAt: stat.mtime.toISOString(),
    readableContent: stat.isFile() ? isSupportedFileName(name) : null,
  };
}

async function safeDirectoryEntries(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries.filter((entry) => {
    if (isExcludedComponent(entry.name) || isExcludedFileName(entry.name)) return false;
    return true;
  });
}

function resolveRipgrepExecutable(config) {
  if (config.rgExecutable === false) return null;
  const candidates = [
    typeof config.rgExecutable === "string" ? config.rgExecutable : null,
    process.env.INFANS_RG_PATH,
    ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, "rg")),
    "/Applications/ChatGPT.app/Contents/Resources/rg",
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep trying deterministic locations; text search has a Node fallback below.
    }
  }
  return null;
}

export function createVaultReader(config) {
  config = { ...config, vaultRoot: realpathSync(config.vaultRoot) };
  const rgExecutable = resolveRipgrepExecutable(config);

  async function info(inputPath) {
    const resolved = await resolveExisting(config, inputPath);
    const stat = await fs.stat(resolved.absolutePath);
    const extension = stat.isFile() ? path.extname(resolved.absolutePath).toLowerCase() : null;
    return {
      path: resolved.relativePath,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.isFile() ? stat.size : null,
      modifiedAt: stat.mtime.toISOString(),
      extension,
      readableContent: stat.isFile() ? isSupportedFileName(resolved.absolutePath) : null,
    };
  }

  async function list(inputPath = "", depth = 1) {
    const safeDepth = Math.max(1, Math.min(Number(depth) || 1, config.limits.directoryDepth));
    const root = await resolveExisting(config, inputPath);
    const rootStat = await fs.stat(root.absolutePath);
    if (!rootStat.isDirectory()) throw new VaultError("NOT_A_DIRECTORY", "The requested Vault path is not a directory.");
    const results = [];

    const visited = new Set();
    async function visit(absoluteDirectory, relativeDirectory, remainingDepth) {
      if (visited.has(absoluteDirectory)) return;
      visited.add(absoluteDirectory);
      if (results.length >= config.limits.directoryEntries) return;
      const entries = await safeDirectoryEntries(absoluteDirectory);
      entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      for (const entry of entries) {
        if (results.length >= config.limits.directoryEntries) break;
        const absoluteEntry = path.join(absoluteDirectory, entry.name);
        let real;
        try {
          real = await fs.realpath(absoluteEntry);
        } catch {
          continue;
        }
        const relativeReal = path.relative(config.vaultRoot, real);
        if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) continue;
        try { checkComponents(relativeReal); } catch { continue; }
        const stat = await fs.stat(real);
        results.push({ path: relativeReal, ...publicEntry(entry.name, stat) });
        if (stat.isDirectory() && remainingDepth > 1) {
          await visit(real, relativeReal, remainingDepth - 1);
        }
      }
    }

    await visit(root.absolutePath, root.relativePath, safeDepth);
    return {
      path: root.relativePath,
      depth: safeDepth,
      entries: results,
      truncated: results.length >= config.limits.directoryEntries,
    };
  }

  async function read(inputPath, options = {}) {
    const resolved = await resolveExisting(config, inputPath);
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) throw new VaultError("NOT_A_FILE", "The requested Vault path is not a file.");
    if (!isSupportedFileName(resolved.absolutePath)) {
      throw new VaultError("UNSUPPORTED_FILE", "This file can be listed, but its content is not supported in version 1.");
    }
    const extension = path.extname(resolved.absolutePath).toLowerCase();
    const maxBytes = extension === PDF_EXTENSION ? config.limits.pdfFileBytes : config.limits.textFileBytes;
    if (stat.size > maxBytes) throw new VaultError("FILE_TOO_LARGE", "The requested file exceeds the safe read limit.");

    if (extension === PDF_EXTENSION) {
      const pageStart = Math.max(1, Number(options.pageStart) || 1);
      const pageCount = Math.max(1, Math.min(Number(options.pageCount) || 5, 20));
      const extracted = await extractPdfPages(resolved.absolutePath, { maxPages: pageStart + pageCount - 1 });
      assertSafeContent(extracted.pages.map((page) => page.text).join("\n"));
      const pages = extracted.pages.filter((page) => page.page >= pageStart).slice(0, pageCount);
      return {
        path: resolved.relativePath,
        type: "pdf",
        modifiedAt: stat.mtime.toISOString(),
        totalPages: extracted.totalPages,
        pageStart,
        pages,
        truncated: pageStart + pages.length - 1 < extracted.totalPages,
      };
    }

    const content = assertSafeContent(await fs.readFile(resolved.absolutePath, "utf8"));
    const sourceHash = createHash("sha256").update(content).digest("hex");
    if (options.lineStart !== undefined) {
      const lines = content.split("\n");
      const lineStart = Math.max(1, Math.trunc(Number(options.lineStart)) || 1);
      const lineCount = Math.max(1, Math.min(Math.trunc(Number(options.lineCount)) || 100, 500));
      const selected = [];
      let used = 0;
      for (const line of lines.slice(lineStart - 1, lineStart - 1 + lineCount)) {
        if (used + line.length + 1 > config.limits.readCharsMax) break;
        selected.push(line); used += line.length + 1;
      }
      if (!selected.length && lineStart <= lines.length) throw new VaultError("LINE_TOO_LONG", "Use character pagination for this line.");
      const nextLine = lineStart + selected.length;
      return { path: resolved.relativePath, type: "text", modifiedAt: stat.mtime.toISOString(), sourceHash,
        lineStart, lineEnd: nextLine - 1, totalLines: lines.length,
        text: selected.join("\n"), truncated: nextLine <= lines.length,
        nextLine: nextLine <= lines.length ? nextLine : null };
    }
    const start = Math.max(0, Number(options.start) || 0);
    const maxChars = Math.max(1, Math.min(Number(options.maxChars) || config.limits.readChars, config.limits.readCharsMax));
    const text = content.slice(start, start + maxChars);
    return {
      path: resolved.relativePath,
      type: "text",
      modifiedAt: stat.mtime.toISOString(),
      start,
      end: start + text.length,
      totalChars: content.length,
      sourceHash,
      text,
      truncated: start + text.length < content.length,
    };
  }

  function rgSearch(query, scope, limit, caseSensitive) {
    if (!rgExecutable) return nodeTextSearch(query, scope, limit, caseSensitive);
    return new Promise((resolve, reject) => {
      const args = [
        "--json",
        "--fixed-strings",
        "--line-number",
        "--max-count",
        String(config.limits.matchesPerFile),
        ...[...TEXT_EXTENSIONS].flatMap((ext) => ["--iglob", `*${ext}`]),
        ...["Dockerfile", "Makefile", ".gitignore", ".gitattributes", ".editorconfig"].flatMap((name) => ["--glob", name]),
        "--max-filesize", String(config.limits.textFileBytes),
        "--glob", "!.git/**",
        "--glob", "!.claude/**",
        "--glob", "!.cursor/**",
        "--glob", "!.codex/**",
        "--glob", "!.agents/**",
        "--glob", "!node_modules/**",
        "--glob", "!**/*.log",
        "--glob", "!**/.env*",
      ];
      if (!caseSensitive) args.push("--ignore-case");
      args.push("--", query, scope.absolutePath);
      const child = spawn(rgExecutable, args, { stdio: ["ignore", "pipe", "pipe"] });
      const deadline = setTimeout(() => {
        child.kill(); reject(new VaultError("SEARCH_LIMIT", "Search time limit reached; narrow the source path."));
      }, 15000);
      let outputBytes = 0;
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 8 * 1024 * 1024) {
          child.kill(); reject(new VaultError("SEARCH_LIMIT", "Search output limit reached; narrow the source path.")); return;
        }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(deadline); reject(error); });
      child.on("close", async (code) => {
        clearTimeout(deadline);
        if (code !== 0 && code !== 1) {
          reject(new VaultError("SEARCH_FAILED", "Vault text search failed."));
          return;
        }
        const matches = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type !== "match") continue;
          const rawPath = event.data.path?.text;
          if (!rawPath) continue;
          const relativePath = path.relative(config.vaultRoot, rawPath);
          let safeLine;
          try {
            const checked = await resolveExisting(config, relativePath);
            const stat = await fs.stat(checked.absolutePath);
            if (!stat.isFile() || stat.size > config.limits.textFileBytes || !isTextFileName(checked.absolutePath)) continue;
            const checkedContent = assertSafeContent(await fs.readFile(checked.absolutePath, "utf8"));
            safeLine = checkedContent.split(/\r?\n/u)[(event.data.line_number || 1) - 1] || "";
            if (!(caseSensitive ? safeLine : safeLine.toLowerCase()).includes(caseSensitive ? query : query.toLowerCase())) continue;
          } catch { continue; }
          const lines = safeLine.trimEnd();
          matches.push({
            path: relativePath,
            line: event.data.line_number || null,
            excerpt: lines.slice(0, 600),
            kind: "text",
          });
          if (matches.length >= limit) break;
        }
        resolve(matches);
      });
    });
  }

  async function nodeTextSearch(query, scope, limit, caseSensitive) {
    const matches = [];
    const needle = caseSensitive ? query : query.toLocaleLowerCase("zh-CN");

    async function searchFile(absoluteFile) {
      if (matches.length >= limit || !isTextFileName(absoluteFile)) return;
      const stat = await fs.stat(absoluteFile);
      if (!stat.isFile() || stat.size > config.limits.textFileBytes) return;
      let content;
      try { content = assertSafeContent(await fs.readFile(absoluteFile, "utf8")); } catch { return; }
      const lines = content.split(/\r?\n/u);
      let perFile = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const haystack = caseSensitive ? line : line.toLocaleLowerCase("zh-CN");
        if (!haystack.includes(needle)) continue;
        matches.push({
          path: path.relative(config.vaultRoot, absoluteFile),
          line: index + 1,
          excerpt: line.slice(0, 600),
          kind: "text",
        });
        perFile += 1;
        if (matches.length >= limit || perFile >= config.limits.matchesPerFile) break;
      }
    }

    const visited = new Set();
    async function visit(absoluteEntry) {
      if (visited.has(absoluteEntry)) return;
      visited.add(absoluteEntry);
      if (matches.length >= limit) return;
      const stat = await fs.stat(absoluteEntry);
      if (stat.isFile()) {
        await searchFile(absoluteEntry);
        return;
      }
      if (!stat.isDirectory()) return;
      const entries = await safeDirectoryEntries(absoluteEntry);
      entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      for (const entry of entries) {
        if (matches.length >= limit) break;
        const candidate = path.join(absoluteEntry, entry.name);
        let real;
        try { real = await fs.realpath(candidate); } catch { continue; }
        const relative = path.relative(config.vaultRoot, real);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        try { checkComponents(relative); } catch { continue; }
        await visit(real);
      }
    }

    await visit(scope.absolutePath);
    return matches;
  }

  async function collectPdfPaths(absoluteDirectory, output, max = 200, visited = new Set()) {
    if (visited.has(absoluteDirectory)) return;
    visited.add(absoluteDirectory);
    if (output.length >= max) return;
    const entries = await safeDirectoryEntries(absoluteDirectory);
    for (const entry of entries) {
      if (output.length >= max) break;
      const absoluteEntry = path.join(absoluteDirectory, entry.name);
      let real;
      try { real = await fs.realpath(absoluteEntry); } catch { continue; }
      const relative = path.relative(config.vaultRoot, real);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      try { checkComponents(relative); } catch { continue; }
      const stat = await fs.stat(real);
      if (stat.isDirectory()) await collectPdfPaths(real, output, max, visited);
      else if (path.extname(real).toLowerCase() === PDF_EXTENSION && stat.size <= config.limits.pdfFileBytes) output.push(real);
    }
  }

  async function pdfSearch(query, scope, remaining, caseSensitive) {
    if (remaining <= 0) return [];
    const pdfPaths = [];
    const stat = await fs.stat(scope.absolutePath);
    if (stat.isFile() && path.extname(scope.absolutePath).toLowerCase() === PDF_EXTENSION) pdfPaths.push(scope.absolutePath);
    else if (stat.isDirectory()) await collectPdfPaths(scope.absolutePath, pdfPaths);
    const needle = caseSensitive ? query : query.toLocaleLowerCase("zh-CN");
    const matches = [];
    for (const pdfPath of pdfPaths) {
      if (matches.length >= remaining) break;
      const extracted = await extractPdfPages(pdfPath, { maxPages: config.limits.pdfSearchPagesPerFile });
      try { assertSafeContent(extracted.pages.map((page) => page.text).join("\n")); } catch { continue; }
      let perFile = 0;
      for (const page of extracted.pages) {
        const haystack = caseSensitive ? page.text : page.text.toLocaleLowerCase("zh-CN");
        const index = haystack.indexOf(needle);
        if (index < 0) continue;
        const start = Math.max(0, index - 120);
        const end = Math.min(page.text.length, index + query.length + 240);
        matches.push({
          path: path.relative(config.vaultRoot, pdfPath),
          page: page.page,
          excerpt: page.text.slice(start, end),
          kind: "pdf",
        });
        perFile += 1;
        if (matches.length >= remaining || perFile >= config.limits.matchesPerFile) break;
      }
    }
    return matches;
  }

  async function search(queryInput, options = {}) {
    const query = String(queryInput || "").trim();
    if (!query) throw new VaultError("EMPTY_QUERY", "A non-empty search query is required.");
    if (query.length > 200) throw new VaultError("QUERY_TOO_LONG", "The search query exceeds 200 characters.");
    const scope = await resolveExisting(config, options.path || "");
    const limit = Math.max(1, Math.min(Number(options.limit) || config.limits.searchResults, config.limits.searchResultsMax));
    const caseSensitive = Boolean(options.caseSensitive);
    const stat = await fs.stat(scope.absolutePath);
    const textMatches = stat.isFile() && !isTextFileName(scope.absolutePath)
      ? []
      : await rgSearch(query, scope, limit, caseSensitive);
    const pdfMatches = await pdfSearch(query, scope, limit - textMatches.length, caseSensitive);
    return {
      scope: scope.relativePath,
      resultCount: textMatches.length + pdfMatches.length,
      results: [...textMatches, ...pdfMatches],
      truncated: textMatches.length + pdfMatches.length >= limit,
    };
  }

  return { info, list, read, search, resolveExisting: (input) => resolveExisting(config, input) };
}
