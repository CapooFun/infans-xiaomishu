import os from "node:os";
import path from "node:path";

export const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".tsv", ".jsonl", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".swift", ".py", ".sh", ".bash", ".zsh", ".css", ".scss", ".html", ".htm", ".xml", ".svg", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".sql", ".gd", ".godot", ".tscn", ".tres", ".cs", ".c", ".h", ".cpp", ".hpp", ".rs", ".go", ".java", ".kt", ".gradle", ".plist", ".entitlements", ".pbxproj", ".xcconfig", ".metal", ".glsl", ".shader", ".gdshader"]);
export const PDF_EXTENSION = ".pdf";
export const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, PDF_EXTENSION]);

export const DEFAULT_LIMITS = Object.freeze({
  directoryEntries: 200,
  directoryDepth: 2,
  searchResults: 20,
  searchResultsMax: 50,
  matchesPerFile: 3,
  readChars: 40_000,
  readCharsMax: 80_000,
  textFileBytes: 5 * 1024 * 1024,
  pdfFileBytes: 25 * 1024 * 1024,
  pdfSearchPagesPerFile: 200,
});

const EXCLUDED_COMPONENTS = new Set([
  ".git",
  ".ssh",
  ".secrets",
  "secrets",
  "credentials",
  ".godot",
  ".build",
  "deriveddata",
  ".claude",
  ".cursor",
  ".codex",
  ".agents",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".cache",
  ".next",
  ".vite",
  "tmp",
  "temp",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".env",
  "credentials.json",
  "token.json",
  "auth.json",
  "id_rsa",
  "id_ed25519",
]);

const EXCLUDED_SUFFIXES = [
  ".log",
  ".pid",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".mobileprovision",
];

export function defaultStateDirectory() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "InfansReadonlyMCP");
  }
  return path.join(os.homedir(), ".local", "state", "infans-readonly-mcp");
}

export function loadConfig(env = process.env) {
  if (!env.INFANS_VAULT_ROOT) {
    throw new Error("INFANS_VAULT_ROOT must be set to your library root");
  }
  const vaultRoot = path.resolve(env.INFANS_VAULT_ROOT);

  const stateDirectory = path.resolve(env.INFANS_MCP_STATE_DIR || defaultStateDirectory());
  const relativeState = path.relative(vaultRoot, stateDirectory);
  if (relativeState === "" || (!relativeState.startsWith("..") && !path.isAbsolute(relativeState))) {
    throw new Error("INFANS_MCP_STATE_DIR must be outside INFANS_VAULT_ROOT");
  }

  return {
    vaultRoot,
    stateDirectory,
    limits: DEFAULT_LIMITS,
  };
}

export function isExcludedComponent(name) {
  return EXCLUDED_COMPONENTS.has(String(name).toLowerCase());
}

export function isExcludedFileName(name) {
  const lower = String(name).toLowerCase();
  if (EXCLUDED_FILE_NAMES.has(lower)) return true;
  if (/(?:密码|凭据|密钥|恢复码|助记词|私钥)/u.test(lower)) return true;
  if (/(?:^|[._-])(?:secrets?|credentials?|passwords?|cookies?|sessions?|keychain|keystore)(?:[._-]|$)/u.test(lower)) return true;
  if (/^(?:tokens?|sessions?|cookies?)(?:\.(?:json|yaml|yml|txt|toml|db|sqlite))?$/u.test(lower)) return true;
  if ([".npmrc", ".pypirc", ".netrc", ".git-credentials"].includes(lower)) return true;
  if (lower.startsWith(".env.")) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function isSupportedFileName(name) {
  return isTextFileName(name) || path.extname(String(name)).toLowerCase() === PDF_EXTENSION;
}

export function isTextFileName(name) {
  return TEXT_EXTENSIONS.has(path.extname(String(name)).toLowerCase()) || ["Dockerfile", "Makefile", "CMakeLists.txt", ".gitignore", ".gitattributes", ".editorconfig"].includes(path.basename(String(name)));
}
